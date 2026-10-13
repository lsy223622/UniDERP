package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

type instanceModeState struct {
	ActiveMode     config.RunMode `json:"active_mode"`
	Listen         string         `json:"listen"`
	ArchiveID      string         `json:"archive_id,omitempty"`
	MemberDatabase string         `json:"member_database,omitempty"`
	Operation      *modeOperation `json:"operation,omitempty"`
}

type modeOperation struct {
	Status        control.ModeSwitchStatus `json:"status"`
	Phase         string                   `json:"phase"`
	Actor         control.Actor            `json:"actor"`
	Base          config.Config            `json:"base"`
	Target        config.Config            `json:"target"`
	RestoreID     string                   `json:"restore_id,omitempty"`
	BuiltinNodeID string                   `json:"builtin_node_id,omitempty"`
	LocalStopped  bool                     `json:"local_stopped"`
	LeaveNotified bool                     `json:"leave_notified"`
}

func (d *Daemon) modeJournalPath() string {
	return filepath.Join(d.activeConfig().Storage.StateDir, "mode-switch.json")
}

func (d *Daemon) writeModeJournal() error {
	body, err := json.Marshal(d.modeState)
	if err != nil {
		return err
	}
	return writeModeBytes(d.modeJournalPath(), body)
}

func (d *Daemon) loadModeJournal(cfg config.Config) (config.Config, error) {
	d.modeState = instanceModeState{Listen: "127.0.0.1:3341"}
	if cfg.Controller.Enabled {
		d.modeState.Listen = cfg.Controller.Listen
	}
	body, err := os.ReadFile(filepath.Join(cfg.Storage.StateDir, "mode-switch.json"))
	if errors.Is(err, os.ErrNotExist) {
		if !cfg.SetupRequired {
			d.modeState.ActiveMode = cfg.EffectiveMode()
		}
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(body, &d.modeState); err != nil {
		return cfg, err
	}
	op := d.modeState.Operation
	if op != nil && op.Status.Stage != "completed" && op.Status.Stage != "cancelled" {
		if op.Base.Storage != cfg.Storage || op.Base.Node.StateDir != cfg.Node.StateDir || op.Status.From != string(d.modeState.ActiveMode) || op.Base.EffectiveMode() != d.modeState.ActiveMode || op.Status.ID == "" {
			return cfg, errors.New("mode switch journal does not match this instance")
		}
		d.modeBusy.Store(true)
		return op.Base.Clone(), nil
	}
	if d.modeState.ActiveMode != "" && !cfg.SetupRequired && cfg.EffectiveMode() != d.modeState.ActiveMode {
		return cfg, errors.New("use the mode switch workflow to change instance mode")
	}
	return cfg, nil
}

func (d *Daemon) localModeAdministrator(ctx context.Context, actor control.Actor) error {
	local, err := d.controllerStore.LocalAdministrator(ctx)
	if err != nil {
		return err
	}
	if !actor.Enabled || actor.Role != "admin" || actor.ID != local.ID {
		return control.ErrForbidden
	}
	return nil
}

func (d *Daemon) ModeSwitchStatus(ctx context.Context, actor control.Actor) (control.ModeSwitchStatus, error) {
	d.opMu.Lock()
	defer d.opMu.Unlock()
	if err := d.localModeAdministrator(ctx, actor); err != nil {
		return control.ModeSwitchStatus{}, err
	}
	if d.modeState.Operation == nil {
		return control.ModeSwitchStatus{From: string(d.activeConfig().EffectiveMode()), Nodes: []control.NodeRevocationProgress{}, ArchiveID: d.modeState.ArchiveID}, nil
	}
	status := d.modeState.Operation.Status
	status.RestoreID = d.modeState.Operation.RestoreID
	if status.Stage == "failed" {
		status.ResumeStage = d.modeState.Operation.Phase
	}
	if status.ArchiveID == "" {
		status.ArchiveID = d.modeState.ArchiveID
	}
	status.Nodes = append([]control.NodeRevocationProgress{}, status.Nodes...)
	return status, nil
}

func (d *Daemon) SwitchMode(ctx context.Context, actor control.Actor, target, archiveID string, expected uint64) (control.ModeSwitchStatus, error) {
	d.opMu.Lock()
	defer d.opMu.Unlock()
	if err := d.localModeAdministrator(ctx, actor); err != nil {
		return control.ModeSwitchStatus{}, err
	}
	op := d.modeState.Operation
	var revision uint64
	if op != nil {
		revision = op.Status.Revision
	}
	if expected != revision {
		return control.ModeSwitchStatus{}, control.ErrConflict
	}
	if d.modeBusy.Load() {
		if op.Status.Stage != "failed" || op.Status.Target != target || op.RestoreID != archiveID {
			return control.ModeSwitchStatus{}, control.ErrConflict
		}
		op.Status.Stage, op.Status.Error = op.Phase, ""
		op.Status.Revision++
		return op.Status, d.writeModeJournal()
	}
	base := d.activeConfig()
	mode := config.RunMode(target)
	if base.SetupRequired || mode == base.EffectiveMode() || (mode != config.ModeController && mode != config.ModeStandalone && mode != config.ModeMember) {
		return control.ModeSwitchStatus{}, control.ErrInvalid
	}
	if !reflect.DeepEqual(base, d.desiredConfig()) {
		return control.ModeSwitchStatus{}, errors.New("apply or discard pending configuration before switching mode")
	}
	var request [32]byte
	if _, err := rand.Read(request[:]); err != nil {
		return control.ModeSwitchStatus{}, err
	}
	id := hex.EncodeToString(request[:])
	cfg := base.Clone()
	cfg.Mode = mode
	if mode == config.ModeMember {
		if archiveID != "" {
			return control.ModeSwitchStatus{}, control.ErrInvalid
		}
		cfg.Controller = &config.ControllerConfig{Enabled: false}
		cfg.Node.ControllerURL = ""
	} else if !base.Controller.Enabled {
		if archiveID != "" {
			if archiveID != d.modeState.ArchiveID {
				return control.ModeSwitchStatus{}, control.ErrInvalid
			}
			archive, err := d.loadModeArchive(ctx, archiveID)
			if err != nil {
				return control.ModeSwitchStatus{}, err
			}
			cfg.Controller = &archive.Controller
		} else {
			cfg.Controller = config.Default().Controller
			root := filepath.Join(base.Storage.StateDir, "clusters", id)
			cfg.Controller.Database, cfg.Controller.KeyFile = filepath.Join(root, "controller.sqlite"), filepath.Join(root, "controller.key")
		}
		cfg.Controller.Listen = d.modeState.Listen
		cfg.Node.ControllerURL = ""
	} else if archiveID != "" {
		return control.ModeSwitchStatus{}, control.ErrInvalid
	}
	if err := cfg.Validate(); err != nil {
		return control.ModeSwitchStatus{}, err
	}
	if mode == config.ModeMember {
		if err := d.controllerStore.ValidateLocalAdminDestination(ctx, managementDatabase(cfg)); err != nil {
			return control.ModeSwitchStatus{}, err
		}
	}
	storage := []string{filepath.Dir(managementDatabase(cfg))}
	if base.Controller.Enabled && mode == config.ModeMember {
		storage = append(storage, filepath.Join(base.Storage.StateDir, "mode-archives"))
	}
	for _, path := range storage {
		if err := os.MkdirAll(path, 0700); err != nil {
			return control.ModeSwitchStatus{}, err
		}
		f, err := os.CreateTemp(path, ".mode-preflight-*")
		if err != nil {
			return control.ModeSwitchStatus{}, err
		}
		name := f.Name()
		closeErr := f.Close()
		removeErr := os.Remove(name)
		if err := errors.Join(closeErr, removeErr); err != nil {
			return control.ModeSwitchStatus{}, err
		}
	}
	builtin := ""
	if base.Controller.Enabled && d.nodeClient != nil {
		clusterID, nodeID := d.nodeClient.PolicyBinding()
		currentID, _, err := d.controllerStore.SnapshotIdentity(ctx)
		if err != nil {
			return control.ModeSwitchStatus{}, err
		}
		if clusterID == currentID && nodeID != "" {
			node, err := d.controllerStore.Node(ctx, actor, nodeID)
			if err != nil || node.Domain != base.Server.Hostname {
				return control.ModeSwitchStatus{}, control.ErrConflict
			}
			builtin = nodeID
		}
	}
	previous := d.modeState
	d.modeState.ActiveMode = base.EffectiveMode()
	d.modeState.Operation = &modeOperation{Status: control.ModeSwitchStatus{ID: id, From: string(base.EffectiveMode()), Target: target, Stage: "preparing", Revision: revision + 1, Nodes: []control.NodeRevocationProgress{}}, Phase: "preparing", Actor: actor, Base: base, Target: cfg, RestoreID: archiveID, BuiltinNodeID: builtin}
	d.modeBusy.Store(true)
	if err := d.writeModeJournal(); err != nil {
		d.modeState = previous
		d.modeBusy.Store(false)
		return control.ModeSwitchStatus{}, err
	}
	if err := d.prepareModeRevocation(ctx); err != nil {
		op := d.modeState.Operation
		op.Status.Stage, op.Status.Error = "failed", err.Error()
		op.Status.Revision++
		_ = d.writeModeJournal()
		return op.Status, err
	}
	return d.modeState.Operation.Status, nil
}

func (d *Daemon) prepareModeRevocation(ctx context.Context) error {
	op := d.modeState.Operation
	if op == nil || !d.modeBusy.Load() || !op.Base.Controller.Enabled {
		return nil
	}
	if err := d.controllerStore.EnableIdentity(op.Base.Controller.KeyFile); err != nil {
		return err
	}
	status, err := d.controllerStore.BeginModeSwitch(ctx, op.Actor, control.ModeSwitchRequest{ID: op.Status.ID, From: op.Status.From, Target: op.Status.Target, BuiltinNodeID: op.BuiltinNodeID})
	if err != nil {
		return err
	}
	if status.Stage == "cancelled" {
		op.Status.Stage, op.Status.Error = "cancelled", ""
		op.Status.Revision++
		d.modeBusy.Store(false)
		return d.writeModeJournal()
	}
	return nil
}

func (d *Daemon) startModeWorker(ctx context.Context) {
	ctx, d.modeCancel = context.WithCancel(ctx)
	d.modeDone = make(chan struct{})
	go func() {
		defer close(d.modeDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				d.advanceModeSwitch(ctx)
			}
		}
	}()
}

func (d *Daemon) stopModeWorker() {
	if d.modeCancel != nil {
		d.modeCancel()
		<-d.modeDone
		d.modeCancel, d.modeDone = nil, nil
	}
}

func (d *Daemon) advanceModeSwitch(ctx context.Context) {
	d.opMu.Lock()
	defer d.opMu.Unlock()
	if !d.modeBusy.Load() || ctx.Err() != nil {
		return
	}
	op := d.modeState.Operation
	if op.Status.Stage == "failed" {
		return
	}
	if err := d.stepModeSwitch(ctx); err != nil && ctx.Err() == nil {
		op.Status.Stage, op.Status.Error = "failed", err.Error()
		op.Status.Revision++
		if journalErr := d.writeModeJournal(); journalErr != nil {
			d.logf("ERROR persist failed mode switch: %v", journalErr)
		}
		d.logf("ERROR mode switch %s at %s: %v", op.Status.ID, op.Phase, err)
	}
}

func (d *Daemon) modePhase(phase string) error {
	op := d.modeState.Operation
	op.Phase, op.Status.Stage, op.Status.Error = phase, phase, ""
	op.Status.Revision++
	return d.writeModeJournal()
}

func (d *Daemon) stepModeSwitch(ctx context.Context) error {
	op := d.modeState.Operation
	switch op.Phase {
	case "preparing":
		if err := d.prepareModeRevocation(ctx); err != nil {
			return err
		}
		if !d.modeBusy.Load() {
			return nil
		}
		return d.modePhase("revoking")
	case "revoking":
		if op.Base.Controller.Enabled {
			status, err := d.controllerStore.ModeSwitch(ctx, op.Actor)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(op.Status.Nodes, status.Nodes) {
				op.Status.Nodes = status.Nodes
				op.Status.Revision++
				if err := d.writeModeJournal(); err != nil {
					return err
				}
			}
			for _, node := range status.Nodes {
				if node.State != "applied" && node.State != "expired" {
					return nil
				}
			}
			if err := d.controllerStore.FinishModeSwitch(ctx, op.Actor, op.Status.ID); err != nil {
				return err
			}
		}
		if op.Target.EffectiveMode() == config.ModeMember {
			return d.modePhase("archiving")
		}
		return d.modePhase("activating")
	case "archiving":
		if err := d.stopModeMembership(ctx); err != nil {
			return err
		}
		if err := d.controllerStore.RetireModeBuiltin(ctx, op.Actor, op.Status.ID, op.BuiltinNodeID); err != nil {
			return err
		}
		archive, err := d.archiveController(ctx, op.Status.ID)
		if err != nil {
			return err
		}
		op.Status.ArchiveID, d.modeState.ArchiveID = archive.ArchiveID, archive.ArchiveID
		return d.modePhase("activating")
	case "activating":
		if op.Base.EffectiveMode() == config.ModeMember {
			if err := d.stopModeMembership(ctx); err != nil {
				return err
			}
			if op.RestoreID != "" && d.managementPath != managementDatabase(op.Target) {
				if err := d.restoreController(ctx, op.RestoreID); err != nil {
					return err
				}
				restored, err := control.OpenStore(managementDatabase(op.Target))
				if err != nil {
					return err
				}
				adoptErr := restored.AdoptModeAdministrator(ctx, d.controllerStore, op.Actor.ID)
				closeErr := restored.Close()
				if err := errors.Join(adoptErr, closeErr); err != nil {
					return err
				}
			}
		}
		d.stopNodeControl()
		if err := d.stopRelay(ctx); err != nil {
			return err
		}
		d.stopController()
		if err := d.replaceManagementStore(ctx, op.Target, op.Actor.ID); err != nil {
			return err
		}
		if d.nodeClient != nil && (!op.Base.Controller.Enabled || !op.Target.Controller.Enabled) {
			if err := d.nodeClient.SetControllerURL(nodeControllerURL(op.Target)); err != nil {
				return err
			}
		}
		if err := d.prepareRole(d.runCtx, op.Target); err != nil {
			return err
		}
		if err := d.syncDerperConfig(ctx, op.Target); err != nil {
			return err
		}
		if err := config.WriteAtomic(d.configPath, op.Target); err != nil {
			return err
		}
		d.mu.Lock()
		d.current, d.desired = op.Target.Clone(), op.Target.Clone()
		d.pendingRestart, d.applyError = false, ""
		d.nodeConflict = false
		d.mu.Unlock()
		if op.Base.Controller.Enabled && op.Target.Controller.Enabled {
			if err := d.controllerStore.CompleteModeSwitch(ctx, op.Actor, op.Status.ID); err != nil {
				return err
			}
		}
		if op.RestoreID != "" {
			if err := d.controllerStore.CompleteModeSwitch(ctx, op.Actor, op.RestoreID); err != nil {
				return err
			}
		}
		if err := d.controllerStore.InvalidateModeSessions(ctx); err != nil {
			return err
		}
		previousMode, previousPhase, previousStatus := d.modeState.ActiveMode, op.Phase, op.Status
		d.modeState.ActiveMode = op.Target.EffectiveMode()
		if !op.Target.Controller.Enabled {
			d.modeState.MemberDatabase = d.managementPath
		}
		if err := d.modePhase("completed"); err != nil {
			d.modeState.ActiveMode, op.Phase, op.Status = previousMode, previousPhase, previousStatus
			return err
		}
		d.modeBusy.Store(false)
		if err := d.prepareRole(d.runCtx, op.Target); err != nil {
			return err
		}
		if op.Target.EffectiveMode() == config.ModeStandalone {
			d.prepareStandalone(ctx)
		}
		if d.nodeClient != nil && d.derper.Running() {
			d.startNodeControl(d.runCtx)
		}
		return nil
	}
	return control.ErrConflict
}

func (d *Daemon) stopModeMembership(ctx context.Context) error {
	op := d.modeState.Operation
	if op.LocalStopped {
		return nil
	}
	d.stopNodeControl()
	if err := d.stopRelay(ctx); err != nil {
		return err
	}
	if d.nodeClient != nil {
		previous, err := d.nodeClient.ClearRegistration()
		if err != nil {
			return err
		}
		if err := cluster.RemoveCache(d.policyClient.Path); err != nil {
			return err
		}
		if previous.Token != "" && !op.Base.Controller.Enabled {
			notifyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			op.LeaveNotified = d.nodeClient.Release(notifyCtx, previous) == nil
			notified := op.LeaveNotified
			op.Status.LeaveNotified = &notified
			cancel()
		}
	}
	op.LocalStopped = true
	return d.writeModeJournal()
}

func (d *Daemon) CancelModeSwitch(ctx context.Context, actor control.Actor, id string, expected uint64) error {
	d.opMu.Lock()
	defer d.opMu.Unlock()
	if err := d.localModeAdministrator(ctx, actor); err != nil {
		return err
	}
	op := d.modeState.Operation
	if op == nil || !d.modeBusy.Load() || op.Status.ID != id || op.Status.Revision != expected || (op.Phase != "preparing" && op.Phase != "revoking") {
		return control.ErrConflict
	}
	if op.Base.Controller.Enabled {
		status, err := d.controllerStore.ModeSwitch(ctx, actor)
		if err != nil {
			return err
		}
		if status.ID == id && status.Stage != "cancelled" {
			if err := d.controllerStore.CancelModeSwitch(ctx, actor, id, status.Revision); err != nil {
				return err
			}
		}
	}
	if err := d.modePhase("cancelled"); err != nil {
		return err
	}
	d.modeBusy.Store(false)
	return d.prepareRole(d.runCtx, d.activeConfig())
}
