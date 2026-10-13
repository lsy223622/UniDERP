package control

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/lsy223622/UniDERP/v2/internal/cluster"
)

var ErrModeSwitch = errors.New("instance mode switch is in progress")

type ModeSwitchRequest struct{ ID, From, Target, ArchiveID, BuiltinNodeID string }

type NodeRevocationProgress struct {
	NodeID         string    `json:"node_id"`
	Domain         string    `json:"domain,omitempty"`
	DisplayName    string    `json:"display_name,omitempty"`
	RevokeRevision uint64    `json:"revoke_revision"`
	State          string    `json:"state"`
	EffectiveUntil time.Time `json:"effective_until,omitempty"`
	ExpiryKnown    bool      `json:"expiry_known"`
	Error          string    `json:"error,omitempty"`
}

type ModeSwitchStatus struct {
	ID        string                   `json:"id"`
	From      string                   `json:"from"`
	Target    string                   `json:"target"`
	Stage     string                   `json:"stage"`
	Revision  uint64                   `json:"revision"`
	ArchiveID string                   `json:"archive_id,omitempty"`
	Nodes     []NodeRevocationProgress `json:"nodes"`
	Error     string                   `json:"error,omitempty"`
}

func modeSwitchFrozen(ctx context.Context, tx *sql.Tx) (bool, error) {
	var active bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM mode_operations WHERE active=1)").Scan(&active)
	return active, err
}

func checkModeMutation(ctx context.Context, tx *sql.Tx) error {
	frozen, err := modeSwitchFrozen(ctx, tx)
	if err != nil {
		return err
	}
	if frozen {
		return ErrModeSwitch
	}
	return nil
}

func readModeSwitch(ctx context.Context, tx *sql.Tx) (ModeSwitchStatus, error) {
	var body []byte
	err := tx.QueryRowContext(ctx, "SELECT state_json FROM mode_operations WHERE id=(SELECT value FROM settings WHERE key='mode_switch_id')").Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return ModeSwitchStatus{}, nil
	}
	if err != nil {
		return ModeSwitchStatus{}, err
	}
	var status ModeSwitchStatus
	err = json.Unmarshal(body, &status)
	return status, err
}

func writeModeSwitch(ctx context.Context, tx *sql.Tx, status ModeSwitchStatus, active bool) error {
	body, err := json.Marshal(status)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE mode_operations SET state_json=?,active=? WHERE id=?", body, active, status.ID)
	return err
}

func modeAdministrator(ctx context.Context, tx *sql.Tx, actor Actor) error {
	if actor.Role != "admin" || !actor.Enabled {
		return ErrForbidden
	}
	return authorizeActor(ctx, tx, actor)
}

func (s *Store) BeginModeSwitch(ctx context.Context, actor Actor, request ModeSwitchRequest) (ModeSwitchStatus, error) {
	if len(request.ID) != 64 || s.clusterID == "" || request.From == request.Target ||
		(request.From != "controller" && request.From != "standalone") ||
		(request.Target != "controller" && request.Target != "standalone" && request.Target != "member") {
		return ModeSwitchStatus{}, ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ModeSwitchStatus{}, err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return ModeSwitchStatus{}, err
	}
	previous, err := readModeSwitch(ctx, tx)
	if err != nil {
		return ModeSwitchStatus{}, err
	}
	if previous.ID == request.ID {
		if previous.From != request.From || previous.Target != request.Target {
			return ModeSwitchStatus{}, ErrConflict
		}
		return previous, nil
	}
	if err := checkModeMutation(ctx, tx); err != nil {
		return ModeSwitchStatus{}, err
	}
	status := ModeSwitchStatus{ID: request.ID, From: request.From, Target: request.Target, Stage: "revoking", Revision: 1, ArchiveID: request.ArchiveID, Nodes: []NodeRevocationProgress{}}
	if request.Target != "controller" {
		rows, err := tx.QueryContext(ctx, "SELECT h.node_id,coalesce(n.domain,h.domain),coalesce(n.display_name,h.display_name),h.expiry_known,h.effective_until FROM node_permission_history h LEFT JOIN nodes n ON n.id=h.node_id WHERE h.node_id<>? AND (n.id IS NOT NULL OR h.expiry_known=0 OR h.effective_until>?) ORDER BY h.node_id", request.BuiltinNodeID, s.now().Unix())
		if err != nil {
			return status, err
		}
		for rows.Next() {
			var node NodeRevocationProgress
			var until int64
			node.State = "waiting"
			if err := rows.Scan(&node.NodeID, &node.Domain, &node.DisplayName, &node.ExpiryKnown, &until); err != nil {
				rows.Close()
				return status, err
			}
			if node.ExpiryKnown && until != 0 {
				node.EffectiveUntil = time.Unix(until, 0).UTC()
			}
			status.Nodes = append(status.Nodes, node)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return status, err
		}
		for i := range status.Nodes {
			node := &status.Nodes[i]
			if _, err := tx.ExecContext(ctx, "UPDATE grants SET state='revoked',revision=revision+1,last_control_success=0 WHERE node_id=? AND state!='revoked'", node.NodeID); err != nil {
				return status, err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM enrollments WHERE node_id=?", node.NodeID); err != nil {
				return status, err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM node_challenges WHERE node_id=? AND json_extract(CAST(payload AS TEXT),'$.purpose')='enroll'", node.NodeID); err != nil {
				return status, err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET enabled=0 WHERE id=?", node.NodeID); err != nil {
				return status, err
			}
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM node_policies WHERE node_id=?)", node.NodeID).Scan(&exists); err != nil {
				return status, err
			}
			if exists {
				policy, err := s.buildPolicy(ctx, tx, node.NodeID, s.now())
				if err != nil {
					return status, err
				}
				if len(policy.Grants) != 0 {
					return status, ErrConflict
				}
				node.RevokeRevision = policy.Revision
			}
			if node.ExpiryKnown && (node.EffectiveUntil.IsZero() || !s.now().Before(node.EffectiveUntil)) {
				node.State = "expired"
			}
		}
	}
	body, err := json.Marshal(status)
	if err != nil {
		return status, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO mode_operations(id,state_json,active) VALUES(?,?,1)", status.ID, body); err != nil {
		return status, conflictError(err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES('mode_switch_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", status.ID); err != nil {
		return status, err
	}
	if err := writeAudit(ctx, tx, actor.ID, actor.ID, "instance", status.ID, "mode.switch.prepare"); err != nil {
		return status, err
	}
	if err := tx.Commit(); err != nil {
		return status, err
	}
	s.notifyPolicies()
	return status, nil
}

func (s *Store) ModeSwitch(ctx context.Context, actor Actor) (ModeSwitchStatus, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ModeSwitchStatus{}, err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return ModeSwitchStatus{}, err
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return status, err
	}
	changed := false
	if status.Stage == "revoking" {
		for i := range status.Nodes {
			node := &status.Nodes[i]
			if node.State != "applied" && node.State != "expired" && node.ExpiryKnown && (node.EffectiveUntil.IsZero() || !s.now().Before(node.EffectiveUntil)) {
				node.State, node.Error = "expired", ""
				changed = true
			}
		}
	}
	if changed {
		status.Revision++
		if err := writeModeSwitch(ctx, tx, status, true); err != nil {
			return status, err
		}
	}
	return status, tx.Commit()
}

func (s *Store) CancelModeSwitch(ctx context.Context, actor Actor, id string, expected uint64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return err
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return err
	}
	if status.ID != id || status.Revision != expected || status.Stage != "revoking" {
		return ErrConflict
	}
	status.Stage = "cancelled"
	status.Revision++
	if err := writeModeSwitch(ctx, tx, status, false); err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor.ID, actor.ID, "instance", id, "mode.switch.cancel"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) FinishModeSwitch(ctx context.Context, actor Actor, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return err
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return err
	}
	if status.ID != id {
		return ErrConflict
	}
	if status.Stage == "completed" || status.Stage == "archiving" || status.Stage == "activating" {
		return nil
	}
	if status.Stage != "revoking" {
		return ErrConflict
	}
	for _, node := range status.Nodes {
		if node.State != "applied" && node.State != "expired" {
			return ErrConflict
		}
	}
	for _, node := range status.Nodes {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?)", node.NodeID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			if err := s.releaseNode(ctx, tx, node.NodeID); err != nil {
				return err
			}
		}
	}
	status.Stage = "activating"
	if status.Target == "member" {
		status.Stage = "archiving"
	}
	status.Revision++
	if err := writeModeSwitch(ctx, tx, status, true); err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor.ID, actor.ID, "instance", id, "mode.revocation.complete"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.notifyPolicies()
	return nil
}

func (s *Store) CompleteModeSwitch(ctx context.Context, actor Actor, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return err
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return err
	}
	if status.ID != id {
		return ErrConflict
	}
	if status.Stage == "completed" {
		return nil
	}
	if status.Stage != "activating" && status.Stage != "archiving" {
		return ErrConflict
	}
	status.Stage = "completed"
	status.Revision++
	if err := writeModeSwitch(ctx, tx, status, false); err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor.ID, actor.ID, "instance", id, "mode.switch.complete"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RetireModeBuiltin(ctx context.Context, actor Actor, id, builtin string) error {
	if builtin == "" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := modeAdministrator(ctx, tx, actor); err != nil {
		return err
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return err
	}
	if status.ID != id || status.Stage != "archiving" || status.Target != "member" {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "UPDATE grants SET state='revoked',revision=revision+1,last_control_success=0 WHERE node_id=? AND state!='revoked'", builtin); err != nil {
		return err
	}
	if err := s.releaseNode(ctx, tx, builtin); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) InvalidateModeSessions(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE users SET session_version=session_version+1"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

func recordPermissionHorizon(ctx context.Context, tx *sql.Tx, policy cluster.Policy) error {
	var until int64
	for _, grant := range policy.Grants {
		for _, device := range grant.Keys {
			deadline := cluster.EffectiveUntil(grant, device)
			value := deadline.Unix()
			if deadline.Nanosecond() != 0 {
				value++
			}
			if value > until {
				until = value
			}
		}
	}
	_, err := tx.ExecContext(ctx, "UPDATE node_permission_history SET effective_until=max(effective_until,?) WHERE node_id=?", until, policy.NodeID)
	return err
}

func acknowledgeModeRevocation(ctx context.Context, tx *sql.Tx, nodeID string, ack cluster.PolicyACK, policyJSON []byte) error {
	var policy cluster.Policy
	if ack.State == "applied" && !ack.Usable {
		if err := json.Unmarshal(policyJSON, &policy); err != nil {
			return err
		}
		if policy.Revision == ack.Revision && len(policy.Grants) == 0 {
			if _, err := tx.ExecContext(ctx, "UPDATE node_permission_history SET expiry_known=1,effective_until=0 WHERE node_id=?", nodeID); err != nil {
				return err
			}
		}
	}
	status, err := readModeSwitch(ctx, tx)
	if err != nil {
		return err
	}
	if status.Stage != "revoking" {
		return nil
	}
	for i := range status.Nodes {
		node := &status.Nodes[i]
		if node.NodeID != nodeID || node.RevokeRevision == 0 || ack.Revision < node.RevokeRevision {
			continue
		}
		if node.State == "applied" || node.State == "expired" {
			continue
		}
		if ack.State == "applied" {
			if ack.Usable {
				return ErrInvalid
			}
			var policy cluster.Policy
			if err := json.NewDecoder(bytes.NewReader(policyJSON)).Decode(&policy); err != nil {
				return err
			}
			if len(policy.Grants) != 0 {
				return ErrConflict
			}
			node.State, node.Error = "applied", ""
			if _, err := tx.ExecContext(ctx, "UPDATE node_permission_history SET expiry_known=1,effective_until=0 WHERE node_id=?", nodeID); err != nil {
				return err
			}
		} else if ack.State == "nack" {
			node.State, node.Error = "failed", ack.Error
		} else {
			continue
		}
		status.Revision++
		return writeModeSwitch(ctx, tx, status, true)
	}
	return nil
}
