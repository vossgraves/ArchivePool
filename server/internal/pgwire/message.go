// Package pgwire implements the subset of the PostgreSQL frontend/backend protocol the
// ArchivePool Go port needs: startup (with SSLRequest, MD5 / cleartext / SCRAM-SHA-256 auth),
// the simple query protocol and the extended (Parse/Bind/Describe/Execute) protocol.
//
// It exists because the deployment has no module proxy available: pgx and lib/pq cannot be
// fetched, so the wire protocol is spoken directly with the standard library. It replaces
// lib/db/index.ts (pg.Pool + drizzle-orm/node-postgres) one-for-one.
package pgwire

import (
	"encoding/binary"
	"fmt"
)

// PgError is a PostgreSQL ErrorResponse. Error() returns the server's `M` field verbatim
// because the TypeScript app inspects `error.message` (lib/ingest.ts describeSaveError matches
// substrings like `relation "account_entries" does not exist`), so parity depends on it.
type PgError struct {
	Severity string
	Code     string
	Message  string
	Detail   string
	Hint     string
}

func (e *PgError) Error() string { return e.Message }

// reader is a forward-only cursor over a message body.
type reader struct{ b []byte }

func (r *reader) u8() byte {
	v := r.b[0]
	r.b = r.b[1:]
	return v
}

func (r *reader) u16() uint16 {
	v := binary.BigEndian.Uint16(r.b)
	r.b = r.b[2:]
	return v
}

func (r *reader) u32() uint32 {
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *reader) i32() int32 { return int32(r.u32()) }

// str reads a NUL-terminated string.
func (r *reader) str() string {
	i := 0
	for i < len(r.b) && r.b[i] != 0 {
		i++
	}
	s := string(r.b[:i])
	if i < len(r.b) {
		i++
	}
	r.b = r.b[i:]
	return s
}

// bytes reads exactly n bytes; a negative n means NULL (no bytes).
func (r *reader) bytes(n int) []byte {
	if n < 0 {
		return nil
	}
	if n > len(r.b) {
		n = len(r.b)
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func (r *reader) rest() []byte {
	v := r.b
	r.b = nil
	return v
}

func (r *reader) empty() bool { return len(r.b) == 0 }

// writer builds a message body.
type writer struct{ b []byte }

func (w *writer) u8(v byte)     { w.b = append(w.b, v) }
func (w *writer) u16(v uint16)  { w.b = binary.BigEndian.AppendUint16(w.b, v) }
func (w *writer) u32(v uint32)  { w.b = binary.BigEndian.AppendUint32(w.b, v) }
func (w *writer) i32(v int32)   { w.b = binary.BigEndian.AppendUint32(w.b, uint32(v)) }
func (w *writer) str(s string)  { w.b = append(w.b, s...); w.b = append(w.b, 0) }
func (w *writer) raw(b []byte)  { w.b = append(w.b, b...) }
func (w *writer) reset()        { w.b = w.b[:0] }
func (w *writer) len() int      { return len(w.b) }
func (w *writer) bytes() []byte { return w.b }

// msg accumulates several protocol messages into one write, so a Parse/Bind/Describe/Execute/Sync
// round trip costs a single syscall (as libpq's PQsendQueryParams does).
type msg struct{ b []byte }

func (m *msg) add(t byte, body []byte) {
	m.b = append(m.b, t)
	m.b = binary.BigEndian.AppendUint32(m.b, uint32(len(body)+4))
	m.b = append(m.b, body...)
}

func (m *msg) bytes() []byte { return m.b }

// parseError turns an ErrorResponse body into a *PgError.
func parseError(body []byte) *PgError {
	e := &PgError{}
	r := &reader{b: body}
	for !r.empty() {
		field := r.u8()
		if field == 0 {
			break
		}
		value := r.str()
		switch field {
		case 'S':
			e.Severity = value
		case 'C':
			e.Code = value
		case 'M':
			e.Message = value
		case 'D':
			e.Detail = value
		case 'H':
			e.Hint = value
		}
	}
	if e.Message == "" {
		e.Message = "postgres error"
	}
	return e
}

func unexpected(t byte, where string) error {
	return fmt.Errorf("pgwire: unexpected message %q in %s", string(t), where)
}
