// Package oauth holds the two third-party credential-acquisition flows: Tidal's device
// authorization (lib/tidal-oauth.ts) and Qobuz's credential login plus app_secret scrape
// (lib/qobuz-oauth.ts).
package oauth

import (
	"context"
	"net/url"
	"strconv"
	"time"

	"archivepool/server/internal/httpx"
)

// Tidal's well-known public "TV/device" OAuth client (matches ArchiveTune's device client).
const (
	tidalClientID     = "zU4XHVVkc2tDPo4t"
	tidalClientSecret = "VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4="
	tidalScope        = "r_usr+w_usr+w_sub"

	tidalDeviceAuthURL = "https://auth.tidal.com/v1/oauth2/device_authorization"
	tidalTokenURL      = "https://auth.tidal.com/v1/oauth2/token"

	// Matches the Tidal TV/device client UA the app uses, so all requests in the device flow appear
	// consistent from Tidal's perspective.
	tidalUA = "TIDAL/1000 (Linux; Android 10)"
)

// DeviceStart is the code + link the site displays to the user.
type DeviceStart struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

// PollOutcome is one poll of a device code. State is pending, slow_down, expired, error or
// authorized.
type PollOutcome struct {
	State        string `json:"state"`
	Detail       string `json:"detail,omitempty"`
	AccessToken  string `json:"-"`
	RefreshToken string `json:"-"`
	ExpiresIn    int    `json:"-"`
	CountryCode  string `json:"-"`
	UserID       int64  `json:"-"`
}

// StartDeviceAuth kicks off a device authorization.
func StartDeviceAuth(ctx context.Context) (DeviceStart, error) {
	form := url.Values{"client_id": {tidalClientID}, "scope": {tidalScope}}
	res, err := httpx.PostForm(ctx, tidalDeviceAuthURL, map[string]string{"user-agent": tidalUA}, form, 12*time.Second)
	if err != nil {
		return DeviceStart{}, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		status := res.StatusCode
		_ = res.Body.Close()
		return DeviceStart{}, &httpStatusError{status: status, prefix: "device_authorization failed"}
	}
	var body struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationURI         string `json:"verificationUri"`
		VerificationURIComplete string `json:"verificationUriComplete"`
		ExpiresIn               int    `json:"expiresIn"`
		Interval                int    `json:"interval"`
	}
	if err := httpx.ReadJSON(res, &body); err != nil {
		return DeviceStart{}, err
	}
	return DeviceStart{
		DeviceCode:              body.DeviceCode,
		UserCode:                body.UserCode,
		VerificationURI:         body.VerificationURI,
		VerificationURIComplete: body.VerificationURIComplete,
		ExpiresIn:               body.ExpiresIn,
		Interval:                body.Interval,
	}, nil
}

// PollDeviceToken polls once. Callers should wait `interval` seconds between polls.
func PollDeviceToken(ctx context.Context, deviceCode string) (PollOutcome, error) {
	form := url.Values{
		"client_id":     {tidalClientID},
		"client_secret": {tidalClientSecret},
		"device_code":   {deviceCode},
		"grant_type":    {"urn:ietf:params:oauth:grant-type:device_code"},
		"scope":         {tidalScope},
	}
	res, err := httpx.PostForm(ctx, tidalTokenURL, map[string]string{"user-agent": tidalUA}, form, 12*time.Second)
	if err != nil {
		return PollOutcome{}, err
	}

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		var body struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
			User         struct {
				CountryCode string `json:"countryCode"`
				UserID      int64  `json:"userId"`
			} `json:"user"`
		}
		if err := httpx.ReadJSON(res, &body); err != nil {
			return PollOutcome{}, err
		}
		return PollOutcome{
			State:        "authorized",
			AccessToken:  body.AccessToken,
			RefreshToken: body.RefreshToken,
			ExpiresIn:    body.ExpiresIn,
			CountryCode:  body.User.CountryCode,
			UserID:       body.User.UserID,
		}, nil
	}

	// Non-2xx: inspect the OAuth error to decide whether to keep polling.
	status := res.StatusCode
	var oauthErr struct {
		Error string `json:"error"`
	}
	decodeErr := httpx.ReadJSON(res, &oauthErr)
	code := oauthErr.Error
	if decodeErr != nil {
		code = ""
	}
	switch code {
	case "authorization_pending":
		return PollOutcome{State: "pending"}, nil
	case "slow_down":
		return PollOutcome{State: "slow_down"}, nil
	case "expired_token", "expired":
		return PollOutcome{State: "expired"}, nil
	default:
		detail := code
		if detail == "" {
			detail = "HTTP " + strconv.Itoa(status)
		}
		return PollOutcome{State: "error", Detail: detail}, nil
	}
}

type httpStatusError struct {
	status int
	prefix string
}

func (e *httpStatusError) Error() string { return e.prefix + ": HTTP " + strconv.Itoa(e.status) }
