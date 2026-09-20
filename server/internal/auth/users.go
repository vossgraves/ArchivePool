package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/kdf"
)

// OWASP-recommended scrypt parameters for interactive logins (lib/users.ts).
const (
	ScryptN   = 16384
	ScryptR   = 8
	ScryptP   = 1
	KeyLength = 64
)

// UsernamePattern is the validation rule the signup route enforces.
var UsernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,24}$`)

// HashPassword produces the exact `N:r:p:salt:hash` hex format the TS writes.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived := kdf.Scrypt([]byte(password), salt, ScryptN, ScryptR, ScryptP, KeyLength)
	return strconv.Itoa(ScryptN) + ":" + strconv.Itoa(ScryptR) + ":" + strconv.Itoa(ScryptP) + ":" +
		hex.EncodeToString(salt) + ":" + hex.EncodeToString(derived), nil
}

// VerifyPassword re-derives with the parameters stored in the row, so hashes written by the TS keep
// verifying after the cutover.
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, ":")
	if len(parts) != 5 {
		return false
	}
	n, errN := strconv.Atoi(parts[0])
	r, errR := strconv.Atoi(parts[1])
	p, errP := strconv.Atoi(parts[2])
	if errN != nil || errR != nil || errP != nil {
		return false
	}
	salt, err := hex.DecodeString(parts[3])
	if err != nil || len(salt) == 0 {
		return false
	}
	expected, err := hex.DecodeString(parts[4])
	if err != nil || len(expected) == 0 {
		return false
	}
	derived := kdf.Scrypt([]byte(password), salt, n, r, p, len(expected))
	return subtle.ConstantTimeCompare(derived, expected) == 1
}

// ValidateCredentials returns the user-facing problem, or "" when the pair is acceptable.
func ValidateCredentials(username, password string) string {
	if !UsernamePattern.MatchString(username) {
		return "Username must be 3-24 characters: lowercase letters, digits, underscores."
	}
	if len(password) < 8 || len(password) > 128 {
		return "Password must be 8-128 characters."
	}
	return ""
}

// FindUserByUsername returns the row (password_hash included) or an invalid Row.
func FindUserByUsername(ctx context.Context, database *db.DB, username string) (db.Row, error) {
	return database.QueryRow(ctx, `select * from users where username = $1 limit 1`, username)
}

// FindUsernameByID is the username for a session id, or nil when the account is gone or disabled.
// Used where only the id is at hand (server actions) and a public credit name is needed.
func FindUsernameByID(ctx context.Context, database *db.DB, userID int) *string {
	row, err := database.QueryRow(ctx,
		`select username, disabled from users where id = $1 limit 1`, userID)
	if err != nil || !row.Valid() || row.Bool("disabled") {
		return nil
	}
	name := row.Str("username")
	return &name
}

// CreateUser inserts an account and returns its id and username.
func CreateUser(ctx context.Context, database *db.DB, username, password, ip, ua string) (int, string, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return 0, "", err
	}
	row, err := database.QueryRow(ctx, `
		insert into users (username, password_hash, created_ip, created_ua, last_login_ip, last_login_ua)
		values ($1, $2, $3, $4, $5, $6)
		returning id, username`, username, hash, ip, ua, ip, ua)
	if err != nil {
		return 0, "", err
	}
	return row.Int("id"), row.Str("username"), nil
}

// UpdateLastLogin records where a login came from. Callers treat a failure as non-fatal.
func UpdateLastLogin(ctx context.Context, database *db.DB, userID int, ip, ua string) error {
	_, err := database.Exec(ctx,
		`update users set last_login_ip = $1, last_login_ua = $2 where id = $3`, ip, ua, userID)
	return err
}

// CountRecentUsersByIpUa counts accounts created from one IP+UA inside the window, which is the
// signup route's mass-creation guard.
func CountRecentUsersByIpUa(ctx context.Context, database *db.DB, ip, ua string, hours int) (int, error) {
	if ip == "" || ua == "" {
		return 0, nil
	}
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)
	rows, err := database.Query(ctx, `
		select id from users
		where created_ip = $1 and created_ua = $2 and created_at >= $3`, ip, ua, cutoff)
	if err != nil {
		return 0, err
	}
	return rows.Len(), nil
}

// IsAdminUser reports whether an account holds the admin role and is enabled.
func IsAdminUser(ctx context.Context, database *db.DB, userID int) bool {
	row, err := database.QueryRow(ctx, `select role, disabled from users where id = $1 limit 1`, userID)
	if err != nil || !row.Valid() {
		return false
	}
	return !row.Bool("disabled") && row.Str("role") == "admin"
}

// UserRoleResult is the outcome of a role change.
type UserRoleResult struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

// SetUserRole promotes or demotes an account. Nil when the account does not exist.
func SetUserRole(ctx context.Context, database *db.DB, userID int, role string) (*UserRoleResult, error) {
	row, err := database.QueryRow(ctx,
		`update users set role = $1 where id = $2 returning id, username, role`, role, userID)
	if err != nil {
		return nil, err
	}
	if !row.Valid() {
		return nil, nil
	}
	return &UserRoleResult{ID: row.Int("id"), Username: row.Str("username"), Role: row.Str("role")}, nil
}

// AdminUser is one account in the admin panel. Never selects password_hash.
type AdminUser struct {
	ID          int    `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	Disabled    bool   `json:"disabled"`
	CreatedAt   string `json:"createdAt"`
	LastLoginIP string `json:"lastLoginIp"`
}

// ListUsersForAdmin lists accounts newest first.
func ListUsersForAdmin(ctx context.Context, database *db.DB) ([]AdminUser, error) {
	rows, err := database.Query(ctx, `
		select id, username, role, disabled, created_at, last_login_ip
		from users order by created_at desc`)
	if err != nil {
		return nil, err
	}
	out := make([]AdminUser, 0, rows.Len())
	for _, r := range rows.All() {
		u := AdminUser{
			ID:          r.Int("id"),
			Username:    r.Str("username"),
			Role:        r.Str("role"),
			Disabled:    r.Bool("disabled"),
			LastLoginIP: r.Str("last_login_ip"),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			u.CreatedAt = *created
		}
		out = append(out, u)
	}
	return out, nil
}
