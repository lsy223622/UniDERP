package control

import (
	"bytes"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestModePreserveSelectedAdminOnly(t *testing.T) {
	s, _, admin, member := accountTestServer(t)
	token, _, err := s.login(t.Context(), "admin", testPassword)
	if err != nil {
		t.Fatal(err)
	}
	var original []byte
	if err := s.db.QueryRow("SELECT password_hash FROM users WHERE id=?", admin.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "local.sqlite")
	if err := s.PreserveLocalAdmin(t.Context(), admin.ID, path); err != nil {
		t.Fatal(err)
	}
	local, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	var count int
	var preserved []byte
	local.db.QueryRow("SELECT count(*) FROM users").Scan(&count)
	local.db.QueryRow("SELECT password_hash FROM users WHERE id=?", admin.ID).Scan(&preserved)
	if count != 1 || !bytes.Equal(original, preserved) {
		t.Fatal("selected admin hash/identity not preserved")
	}
	if _, err := local.Authenticate(t.Context(), token); err == nil {
		t.Fatal("old session copied")
	}
	if _, _, err := local.login(t.Context(), member.Username, testPassword); err == nil {
		t.Fatal("platform member gained local login")
	}
	newToken, _, err := local.login(t.Context(), admin.Username, testPassword)
	if err != nil {
		t.Fatal("preserved admin cannot log in", err)
	}
	actor, err := local.Authenticate(t.Context(), newToken)
	if err != nil || actor.ID != admin.ID {
		t.Fatal("admin identity changed", err)
	}
}

func TestModeArchiveSnapshotIncludesCommittedWAL(t *testing.T) {
	s, _, admin, _ := accountTestServer(t)
	if _, err := s.db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(t.Context(), admin, "snapshot-member", testPassword, "member"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "snapshot.sqlite")
	if err := s.Snapshot(t.Context(), path); err != nil {
		t.Fatal(err)
	}
	snapshot, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	if _, _, err := snapshot.login(t.Context(), "snapshot-member", testPassword); err != nil {
		t.Fatal("committed WAL data missing", err)
	}
	before, _ := os.ReadFile(path)
	if err := s.Snapshot(t.Context(), path); err == nil {
		t.Fatal("snapshot overwrote an existing archive")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("failed snapshot changed existing archive")
	}
}

func TestModePreserveRejectsUnownedDestination(t *testing.T) {
	s, _, admin, _ := accountTestServer(t)
	path := filepath.Join(t.TempDir(), "local.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, _ := os.ReadFile(path)
	if err := s.PreserveLocalAdmin(t.Context(), admin.ID, path); err == nil {
		t.Fatal("unowned database overwritten")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected destination was modified")
	}
}
