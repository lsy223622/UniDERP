package daemon

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/lsy223622/UniDERP/v2/internal/admin"
	"github.com/lsy223622/UniDERP/v2/internal/cluster"
	"github.com/lsy223622/UniDERP/v2/internal/config"
	"github.com/lsy223622/UniDERP/v2/internal/control"
)

func (d *Daemon) startManagement(cfg config.Config) error {
	database, listen := d.managementDatabase(cfg), "127.0.0.1:3341"
	if cfg.Controller.Enabled {
		database, listen = cfg.Controller.Database, cfg.Controller.Listen
	}
	if !cfg.Controller.Enabled && d.modeState.Listen != "" {
		listen = d.modeState.Listen
	}
	store, err := control.OpenStore(database)
	if err != nil {
		return fmt.Errorf("open controller database: %w", err)
	}
	d.controllerStore = store
	d.managementPath = database
	if !cfg.Controller.Enabled {
		d.modeState.MemberDatabase = database
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen controller: %w", err)
	}
	d.controllerListener = listener
	d.managementHandler.Store(control.NewLocalHTTPHandler(store, d))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/cluster/v1/domain-challenge/") {
			d.mu.RLock()
			c := d.nodeClient
			d.mu.RUnlock()
			if c != nil {
				c.DomainHandler().ServeHTTP(w, r)
			} else {
				http.NotFound(w, r)
			}
			return
		}
		d.managementHandler.Load().(http.Handler).ServeHTTP(w, r)
	})
	d.controllerServer = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 64 << 10}
	go func() {
		if err := d.controllerServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			d.reportFatal(fmt.Errorf("controller server: %w", err))
		}
	}()
	if cfg.Server.Management.Listen != "" {
		l, err := net.Listen("tcp", cfg.Server.Management.Listen)
		if err != nil {
			return fmt.Errorf("listen independent management: %w", err)
		}
		d.managementListener = l
		d.managementServer = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 64 << 10}
		go func() {
			if err := d.managementServer.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
				d.reportFatal(err)
			}
		}()
	}
	return nil
}

func (d *Daemon) prepareRole(ctx context.Context, cfg config.Config) error {
	if cfg.SetupRequired {
		return nil
	}
	if !cfg.Controller.Enabled || d.managementDatabase(cfg) != d.managementPath {
		d.stopController()
	}
	if err := d.replaceManagementStore(ctx, cfg, ""); err != nil {
		return err
	}
	if cfg.Controller.Enabled && d.controllerCancel == nil {
		if err := d.controllerStore.EnableIdentity(cfg.Controller.KeyFile); err != nil {
			return err
		}
		if err := d.controllerStore.ConfigureNodes(cfg.Controller.AllowedNodeCIDRs); err != nil {
			return err
		}
		if !d.modeBusy.Load() {
			syncCtx, cancel := context.WithCancel(ctx)
			d.controllerCancel = cancel
			done := make(chan struct{})
			d.controllerDone = done
			store := d.controllerStore
			go func() {
				defer close(done)
				if err := store.RunIdentitySync(syncCtx); err != nil {
					d.reportFatal(err)
				}
			}()
		}
	}
	origin := cfg.Node.ControllerURL
	if cfg.Controller.Enabled && cfg.Server.Hostname != "" {
		origin = nodeControllerURL(cfg)
	}
	d.mu.RLock()
	client := d.nodeClient
	d.mu.RUnlock()
	if client == nil {
		var err error
		client, err = cluster.NewEnrollmentClient(origin, cfg.Node.StateDir)
		if err != nil {
			return err
		}
		d.mu.Lock()
		d.nodeClient = client
		d.mu.Unlock()
	} else if cfg.Server.Hostname != d.activeConfig().Server.Hostname && cfg.Controller.Enabled {
		if err := client.SetControllerURL(origin); err != nil {
			return err
		}
	}
	if err := d.prepareNodePolicy(cfg.Node); err != nil {
		return err
	}
	return d.configureModeStore(ctx, cfg)
}

func (d *Daemon) configureModeStore(ctx context.Context, cfg config.Config) error {
	owner, nodeID := "", ""
	actor, err := d.controllerStore.LocalAdministrator(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	owner = actor.ID
	if cfg.Controller.Enabled && d.nodeClient != nil {
		clusterID, boundID := d.nodeClient.PolicyBinding()
		localID, _, err := d.controllerStore.SnapshotIdentity(ctx)
		if err != nil {
			return err
		}
		if clusterID == localID && boundID != "" {
			node, err := d.controllerStore.Node(ctx, actor, boundID)
			if err != nil {
				return err
			}
			if node.Domain != cfg.Server.Hostname {
				return control.ErrConflict
			}
			owner, nodeID = node.OwnerID, node.ID
		}
	}
	return d.controllerStore.ConfigureInstanceMode(ctx, string(cfg.EffectiveMode()), owner, cfg.Server.Hostname, nodeID)
}

func (d *Daemon) controllerAdmin(ctx context.Context, request admin.Request) admin.Response {
	d.opMu.Lock()
	defer d.opMu.Unlock()
	if d.modeBusy.Load() {
		return admin.Failure("instance mode switch is in progress")
	}
	if d.controllerStore == nil || d.Role() != "controller" {
		return admin.Failure("controller is not enabled")
	}
	if request.Action == "controller.init" {
		actor, err := d.controllerStore.InitializeAdmin(ctx, request.Username, request.Password)
		if err != nil {
			return admin.Failure("administrator initialization failed")
		}
		return admin.Success("administrator initialized", actor)
	}
	if err := d.controllerStore.RecoverAdmin(ctx, request.UserID, request.Password); err != nil {
		return admin.Failure("administrator recovery failed")
	}
	return admin.Success("administrator recovered", nil)
}
