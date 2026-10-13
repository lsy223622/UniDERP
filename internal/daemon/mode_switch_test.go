package daemon

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lsy223622/UniDERP/v2/internal/admin"
	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

func modeTestDaemon(t *testing.T, mode config.RunMode) (*Daemon, control.Actor) {
	t.Helper()
	dir := shortTempDir(t)
	cfg := config.Default()
	cfg.Mode = mode
	cfg.Storage.StateDir, cfg.Node.StateDir = dir, filepath.Join(dir, "node")
	cfg.Server.Hostname = "mode.example.com"
	cfg.Server.DERP.TLSMode, cfg.Server.DERP.CertMode = "external", "none"
	cfg.Node.MaxBudgetBPS = 12345
	cfg.Server.Admin.Socket = filepath.Join(dir, "admin.sock")
	cfg.Server.Management.Listen, cfg.Server.Health.Listen = freeLoopbackAddress(t), freeLoopbackAddress(t)
	if mode == config.ModeMember {
		cfg.Controller = &config.ControllerConfig{Enabled: false}
	} else {
		cfg.Controller.Listen = freeLoopbackAddress(t)
		cfg.Controller.Database, cfg.Controller.KeyFile = filepath.Join(dir, "custom.sqlite"), filepath.Join(dir, "custom.key")
	}
	path := filepath.Join(dir, "config.yaml")
	if err := config.WriteAtomic(path, cfg); err != nil {
		t.Fatal(err)
	}
	d := restartModeTestDaemon(t, path)
	actor, err := d.controllerStore.InitializeAdmin(t.Context(), "mode-admin", "mode-test-password")
	if err != nil {
		t.Fatal(err)
	}
	return d, actor
}

func restartModeTestDaemon(t *testing.T, path string) *Daemon {
	t.Helper()
	d := New(context.Background(), Options{ConfigPath: path, Logger: log.New(io.Discard, "", 0)})
	d.derper = &daemonFakeProcess{}
	if err := d.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	d.stopModeWorker()
	t.Cleanup(func() { d.Shutdown() })
	return d
}

func modeTestLogin(t *testing.T, d *Daemon, passwords ...string) {
	t.Helper()
	password := "mode-test-password"
	if len(passwords) != 0 {
		password = passwords[0]
	}
	r := httptest.NewRequest("POST", "https://mode.example.com/api/v1/login", strings.NewReader(`{"username":"mode-admin","password":"`+password+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://mode.example.com")
	w := httptest.NewRecorder()
	control.NewLocalHTTPHandler(d.controllerStore, d).ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("selected administrator lost access", w.Code, w.Body.String())
	}
}

func TestModeRestoreKeepsSelectedAdmin(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	archived := finishModeTestSwitch(t, d, actor)
	if err := d.controllerStore.ChangePassword(t.Context(), actor, actor.ID, "new-member-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "controller", archived.ArchiveID, archived.Revision); err != nil {
		t.Fatal(err)
	}
	finishModeTestSwitch(t, d, actor)
	modeTestLogin(t, d, "new-member-password")
	if _, _, err := d.controllerStore.CreateNode(t.Context(), actor, "New", "new.example.com", 443, 3478); err != nil {
		t.Fatal("restored controller remains frozen", err)
	}
}

func TestModeRestoreDoesNotReactivateRemote(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	node, enrollment, err := d.controllerStore.CreateNode(t.Context(), actor, "Remote", "remote.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	clusterID, _, err := d.controllerStore.SnapshotIdentity(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	archived := finishModeTestSwitch(t, d, actor)
	if _, err := d.SwitchMode(t.Context(), actor, "controller", archived.ArchiveID, archived.Revision); err != nil {
		t.Fatal(err)
	}
	finishModeTestSwitch(t, d, actor)
	restoredID, _, err := d.controllerStore.SnapshotIdentity(t.Context())
	if err != nil || restoredID != clusterID {
		t.Fatal("explicit restore replaced original cluster identity", err)
	}
	remote, err := d.controllerStore.Node(t.Context(), actor, node.ID)
	if err != nil || remote.Enabled || remote.State != "pending" {
		t.Fatal("restoring archive revived remote membership", err, remote)
	}
	if _, err := d.controllerStore.EnrollmentChallenge(t.Context(), enrollment.Code, make([]byte, 32), strings.Repeat("e", 64)); err == nil {
		t.Fatal("old enrollment restored")
	}
	if _, err := d.loadModeArchive(t.Context(), archived.ArchiveID); err != nil {
		t.Fatal("restore mutated immutable archive", err)
	}
}

func TestModeSwitchCLIMutationsFrozen(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	d.stopNodeControl()
	var attempts atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempts.Add(1); w.WriteHeader(401) }))
	defer server.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = server.Client().Transport
	client, err := cluster.NewEnrollmentClient(server.URL, d.activeConfig().Node.StateDir)
	http.DefaultTransport = previous
	if err != nil {
		t.Fatal(err)
	}
	d.nodeClient = client
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	for _, request := range []admin.Request{{Action: "derp.restart"}, {Action: "node.enroll", ControllerURL: nodeControllerURL(d.activeConfig()), EnrollmentCode: strings.Repeat("e", 64)}} {
		response := d.handleRequest(t.Context(), request)
		if response.OK || response.Error != control.ErrModeSwitch.Error() {
			t.Errorf("CLI mutation not frozen: %s %v", request.Action, response)
		}
	}
	if attempts.Load() != 0 {
		t.Fatal("CLI enrollment contacted a controller during mode transition", attempts.Load())
	}
}

func TestModeLegacyMemberSettingsKeepLogin(t *testing.T) {
	d, _ := modeTestDaemon(t, config.ModeMember)
	cfg := d.activeConfig()
	previousPath := d.managementPath
	if err := d.Shutdown(); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(cfg.Storage.StateDir, "controller.sqlite")
	if err := os.Rename(previousPath, legacyPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(d.modeJournalPath()); err != nil {
		t.Fatal(err)
	}
	cfg.Mode = ""
	if err := config.WriteAtomic(d.configPath, cfg); err != nil {
		t.Fatal(err)
	}
	d = restartModeTestDaemon(t, d.configPath)
	h := control.NewLocalHTTPHandler(d.controllerStore, d)
	r := httptest.NewRequest("POST", "https://mode.example.com/api/v1/login", strings.NewReader(`{"username":"mode-admin","password":"mode-test-password"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	status, err := d.Status(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SaveSettings(t.Context(), status.Saved); err != nil {
		t.Fatal(err)
	}
	if err := d.ApplySettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest("GET", "https://mode.example.com/api/v1/session", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	control.NewLocalHTTPHandler(d.controllerStore, d).ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("ordinary member settings invalidated administrator login", w.Code, w.Body.String())
	}
}

func finishModeTestSwitch(t *testing.T, d *Daemon, actor control.Actor) control.ModeSwitchStatus {
	t.Helper()
	for range 10 {
		d.advanceModeSwitch(t.Context())
		status, err := d.ModeSwitchStatus(t.Context(), actor)
		if err != nil {
			t.Fatal(err)
		}
		if status.Stage == "completed" {
			return status
		}
		if status.Stage == "failed" {
			t.Fatal(status.Error)
		}
	}
	t.Fatal("mode switch did not complete")
	return control.ModeSwitchStatus{}
}

func TestModeSwitchSixDirections(t *testing.T) {
	for _, from := range []config.RunMode{config.ModeStandalone, config.ModeController, config.ModeMember} {
		for _, target := range []config.RunMode{config.ModeStandalone, config.ModeController, config.ModeMember} {
			if from == target {
				continue
			}
			t.Run(string(from)+"_to_"+string(target), func(t *testing.T) {
				d, actor := modeTestDaemon(t, from)
				before := d.activeConfig()
				if _, err := d.SwitchMode(t.Context(), actor, string(target), "", 0); err != nil {
					t.Fatal(err)
				}
				status := finishModeTestSwitch(t, d, actor)
				after := d.activeConfig()
				if after.EffectiveMode() != target || after.Server != before.Server || after.Node.MaxBudgetBPS != before.Node.MaxBudgetBPS || after.Node.StateDir != before.Node.StateDir {
					t.Fatal("target mode or local configuration not preserved", after)
				}
				modeTestLogin(t, d)
				if target == config.ModeMember {
					if status.ArchiveID == "" {
						t.Fatal("controller archive missing")
					}
					if _, err := d.loadModeArchive(t.Context(), status.ArchiveID); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}

func TestModeSwitchConcurrentRequest(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "standalone", "", 0); !errors.Is(err, control.ErrConflict) {
		t.Fatal("concurrent mode request accepted", err)
	}
}

func TestModeSwitchRestartResume(t *testing.T) {
	for steps, phase := range []string{"preparing", "revoking", "archiving", "activating"} {
		t.Run(phase, func(t *testing.T) {
			d, actor := modeTestDaemon(t, config.ModeController)
			status, err := d.SwitchMode(t.Context(), actor, "member", "", 0)
			if err != nil {
				t.Fatal(err)
			}
			for range steps {
				d.advanceModeSwitch(t.Context())
			}
			progress, err := d.ModeSwitchStatus(t.Context(), actor)
			if err != nil || progress.Stage != phase {
				t.Fatal("wrong interruption stage", err, progress)
			}
			if err := d.Shutdown(); err != nil {
				t.Fatal(err)
			}
			restarted := restartModeTestDaemon(t, d.configPath)
			recovered, err := restarted.ModeSwitchStatus(t.Context(), actor)
			if err != nil || recovered.ID != status.ID {
				t.Fatal("durable switch intent lost", err, recovered)
			}
			if restarted.controllerCancel != nil {
				t.Fatal("identity synchronization resumed before unfinished switch")
			}
			finishModeTestSwitch(t, restarted, actor)
		})
	}
}

func TestModeSwitchCancelDoesNotRestoreGrants(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	node, _, err := d.controllerStore.CreateNode(t.Context(), actor, "Remote", "remote.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	status, err := d.SwitchMode(t.Context(), actor, "standalone", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	d.advanceModeSwitch(t.Context())
	status, err = d.ModeSwitchStatus(t.Context(), actor)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.CancelModeSwitch(t.Context(), actor, status.ID, status.Revision); err != nil {
		t.Fatal(err)
	}
	after, err := d.controllerStore.Node(t.Context(), actor, node.ID)
	if err != nil || after.Enabled {
		t.Fatal("cancel restored revoked node", err, after)
	}
}

func TestModeSwitchActivationFailureKeepsAdminAccess(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	d.stopNodeControl()
	if err := d.stopRelay(t.Context()); err != nil {
		t.Fatal(err)
	}
	process := d.derper.(*daemonFakeProcess)
	process.mu.Lock()
	process.startErr = errors.New("mode activation test failure")
	process.mu.Unlock()
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		d.advanceModeSwitch(t.Context())
	}
	status, err := d.ModeSwitchStatus(t.Context(), actor)
	if err != nil || status.Stage != "failed" || d.activeConfig().EffectiveMode() != config.ModeController {
		t.Fatal("failed activation reported success", err, status)
	}
	modeTestLogin(t, d)
	if _, err := os.Stat(d.modeJournalPath()); err != nil {
		t.Fatal("failed activation journal missing", err)
	}
	process.mu.Lock()
	process.startErr = nil
	process.mu.Unlock()
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", status.Revision); err != nil {
		t.Fatal("activation retry failed", err)
	}
	finishModeTestSwitch(t, d, actor)
}

func TestModeSwitchUnknownNodeWaitsAcrossRestart(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	node, _, err := d.controllerStore.CreateNode(t.Context(), actor, "Offline", "offline.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", d.managementPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("UPDATE node_permission_history SET expiry_known=0 WHERE node_id=?", node.ID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		d.advanceModeSwitch(t.Context())
	}
	if err := d.Shutdown(); err != nil {
		t.Fatal(err)
	}
	d = restartModeTestDaemon(t, d.configPath)
	d.advanceModeSwitch(t.Context())
	status, err := d.ModeSwitchStatus(t.Context(), actor)
	if err != nil || status.Stage != "revoking" || len(status.Nodes) != 1 || status.Nodes[0].ExpiryKnown || status.Nodes[0].State != "waiting" || d.activeConfig().EffectiveMode() != config.ModeController {
		t.Fatal("unknown offline node did not keep original mode waiting", err, status)
	}
	if _, _, err := d.controllerStore.CreateNode(t.Context(), actor, "New", "new.example.com", 443, 3478); !errors.Is(err, control.ErrModeSwitch) {
		t.Fatal("startup restored authorization before revocation completion", err)
	}
}

func TestModeSwitchArchiveFailureKeepsSourceData(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	before := d.activeConfig()
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(before.Storage.StateDir, "mode-archives")
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocked archive directory"), 0600); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		d.advanceModeSwitch(t.Context())
	}
	status, err := d.ModeSwitchStatus(t.Context(), actor)
	if err != nil || status.Stage != "failed" || d.activeConfig().EffectiveMode() != config.ModeController || d.managementPath != before.Controller.Database {
		t.Fatal("archive failure changed active mode or discarded source", err, status)
	}
	modeTestLogin(t, d)
	if _, err := os.Stat(before.Controller.KeyFile); err != nil {
		t.Fatal("original controller key lost", err)
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", status.Revision); err != nil {
		t.Fatal(err)
	}
	finishModeTestSwitch(t, d, actor)
}

func TestModeSwitchJournalFailureCanRetryActivation(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	if _, err := d.SwitchMode(t.Context(), actor, "standalone", "", 0); err != nil {
		t.Fatal(err)
	}
	d.advanceModeSwitch(t.Context())
	d.advanceModeSwitch(t.Context())
	journal := d.modeJournalPath()
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(journal, 0700); err != nil {
		t.Fatal(err)
	}
	d.advanceModeSwitch(t.Context())
	status, err := d.ModeSwitchStatus(t.Context(), actor)
	if err != nil || status.Stage != "failed" {
		t.Fatal("journal write failure reported completion", err, status)
	}
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "standalone", "", status.Revision); err != nil {
		t.Fatal(err)
	}
	finishModeTestSwitch(t, d, actor)
}

func TestModeSwitchFreezesBeforeStartReturns(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.controllerStore.CreateNode(t.Context(), actor, "Late", "late.example.com", 443, 3478); !errors.Is(err, control.ErrModeSwitch) {
		t.Fatal("switch returned before freezing authorization", err)
	}
}

func TestModeSwitchRejectsUnownedStorageBeforeRevocation(t *testing.T) {
	d, actor := modeTestDaemon(t, config.ModeController)
	node, _, err := d.controllerStore.CreateNode(t.Context(), actor, "Remote", "remote.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(d.activeConfig().Storage.StateDir, "local.sqlite")
	if err := os.WriteFile(destination, []byte("unrelated data"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SwitchMode(t.Context(), actor, "member", "", 0); !errors.Is(err, control.ErrConflict) {
		t.Fatal("unowned target data was accepted", err)
	}
	after, err := d.controllerStore.Node(t.Context(), actor, node.ID)
	if err != nil || !after.Enabled {
		t.Fatal("storage preflight failure revoked external node", err, after)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "unrelated data" {
		t.Fatal("storage preflight changed unowned data", err)
	}
}
