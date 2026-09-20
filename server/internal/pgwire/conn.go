package pgwire

import (
	"bufio"
	"context"
	"crypto/md5"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// maxMessageSize guards against a malformed length field; the largest realistic message here is a
// RowDescription or a JSON payload.
const maxMessageSize = 64 << 20

// Conn is one authenticated frontend/backend connection. It is not safe for concurrent use: the
// pool in internal/db owns exclusivity, exactly as node-postgres's client does.
type Conn struct {
	cfg *Config

	nc net.Conn
	br *bufio.Reader
	bw *bufio.Writer

	params   map[string]string
	pid      uint32
	secret   uint32
	txStatus byte
	broken   bool
	closed   bool
}

func newConn(cfg *Config, nc net.Conn) *Conn {
	return &Conn{
		cfg:    cfg,
		nc:     nc,
		br:     bufio.NewReaderSize(nc, 16<<10),
		bw:     bufio.NewWriterSize(nc, 16<<10),
		params: map[string]string{},
	}
}

// Dial opens and authenticates a connection. The whole handshake is bounded by the context
// deadline (falling back to ConnectTimeout), so a black-holed host cannot hang a request.
func Dial(ctx context.Context, cfg *Config) (*Conn, error) {
	dialer := net.Dialer{Timeout: cfg.ConnectTimeout}
	nc, err := dialer.DialContext(ctx, "tcp", cfg.addr())
	if err != nil {
		return nil, fmt.Errorf("pgwire: dial %s: %w", cfg.addr(), err)
	}
	c := newConn(cfg, nc)
	deadline := time.Now().Add(cfg.ConnectTimeout)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	_ = nc.SetDeadline(deadline)
	if err := c.startup(); err != nil {
		_ = nc.Close()
		return nil, err
	}
	_ = nc.SetDeadline(time.Time{})
	return c, nil
}

// MarkBroken flags the connection as unusable so the pool discards it instead of reusing it
// (used when a transaction rollback itself fails on a dead socket).
func (c *Conn) MarkBroken() { c.broken = true }

// Broken reports a connection whose stream can no longer be trusted (I/O error or a protocol
// desync); the pool discards those instead of returning them to the idle set.
func (c *Conn) Broken() bool { return c.broken }

func (c *Conn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	// Write a Terminate message best-effort; the server closes either way.
	w := &msg{}
	w.add('X', nil)
	_ = c.writeAll(w.bytes())
	return c.nc.Close()
}

func (c *Conn) startup() error {
	if c.cfg.wantsTLS() {
		if err := c.negotiateTLS(); err != nil {
			return err
		}
	}
	if err := c.sendStartupMessage(); err != nil {
		return err
	}
	return c.authenticate()
}

func (c *Conn) negotiateTLS() error {
	w := &writer{}
	w.i32(8)
	w.i32(80877103) // SSLRequest
	if err := c.writeAll(w.bytes()); err != nil {
		return err
	}
	reply := make([]byte, 1)
	if _, err := io.ReadFull(c.br, reply); err != nil {
		return fmt.Errorf("pgwire: reading SSLRequest reply: %w", err)
	}
	switch reply[0] {
	case 'S':
		tlsCfg, err := c.cfg.tlsConfig()
		if err != nil {
			return err
		}
		tc := tls.Client(c.nc, tlsCfg)
		if err := tc.Handshake(); err != nil {
			return fmt.Errorf("pgwire: TLS handshake: %w", err)
		}
		c.nc = tc
		c.br = bufio.NewReaderSize(tc, 16<<10)
		c.bw = bufio.NewWriterSize(tc, 16<<10)
		return nil
	case 'N':
		if c.cfg.requiresTLS() {
			return fmt.Errorf("pgwire: server does not support SSL but sslmode=%s requires it", c.cfg.SSLMode)
		}
		return nil
	default:
		return fmt.Errorf("pgwire: unexpected SSLRequest reply %q", string(reply[0]))
	}
}

func (c *Conn) sendStartupMessage() error {
	w := &writer{}
	w.i32(0) // length placeholder
	w.i32(196608)
	w.str("user")
	w.str(c.cfg.User)
	w.str("database")
	w.str(c.cfg.Database)
	w.str("client_encoding")
	w.str("UTF8")
	for _, kv := range c.cfg.sortedParams() {
		w.str(kv[0])
		w.str(kv[1])
	}
	w.u8(0)
	binary.BigEndian.PutUint32(w.b[0:4], uint32(len(w.b)))
	return c.writeAll(w.bytes())
}

func (c *Conn) authenticate() error {
	scram := newSCRAM(c.cfg.User, c.cfg.Password)
	scramStarted := false
	for {
		t, body, err := c.readMessage()
		if err != nil {
			return err
		}
		switch t {
		case 'R':
			r := &reader{b: body}
			switch r.u32() {
			case 0: // AuthenticationOk
			case 3: // AuthenticationCleartextPassword
				if c.cfg.Password == "" {
					return errors.New("pgwire: server requested a password but none is configured")
				}
				if err := c.sendPassword([]byte(c.cfg.Password)); err != nil {
					return err
				}
			case 5: // AuthenticationMD5Password
				salt := r.bytes(4)
				if c.cfg.Password == "" {
					return errors.New("pgwire: server requested a password but none is configured")
				}
				if err := c.sendPassword(md5Password(c.cfg.User, c.cfg.Password, salt)); err != nil {
					return err
				}
			case 10: // AuthenticationSASL
				mechs := []string{}
				for {
					m := r.str()
					if m == "" {
						break
					}
					mechs = append(mechs, m)
				}
				if !contains(mechs, scramMech) {
					return fmt.Errorf("pgwire: server offers %v; only SCRAM-SHA-256 is supported", mechs)
				}
				first, err := scram.clientFirst()
				if err != nil {
					return err
				}
				if err := c.sendSASLInitial(scramMech, first); err != nil {
					return err
				}
				scramStarted = true
			case 11: // AuthenticationSASLContinue
				if !scramStarted {
					return errors.New("pgwire: SASLContinue before SASL start")
				}
				final, err := scram.clientFinal(r.rest())
				if err != nil {
					return err
				}
				if err := c.sendSASLResponse(final); err != nil {
					return err
				}
			case 12: // AuthenticationSASLFinal
				if err := scram.verifyServerFinal(r.rest()); err != nil {
					return err
				}
			default:
				return fmt.Errorf("pgwire: unsupported authentication request")
			}
		case 'K':
			r := &reader{b: body}
			c.pid = r.u32()
			c.secret = r.u32()
		case 'S':
			c.applyParamStatus(body)
		case 'N':
			// NoticeResponse: ignored, as node-postgres does by default.
		case 'E':
			return parseError(body)
		case 'Z':
			if len(body) > 0 {
				c.txStatus = body[0]
			}
			return nil
		default:
			return unexpected(t, "startup")
		}
	}
}

func (c *Conn) applyParamStatus(body []byte) {
	r := &reader{b: body}
	name := r.str()
	value := r.str()
	c.params[name] = value
}

// sendPassword writes a PasswordMessage for cleartext/MD5 auth.
func (c *Conn) sendPassword(password []byte) error {
	w := &writer{}
	w.raw(password)
	w.u8(0)
	m := &msg{}
	m.add('p', w.bytes())
	return c.writeAll(m.bytes())
}

// sendSASLInitial writes SASLInitialResponse: mechanism, then the client-first-message.
func (c *Conn) sendSASLInitial(mechanism string, initial []byte) error {
	w := &writer{}
	w.str(mechanism)
	w.i32(int32(len(initial)))
	w.raw(initial)
	m := &msg{}
	m.add('p', w.bytes())
	return c.writeAll(m.bytes())
}

// sendSASLResponse writes the client-final-message.
func (c *Conn) sendSASLResponse(response []byte) error {
	m := &msg{}
	m.add('p', response)
	return c.writeAll(m.bytes())
}

func (c *Conn) readMessage() (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(c.br, header[:]); err != nil {
		c.broken = true
		return 0, nil, fmt.Errorf("pgwire: reading message header: %w", err)
	}
	t := header[0]
	length := int(binary.BigEndian.Uint32(header[1:]))
	if length < 4 || length > maxMessageSize {
		c.broken = true
		return 0, nil, fmt.Errorf("pgwire: invalid message length %d", length)
	}
	body := make([]byte, length-4)
	if _, err := io.ReadFull(c.br, body); err != nil {
		c.broken = true
		return 0, nil, fmt.Errorf("pgwire: reading message body: %w", err)
	}
	return t, body, nil
}

func (c *Conn) writeAll(buf []byte) error {
	if c.closed {
		return errors.New("pgwire: connection is closed")
	}
	if _, err := c.bw.Write(buf); err != nil {
		c.broken = true
		return fmt.Errorf("pgwire: writing: %w", err)
	}
	if err := c.bw.Flush(); err != nil {
		c.broken = true
		return fmt.Errorf("pgwire: flushing: %w", err)
	}
	return nil
}

func (c *Conn) applyDeadline(ctx context.Context) func() {
	if dl, ok := ctx.Deadline(); ok {
		_ = c.nc.SetDeadline(dl)
		return func() { _ = c.nc.SetDeadline(time.Time{}) }
	}
	return func() {}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// md5Password builds the `md5` + hex(md5(hex(md5(password+user)) + salt)) response libpq sends.
func md5Password(user, password string, salt []byte) []byte {
	inner := md5.Sum([]byte(password + user))
	innerHex := hex.EncodeToString(inner[:])
	outer := md5.Sum(append([]byte(innerHex), salt...))
	return []byte("md5" + hex.EncodeToString(outer[:]))
}
