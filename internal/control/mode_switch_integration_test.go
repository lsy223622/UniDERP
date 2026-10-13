package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/derper"
	"tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/net/netmon"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func TestModeRevocationOnPatchedRelays(t *testing.T) {
	binary := os.Getenv("UNIDERP_TEST_DERPER")
	if binary == "" {
		t.Skip("requires freshly built patched derper")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	s, stub, admin := credentialTestStore(t)
	s.now = time.Now
	a, b := key.NewNode(), key.NewNode()
	stub.body = fmt.Sprintf(`{"devices":[{"nodeKey":%q,"authorized":true,"isExternal":false,"keyExpiryDisabled":true,"expires":""},{"nodeKey":%q,"authorized":true,"isExternal":false,"keyExpiryDisabled":true,"expires":""}]}`, a.Public().String(), b.Public().String())
	if err := s.ConfigureNodes(nil); err != nil {
		t.Fatal(err)
	}
	s.verifyDomain = func(context.Context, cluster.NodeChallenge) error { return nil }
	tailnet, err := s.AddTailnet(ctx, admin, "Integration", "TmodeIntegration", OAuthCredential{"id", "secret"})
	if err != nil {
		t.Fatal(err)
	}
	controller := httptest.NewTLSServer(NewHTTPHandler(s))
	defer controller.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = controller.Client().Transport
	defer func() { http.DefaultTransport = previous }()
	type member struct {
		node        Node
		client      *cluster.EnrollmentClient
		process     *derper.Process
		address     string
		stop        context.CancelFunc
		done        chan error
		connections [2]*derphttp.Client
	}
	var members [2]*member
	startControl := func(m *member) {
		controlCtx, stop := context.WithCancel(ctx)
		m.stop, m.done = stop, make(chan error, 1)
		done := m.done
		go func() {
			done <- m.client.RunControl(controlCtx, m.process.Policy.Path, m.process.Policy.ApplyPolicy, m.process.Policy.Status)
			close(done)
		}()
	}
	wait := func(label string, ready func() bool) {
		t.Helper()
		for !ready() {
			select {
			case <-ctx.Done():
				t.Fatal(label, ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	for i := range members {
		dir, err := os.MkdirTemp("", "ud-mode-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address, port := listener.Addr().String(), listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		udp, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		stunAddress := udp.LocalAddr().String()
		udp.Close()
		node, code, err := s.CreateNode(ctx, admin, fmt.Sprintf("Relay %d", i), fmt.Sprintf("mode-%d.example.com", i), port, 3478)
		if err != nil {
			t.Fatal(err)
		}
		client, err := cluster.NewEnrollmentClient(controller.URL, dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Enroll(ctx, code.Code); err != nil {
			t.Fatal(err)
		}
		if _, err := s.RequestGrant(ctx, admin, node.ID, tailnet.ID, 0, time.Time{}); err != nil {
			t.Fatal(err)
		}
		server := config.Default().Server
		server.Hostname, server.DERP.TLSMode, server.DERP.CertMode = node.Domain, "external", "none"
		server.DERP.Listen, server.DERP.STUNListen = address, stunAddress
		process := derper.NewProcess(binary, io.Discard)
		process.Policy = derper.PolicyClient{Path: filepath.Join(dir, "policy.json"), SocketPath: filepath.Join(dir, "policy.sock")}
		if err := process.Start(ctx, server, "127.0.0.1:9", filepath.Join(dir, "derper.key")); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			stopCtx, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			process.Stop(stopCtx)
		})
		if err := process.WaitReady(ctx, server); err != nil {
			t.Fatal(err)
		}
		m := &member{node: node, client: client, process: process, address: address}
		members[i] = m
		startControl(m)
		t.Cleanup(func() { m.stop(); <-m.done })
		wait("initial real policy application", func() bool { return client.ControlStatus().Usable })
		for j, identity := range []key.NodePrivate{a, b} {
			c, err := derphttp.NewClient(identity, "http://"+address+"/derp", logger.Discard, netmon.NewStatic())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { c.Close() })
			m.connections[j] = c
			if err := c.Connect(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := c.Recv(); err != nil {
				t.Fatal(err)
			}
		}
		if err := m.connections[0].Send(b.Public(), []byte("before mode switch")); err != nil {
			t.Fatal(err)
		}
		for {
			message, err := m.connections[1].Recv()
			if err != nil {
				t.Fatal(err)
			}
			if packet, ok := message.(derp.ReceivedPacket); ok {
				if string(packet.Data) != "before mode switch" {
					t.Fatal("relay payload mismatch")
				}
				break
			}
		}
	}
	mapBefore, err := s.BuildDERPMap(ctx, admin, tailnet.ID)
	if err != nil || len(mapBefore.Regions) != 2 {
		t.Fatal("active relays missing from DERP map", err, mapBefore)
	}
	// Disconnect only the control channel; the offline relay retains its old cache.
	offline := members[1]
	offline.stop()
	<-offline.done
	if _, err := s.db.Exec("UPDATE node_permission_history SET expiry_known=0 WHERE node_id=?", offline.node.ID); err != nil {
		t.Fatal(err)
	}
	op := beginModeRevocation(t, s, admin, "")
	wait("online relay revocation ACK", func() bool {
		status, err := s.ModeSwitch(ctx, admin)
		if err != nil {
			t.Fatal(err)
		}
		for _, node := range status.Nodes {
			if node.NodeID == members[0].node.ID {
				return node.State == "applied"
			}
		}
		return false
	})
	status, err := s.ModeSwitch(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range status.Nodes {
		if node.NodeID == offline.node.ID && (node.ExpiryKnown || node.State != "waiting") {
			t.Fatal("unknown offline relay counted as revoked", node)
		}
	}
	if err := s.FinishModeSwitch(ctx, admin, op.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("mode completed before offline relay applied revocation", err)
	}
	assertDenied := func(m *member) {
		t.Helper()
		closed := make(chan error, 1)
		go func() {
			for {
				if _, err := m.connections[1].Recv(); err != nil {
					closed <- err
					return
				}
			}
		}()
		select {
		case <-closed:
		case <-ctx.Done():
			t.Fatal("old DERP connection survived applied revocation")
		}
		fresh, err := derphttp.NewClient(a, "http://"+m.address+"/derp", logger.Discard, netmon.NewStatic())
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		if err := fresh.Connect(ctx); err != nil {
			return
		}
		rejected := make(chan error, 1)
		go func() { _, err := fresh.Recv(); rejected <- err }()
		select {
		case err := <-rejected:
			if err == nil {
				t.Fatal("new DERP client authenticated after revocation")
			}
		case <-ctx.Done():
			t.Fatal("new DERP connection was not rejected")
		}
	}
	assertDenied(members[0])
	startControl(offline)
	wait("offline relay reconnect and applied empty policy", func() bool {
		status, err := s.ModeSwitch(ctx, admin)
		if err != nil {
			t.Fatal(err)
		}
		for _, node := range status.Nodes {
			if node.State != "applied" {
				return false
			}
		}
		return true
	})
	assertDenied(offline)
	if err := s.FinishModeSwitch(ctx, admin, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteModeSwitch(ctx, admin, op.ID); err != nil {
		t.Fatal(err)
	}
	mapAfter, err := s.BuildDERPMap(ctx, admin, tailnet.ID)
	if err != nil || len(mapAfter.Regions) != 0 {
		t.Fatal("revoked relays remained in DERP map", err, mapAfter)
	}
}
