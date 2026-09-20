package pgwire

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Config is a parsed connection string. It mirrors what lib/pq and pg expose via pg-connection-string,
// because lib/db/index.ts hands process.env.DATABASE_URL straight to `new Pool({ connectionString })`.
type Config struct {
	Host           string
	Port           int
	User           string
	Password       string
	Database       string
	SSLMode        string // disable | allow | prefer | require | verify-ca | verify-full
	SSLRootCert    string
	ConnectTimeout time.Duration
	// Extra startup parameters (application_name, options, …). `channel_binding` is parsed and
	// ignored: SCRAM-SHA-256 (not -PLUS) is negotiated, which Neon and Railway both accept.
	RuntimeParams map[string]string
}

const defaultConnectTimeout = 15 * time.Second

// ParseConfig accepts a postgres:// URL or a libpq key=value DSN. An empty string yields an
// error so callers can surface "DATABASE_URL is not configured" the way the TS does.
func ParseConfig(raw string) (*Config, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("pgwire: empty connection string")
	}
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		return parseURLConfig(raw)
	}
	return parseDSN(raw)
}

func parseURLConfig(raw string) (*Config, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("pgwire: invalid connection string: %w", err)
	}
	cfg := &Config{
		Host:          u.Hostname(),
		Port:          5432,
		Database:      strings.TrimPrefix(u.Path, "/"),
		SSLMode:       "",
		RuntimeParams: map[string]string{},
	}
	if cfg.Host == "" {
		cfg.Host = "localhost"
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, fmt.Errorf("pgwire: invalid port %q", p)
		}
		cfg.Port = n
	}
	if u.User != nil {
		cfg.User = u.User.Username()
		cfg.Password, _ = u.User.Password()
	}
	if cfg.User == "" {
		cfg.User = os.Getenv("PGUSER")
	}
	q := u.Query()
	cfg.applyParam("sslmode", q.Get("sslmode"))
	cfg.applyParam("sslrootcert", q.Get("sslrootcert"))
	cfg.applyParam("connect_timeout", q.Get("connect_timeout"))
	cfg.applyParam("application_name", q.Get("application_name"))
	cfg.applyParam("options", q.Get("options"))
	cfg.applyParam("search_path", q.Get("search_path"))
	if db := q.Get("dbname"); db != "" {
		cfg.Database = db
	}
	return cfg.normalized()
}

func parseDSN(raw string) (*Config, error) {
	cfg := &Config{Port: 5432, RuntimeParams: map[string]string{}}
	for _, field := range strings.Fields(raw) {
		k, v, ok := strings.Cut(field, "=")
		if !ok {
			return nil, fmt.Errorf("pgwire: invalid DSN field %q", field)
		}
		v = strings.Trim(v, "'")
		switch k {
		case "host":
			cfg.Host = v
		case "port":
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, fmt.Errorf("pgwire: invalid port %q", v)
			}
			cfg.Port = n
		case "user":
			cfg.User = v
		case "password":
			cfg.Password = v
		case "dbname", "database":
			cfg.Database = v
		default:
			cfg.applyParam(k, v)
		}
	}
	return cfg.normalized()
}

func (c *Config) applyParam(key, value string) {
	switch key {
	case "sslmode":
		c.SSLMode = strings.ToLower(strings.TrimSpace(value))
	case "sslrootcert":
		c.SSLRootCert = value
	case "connect_timeout":
		if n, err := strconv.Atoi(value); err == nil && n > 0 {
			c.ConnectTimeout = time.Duration(n) * time.Second
		}
	default:
		if value != "" && key != "channel_binding" {
			c.RuntimeParams[key] = value
		}
	}
}

func (c *Config) normalized() (*Config, error) {
	if c.Host == "" || c.Host == "/tmp" {
		c.Host = "localhost"
	}
	if c.Database == "" {
		c.Database = c.User
	}
	if c.Database == "" {
		return nil, fmt.Errorf("pgwire: connection string has no database name")
	}
	if c.SSLMode == "" {
		c.SSLMode = "prefer"
	}
	switch c.SSLMode {
	case "disable", "allow", "prefer", "require", "verify-ca", "verify-full":
	default:
		return nil, fmt.Errorf("pgwire: unsupported sslmode %q", c.SSLMode)
	}
	if c.ConnectTimeout <= 0 {
		c.ConnectTimeout = defaultConnectTimeout
	}
	if c.RuntimeParams == nil {
		c.RuntimeParams = map[string]string{}
	}
	return c, nil
}

func (c *Config) addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// hostReachable reports whether the host looks like a DNS name or address we can dial.
func (c *Config) requiresTLS() bool {
	return c.SSLMode == "require" || c.SSLMode == "verify-ca" || c.SSLMode == "verify-full"
}

func (c *Config) wantsTLS() bool { return c.SSLMode != "disable" }

func (c *Config) tlsConfig() (*tls.Config, error) {
	tc := &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12}

	var pool *x509.CertPool
	if c.SSLRootCert != "" {
		pem, err := os.ReadFile(c.SSLRootCert)
		if err != nil {
			return nil, fmt.Errorf("pgwire: reading sslrootcert: %w", err)
		}
		pool = x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("pgwire: sslrootcert %q contains no certificates", c.SSLRootCert)
		}
	} else if roots, err := x509.SystemCertPool(); err == nil {
		pool = roots
	}
	if pool != nil {
		tc.RootCAs = pool
	}

	switch c.SSLMode {
	case "verify-full":
		// Full verification: chain plus host name (the tls package does both).
	case "verify-ca":
		// Chain verification without the host name check, matching libpq's verify-ca.
		tc.InsecureSkipVerify = true
		roots := pool
		tc.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			certs := make([]*x509.Certificate, 0, len(rawCerts))
			for _, raw := range rawCerts {
				cert, err := x509.ParseCertificate(raw)
				if err != nil {
					return err
				}
				certs = append(certs, cert)
			}
			if len(certs) == 0 {
				return fmt.Errorf("pgwire: server presented no certificate")
			}
			inter := x509.NewCertPool()
			for _, cert := range certs[1:] {
				inter.AddCert(cert)
			}
			_, err := certs[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter})
			return err
		}
	default:
		// require / prefer / allow: encrypted, not authenticated (libpq's `require` semantics).
		tc.InsecureSkipVerify = true
	}
	return tc, nil
}

// sortedParams gives a deterministic startup packet (map iteration order would otherwise vary).
func (c *Config) sortedParams() [][2]string {
	keys := make([]string, 0, len(c.RuntimeParams))
	for k := range c.RuntimeParams {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([][2]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, [2]string{k, c.RuntimeParams[k]})
	}
	return out
}
