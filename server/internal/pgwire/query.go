package pgwire

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
)

// Column mirrors one RowDescription field.
type Column struct {
	Name string
	OID  uint32
}

// Result is a fully-materialised query result. Rows are accumulated rather than streamed because
// every caller in the app (drizzle's db.select()/db.execute()) also buffers the whole result.
type Result struct {
	Columns    []Column
	Data       [][]any
	CommandTag string
}

// RowCount is the number of rows returned (not the rows affected by a DML tag).
func (r *Result) RowCount() int { return len(r.Data) }

// Query runs a parameterised statement over the extended protocol, binding every argument in text
// format. Parameter type OIDs are left for the server to infer (OID 0), exactly as pg does when
// drizzle sends a parameterised query — declaring them client-side would break comparisons such as
// `where id = $1` where the column type differs from the Go type.
func (c *Conn) Query(ctx context.Context, sql string, args ...any) (*Result, error) {
	done := c.applyDeadline(ctx)
	defer done()
	return c.extendedQuery(sql, args)
}

// Exec runs a statement and discards its rows.
func (c *Conn) Exec(ctx context.Context, sql string, args ...any) (string, error) {
	res, err := c.Query(ctx, sql, args...)
	if err != nil {
		return "", err
	}
	return res.CommandTag, nil
}

func (c *Conn) extendedQuery(sql string, args []any) (*Result, error) {
	parse := &writer{}
	parse.str("") // unnamed statement
	parse.str(sql)
	parse.u16(0) // parameter type OIDs: infer

	bind := &writer{}
	bind.str("") // unnamed portal
	bind.str("") // unnamed statement
	bind.u16(0)  // all parameters are text format
	bind.u16(uint16(len(args)))
	for _, arg := range args {
		enc := encodeParamText(arg)
		if enc == nil {
			bind.i32(-1)
			continue
		}
		bind.i32(int32(len(enc)))
		bind.raw(enc)
	}
	bind.u16(0) // all results are text format

	describe := &writer{}
	describe.u8('P')
	describe.str("")

	execute := &writer{}
	execute.str("")
	execute.i32(0) // no row limit

	var m msg
	m.add('P', parse.bytes())
	m.add('B', bind.bytes())
	m.add('D', describe.bytes())
	m.add('E', execute.bytes())
	m.add('S', nil) // Sync

	if err := c.writeAll(m.bytes()); err != nil {
		return nil, err
	}
	return c.readResults()
}

// SimpleQuery uses the simple query protocol. Used for statements where the SQL text is static and
// parameter binding adds nothing (BEGIN/COMMIT/ROLLBACK and the schema migration statements).
func (c *Conn) SimpleQuery(ctx context.Context, sql string) (*Result, error) {
	done := c.applyDeadline(ctx)
	defer done()
	w := &writer{}
	w.str(sql)
	var m msg
	m.add('Q', w.bytes())
	if err := c.writeAll(m.bytes()); err != nil {
		return nil, err
	}
	return c.readResults()
}

func (c *Conn) readResults() (*Result, error) {
	res := &Result{}
	var firstErr error
	for {
		t, body, err := c.readMessage()
		if err != nil {
			return nil, err
		}
		switch t {
		case '1', '2', 'n', 's', 'I', 't':
			// ParseComplete, BindComplete, NoData, PortalSuspended, EmptyQueryResponse,
			// ParameterDescription — nothing to collect.
		case 'T':
			res.Columns = parseRowDescription(body)
		case 'D':
			res.Data = append(res.Data, parseDataRow(body, res.Columns))
		case 'C':
			res.CommandTag = leadingField(body)
		case 'S':
			c.applyParamStatus(body)
		case 'N':
			// NoticeResponse
		case 'E':
			// Keep the first error and keep draining: the Sync that follows still has to be
			// answered with a ReadyForQuery before the connection is usable again.
			if firstErr == nil {
				firstErr = parseError(body)
			}
		case 'Z':
			if len(body) > 0 {
				c.txStatus = body[0]
			}
			return res, firstErr
		default:
			if firstErr == nil {
				firstErr = unexpected(t, "query")
			}
		}
	}
}

func parseRowDescription(body []byte) []Column {
	r := &reader{b: body}
	count := int(r.u16())
	cols := make([]Column, 0, count)
	for i := 0; i < count; i++ {
		name := r.str()
		if !r.empty() {
			r.u32() // table OID
			r.u16() // column attribute number
			oid := r.u32()
			r.u16() // type size
			r.i32() // type modifier
			if !r.empty() {
				r.u16() // format code
			}
			cols = append(cols, Column{Name: name, OID: oid})
			continue
		}
		cols = append(cols, Column{Name: name})
	}
	return cols
}

func parseDataRow(body []byte, cols []Column) []any {
	r := &reader{b: body}
	count := int(r.u16())
	row := make([]any, count)
	for i := 0; i < count; i++ {
		length := int(r.i32())
		raw := r.bytes(length)
		if length < 0 {
			row[i] = nil
			continue
		}
		var oid uint32
		if i < len(cols) {
			oid = cols[i].OID
		}
		row[i] = decodeText(oid, raw)
	}
	return row
}

// leadingField reads the first NUL-terminated string of a CommandComplete body (the command tag).
func leadingField(body []byte) string {
	r := &reader{b: body}
	return r.str()
}

// encodeParamText renders a Go value into the text representation PostgreSQL expects. Returns nil
// for SQL NULL.
func encodeParamText(v any) []byte {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return []byte(x)
	case []byte:
		return x
	case json.RawMessage:
		return x
	case bool:
		if x {
			return []byte("t")
		}
		return []byte("f")
	case int:
		return strconv.AppendInt(nil, int64(x), 10)
	case int8:
		return strconv.AppendInt(nil, int64(x), 10)
	case int16:
		return strconv.AppendInt(nil, int64(x), 10)
	case int32:
		return strconv.AppendInt(nil, int64(x), 10)
	case int64:
		return strconv.AppendInt(nil, x, 10)
	case uint:
		return strconv.AppendUint(nil, uint64(x), 10)
	case uint32:
		return strconv.AppendUint(nil, uint64(x), 10)
	case uint64:
		return strconv.AppendUint(nil, x, 10)
	case float32:
		return strconv.AppendFloat(nil, float64(x), 'g', -1, 32)
	case float64:
		return strconv.AppendFloat(nil, x, 'g', -1, 64)
	case time.Time:
		return []byte(x.UTC().Format("2006-01-02T15:04:05.999999Z07:00"))
	default:
		return []byte("")
	}
}
