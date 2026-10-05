// SPDX-License-Identifier: GPL-3.0-or-later
package oauth

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"archivepool/server/internal/httpx"
)

// Public Qobuz web-player app credentials. These are widely known and used by every open-source
// Qobuz client (streamrip, qobuz-dl) — they are NOT private.
//
// Two registrations are in play and they are not interchangeable (see lib/qobuz-oauth.ts):
// QobuzAppID signs stream requests with the play.qobuz.com secret but `user/login` rejects valid
// credentials under it, while QobuzLoginAppID with the open.qobuz.com secret logs in and signs.
// Entries sign with the pair they already store; sign-in uses the login-capable one.
const (
	QobuzAppID          = "950096963"
	QobuzLoginAppID     = "712109809"
	QobuzLoginAppSecret = "589be88e4538daea11f509d29e4a23b1"
)

const (
	qobuzLoginURL = "https://www.qobuz.com/api.json/0.2/user/login"
	// A stable, versioned Chrome UA consistent with what the Qobuz web player itself sends. A fixed
	// string (not randomised per call) prevents Qobuz flagging sessions for apparent UA rotation,
	// which is a known cause of early token invalidation.
	qobuzUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

// secretSources maps an app id to the web player whose bundle carries that registration's secret.
var secretSources = map[string]struct{ page, origin string }{
	QobuzAppID:      {"https://play.qobuz.com/login", "https://play.qobuz.com"},
	QobuzLoginAppID: {"https://open.qobuz.com/", "https://open.qobuz.com"},
}

var (
	scriptSrcRe = regexp.MustCompile(`(?i)<script[^>]+src="([^"]+\.js[^"]*)"[^>]*>`)
	secretRe    = regexp.MustCompile(`(?i)(?:app_secret|secret|seed)\s*[:=]\s*"([a-f0-9]{32})"`)
)

// QobuzLoginResult is a successful credential login.
type QobuzLoginResult struct {
	UserAuthToken string
	UserID        string
	CountryCode   string
	Username      string
}

// QobuzLogin signs in with Qobuz credentials. The error messages are user-facing and identical to
// the TS, because the route returns them verbatim as `detail`.
func QobuzLogin(ctx context.Context, username, password string) (QobuzLoginResult, error) {
	form := url.Values{
		"username": {username},
		"email":    {username},
		"password": {password},
		"app_id":   {QobuzLoginAppID},
	}
	res, err := httpx.PostForm(ctx, qobuzLoginURL, map[string]string{
		"x-app-id":   QobuzLoginAppID,
		"user-agent": qobuzUA,
	}, form, 12*time.Second)
	if err != nil {
		return QobuzLoginResult{}, err
	}

	if res.StatusCode == 401 || res.StatusCode == 400 {
		_ = res.Body.Close()
		return QobuzLoginResult{}, errors.New("Incorrect email or password.")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		status := res.StatusCode
		_ = res.Body.Close()
		return QobuzLoginResult{}, errors.New("Qobuz login failed: HTTP " + strconv.Itoa(status))
	}

	var body struct {
		UserAuthToken string `json:"user_auth_token"`
		User          struct {
			ID          jsonNumber `json:"id"`
			CountryCode string     `json:"country_code"`
			Login       string     `json:"login"`
		} `json:"user"`
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if err := httpx.ReadJSON(res, &body); err != nil {
		return QobuzLoginResult{}, err
	}

	if body.UserAuthToken == "" {
		msg := body.Message
		if msg == "" {
			msg = body.Status
		}
		if msg == "" {
			msg = "no token returned"
		}
		return QobuzLoginResult{}, errors.New("Login rejected: " + msg)
	}

	name := body.User.Login
	if name == "" {
		name = username
	}
	return QobuzLoginResult{
		UserAuthToken: body.UserAuthToken,
		UserID:        string(body.User.ID),
		CountryCode:   body.User.CountryCode,
		Username:      name,
	}, nil
}

// jsonNumber accepts either a JSON number or a JSON string (Qobuz returns the user id as either,
// depending on the endpoint version).
type jsonNumber string

func (n *jsonNumber) UnmarshalJSON(data []byte) error {
	*n = jsonNumber(strings.Trim(string(data), `"`))
	if string(*n) == "null" {
		*n = ""
	}
	return nil
}

// ScrapeQobuzAppSecret extracts appID's app_secret from the JS bundle of the web player that serves
// that registration. Qobuz embeds it as a 32-char lowercase hex string; an unknown appID falls back
// to the play.qobuz.com player.
func ScrapeQobuzAppSecret(ctx context.Context, appID string) string {
	source, ok := secretSources[appID]
	if !ok {
		source = secretSources[QobuzAppID]
	}
	pageRes, err := httpx.Get(ctx, source.page, map[string]string{"user-agent": qobuzUA}, 12*time.Second)
	if err != nil {
		return ""
	}
	if pageRes.StatusCode < 200 || pageRes.StatusCode >= 300 {
		_ = pageRes.Body.Close()
		return ""
	}
	html, err := httpx.ReadText(pageRes)
	if err != nil {
		return ""
	}

	scriptURLs := []string{}
	for _, m := range scriptSrcRe.FindAllStringSubmatch(html, -1) {
		src := m[1]
		if strings.HasPrefix(src, "http") {
			scriptURLs = append(scriptURLs, src)
		} else {
			scriptURLs = append(scriptURLs, source.origin+src)
		}
	}

	for _, scriptURL := range scriptURLs {
		jsRes, err := httpx.Get(ctx, scriptURL, map[string]string{"user-agent": qobuzUA}, 12*time.Second)
		if err != nil {
			continue
		}
		if jsRes.StatusCode < 200 || jsRes.StatusCode >= 300 {
			_ = jsRes.Body.Close()
			continue
		}
		js, err := httpx.ReadText(jsRes)
		if err != nil {
			continue
		}
		if m := secretRe.FindStringSubmatch(js); len(m) > 1 {
			return m[1]
		}
	}
	return ""
}

// ValidateAppSecret signs a probe request and verifies the secret works. It returns true only when
// Qobuz answered and did not reject the signature. A network error is NOT a validated secret: the
// caller maps false to the `needs_secret` state so the user can paste one manually, which is safer
// than proceeding with an unverified secret.
func ValidateAppSecret(ctx context.Context, appSecret, userAuthToken, appID string) bool {
	const probeTrack = "5966783"
	const probeFormat = "5"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sum := md5.Sum([]byte("trackgetFileUrlformat_id" + probeFormat + "intentstreamtrack_id" + probeTrack + ts + appSecret))
	sig := hex.EncodeToString(sum[:])
	probeURL := "https://www.qobuz.com/api.json/0.2/track/getFileUrl?request_ts=" + ts + "&request_sig=" + sig +
		"&track_id=" + probeTrack + "&format_id=" + probeFormat + "&intent=stream" +
		"&app_id=" + url.QueryEscape(appID) + "&user_auth_token=" + url.QueryEscape(userAuthToken)

	res, err := httpx.Get(ctx, probeURL, map[string]string{
		"x-app-id":          appID,
		"x-user-auth-token": userAuthToken,
		"user-agent":        qobuzUA,
	}, 12*time.Second)
	if err != nil {
		return false
	}
	body, err := httpx.ReadText(res)
	if err != nil {
		return false
	}
	// A bad secret returns an explicit "InvalidRequestSignature" error.
	return !strings.Contains(strings.ToLower(body), "invalid request signature")
}
