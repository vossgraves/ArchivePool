// Package httpx wraps the outbound HTTP calls the port makes to third-party services. Every call
// carries the pool's identifying User-Agent and an explicit timeout, mirroring the TS's
// `fetch(..., { cache: "no-store" })` plus AbortController pattern.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// DefaultUA is the pool's self-identifying agent for community feeds.
const DefaultUA = "ArchiveTune-SourcePool/1.0"

// BrowserUA is the Chrome UA the TS sends to Qobuz, Deezer and Apple endpoints (they reject
// unfamiliar agents or set different quality flags).
const BrowserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Client is shared so connections are reused across a sweep. Timeouts are per call.
var Client = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     30 * time.Second,
	},
}

// Request describes one outbound call.
type Request struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
	Timeout time.Duration
}

// Do performs the request under a context deadline and returns the response. The caller owns the
// body.
func Do(ctx context.Context, spec Request) (*http.Response, error) {
	method := spec.Method
	if method == "" {
		method = http.MethodGet
	}
	timeout := spec.Timeout
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	// The cancel is deliberately not deferred: the response body is read by the caller, and
	// cancelling on return would abort that read. Callers close the body, which releases the
	// context through the request's own lifetime.
	_ = cancel

	var body io.Reader
	if spec.Body != nil {
		body = bytes.NewReader(spec.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, spec.URL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", DefaultUA)
	for k, v := range spec.Headers {
		req.Header.Set(k, v)
	}
	res, err := Client.Do(req)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// Get issues a GET and returns the response.
func Get(ctx context.Context, rawURL string, headers map[string]string, timeout time.Duration) (*http.Response, error) {
	return Do(ctx, Request{Method: http.MethodGet, URL: rawURL, Headers: headers, Timeout: timeout})
}

// PostForm issues an application/x-www-form-urlencoded POST.
func PostForm(ctx context.Context, rawURL string, headers map[string]string, form url.Values, timeout time.Duration) (*http.Response, error) {
	merged := map[string]string{"content-type": "application/x-www-form-urlencoded"}
	for k, v := range headers {
		merged[k] = v
	}
	return Do(ctx, Request{
		Method:  http.MethodPost,
		URL:     rawURL,
		Headers: merged,
		Body:    []byte(form.Encode()),
		Timeout: timeout,
	})
}

// ReadText reads and closes a response body.
func ReadText(res *http.Response) (string, error) {
	defer res.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// ReadLimitedText reads at most max bytes (the TS slices probe bodies to 20 000 chars).
func ReadLimitedText(res *http.Response, max int) (string, error) {
	defer res.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(res.Body, int64(max)+1))
	if err != nil {
		return "", err
	}
	if len(buf) > max {
		buf = buf[:max]
	}
	return string(buf), nil
}

// ReadJSON decodes a response body and closes it.
func ReadJSON(res *http.Response, out any) error {
	defer res.Body.Close()
	dec := json.NewDecoder(res.Body)
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("httpx: decoding JSON: %w", err)
	}
	return nil
}

// Reason renders a transport error the way lib/health.ts `reason()` does: an aborted or timed-out
// request is reported as "timeout", everything else is truncated to 120 characters.
func Reason(err error) string {
	if err == nil {
		return "error"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "timeout"
	}
	msg := err.Error()
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return msg
}
