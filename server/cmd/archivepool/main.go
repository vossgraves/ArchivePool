// SPDX-License-Identifier: GPL-3.0-or-later
// Command archivepool is the Go port of the ArchivePool backend: a drop-in for the Next.js /api/*
// surface (30 route handlers plus the manual-submission server action's logic).
//
// Run it beside Next during cutover:
//
//	Next (frontend, /api proxied or the client pointed at this base URL) :3000
//	Go   (this server)                                                   :8080
//
// See README.md for the route-by-route parity map.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"archivepool/server/internal/blob"
	"archivepool/server/internal/config"
	"archivepool/server/internal/db"
	"archivepool/server/internal/httpapi"
	"archivepool/server/internal/schema"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		log.Println("[boot] DATABASE_URL is not set: every database-backed route will fail, as the TS app does without it")
	}

	var database *db.DB
	if cfg.DatabaseURL != "" {
		opened, err := db.Open(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("[boot] invalid DATABASE_URL: %v", err)
		}
		database = opened
		database.SetEnsurer(func(ctx context.Context) error {
			return schema.Ensure(ctx, database)
		})
		// Warm the idempotent migration in the background. It is ~90 statements and each is a round
		// trip, so running it inline would delay the listener by tens of seconds; the TS app has the
		// same shape (memoised, triggered by the first request) and every handler that needs the
		// schema awaits the same sync.Once.
		go database.EnsureSchema(context.Background())
	} else {
		database = db.Unconfigured()
	}
	defer database.Close()

	store := blob.NewFromEnv()
	server := httpapi.New(cfg, database, store)

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// The cron routes run full sweeps, so the write timeout has to accommodate one; it is a
		// backstop against a wedged client, not a request budget.
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	go func() {
		log.Printf("[boot] archivepool listening on %s (blob=%v, keys_enforced=%v)", httpServer.Addr, store.Enabled(), cfg.ReadKeysEnforced)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[boot] server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("[boot] shutdown: %v", err)
	}
}
