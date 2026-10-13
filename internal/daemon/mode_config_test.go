package daemon

import (
	"errors"
	"testing"

	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

func TestModeChangeRequiresSwitch(t *testing.T) {
	d := localTestDaemon(t, false)
	status, err := d.Status(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	settings := status.Saved
	settings.Hostname, settings.Mode = "relay.example.com", "standalone"
	if err := d.SaveSettings(t.Context(), settings); !errors.Is(err, control.ErrConflict) {
		t.Fatalf("ordinary settings mode change: %v", err)
	}
	cfg := d.activeConfig()
	cfg.Mode = config.ModeStandalone
	if err := d.applyLocalConfig(t.Context(), cfg); !errors.Is(err, control.ErrConflict) {
		t.Fatalf("reload mode change: %v", err)
	}
	if err := config.WriteAtomic(d.configPath, cfg); err != nil {
		t.Fatal(err)
	}
	if response := d.reloadConfig(t.Context()); response.OK {
		t.Fatal("CLI config reload bypassed mode switching")
	}
	if d.activeConfig().EffectiveMode() != config.ModeController {
		t.Fatal("failed reload changed active mode")
	}
}

func TestModeBootstrapStandaloneUsesControllerRole(t *testing.T) {
	d := localTestDaemon(t, true)
	status, _ := d.Status(t.Context())
	settings := status.Saved
	settings.Role, settings.Mode, settings.Hostname = "controller", "standalone", "relay.example.com"
	if err := d.SaveSettings(t.Context(), settings); err != nil {
		t.Fatal(err)
	}
	cfg := d.desiredConfig()
	if cfg.EffectiveMode() != config.ModeStandalone || !cfg.Controller.Enabled {
		t.Fatal("standalone did not select controller role")
	}
	if d.Role() != "setup" {
		t.Fatal("saved mode became active before apply")
	}
}
