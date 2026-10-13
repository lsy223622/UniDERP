package config

import "testing"

func TestModeLegacyConfig(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		cfg := Default()
		cfg.Controller.Enabled = enabled
		if !enabled {
			cfg.Controller = &ControllerConfig{Enabled: false}
		}
		want := ModeMember
		if enabled {
			want = ModeController
		}
		if cfg.EffectiveMode() != want {
			t.Fatalf("legacy enabled=%v: mode=%q", enabled, cfg.EffectiveMode())
		}
		cfg.Server.Hostname = "relay.example.com"
		if err := cfg.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestModeRoleConflict(t *testing.T) {
	for _, mode := range []RunMode{ModeStandalone, ModeController, ModeMember, "invalid"} {
		cfg := Default()
		cfg.Mode = mode
		cfg.Server.Hostname = "relay.example.com"
		cfg.Controller.Enabled = mode == ModeMember
		if err := cfg.Validate(); err == nil {
			t.Fatalf("conflicting mode %q accepted", mode)
		}
	}
	result, err := Parse([]byte("version: 2\nmode: standalone\ncontroller:\n  enabled: true\nserver:\n  hostname: relay.example.com\n"))
	if err != nil || result.Config.EffectiveMode() != ModeStandalone || len(result.Warnings) != 0 {
		t.Fatalf("explicit mode parse: %v, %#v", err, result)
	}
}
