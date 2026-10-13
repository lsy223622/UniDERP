package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type LocalGrantResult struct {
	State   string `json:"state"`
	NodeID  string `json:"node_id,omitempty"`
	GrantID string `json:"grant_id,omitempty"`
	Error   string `json:"error,omitempty"`
}

type instanceMode struct{ Mode, Owner, Domain, NodeID string }

var ErrStandalone = errors.New("disabled in standalone mode")

func requireStandaloneNode(ctx context.Context, tx *sql.Tx, id string) error {
	mode, err := readInstanceMode(ctx, tx)
	if err != nil || mode.Mode != "standalone" {
		return err
	}
	if mode.NodeID != "" {
		if mode.NodeID == id {
			return nil
		}
		return ErrStandalone
	}
	var domain, owner string
	if err := tx.QueryRowContext(ctx, "SELECT domain,owner_id FROM nodes WHERE id=?", id).Scan(&domain, &owner); err != nil {
		return err
	}
	if domain != mode.Domain || owner != mode.Owner {
		return ErrStandalone
	}
	return nil
}

func readInstanceMode(ctx context.Context, tx *sql.Tx) (instanceMode, error) {
	var mode instanceMode
	rows, err := tx.QueryContext(ctx, "SELECT key,value FROM settings WHERE key IN ('instance_mode','builtin_owner_id','builtin_domain','builtin_node_id')")
	if err != nil {
		return mode, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			return mode, err
		}
		switch name {
		case "instance_mode":
			mode.Mode = value
		case "builtin_owner_id":
			mode.Owner = value
		case "builtin_domain":
			mode.Domain = value
		case "builtin_node_id":
			mode.NodeID = value
		}
	}
	return mode, rows.Err()
}

func (s *Store) ConfigureInstanceMode(ctx context.Context, mode, owner, domain, nodeID string) error {
	if mode != "standalone" && mode != "controller" && mode != "member" {
		return ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for name, value := range map[string]string{"instance_mode": mode, "builtin_owner_id": owner, "builtin_domain": domain, "builtin_node_id": nodeID} {
		if _, err := tx.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", name, value); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func writeLocalGrant(ctx context.Context, tx *sql.Tx, tailnet string, result LocalGrantResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "local_grant:"+tailnet, string(body))
	return err
}

func (s *Store) completeStandaloneGrant(ctx context.Context, tx *sql.Tx, actor Actor, tailnet string, result LocalGrantResult) (LocalGrantResult, error) {
	mode, err := readInstanceMode(ctx, tx)
	if err != nil {
		return result, err
	}
	var owner string
	if err := tx.QueryRowContext(ctx, "SELECT owner_id FROM tailnets WHERE id=?", tailnet).Scan(&owner); err != nil {
		return result, err
	}
	if mode.Mode != "standalone" || owner != actor.ID || owner != mode.Owner || result.State == "skipped" {
		return result, ErrConflict
	}
	if result.NodeID != "" && result.NodeID != mode.NodeID {
		return result, ErrConflict
	}
	if mode.NodeID == "" {
		result.State, result.Error = "pending", "local_node_not_ready"
		return result, writeLocalGrant(ctx, tx, tailnet, result)
	}
	result.NodeID = mode.NodeID
	var nodeOwner string
	if err := tx.QueryRowContext(ctx, "SELECT owner_id FROM nodes WHERE id=?", result.NodeID).Scan(&nodeOwner); err != nil {
		return result, err
	}
	if nodeOwner != owner {
		return result, ErrConflict
	}
	var existingID, existingState string
	err = tx.QueryRowContext(ctx, "SELECT id,state FROM grants WHERE node_id=? AND tailnet_id=?", result.NodeID, tailnet).Scan(&existingID, &existingState)
	if err == nil {
		if existingState != "active" {
			return result, ErrConflict
		}
		result.State, result.GrantID, result.Error = "active", existingID, ""
		return result, writeLocalGrant(ctx, tx, tailnet, result)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if result.State == "active" {
		return result, ErrConflict
	}
	if _, err := tx.ExecContext(ctx, "SAVEPOINT local_grant"); err != nil {
		return result, err
	}
	grant, grantErr := s.requestGrant(ctx, tx, actor, result.NodeID, tailnet, 0, time.Time{})
	if grantErr != nil {
		if _, err := tx.ExecContext(ctx, "ROLLBACK TO local_grant"); err != nil {
			return result, err
		}
		result.State, result.Error = "failed", "local_grant_failed"
	} else {
		result.State, result.GrantID, result.Error = "active", grant.ID, ""
	}
	if _, err := tx.ExecContext(ctx, "RELEASE local_grant"); err != nil {
		return result, err
	}
	return result, writeLocalGrant(ctx, tx, tailnet, result)
}

func (s *Store) RetryStandaloneGrant(ctx context.Context, actor Actor, tailnet string) (LocalGrantResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LocalGrantResult{}, err
	}
	defer tx.Rollback()
	if err := activeActor(ctx, tx, actor); err != nil {
		return LocalGrantResult{}, err
	}
	var body string
	if err := tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", "local_grant:"+tailnet).Scan(&body); errors.Is(err, sql.ErrNoRows) {
		return LocalGrantResult{}, ErrConflict
	} else if err != nil {
		return LocalGrantResult{}, err
	}
	var result LocalGrantResult
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		return result, err
	}
	result, err = s.completeStandaloneGrant(ctx, tx, actor, tailnet, result)
	if err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	if result.State == "active" {
		s.notifyPolicy(result.NodeID)
	}
	return result, nil
}
