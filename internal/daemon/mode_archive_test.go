package daemon

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

func TestModeArchiveConsistentDatabaseAndKey(t *testing.T) {
	d := localTestDaemon(t, false)
	admin, err := d.controllerStore.InitializeAdmin(t.Context(), "archive-admin", "archive-test-password")
	if err != nil {
		t.Fatal(err)
	}
	archive, err := d.archiveController(t.Context(), "switch-1")
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := d.loadModeArchive(t.Context(), archive.ArchiveID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClusterID == "" || loaded.ClusterID != archive.ClusterID {
		t.Fatal("archive cluster identity missing")
	}
	snapshot, err := control.OpenStore(filepath.Join(d.archiveRoot(archive.ArchiveID), "controller.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	actor, err := snapshot.LocalAdministrator(t.Context())
	if err != nil || actor.ID != admin.ID {
		t.Fatal("archive database cannot restore admin", err)
	}
	key, _ := os.ReadFile(d.activeConfig().Controller.KeyFile)
	archivedKey, _ := os.ReadFile(filepath.Join(d.archiveRoot(archive.ArchiveID), "controller.key"))
	if !bytes.Equal(key, archivedKey) {
		t.Fatal("archive did not preserve matching key")
	}
	if err := os.WriteFile(filepath.Join(d.archiveRoot(archive.ArchiveID), "controller.key"), bytes.Repeat([]byte{9}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.loadModeArchive(t.Context(), archive.ArchiveID); err == nil {
		t.Fatal("mismatched archive key accepted")
	}
}

func TestModeArchiveCustomPaths(t *testing.T) {
	d := localTestDaemon(t, false)
	cfg := d.activeConfig()
	oldKey, _ := os.ReadFile(cfg.Controller.KeyFile)
	path := filepath.Join(shortTempDir(t), "custom.sqlite")
	if err := d.controllerStore.Snapshot(t.Context(), path); err != nil {
		t.Fatal(err)
	}
	d.controllerCancel()
	<-d.controllerDone
	d.controllerCancel = nil
	d.controllerDone = nil
	if err := d.controllerStore.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := control.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	d.controllerStore = store
	cfg.Controller.Database = path
	cfg.Controller.KeyFile = filepath.Join(filepath.Dir(path), "custom.key")
	if err := os.WriteFile(cfg.Controller.KeyFile, oldKey, 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.EnableIdentity(cfg.Controller.KeyFile); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureNodes(nil); err != nil {
		t.Fatal(err)
	}
	d.mu.Lock()
	d.current = cfg
	d.desired = cfg
	d.mu.Unlock()
	untouched := filepath.Join(cfg.Storage.StateDir, "other-file")
	os.WriteFile(untouched, []byte("keep"), 0600)
	archive, err := d.archiveController(t.Context(), "custom-switch")
	if err != nil {
		t.Fatal(err)
	}
	if archive.DatabasePath != path || archive.KeyPath != cfg.Controller.KeyFile {
		t.Fatal("custom paths lost")
	}
	if data, err := os.ReadFile(untouched); err != nil || string(data) != "keep" {
		t.Fatal("unrelated data moved")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("source database moved")
	}
}

func TestModePreserveMemberManagementIsolation(t *testing.T) {
	d := localTestDaemon(t, true)
	d.derper = &daemonFakeProcess{}
	admin, err := d.controllerStore.InitializeAdmin(t.Context(), "admin", "archive-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.controllerStore.CreateUser(t.Context(), admin, "platform-member", "archive-test-password", "member"); err != nil {
		t.Fatal(err)
	}
	status, _ := d.Status(t.Context())
	settings := status.Saved
	settings.Role, settings.Mode, settings.Hostname = "member", "member", "relay.example.com"
	if err := d.SaveSettings(t.Context(), settings); err != nil {
		t.Fatal(err)
	}
	if err := d.ApplySettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d.activeConfig().Storage.StateDir, "local.sqlite")); err != nil {
		t.Fatal("member local database absent", err)
	}
	for _, username := range []string{"admin", "platform-member"} {
		req := httptest.NewRequest("POST", "https://relay.example.com/api/v1/login", strings.NewReader(`{"username":"`+username+`","password":"archive-test-password"}`))
		req.Header.Set("Origin", "https://relay.example.com")
		response := httptest.NewRecorder()
		control.NewLocalHTTPHandler(d.controllerStore, d).ServeHTTP(response, req)
		want := 200
		if username != "admin" {
			want = 401
		}
		if response.Code != want {
			t.Fatalf("%s login status=%d want=%d", username, response.Code, want)
		}
	}
}

func TestModeArchiveRestoreAndCorruption(t *testing.T) {
	d := localTestDaemon(t, false)
	admin, err := d.controllerStore.InitializeAdmin(t.Context(), "admin", "archive-test-password")
	if err != nil {
		t.Fatal(err)
	}
	archive, err := d.archiveController(t.Context(), "restore-switch")
	if err != nil {
		t.Fatal(err)
	}
	d.controllerCancel()
	<-d.controllerDone
	d.controllerCancel = nil
	d.controllerDone = nil
	d.controllerStore.Close()
	d.controllerStore = nil
	cfg := d.activeConfig()
	cfg.Mode = config.ModeMember
	cfg.Controller = &config.ControllerConfig{Enabled: false}
	d.mu.Lock()
	d.current = cfg
	d.desired = cfg
	d.mu.Unlock()
	if err := d.restoreController(t.Context(), archive.ArchiveID); err != nil {
		t.Fatal(err)
	}
	restored, err := control.OpenStore(archive.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	actor, err := restored.LocalAdministrator(t.Context())
	if err != nil || actor.ID != admin.ID {
		t.Fatal("restored administrator lost", err)
	}
	if err := os.WriteFile(filepath.Join(d.archiveRoot(archive.ArchiveID), "controller.sqlite"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := d.restoreController(t.Context(), archive.ArchiveID); err == nil {
		t.Fatal("corrupt archive restored")
	}
	if actor, err := restored.LocalAdministrator(t.Context()); err != nil || actor.ID != admin.ID {
		t.Fatal("rejected restore changed destination", err)
	}
}

func TestModeArchiveFailureRetainsSource(t *testing.T) {
	d := localTestDaemon(t, false)
	admin, err := d.controllerStore.InitializeAdmin(t.Context(), "admin", "archive-test-password")
	if err != nil {
		t.Fatal(err)
	}
	cfg := d.activeConfig()
	key, _ := os.ReadFile(cfg.Controller.KeyFile)
	if err := os.WriteFile(filepath.Join(cfg.Storage.StateDir, "mode-archives"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.archiveController(t.Context(), "failed-switch"); err == nil {
		t.Fatal("archive failure reported success")
	}
	if actor, err := d.controllerStore.LocalAdministrator(t.Context()); err != nil || actor.ID != admin.ID {
		t.Fatal("source store unusable", err)
	}
	after, _ := os.ReadFile(cfg.Controller.KeyFile)
	if !bytes.Equal(key, after) {
		t.Fatal("failed archive changed source key")
	}
}
