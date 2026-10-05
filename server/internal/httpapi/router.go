// SPDX-License-Identifier: GPL-3.0-or-later
// Package httpapi is the HTTP surface: every route handler of app/api/**/route.ts plus the one
// server action, wired to the same paths, methods, status codes, headers and JSON shapes.
package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
)

// Router is a small path-pattern router with Next-compatible fallbacks.
//
// It is hand-rolled rather than net/http.ServeMux for one reason: parity of the not-found and
// method-mismatch responses. Next answers an unknown /api path and a known path with the wrong
// method with an EMPTY body (404 / 405), while ServeMux writes "404 page not found" and
// "Method Not Allowed" bodies, and its 404 body would collide with the routes that legitimately
// answer 404 with a JSON payload (an unknown service on /api/instances/{service}).
type Router struct {
	routes []route
}

type route struct {
	method   string
	segments []string
	handler  http.HandlerFunc
}

// Handle registers a handler for a method and pattern. Pattern segments in braces capture a single
// path segment, e.g. "/api/instances/{service}".
func (r *Router) Handle(method, pattern string, handler http.HandlerFunc) {
	r.routes = append(r.routes, route{
		method:   method,
		segments: splitPath(pattern),
		handler:  handler,
	})
}

// ServeHTTP matches the request. A path that matches no pattern is 404 with an empty body; a path
// that matches a pattern registered for another method is 405 with an empty body — both as Next
// does. Trailing slashes get Next's default 308 redirect (trailingSlash: false).
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path
	if path != "/" && strings.HasSuffix(path, "/") {
		target := strings.TrimRight(path, "/")
		if req.URL.RawQuery != "" {
			target += "?" + req.URL.RawQuery
		}
		w.Header().Set("location", target)
		w.WriteHeader(http.StatusPermanentRedirect)
		return
	}

	segments := splitPath(path)
	// Next answers a HEAD request with the matching GET handler (and net/http discards the body it
	// writes), so route HEAD as GET rather than reporting a method mismatch.
	method := req.Method
	if method == http.MethodHead {
		method = http.MethodGet
	}
	pathMatched := false
	for _, rt := range r.routes {
		params, ok := match(rt.segments, segments)
		if !ok {
			continue
		}
		pathMatched = true
		if rt.method != method {
			continue
		}
		rt.handler(w, req.WithContext(withParams(req.Context(), params)))
		return
	}
	if pathMatched {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func match(pattern, path []string) (map[string]string, bool) {
	if len(pattern) != len(path) {
		return nil, false
	}
	params := map[string]string{}
	for i, segment := range pattern {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			if path[i] == "" {
				return nil, false
			}
			params[strings.Trim(segment, "{}")] = path[i]
			continue
		}
		if segment != path[i] {
			return nil, false
		}
	}
	return params, true
}

// jsonBody renders a JSON response the way NextResponse.json does: no HTML escaping, no trailing
// newline, application/json content type.
func jsonBody(v any) []byte {
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// writeJSON writes status + body with the given extra headers.
func writeJSON(w http.ResponseWriter, status int, body any, headers map[string]string) {
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(jsonBody(body))
}

// writeEmpty writes a status with no body, which is what Next produces for an unhandled throw and
// for its 404/405 fallbacks.
func writeEmpty(w http.ResponseWriter, status int) { w.WriteHeader(status) }
