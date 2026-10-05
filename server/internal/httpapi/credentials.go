// SPDX-License-Identifier: GPL-3.0-or-later
package httpapi

import (
	"encoding/json"
	"net/http"

	"archivepool/server/internal/health"
	"archivepool/server/internal/oauth"
	"archivepool/server/internal/pool"
)

// The response shapes are structs so the serialized key order matches the TS object literals.
type pollState struct {
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type savedIngest struct {
	State   string `json:"state"`
	Saved   bool   `json:"saved"`
	OK      bool   `json:"ok"`
	Status  string `json:"status"`
	Premium bool   `json:"premium"`
	Detail  string `json:"detail"`
}

type failedIngest struct {
	State  string `json:"state"`
	Saved  bool   `json:"saved"`
	Detail string `json:"detail"`
}

type needsSecret struct {
	State         string `json:"state"`
	UserAuthToken string `json:"userAuthToken"`
	AppID         string `json:"appId"`
	UserID        string `json:"userId"`
	// Absent when Qobuz's login response carried no country_code, exactly as the TS object literal
	// serializes (`countryCode: loginResult.countryCode`, undefined keys are dropped).
	CountryCode string `json:"countryCode,omitempty"`
	Detail      string `json:"detail"`
}

// handleTidalDeviceStart is POST /api/tidal/device/start.
func (s *Server) handleTidalDeviceStart(w http.ResponseWriter, r *http.Request) {
	start, err := oauth.StartDeviceAuth(r.Context())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error": "start_failed", "detail": errMessage(err),
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, start, nil)
}

// handleTidalDevicePoll is POST /api/tidal/device/poll. When the user has authorized, the resulting
// access token is health-checked and added to the pool as a Tidal account.
func (s *Server) handleTidalDevicePoll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		DeviceCode string `json:"deviceCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		body.DeviceCode = ""
	}
	deviceCode := trimString(body.DeviceCode)
	if deviceCode == "" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "missing_device_code"}, nil)
		return
	}

	outcome, err := oauth.PollDeviceToken(ctx, deviceCode)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, pollState{State: "error", Detail: errMessage(err)}, nil)
		return
	}

	if outcome.State != "authorized" {
		writeJSON(w, http.StatusOK, pollState{State: outcome.State, Detail: outcome.Detail}, nil)
		return
	}

	// Authorized: build the account payload and ingest it exactly like a manual submission.
	payload := map[string]any{
		"token": outcome.AccessToken,
		"note":  "Added via Tidal sign-in",
	}
	if outcome.RefreshToken != "" {
		payload["refreshToken"] = outcome.RefreshToken
	}
	if outcome.CountryCode != "" {
		payload["countryCode"] = outcome.CountryCode
	}

	result, err := health.IngestSource(ctx, s.DB, pool.ServiceTidal, pool.KindAccount, payload, health.IngestOptions{})
	if err != nil {
		logf("[tidal] device poll ingest failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, failedIngest{
			State: "authorized", Saved: false, Detail: health.DescribeSaveError(s.Cfg.DatabaseURL, err),
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, savedIngest{
		State: "authorized", Saved: result.Saved, OK: result.OK,
		Status: result.Status, Premium: result.Premium, Detail: result.Detail,
	}, nil)
}

// handleQobuzLogin is POST /api/qobuz/login: credential login, app_secret scrape, then ingest.
func (s *Server) handleQobuzLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		body.Username, body.Password = "", ""
	}
	username := trimString(body.Username)
	password := trimString(body.Password)
	if username == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, errJSON("missing_credentials", "Email and password are required."), nil)
		return
	}

	// Step 1: sign in to Qobuz.
	login, err := oauth.QobuzLogin(ctx, username, password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, errJSON("login_failed", errMessage(err)), nil)
		return
	}

	// Step 2: scrape the app_secret from the web player bundle.
	appSecret := oauth.ScrapeQobuzAppSecret(ctx)
	secretOK := appSecret != "" && oauth.ValidateAppSecret(ctx, appSecret, login.UserAuthToken)

	if appSecret == "" || !secretOK {
		// Login succeeded but we can't get a working secret — return the token anyway so the user can
		// still manually paste the app_secret if needed.
		writeJSON(w, http.StatusOK, needsSecret{
			State:         "needs_secret",
			UserAuthToken: login.UserAuthToken,
			AppID:         oauth.QobuzAppID,
			UserID:        login.UserID,
			CountryCode:   login.CountryCode,
			Detail:        "Signed in, but could not scrape app_secret from bundle. Please paste it manually.",
		}, nil)
		return
	}

	// Step 3: build payload and ingest, just like Tidal's device poll endpoint.
	payload := map[string]any{
		"token":     login.UserAuthToken,
		"appId":     oauth.QobuzAppID,
		"appSecret": appSecret,
		"note":      "Added via Qobuz sign-in",
	}
	if login.Username != "" {
		payload["username"] = login.Username
	}
	if login.CountryCode != "" {
		payload["countryCode"] = login.CountryCode
	}

	result, err := health.IngestSource(ctx, s.DB, pool.ServiceQobuz, pool.KindAccount, payload, health.IngestOptions{})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, failedIngest{
			State: "authorized", Saved: false, Detail: health.DescribeSaveError(s.Cfg.DatabaseURL, err),
		}, nil)
		return
	}
	writeJSON(w, http.StatusOK, savedIngest{
		State: "authorized", Saved: result.Saved, OK: result.OK,
		Status: result.Status, Premium: result.Premium, Detail: result.Detail,
	}, nil)
}
