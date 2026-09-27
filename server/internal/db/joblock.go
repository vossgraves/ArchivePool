package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"time"
)

// JobLocksDDL creates the table the scheduled jobs claim before doing work. It is idempotent, so it
// is part of the runtime migration (internal/schema) like every other statement the app applies.
//
// Why a table and not `pg_try_advisory_lock`: serverless Postgres is reached through the pooler
// endpoint (docs/API.md, "Database"), and a transaction-mode pooler may serve two consecutive
// statements from one client on different backends. A session-scoped advisory lock would then be
// taken on a backend that goes on to serve somebody else, and the unlock — arriving on another
// backend — would not release it. A single-statement row lease is committed atomically and is
// therefore backend-independent.
const JobLocksDDL = `create table if not exists job_locks (
  name text primary key,
  holder text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
)`

// claimJobSQL takes the lease for one job. A conflicting row is updated only when its lease has
// already expired, so exactly one caller per window can win, and a crashed run self-heals instead of
// blocking the next scheduled one.
const claimJobSQL = `
	insert into job_locks (name, holder, locked_until, updated_at)
	values ($1, $2, now() + make_interval(secs => $3), now())
	on conflict (name) do update
	  set holder = excluded.holder, locked_until = excluded.locked_until, updated_at = now()
	  where job_locks.locked_until < now()
	returning holder`

// JobLease is a time-bounded exclusive claim on a named background job.
type JobLease struct {
	database *DB
	name     string
	holder   string
}

// ClaimJob takes name's lease for ttl, or reports false when another run holds it. A database
// failure is returned so the caller can decide whether to run unguarded rather than silently
// stopping every scheduled job.
func (d *DB) ClaimJob(ctx context.Context, name string, ttl time.Duration) (*JobLease, bool, error) {
	d.EnsureSchema(ctx)
	holder, err := randomHolder()
	if err != nil {
		return nil, false, err
	}
	rows, err := d.Query(ctx, claimJobSQL, name, holder, int64(ttl/time.Second))
	if err != nil {
		return nil, false, err
	}
	if rows.Len() == 0 {
		return nil, false, nil
	}
	return &JobLease{database: d, name: name, holder: holder}, true, nil
}

// Release ends the lease. Only the holder that took it can end it, so a run whose lease expired
// underneath it cannot release the run that replaced it. Best effort: a lost connection ends the
// lease by expiry, and the unlock runs under its own short deadline — the caller's context may
// already be cancelled (the job finished after a client hung up) and must not become an unbounded
// wait on a dead connection.
func (l *JobLease) Release(ctx context.Context) {
	if l == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), jobLeaseReleaseTimeout)
	defer cancel()
	if _, err := l.database.Exec(ctx,
		`update job_locks set locked_until = now() where name = $1 and holder = $2`,
		l.name, l.holder); err != nil {
		log.Printf("[db] releasing the %s job lease failed: %v", l.name, err)
	}
}

// jobLeaseReleaseTimeout bounds the unlock and the pool wait behind it.
const jobLeaseReleaseTimeout = 10 * time.Second

// randomHolder identifies this claim, so only it can release the lease.
func randomHolder() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
