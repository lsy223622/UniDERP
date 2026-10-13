package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type localTestBackend struct {
	mode        string
	frozen      bool
	role        string
	writes      int
	err         error
	certificate CertificateStatus
}

func (b *localTestBackend) Mode() string           { return b.mode }
func (b *localTestBackend) ModeSwitchFrozen() bool { return b.frozen }
func (b *localTestBackend) ModeSwitchStatus(context.Context, Actor) (ModeSwitchStatus, error) {
	return ModeSwitchStatus{ID: "test-switch", Stage: "revoking", Revision: 7, Nodes: []NodeRevocationProgress{}}, b.err
}
func (b *localTestBackend) SwitchMode(context.Context, Actor, string, string, uint64) (ModeSwitchStatus, error) {
	b.writes++
	return ModeSwitchStatus{ID: "test-switch", Stage: "preparing", Revision: 1}, b.err
}
func (b *localTestBackend) CancelModeSwitch(context.Context, Actor, string, uint64) error {
	b.writes++
	return b.err
}

func (b *localTestBackend) Role() string { return b.role }
func (b *localTestBackend) Status(context.Context) (LocalStatus, error) {
	return LocalStatus{Role: b.role, Certificate: b.certificate}, nil
}
func (b *localTestBackend) SaveSettings(context.Context, LocalSettings) error {
	b.writes++
	return b.err
}
func (b *localTestBackend) ApplySettings(context.Context) error { b.writes++; return nil }
func (b *localTestBackend) UploadCertificate(context.Context, string, string) error {
	b.writes++
	return nil
}
func (b *localTestBackend) Join(context.Context, string, string) error { b.writes++; return nil }
func (b *localTestBackend) Leave(context.Context) (bool, error)        { b.writes++; return true, nil }
func (b *localTestBackend) RegisterLocal(context.Context, Actor, string) (Node, error) {
	b.writes++
	return Node{}, nil
}

func TestLocalSettingsInputErrorResponseDoesNotExposeSecrets(t *testing.T) {
	s, _, _ := nodeTestStore(t)
	h := NewLocalHTTPHandler(s, &localTestBackend{role: "controller", err: &InputError{Code: "invalid_hostname", Field: "hostname"}})
	cookie, csrf := loginTest(t, h, "admin")
	w := accountRequest(h, cookie, csrf, "POST", "/api/v1/local/settings", LocalSettings{Hostname: "https://secret.example.com/"})
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_hostname"`) || !strings.Contains(w.Body.String(), `"field":"hostname"`) || strings.Contains(w.Body.String(), "secret.example") {
		t.Fatalf("unsafe or missing field response: %d %s", w.Code, w.Body)
	}
}

func TestLocalCertificateStatusContainsNoSecrets(t *testing.T) {
	s, _, _ := nodeTestStore(t)
	h := NewLocalHTTPHandler(s, &localTestBackend{role: "controller", certificate: CertificateStatus{State: "ready", Hostname: "relay.example.com"}})
	cookie, csrf := loginTest(t, h, "admin")
	member, _ := loginTest(t, h, "alice")
	anonymous := httptest.NewRecorder()
	h.ServeHTTP(anonymous, httptest.NewRequest("GET", "https://controller.example.com/api/v1/local/status", nil))
	if w := anonymous; w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := accountRequest(h, member, "", "GET", "/api/v1/local/status", nil); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := accountRequest(h, cookie, csrf, "GET", "/api/v1/local/status", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"ready"`) {
		t.Fatal(w.Code, w.Body)
	}
	for _, secret := range []string{"PRIVATE KEY", "BEGIN CERTIFICATE", "private_key", "cert_dir"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("secret in certificate status")
		}
	}
}

func TestModeSwitchHTTPPermissionsAndCSRF(t *testing.T) {
	s, _, _ := nodeTestStore(t)
	backend := &localTestBackend{role: "controller", mode: "controller"}
	h := NewLocalHTTPHandler(s, backend)
	admin, csrf := loginTest(t, h, "admin")
	member, memberCSRF := loginTest(t, h, "alice")
	for _, method := range []string{"GET", "POST"} {
		w := accountRequest(h, member, memberCSRF, method, "/api/v1/local/mode-switch", map[string]any{"target_mode": "member", "expected_revision": 0})
		if w.Code != 403 {
			t.Fatal("ordinary member can change local mode", method, w.Code)
		}
	}
	body := map[string]any{"target_mode": "member", "expected_revision": 0}
	if w := accountRequest(h, admin, "", "POST", "/api/v1/local/mode-switch", body); w.Code != 403 || backend.writes != 0 {
		t.Fatal("mode switch bypassed CSRF", w.Code, backend.writes)
	}
	if w := accountRequest(h, admin, csrf, "GET", "/api/v1/local/mode-switch", nil); w.Code != 200 {
		t.Fatal("administrator cannot inspect switch progress", w.Code, w.Body.String())
	}
	if w := accountRequest(h, admin, csrf, "POST", "/api/v1/local/mode-switch", body); w.Code != 200 || backend.writes != 1 {
		t.Fatal("administrator switch did not use local coordinator", w.Code, backend.writes)
	}
	if w := accountRequest(h, admin, csrf, "POST", "/api/v1/local/mode-switch/test-switch/cancel", map[string]int{"expected_revision": 7}); w.Code != 200 || backend.writes != 2 {
		t.Fatal("administrator cannot cancel revocation", w.Code, backend.writes)
	}
}

func TestModeSwitchHTTPFreezesFreshStoreMutations(t *testing.T) {
	s, _, _ := nodeTestStore(t)
	backend := &localTestBackend{role: "controller", frozen: true}
	h := NewLocalHTTPHandler(s, backend)
	admin, csrf := loginTest(t, h, "admin")
	for _, path := range []string{"/api/v1/users", "/api/v1/nodes", "/api/v1/local/settings", "/api/v1/local/register"} {
		w := accountRequest(h, admin, csrf, "POST", path, map[string]string{})
		if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"mode_switch_in_progress"`) || backend.writes != 0 {
			t.Fatal("instance freeze absent on switched Store", path, w.Code, w.Body.String())
		}
	}
	if w := accountRequest(h, admin, csrf, "GET", "/api/v1/local/status", nil); w.Code != 200 {
		t.Fatal("freeze prevented management status", w.Code)
	}
}

func TestLocalManagementRequiresLocalAdminAndCSRF(t *testing.T) {
	s, _, _ := nodeTestStore(t)
	b := &localTestBackend{role: "controller"}
	h := NewLocalHTTPHandler(s, b)
	adminCookie, adminCSRF := loginTest(t, h, "admin")
	memberCookie, memberCSRF := loginTest(t, h, "alice")
	path := "/api/v1/local/apply"
	anonymous := httptest.NewRecorder()
	h.ServeHTTP(anonymous, httptest.NewRequest("POST", "https://controller.example.com"+path, nil))
	if anonymous.Code != 401 {
		t.Fatal(anonymous.Code)
	}
	for _, tc := range []struct {
		cookie *http.Cookie
		csrf   string
		want   int
	}{
		{memberCookie, memberCSRF, 403}, {adminCookie, "", 403},
	} {
		if w := accountRequest(h, tc.cookie, tc.csrf, "POST", path, nil); w.Code != tc.want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	other, _, _ := nodeTestStore(t)
	foreignCookie, foreignCSRF := loginTest(t, NewHTTPHandler(other), "admin")
	if w := accountRequest(h, foreignCookie, foreignCSRF, "POST", path, nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("POST", "https://controller.example.com"+path, strings.NewReader("{}"))
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || b.writes != 0 {
		t.Fatal("local boundary bypassed", w.Code, b.writes)
	}
	if w := accountRequest(h, adminCookie, adminCSRF, "POST", path, nil); w.Code != 200 || b.writes != 1 {
		t.Fatal(w.Code, b.writes)
	}
}

func TestMemberManagementDoesNotExposeControllerAPIs(t *testing.T) {
	s, admin, _ := nodeTestStore(t)
	h := NewLocalHTTPHandler(s, &localTestBackend{role: "member"})
	cookie, csrf := loginTest(t, h, "admin")
	for _, path := range []string{"/api/v1/tailnets", "/api/v1/grants", "/api/v1/users", "/api/v1/nodes", "/cluster/v1/control"} {
		if w := accountRequest(h, cookie, csrf, "GET", path, nil); w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	for _, path := range []string{"/api/v1/session", "/api/v1/local/status", "/manage/"} {
		if w := accountRequest(h, cookie, csrf, "GET", path, nil); w.Code != 200 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	w := accountRequest(h, cookie, csrf, "POST", "/api/v1/users/"+admin.ID+"/password", map[string]string{"password": "new independent administrator password"})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
