// SPDX-License-Identifier: GPL-3.0-or-later
// Package migrations embeds the SQL DDL. Package-level (rather than inside internal/) because
// go:embed cannot reach a parent directory, and the task's layout keeps the DDL at server/migrations.
package migrations

import _ "embed"

// SchemaSQL is scripts/schema.sql, verbatim: the fresh-install DDL.
//
//go:embed 001_schema.sql
var SchemaSQL string
