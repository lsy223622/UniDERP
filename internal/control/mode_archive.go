package control

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
)

func (s *Store) LocalAdministrator(ctx context.Context) (Actor, error) {
	var actor Actor
	err := s.db.QueryRowContext(ctx, "SELECT id,username,role,enabled FROM users WHERE role='admin' AND enabled=1").Scan(&actor.ID, &actor.Username, &actor.Role, &actor.Enabled)
	return actor, err
}

func (s *Store) AdoptModeAdministrator(ctx context.Context, source *Store, actorID string) error {
	var username string
	var hash []byte
	if err := source.db.QueryRowContext(ctx, "SELECT username,password_hash FROM users WHERE id=? AND role='admin' AND enabled=1", actorID).Scan(&username, &hash); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE users SET username=?,password_hash=?,enabled=1,session_version=session_version+1 WHERE id=? AND role='admin'", username, hash, actorID)
	if err != nil {
		return conflictError(err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ValidateLocalAdminDestination(ctx context.Context, destination string) error {
	abs, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if abs == s.path {
		return ErrConflict
	}
	if destinationInfo, err := os.Stat(abs); err == nil {
		if sourceInfo, err := os.Stat(s.path); err == nil && os.SameFile(sourceInfo, destinationInfo) {
			return ErrConflict
		}
		db, err := openSnapshot(abs)
		if err != nil {
			return ErrConflict
		}
		var owner string
		err = db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='local_admin_id'").Scan(&owner)
		db.Close()
		if err != nil || owner == "" {
			return ErrConflict
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *Store) PreserveLocalAdmin(ctx context.Context, actorID, destination string) error {
	if err := s.ValidateLocalAdminDestination(ctx, destination); err != nil {
		return err
	}
	abs, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	var username string
	var hash []byte
	var version int64
	if err := s.db.QueryRowContext(ctx, "SELECT username,password_hash,session_version FROM users WHERE id=? AND role='admin' AND enabled=1", actorID).Scan(&username, &hash, &version); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(abs), ".local-admin-*.sqlite")
	if err != nil {
		return err
	}
	stage := f.Name()
	if err := f.Close(); err != nil {
		os.Remove(stage)
		return err
	}
	defer os.Remove(stage)
	local, err := OpenStore(stage)
	if err != nil {
		return err
	}
	defer local.Close()
	tx, err := local.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO users(id,username,role,enabled,password_hash,session_version) VALUES(?,?,'admin',1,?,?)", actorID, username, hash, version+1); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES('local_admin_id',?)", actorID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := local.Close(); err != nil {
		return err
	}
	f, err = os.OpenFile(stage, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(stage, abs); err != nil {
		return err
	}
	if parent, err := os.Open(filepath.Dir(abs)); err == nil {
		defer parent.Close()
		_ = parent.Sync()
	}
	return nil
}

func (s *Store) Snapshot(ctx context.Context, destination string) error {
	abs, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(abs)
		return err
	}
	if _, err := s.db.ExecContext(ctx, "VACUUM INTO ?", abs); err != nil {
		os.Remove(abs)
		return err
	}
	f, err = os.OpenFile(abs, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *Store) SnapshotIdentity(ctx context.Context) (string, int, error) {
	var clusterID string
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return "", 0, err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='cluster_id'").Scan(&clusterID); err != nil {
		return "", 0, err
	}
	return clusterID, version, nil
}

func openSnapshot(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
	if filepath.VolumeName(abs) != "" {
		u.Path = "/" + u.Path
	}
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	return sql.Open("sqlite", u.String())
}

func InspectSnapshot(ctx context.Context, path string, key []byte) (string, int, error) {
	db, err := openSnapshot(path)
	if err != nil {
		return "", 0, err
	}
	defer db.Close()
	store := &Store{db: db}
	id, version, err := store.SnapshotIdentity(ctx)
	if err != nil {
		return "", 0, err
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		return "", 0, err
	}
	if integrity != "ok" {
		return "", 0, errors.New("invalid controller snapshot")
	}
	if len(key) != 32 {
		return "", 0, errors.New("invalid controller key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", 0, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", 0, err
	}
	rows, err := db.QueryContext(ctx, "SELECT tailnet_id,encrypted FROM credentials WHERE length(encrypted)>0 UNION ALL SELECT 'enrollment:'||node_id,response_encrypted FROM enrollments WHERE length(response_encrypted)>0")
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var aad string
		var encrypted []byte
		if err := rows.Scan(&aad, &encrypted); err != nil {
			return "", 0, err
		}
		n := aead.NonceSize()
		if len(encrypted) < n {
			return "", 0, errors.New("controller archive key does not match its database")
		}
		if _, err := aead.Open(nil, encrypted[:n], encrypted[n:], []byte(aad)); err != nil {
			return "", 0, errors.New("controller archive key does not match its database")
		}
	}
	if err := rows.Err(); err != nil {
		return "", 0, err
	}
	return id, version, nil
}
