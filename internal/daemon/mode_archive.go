package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

type modeArchive struct {
	ArchiveID      string                  `json:"archive_id"`
	ClusterID      string                  `json:"cluster_id"`
	DatabasePath   string                  `json:"database_path"`
	KeyPath        string                  `json:"key_path"`
	SourceMode     config.RunMode          `json:"source_mode"`
	Format         int                     `json:"format"`
	Schema         int                     `json:"schema"`
	DatabaseSHA256 string                  `json:"database_sha256"`
	KeySHA256      string                  `json:"key_sha256"`
	Controller     config.ControllerConfig `json:"controller"`
}

var modeArchiveID = regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`)

func (d *Daemon) archiveRoot(id string) string {
	return filepath.Join(d.activeConfig().Storage.StateDir, "mode-archives", id)
}

func modeFileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func writeModeBytes(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".mode-*.tmp")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		defer dir.Close()
		_ = dir.Sync()
	}
	return nil
}

func (d *Daemon) archiveController(ctx context.Context, id string) (modeArchive, error) {
	if !modeArchiveID.MatchString(id) {
		return modeArchive{}, control.ErrInvalid
	}
	cfg := d.activeConfig()
	if !cfg.Controller.Enabled || d.controllerStore == nil {
		return modeArchive{}, control.ErrConflict
	}
	root := d.archiveRoot(id)
	if _, err := os.Stat(root); err == nil {
		return d.loadModeArchive(ctx, id)
	} else if !errors.Is(err, os.ErrNotExist) {
		return modeArchive{}, err
	}
	key, err := os.ReadFile(cfg.Controller.KeyFile)
	if err != nil {
		return modeArchive{}, err
	}
	if len(key) != 32 {
		return modeArchive{}, errors.New("invalid controller key")
	}
	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return modeArchive{}, err
	}
	stage, err := os.MkdirTemp(parent, ".archive-")
	if err != nil {
		return modeArchive{}, err
	}
	defer os.RemoveAll(stage)
	if err := d.controllerStore.Snapshot(ctx, filepath.Join(stage, "controller.sqlite")); err != nil {
		return modeArchive{}, err
	}
	clusterID, schema, err := control.InspectSnapshot(ctx, filepath.Join(stage, "controller.sqlite"))
	if err != nil {
		return modeArchive{}, err
	}
	after, err := os.ReadFile(cfg.Controller.KeyFile)
	if err != nil {
		return modeArchive{}, err
	}
	if !bytes.Equal(key, after) {
		return modeArchive{}, errors.New("controller key changed during archive")
	}
	if err := writeModeBytes(filepath.Join(stage, "controller.key"), key); err != nil {
		return modeArchive{}, err
	}
	databaseHash, err := modeFileHash(filepath.Join(stage, "controller.sqlite"))
	if err != nil {
		return modeArchive{}, err
	}
	keyHash, err := modeFileHash(filepath.Join(stage, "controller.key"))
	if err != nil {
		return modeArchive{}, err
	}
	databasePath, err := filepath.Abs(cfg.Controller.Database)
	if err != nil {
		return modeArchive{}, err
	}
	keyPath, err := filepath.Abs(cfg.Controller.KeyFile)
	if err != nil {
		return modeArchive{}, err
	}
	archive := modeArchive{ArchiveID: id, ClusterID: clusterID, DatabasePath: databasePath, KeyPath: keyPath, SourceMode: cfg.EffectiveMode(), Format: 1, Schema: schema, DatabaseSHA256: databaseHash, KeySHA256: keyHash, Controller: *cfg.Controller}
	manifest, err := json.Marshal(archive)
	if err != nil {
		return modeArchive{}, err
	}
	if err := writeModeBytes(filepath.Join(stage, "manifest.json"), manifest); err != nil {
		return modeArchive{}, err
	}
	if err := os.Rename(stage, root); err != nil {
		return modeArchive{}, err
	}
	if parentFile, err := os.Open(parent); err == nil {
		defer parentFile.Close()
		_ = parentFile.Sync()
	}
	return archive, nil
}

func (d *Daemon) loadModeArchive(ctx context.Context, id string) (modeArchive, error) {
	if !modeArchiveID.MatchString(id) {
		return modeArchive{}, control.ErrInvalid
	}
	root := d.archiveRoot(id)
	data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return modeArchive{}, err
	}
	var archive modeArchive
	if err := json.Unmarshal(data, &archive); err != nil {
		return modeArchive{}, err
	}
	if archive.Format != 1 || archive.ArchiveID != id || archive.ClusterID == "" || !filepath.IsAbs(archive.DatabasePath) || !filepath.IsAbs(archive.KeyPath) || (archive.SourceMode != config.ModeController && archive.SourceMode != config.ModeStandalone) || !archive.Controller.Enabled {
		return modeArchive{}, errors.New("invalid controller archive manifest")
	}
	databaseHash, err := modeFileHash(filepath.Join(root, "controller.sqlite"))
	if err != nil {
		return modeArchive{}, err
	}
	keyHash, err := modeFileHash(filepath.Join(root, "controller.key"))
	if err != nil {
		return modeArchive{}, err
	}
	if databaseHash != archive.DatabaseSHA256 || keyHash != archive.KeySHA256 {
		return modeArchive{}, errors.New("controller archive checksum mismatch")
	}
	clusterID, schema, err := control.InspectSnapshot(ctx, filepath.Join(root, "controller.sqlite"))
	if err != nil {
		return modeArchive{}, err
	}
	if clusterID != archive.ClusterID || schema != archive.Schema {
		return modeArchive{}, errors.New("controller archive identity mismatch")
	}
	return archive, nil
}

func (d *Daemon) restoreController(ctx context.Context, id string) error {
	archive, err := d.loadModeArchive(ctx, id)
	if err != nil {
		return err
	}
	if d.activeConfig().Controller.Enabled && d.controllerStore != nil {
		return control.ErrConflict
	}
	if d.controllerStore != nil {
		currentInfo, currentErr := os.Stat(d.managementPath)
		destinationInfo, destinationErr := os.Stat(archive.DatabasePath)
		if currentErr == nil && destinationErr == nil && os.SameFile(currentInfo, destinationInfo) {
			return control.ErrConflict
		}
	}
	root := d.archiveRoot(id)
	database, err := os.ReadFile(filepath.Join(root, "controller.sqlite"))
	if err != nil {
		return err
	}
	key, err := os.ReadFile(filepath.Join(root, "controller.key"))
	if err != nil {
		return err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(archive.DatabasePath + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := writeModeBytes(archive.DatabasePath, database); err != nil {
		return err
	}
	return writeModeBytes(archive.KeyPath, key)
}

func managementDatabase(cfg config.Config) string {
	if cfg.Controller.Enabled {
		return cfg.Controller.Database
	}
	if cfg.Mode == config.ModeMember {
		return filepath.Join(cfg.Storage.StateDir, "local.sqlite")
	}
	return filepath.Join(cfg.Storage.StateDir, "controller.sqlite")
}

func (d *Daemon) managementDatabase(cfg config.Config) string {
	if !cfg.Controller.Enabled && d.modeState.ActiveMode == config.ModeMember && d.modeState.MemberDatabase != "" {
		return d.modeState.MemberDatabase
	}
	return managementDatabase(cfg)
}

func (d *Daemon) stopController() {
	if d.controllerCancel != nil {
		d.controllerCancel()
		<-d.controllerDone
		d.controllerCancel, d.controllerDone = nil, nil
	}
}

func (d *Daemon) replaceManagementStore(ctx context.Context, cfg config.Config, actorID string) error {
	path := d.managementDatabase(cfg)
	if path == d.managementPath {
		return nil
	}
	previous := d.controllerStore
	_, statErr := os.Stat(path)
	if !cfg.Controller.Enabled || errors.Is(statErr, os.ErrNotExist) {
		if actorID == "" {
			actor, err := previous.LocalAdministrator(ctx)
			if err != nil {
				return err
			}
			actorID = actor.ID
		}
		if err := previous.PreserveLocalAdmin(ctx, actorID, path); err != nil {
			return err
		}
	}
	store, err := control.OpenStore(path)
	if err != nil {
		return err
	}
	d.managementHandler.Store(control.NewLocalHTTPHandler(store, d))
	d.controllerStore, d.managementPath = store, path
	return previous.Close()
}
