package control

import (
	"net/http"
	"strings"
	"testing"
)

func TestStandaloneDisabledOperationsServerSide(t *testing.T) {
	s, _, admin, builtin := standaloneTestStore(t)
	if err := s.ConfigureInstanceMode(t.Context(), "controller", admin.ID, builtin.Domain, builtin.ID); err != nil {
		t.Fatal(err)
	}
	remote, _, err := s.CreateNode(t.Context(), admin, "Remote", "remote.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetNodeEnabled(t.Context(), admin, remote.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureInstanceMode(t.Context(), "standalone", admin.ID, builtin.Domain, builtin.ID); err != nil {
		t.Fatal(err)
	}
	h := NewLocalHTTPHandler(s, &localTestBackend{role: "controller", mode: "standalone"})
	cookie, csrf := loginTest(t, h, "admin")
	for _, path := range []string{"/api/v1/nodes", "/api/v1/nodes/" + remote.ID + "/enrollment", "/api/v1/nodes/" + remote.ID + "/enabled"} {
		body := map[string]any{}
		if path == "/api/v1/nodes" {
			body = map[string]any{"display_name": "New remote", "domain": "new.example.com", "derp_port": 443, "stun_port": 3478}
		}
		if strings.HasSuffix(path, "/enabled") {
			body = map[string]any{"enabled": true}
		}
		w := accountRequest(h, cookie, csrf, http.MethodPost, path, body)
		if w.Code != 403 || !strings.Contains(w.Body.String(), `"code":"standalone_disabled"`) {
			t.Fatal("standalone operation not enforced server-side", path, w.Code, w.Body.String())
		}
	}
}
