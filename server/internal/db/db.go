// Package db is the pool + query layer that replaces lib/db/index.ts (a node-postgres Pool) and
// the drizzle call sites. Queries are written as explicit SQL with $n placeholders, which the
// pgwire extended protocol binds server-side — the same mechanism drizzle uses, so no query text
// is ever built by string concatenation.
package db

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"time"

	"archivepool/server/internal/pgwire"
)

// defaultMaxConns keeps the connection count under a serverless Postgres plan's limit while still
// allowing the concurrent health sweeps (6 workers) to run without serialising on one connection.
const defaultMaxConns = 8

// idleProbeAfter is how long a connection may sit idle before the pool proves it is still alive
// before handing it to a request by reusing it.
//
// A managed Postgres suspends the compute after a few idle minutes and drops its connections —
// which is the normal state of this pool, since the whole point of the caches is to let the compute
// sleep. The dropped socket looks fine from here until a statement is written to it, so without this
// check the first request after every idle period fails with a transport error even though the
// database is healthy. Probing costs one round trip on a connection that has been idle, and nothing
// on a busy pool.
const idleProbeAfter = 30 * time.Second

// idleProbeTimeout bounds the liveness probe itself, so a black-holed connection cannot hold a
// request past its own deadline.
const idleProbeTimeout = 5 * time.Second

// idleConn is a pooled connection plus the moment it went idle.
type idleConn struct {
	conn  *pgwire.Conn
	since time.Time
}

// DB is a connection pool plus the one-time schema migration hook.
type DB struct {
	cfg      pgwire.Config
	maxConns int

	mu      sync.Mutex
	idle    []idleConn
	open    int
	waiters []chan struct{}
	closed  bool

	ensureOnce sync.Once
	ensurer    func(ctx context.Context) error

	// unconfigured marks a pool with no DATABASE_URL at all; every operation fails with the same
	// clear error instead of attempting a dial, which is how the app reads with no database
	// configured (lib/ingest.ts describeSaveError special-cases exactly that state).
	unconfigured bool
}

// Open parses DATABASE_URL. An empty value is an error rather than a lazy failure so callers can
// report the misconfiguration the way the TS does (see lib/ingest.ts describeSaveError).
func Open(databaseURL string) (*DB, error) {
	cfg, err := pgwire.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	max := defaultMaxConns
	if raw := os.Getenv("DB_MAX_CONNS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			max = n
		}
	}
	return &DB{cfg: *cfg, maxConns: max}, nil
}

// Unconfigured returns a DB whose queries all fail with the missing-configuration error.
func Unconfigured() *DB {
	return &DB{maxConns: 1, unconfigured: true}
}

// SetEnsurer installs the schema migration hook run by EnsureSchema.
func (d *DB) SetEnsurer(fn func(ctx context.Context) error) {
	d.mu.Lock()
	d.ensurer = fn
	d.mu.Unlock()
}

// EnsureSchema applies the idempotent migration once per process. lib/db/ensure.ts memoizes the
// same way, so a failing statement is logged and the process keeps serving.
func (d *DB) EnsureSchema(ctx context.Context) {
	d.ensureOnce.Do(func() {
		d.mu.Lock()
		fn := d.ensurer
		d.mu.Unlock()
		if fn != nil {
			_ = fn(ctx)
		}
	})
}

// ErrUnconfigured is returned by every operation on a database-less server.
var ErrUnconfigured = errors.New("DATABASE_URL is not set")

func (d *DB) acquire(ctx context.Context) (*pgwire.Conn, error) {
	if d.unconfigured {
		return nil, ErrUnconfigured
	}
	for {
		d.mu.Lock()
		if d.closed {
			d.mu.Unlock()
			return nil, errors.New("db: pool is closed")
		}
		if n := len(d.idle); n > 0 {
			ic := d.idle[n-1]
			d.idle = d.idle[:n-1]
			d.mu.Unlock()
			if ic.conn.Broken() || !d.stillAlive(ctx, ic) {
				_ = ic.conn.Close()
				d.mu.Lock()
				d.open--
				d.wakeLocked()
				d.mu.Unlock()
				continue
			}
			return ic.conn, nil
		}
		if d.open < d.maxConns {
			d.open++
			d.mu.Unlock()
			// Dialled outside the lock, with the caller's ctx: a hung database must not hold the
			// reserved slot past the request's deadline.
			c, err := pgwire.Dial(ctx, &d.cfg)
			if err != nil {
				d.mu.Lock()
				d.open--
				d.wakeLocked()
				d.mu.Unlock()
				return nil, err
			}
			return c, nil
		}
		// Queued under the same lock hold that saw the pool exhausted: a release() in between
		// would otherwise wake nobody, and this caller would sleep beside an idle connection
		// until its deadline.
		ch := make(chan struct{})
		d.waiters = append(d.waiters, ch)
		d.mu.Unlock()

		select {
		case <-ch:
		case <-ctx.Done():
			d.mu.Lock()
			if !d.dropWaiterLocked(ch) {
				// Woken in the same instant ctx ended: pass the wake-up on, or the slot it
				// announced leaves with this caller and the next waiter sleeps on.
				d.wakeLocked()
			}
			d.mu.Unlock()
			return nil, ctx.Err()
		}
	}
}

func (d *DB) release(c *pgwire.Conn) {
	if c.Broken() {
		_ = c.Close()
		d.mu.Lock()
		defer d.mu.Unlock()
		d.open--
		d.wakeLocked()
		return
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if d.closed {
		_ = c.Close()
		return
	}
	d.idle = append(d.idle, idleConn{conn: c, since: time.Now()})
	d.wakeLocked()
}

// stillAlive reports whether a connection that has been idle can still be handed to a request.
// A recently used connection is taken as-is; one that has been idle past idleProbeAfter is probed
// with a trivial statement, because its socket may have been closed by a suspended server without
// any error being visible on this side yet.
func (d *DB) stillAlive(ctx context.Context, ic idleConn) bool {
	if time.Since(ic.since) < idleProbeAfter {
		return true
	}
	if ctx.Err() != nil {
		// The caller's deadline has already passed: its query will fail on its own account, and
		// discarding a healthy connection here would only cost the next caller a reconnect.
		return true
	}
	probeCtx, cancel := context.WithTimeout(ctx, idleProbeTimeout)
	defer cancel()
	if _, err := ic.conn.SimpleQuery(probeCtx, "select 1"); err != nil {
		return false
	}
	return true
}

// wakeLocked hands one waiter its slot (caller holds d.mu).
func (d *DB) wakeLocked() {
	if len(d.waiters) == 0 {
		return
	}
	ch := d.waiters[0]
	d.waiters = d.waiters[1:]
	close(ch)
}

// dropWaiterLocked removes ch from the queue (caller holds d.mu). It reports false when ch was
// no longer queued, i.e. wakeLocked had already popped and closed it.
func (d *DB) dropWaiterLocked(ch chan struct{}) bool {
	for i, w := range d.waiters {
		if w == ch {
			d.waiters = append(d.waiters[:i], d.waiters[i+1:]...)
			return true
		}
	}
	return false
}

// Close drains the idle connections. In-flight connections are closed on release.
func (d *DB) Close() error {
	d.mu.Lock()
	d.closed = true
	idle := d.idle
	d.idle = nil
	d.mu.Unlock()
	for _, ic := range idle {
		_ = ic.conn.Close()
	}
	return nil
}

// Query runs a parameterised SELECT and materialises the rows.
func (d *DB) Query(ctx context.Context, sql string, args ...any) (*Rows, error) {
	c, err := d.acquire(ctx)
	if err != nil {
		return nil, err
	}
	res, err := c.Query(ctx, sql, args...)
	if err != nil {
		d.release(c)
		return nil, err
	}
	d.release(c)
	return newRows(res), nil
}

// Exec runs a statement whose rows are not needed.
func (d *DB) Exec(ctx context.Context, sql string, args ...any) (string, error) {
	c, err := d.acquire(ctx)
	if err != nil {
		return "", err
	}
	tag, err := c.Exec(ctx, sql, args...)
	d.release(c)
	return tag, err
}

// QueryRow returns the first row. A missing row yields a Row that reports Valid() == false, which
// mirrors destructuring `const [row] = await db.select()…` in the TS.
func (d *DB) QueryRow(ctx context.Context, sql string, args ...any) (Row, error) {
	rows, err := d.Query(ctx, sql, args...)
	if err != nil {
		return Row{}, err
	}
	if rows.Len() == 0 {
		return Row{rows: rows, i: -1}, nil
	}
	return rows.Row(0), nil
}

// Tx runs fn inside a transaction, rolling back on any error. Used by claimApprovedKey, whose
// `.for("update")` row lock is what stops two dashboard tabs minting two keys for one request.
func (d *DB) Tx(ctx context.Context, fn func(tx *Tx) error) error {
	c, err := d.acquire(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			if _, err := c.SimpleQuery(context.WithoutCancel(ctx), "ROLLBACK"); err != nil {
				c.MarkBroken()
			}
		}
		d.release(c)
	}()

	if _, err := c.SimpleQuery(ctx, "BEGIN"); err != nil {
		return err
	}
	if err := fn(&Tx{conn: c, db: d}); err != nil {
		return err
	}
	if _, err := c.SimpleQuery(ctx, "COMMIT"); err != nil {
		return err
	}
	committed = true
	return nil
}

// Tx is a transaction-scoped query interface.
type Tx struct {
	conn *pgwire.Conn
	db   *DB
}

func (t *Tx) Query(ctx context.Context, sql string, args ...any) (*Rows, error) {
	res, err := t.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return newRows(res), nil
}

func (t *Tx) Exec(ctx context.Context, sql string, args ...any) (string, error) {
	return t.conn.Exec(ctx, sql, args...)
}

func (t *Tx) QueryRow(ctx context.Context, sql string, args ...any) (Row, error) {
	rows, err := t.Query(ctx, sql, args...)
	if err != nil {
		return Row{}, err
	}
	if rows.Len() == 0 {
		return Row{rows: rows, i: -1}, nil
	}
	return rows.Row(0), nil
}

// ErrorMessage renders any error for a response body; the TS uses `err instanceof Error ?
// err.message : "unknown database error"` in the status route.
func ErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	var pgErr *pgwire.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Message
	}
	return err.Error()
}
