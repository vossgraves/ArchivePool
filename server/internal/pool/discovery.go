// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import (
	"context"
	"strings"

	"archivepool/server/internal/db"
)

// Discovery is the `{ streaming, api }` shape the app's discoverInstances() parser expects. The
// same URLs are mirrored under both keys: "streaming" is the preferred audio-serving list, and the
// app's parser is unchanged by seeing them twice.
type Discovery struct {
	Streaming []string `json:"streaming"`
	API       []string `json:"api"`
}

// GetDiscovery reads the servable instance URLs for one service, deduplicated while preserving the
// premium/last-checked order.
func GetDiscovery(ctx context.Context, database *db.DB, service Service) (Discovery, error) {
	database.EnsureSchema(ctx)
	rows, err := database.Query(ctx, `
		select payload, premium, status
		from instance_entries
		where service = $1 and removed = false and disabled = false
		  and status in ('alive','preview')
		order by premium desc, last_checked_at desc`, string(service))
	if err != nil {
		return Discovery{}, err
	}

	seen := map[string]bool{}
	urls := make([]string, 0, rows.Len())
	for _, row := range rows.All() {
		base, _ := row.JSON("payload")["baseUrl"].(string)
		base = strings.TrimSpace(base)
		if base == "" || seen[base] {
			continue
		}
		seen[base] = true
		urls = append(urls, base)
	}
	return Discovery{Streaming: urls, API: urls}, nil
}
