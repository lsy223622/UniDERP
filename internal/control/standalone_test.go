package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"testing"

	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"tailscale.com/types/key"
)

func standaloneTestStore(t *testing.T) (*Store, *identityAPIStub, Actor, Node) {
	t.Helper()
	s, stub, admin := credentialTestStore(t)
	stub.body = `{"devices":[` + identityFixture(key.NewNode().Public()) + `]}`
	if err := s.ConfigureNodes(nil); err != nil {
		t.Fatal(err)
	}
	s.verifyDomain = func(context.Context, cluster.NodeChallenge) error { return nil }
	node, code, err := s.CreateNode(t.Context(), admin, "Local", "relay.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := s.EnrollmentChallenge(t.Context(), code.Code, pub, "standalone-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnrollNode(t.Context(), cluster.EnrollmentRequest{Code: code.Code, Challenge: challenge, Signature: ed25519.Sign(private, challenge.SigningBytes())}); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureInstanceMode(t.Context(), "standalone", admin.ID, node.Domain, node.ID); err != nil {
		t.Fatal(err)
	}
	return s, stub, admin, node
}

func TestStandaloneRegisterAndGrantOnce(t *testing.T) {
	s, _, admin, node := standaloneTestStore(t)
	tailnet, err := s.AddTailnet(t.Context(), admin, "Own", "Tstandalone", OAuthCredential{"id", "secret"})
	if err != nil || tailnet.LocalGrant == nil || tailnet.LocalGrant.State != "active" {
		t.Fatal("new own Tailnet not automatically authorized", err, tailnet)
	}
	if _, err := s.RetryStandaloneGrant(t.Context(), admin, tailnet.ID); err != nil {
		t.Fatal(err)
	}
	grants, err := s.ListGrants(t.Context(), admin)
	if err != nil || len(grants) != 1 || grants[0].State != "active" || grants[0].NodeID != node.ID {
		t.Fatal("retry created duplicate or remote grants", err, grants)
	}
}

func TestStandaloneOtherUserNoAutoGrant(t *testing.T) {
	s, _, admin, _ := standaloneTestStore(t)
	var other Actor
	if err := s.db.QueryRow("SELECT id,username,role,enabled FROM users WHERE username='alice'").Scan(&other.ID, &other.Username, &other.Role, &other.Enabled); err != nil {
		t.Fatal(err)
	}
	tailnet, err := s.AddTailnet(t.Context(), other, "Other", "Tother", OAuthCredential{"id", "secret"})
	if err != nil || (tailnet.LocalGrant != nil && tailnet.LocalGrant.State == "active") {
		t.Fatal("other owner automatically authorized", err)
	}
	grants, err := s.ListGrants(t.Context(), admin)
	if err != nil || len(grants) != 0 {
		t.Fatal("other owner received a grant", err, grants)
	}
	if _, err := s.RetryStandaloneGrant(t.Context(), other, tailnet.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("retry broadened standalone ownership", err)
	}
}

func TestStandaloneRevokedGrantStaysRevoked(t *testing.T) {
	s, _, admin, _ := standaloneTestStore(t)
	tailnet, err := s.AddTailnet(t.Context(), admin, "Own", "Trevoked", OAuthCredential{"id", "secret"})
	if err != nil {
		t.Fatal(err)
	}
	grants, err := s.ListGrants(t.Context(), admin)
	if err != nil || len(grants) != 1 {
		t.Fatal(err, grants)
	}
	if _, err := s.ApplyGrantAction(t.Context(), admin, grants[0].ID, grants[0].Revision, GrantRevoke); err != nil {
		t.Fatal(err)
	}
	if err := s.RefreshIdentity(t.Context(), tailnet.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryStandaloneGrant(t.Context(), admin, tailnet.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("completed action retried after revoke", err)
	}
	grants, err = s.ListGrants(t.Context(), admin)
	if err != nil || grants[0].State != "revoked" {
		t.Fatal("revoked grant revived", err, grants)
	}
}

func TestStandalonePartialRetry(t *testing.T) {
	s, stub, admin, node := standaloneTestStore(t)
	if err := s.ConfigureInstanceMode(t.Context(), "standalone", admin.ID, node.Domain, ""); err != nil {
		t.Fatal(err)
	}
	tailnet, err := s.AddTailnet(t.Context(), admin, "Own", "Tpartial", OAuthCredential{"id", "secret"})
	if err != nil || tailnet.LocalGrant == nil || tailnet.LocalGrant.State != "pending" {
		t.Fatal("Tailnet saved without truthful partial result", err, tailnet)
	}
	if err := s.ConfigureInstanceMode(t.Context(), "standalone", admin.ID, node.Domain, node.ID); err != nil {
		t.Fatal(err)
	}
	result, err := s.RetryStandaloneGrant(t.Context(), admin, tailnet.ID)
	if err != nil || result.State != "active" {
		t.Fatal("partial retry failed", err, result)
	}
	stub.mu.Lock()
	exchanges := len(stub.clientIDs)
	stub.mu.Unlock()
	if exchanges != 1 {
		t.Fatal("partial retry repeated OAuth validation", exchanges)
	}
	tailnets, err := s.ListTailnets(t.Context(), admin)
	if err != nil || len(tailnets) != 1 {
		t.Fatal("partial retry duplicated Tailnet", err, tailnets)
	}
}

func TestStandaloneFirstAdministratorGetsPendingOwnGrant(t *testing.T) {
	api, _, _ := credentialTestStore(t)
	s, err := OpenStore(filepath.Join(t.TempDir(), "standalone.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.EnableIdentity(filepath.Join(t.TempDir(), "controller.key")); err != nil {
		t.Fatal(err)
	}
	s.apiBase, s.apiClient = api.apiBase, api.apiClient
	if err := s.ConfigureInstanceMode(t.Context(), "standalone", "", "relay.example.com", ""); err != nil {
		t.Fatal(err)
	}
	admin, err := s.InitializeAdmin(t.Context(), "first-admin", "first-admin-password")
	if err != nil {
		t.Fatal(err)
	}
	tailnet, err := s.AddTailnet(t.Context(), admin, "First own", "Tfirstown", OAuthCredential{"id", "secret"})
	if err != nil || tailnet.LocalGrant == nil || tailnet.LocalGrant.State != "pending" {
		t.Fatal("first administrator treated as another node owner", err, tailnet)
	}
}
