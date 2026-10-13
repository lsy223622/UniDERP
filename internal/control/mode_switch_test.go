package control

import (
	"errors"
	"testing"
	"time"

	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"tailscale.com/types/key"
)

func modeRevocationFixture(t *testing.T) (*Store, Actor, Node, cluster.NodeSession, string, cluster.Policy) {
	t.Helper()
	s, admin, _, node, _, session := registeredTestNode(t)
	now := time.Now().UTC().Truncate(time.Second).Add(time.Second)
	s.now = func() time.Time { return now }
	if err := s.SetRetentions(t.Context(), admin, Retentions{IdentitySeconds: 3600, ControlSeconds: 3600}); err != nil {
		t.Fatal(err)
	}
	tailnet := randomToken()
	policyTailnet(t, s, admin.ID, tailnet, []identityKey{{NodePublic: key.NewNode().Public().String()}}, now)
	if _, err := s.RequestGrant(t.Context(), admin, node.ID, tailnet, 0, time.Time{}); err != nil {
		t.Fatal(err)
	}
	policy, err := s.BuildPolicy(t.Context(), node.ID, now)
	if err != nil || len(policy.Grants) != 1 {
		t.Fatal("fixture grant missing", err)
	}
	return s, admin, node, session, tailnet, policy
}

func beginModeRevocation(t *testing.T, s *Store, admin Actor, builtin string) ModeSwitchStatus {
	t.Helper()
	status, err := s.BeginModeSwitch(t.Context(), admin, ModeSwitchRequest{ID: randomToken(), From: "controller", Target: "standalone", BuiltinNodeID: builtin})
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func TestModeRevocationExcludesBuiltin(t *testing.T) {
	s, admin, builtin, _, tailnet, _ := modeRevocationFixture(t)
	remote, _, err := s.CreateNode(t.Context(), admin, "Remote", "remote.example.com", 443, 3478)
	if err != nil {
		t.Fatal(err)
	}
	status := beginModeRevocation(t, s, admin, builtin.ID)
	if len(status.Nodes) != 1 || status.Nodes[0].NodeID != remote.ID {
		t.Fatal("local node included in remote revocation", status)
	}
	var state string
	s.db.QueryRow("SELECT state FROM grants WHERE node_id=? AND tailnet_id=?", builtin.ID, tailnet).Scan(&state)
	if state != "active" {
		t.Fatal("local permission revoked")
	}
}

func TestModeRevocationNeedsApplied(t *testing.T) {
	s, admin, node, session, _, old := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, "")
	revision := status.Nodes[0].RevokeRevision
	if _, err := s.AuthenticateNode(t.Context(), session.Token); err != nil {
		t.Fatal("ACK channel was cut before apply", err)
	}
	for _, ack := range []cluster.PolicyACK{{Revision: old.Revision, State: "received"}, {Revision: old.Revision, State: "applied", Usable: true}, {Revision: revision, State: "received"}, {Revision: revision, State: "nack", Error: "apply_failed"}} {
		if err := s.AcknowledgePolicy(t.Context(), session.Token, ack); err != nil {
			t.Fatal(err)
		}
		progress, err := s.ModeSwitch(t.Context(), admin)
		if err != nil {
			t.Fatal(err)
		}
		if progress.Nodes[0].State == "applied" || progress.Nodes[0].State == "expired" {
			t.Fatal("received/old ACK/NACK completed revocation")
		}
	}
	if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: revision, State: "applied", Usable: false}); err != nil {
		t.Fatal(err)
	}
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "applied" {
		t.Fatal("applied empty policy not recognized", err, progress)
	}
	if err := s.FinishModeSwitch(t.Context(), admin, status.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AuthenticateNode(t.Context(), session.Token); err == nil {
		t.Fatal("old control session survived completed revocation")
	}
	if _, err := s.SessionChallenge(t.Context(), node.ID, "original"); err == nil {
		t.Fatal("old registration survived completion")
	}
}

func TestModeOfflineUnknownBlocks(t *testing.T) {
	s, admin, node, _, _, _ := modeRevocationFixture(t)
	if _, err := s.db.Exec("UPDATE node_permission_history SET expiry_known=0 WHERE node_id=?", node.ID); err != nil {
		t.Fatal(err)
	}
	status := beginModeRevocation(t, s, admin, "")
	if status.Nodes[0].ExpiryKnown || !status.Nodes[0].EffectiveUntil.IsZero() {
		t.Fatal("unknown historical deadline was guessed")
	}
	future := s.now().Add(30 * 24 * time.Hour)
	s.now = func() time.Time { return future }
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "waiting" {
		t.Fatal("unknown offline node completed", err, progress)
	}
	if err := s.FinishModeSwitch(t.Context(), admin, status.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("unfinished unknown revocation completed", err)
	}
}

func TestModeHistoricalExpiryCannotUseLatestOnly(t *testing.T) {
	s, admin, node, _, _, old := modeRevocationFixture(t)
	historical := cluster.EffectiveUntil(old.Grants[0], old.Grants[0].Keys[0])
	if err := s.SetRetentions(t.Context(), admin, Retentions{IdentitySeconds: 10, ControlSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	latest, err := s.currentPolicy(t.Context(), node.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !cluster.EffectiveUntil(latest.Grants[0], latest.Grants[0].Keys[0]).Before(historical) {
		t.Fatal("fixture did not shorten latest policy")
	}
	status := beginModeRevocation(t, s, admin, "")
	if !status.Nodes[0].EffectiveUntil.Equal(historical) {
		t.Fatal("historical deadline lost", status)
	}
	shorterExpiry := s.now().Add(time.Minute)
	s.now = func() time.Time { return shorterExpiry }
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "waiting" {
		t.Fatal("latest-only expiration used", err, progress)
	}
}

func TestModeExpiryProvenBound(t *testing.T) {
	s, admin, _, session, _, old := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, "")
	until := cluster.EffectiveUntil(old.Grants[0], old.Grants[0].Keys[0])
	before := until.Add(-time.Second)
	s.now = func() time.Time { return before }
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "waiting" {
		t.Fatal("expiry before actual bound", err)
	}
	s.now = func() time.Time { return until }
	progress, err = s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "expired" {
		t.Fatal("proven expiry not completed", err, progress)
	}
	s.db.Exec("UPDATE node_sessions SET expires_at=?", until.Add(time.Hour).Unix())
	if err := s.FinishModeSwitch(t.Context(), admin, status.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AuthenticateNode(t.Context(), session.Token); err == nil {
		t.Fatal("expired relationship could renew")
	}
}

func TestModeRevocationFreezesRenewal(t *testing.T) {
	s, admin, builtin, session, tailnet, _ := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, builtin.ID)
	var before int64
	s.db.QueryRow("SELECT last_control_success FROM grants WHERE node_id=?", builtin.ID).Scan(&before)
	later := s.now().Add(time.Minute)
	s.now = func() time.Time { return later }
	if _, err := s.NodeHeartbeat(t.Context(), session.Token, nil); err != nil {
		t.Fatal("control channel frozen", err)
	}
	var after int64
	s.db.QueryRow("SELECT last_control_success FROM grants WHERE node_id=?", builtin.ID).Scan(&after)
	if after != before {
		t.Fatal("grant deadline renewed while switching")
	}
	if err := s.SetRetentions(t.Context(), admin, Retentions{IdentitySeconds: 1, ControlSeconds: 1}); !errors.Is(err, ErrModeSwitch) {
		t.Fatal("retention mutated during switch", err)
	}
	if err := s.RefreshIdentity(t.Context(), tailnet); !errors.Is(err, ErrModeSwitch) {
		t.Fatal("identity synchronization not frozen", err)
	}
	if _, _, err := s.CreateNode(t.Context(), admin, "Remote", "frozen.example.com", 443, 3478); !errors.Is(err, ErrModeSwitch) {
		t.Fatal("registration not frozen", err)
	}
	if err := s.CancelModeSwitch(t.Context(), admin, status.ID, status.Revision); err != nil {
		t.Fatal(err)
	}
}

func TestModeRevocationCancelKeepsGrantsRevoked(t *testing.T) {
	s, admin, node, session, _, _ := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, "")
	if err := s.CancelModeSwitch(t.Context(), admin, status.ID, status.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := s.NodeHeartbeat(t.Context(), session.Token, nil); err != nil {
		t.Fatal(err)
	}
	policy, err := s.currentPolicy(t.Context(), node.ID)
	if err != nil || len(policy.Grants) != 0 {
		t.Fatal("cancel restored grants", err)
	}
	var state string
	s.db.QueryRow("SELECT state FROM grants WHERE node_id=?", node.ID).Scan(&state)
	if state != "revoked" {
		t.Fatal("revocation rolled back")
	}
}

func TestModeHistoricalExpirySurvivesNodeDeletion(t *testing.T) {
	s, admin, node, _, _, old := modeRevocationFixture(t)
	if err := s.SetNodeEnabled(t.Context(), admin, node.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteNode(t.Context(), admin, node.ID); err != nil {
		t.Fatal(err)
	}
	status := beginModeRevocation(t, s, admin, "")
	if len(status.Nodes) != 1 || status.Nodes[0].NodeID != node.ID || status.Nodes[0].State != "waiting" {
		t.Fatal("removed node lost outstanding authority evidence", status)
	}
	until := cluster.EffectiveUntil(old.Grants[0], old.Grants[0].Keys[0])
	s.now = func() time.Time { return until }
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "expired" {
		t.Fatal("removed node proven expiry failed", err)
	}
}

func TestModeRevocationExistingAppliedEmptyPolicyCompletes(t *testing.T) {
	s, admin, node, session, _, _ := modeRevocationFixture(t)
	if err := s.SetNodeEnabled(t.Context(), admin, node.ID, false); err != nil {
		t.Fatal(err)
	}
	empty, err := s.currentPolicy(t.Context(), node.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"received", "applied"} {
		if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: empty.Revision, State: state}); err != nil {
			t.Fatal(err)
		}
	}
	status := beginModeRevocation(t, s, admin, "")
	if status.Nodes[0].State == "waiting" || status.Nodes[0].State == "failed" {
		t.Fatal("already applied empty policy still waits")
	}
}

func TestModeRevocationUsableACKDoesNotComplete(t *testing.T) {
	s, admin, _, session, _, _ := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, "")
	revision := status.Nodes[0].RevokeRevision
	if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: revision, State: "received"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: revision, State: "applied", Usable: true}); !errors.Is(err, ErrInvalid) {
		t.Fatal("contradictory usable empty-policy ACK accepted", err)
	}
}

func TestModeOfflineMigratedHistoryIsUnknown(t *testing.T) {
	s, admin, _, _, _, _ := modeRevocationFixture(t)
	if _, err := s.db.Exec("DROP TABLE node_permission_history; DROP TABLE mode_operations; PRAGMA user_version=7;"); err != nil {
		t.Fatal(err)
	}
	if err := s.migrate(); err != nil {
		t.Fatal(err)
	}
	status := beginModeRevocation(t, s, admin, "")
	if len(status.Nodes) != 1 || status.Nodes[0].ExpiryKnown || !status.Nodes[0].EffectiveUntil.IsZero() {
		t.Fatal("migration invented historical expiry proof", status)
	}
}

func TestModeRevocationKeepsSessionChallengesAndACKChannel(t *testing.T) {
	s, admin, node, session, _, _ := modeRevocationFixture(t)
	challenge, err := s.SessionChallenge(t.Context(), node.ID, "original")
	if err != nil {
		t.Fatal(err)
	}
	beginModeRevocation(t, s, admin, "")
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM node_challenges WHERE nonce_hash=?", tokenHash(challenge.Nonce)).Scan(&count); err != nil || count != 1 {
		t.Fatal("existing session proof was discarded", err)
	}
	if err := s.ReleaseNode(t.Context(), session.Token); !errors.Is(err, ErrModeSwitch) {
		t.Fatal("leave cut ACK channel during revocation", err)
	}
	if _, err := s.AuthenticateNode(t.Context(), session.Token); err != nil {
		t.Fatal("ACK session no longer valid", err)
	}
}

func TestModeExpiryFractionalKeyDeadline(t *testing.T) {
	s, admin, _, node, _, _ := registeredTestNode(t)
	now := time.Now().UTC().Truncate(time.Second).Add(time.Second)
	s.now = func() time.Time { return now }
	until := now.Add(10*time.Second + 900*time.Millisecond)
	tailnet := randomToken()
	policyTailnet(t, s, admin.ID, tailnet, []identityKey{{NodePublic: key.NewNode().Public().String(), NotAfter: until}}, now)
	if _, err := s.RequestGrant(t.Context(), admin, node.ID, tailnet, 0, time.Time{}); err != nil {
		t.Fatal(err)
	}
	status := beginModeRevocation(t, s, admin, "")
	if status.Nodes[0].EffectiveUntil.Before(until) {
		t.Fatal("historical bound precedes issued key deadline", status.Nodes[0].EffectiveUntil, until)
	}
	now = until.Truncate(time.Second)
	progress, err := s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "waiting" {
		t.Fatal("fractional key permission expired early", err, progress)
	}
	now = until.Truncate(time.Second).Add(time.Second)
	progress, err = s.ModeSwitch(t.Context(), admin)
	if err != nil || progress.Nodes[0].State != "expired" {
		t.Fatal("proven fractional deadline did not expire", err, progress)
	}
}

func TestModeRevocationFinishKeepsActivationFrozen(t *testing.T) {
	s, admin, _, session, _, _ := modeRevocationFixture(t)
	status := beginModeRevocation(t, s, admin, "")
	if err := s.CompleteModeSwitch(t.Context(), admin, status.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("unfinished revocation completed", err)
	}
	if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: status.Nodes[0].RevokeRevision, State: "received"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AcknowledgePolicy(t.Context(), session.Token, cluster.PolicyACK{Revision: status.Nodes[0].RevokeRevision, State: "applied"}); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishModeSwitch(t.Context(), admin, status.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateNode(t.Context(), admin, "New", "new.example.com", 443, 3478); !errors.Is(err, ErrModeSwitch) {
		t.Fatal("authorization unfrozen before instance activation", err)
	}
	if err := s.CompleteModeSwitch(t.Context(), admin, status.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateNode(t.Context(), admin, "New", "new.example.com", 443, 3478); err != nil {
		t.Fatal("completed instance remains frozen", err)
	}
}
