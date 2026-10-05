// SPDX-License-Identifier: GPL-3.0-or-later
// Package config reads the deployment's environment. Every variable name is identical to the TS
// app's (see .env.example), so one environment file drives both during the cutover.
package config

import (
	"os"
	"strings"
)

// Config is the process-wide environment snapshot.
type Config struct {
	DatabaseURL        string
	AdminTokenHash     string
	AdminToken         string
	CronSecret         string
	ReadKeysEnforced   bool
	SessionSecret      string
	PoolEncryptionKey  string
	PoolClientKey      string
	BlobReadWriteToken string
	Port               string
	NodeEnv            string
}

// Load reads the environment. It deliberately does not validate: the TS app fails closed at the
// point of use (a missing ADMIN_TOKEN is "not authorized", a missing SESSION_SECRET refuses to sign)
// rather than at boot, and callers rely on that.
func Load() *Config {
	return &Config{
		DatabaseURL:        strings.TrimSpace(os.Getenv("DATABASE_URL")),
		AdminTokenHash:     strings.TrimSpace(os.Getenv("ADMIN_TOKEN_HASH")),
		AdminToken:         os.Getenv("ADMIN_TOKEN"),
		CronSecret:         os.Getenv("CRON_SECRET"),
		ReadKeysEnforced:   os.Getenv("READ_KEYS_ENFORCED") == "true",
		SessionSecret:      strings.TrimSpace(os.Getenv("SESSION_SECRET")),
		PoolEncryptionKey:  os.Getenv("POOL_ENCRYPTION_KEY"),
		PoolClientKey:      os.Getenv("POOL_CLIENT_KEY"),
		BlobReadWriteToken: os.Getenv("BLOB_READ_WRITE_TOKEN"),
		Port:               port(),
		NodeEnv:            os.Getenv("NODE_ENV"),
	}
}

// Production mirrors `process.env.NODE_ENV === "production"`, which decides the session cookie's
// Secure flag.
func (c *Config) Production() bool { return c.NodeEnv == "production" }

func port() string {
	if p := strings.TrimSpace(os.Getenv("PORT")); p != "" {
		return p
	}
	return "8080"
}
