package pool

import "log"

// logf is the pool package's logger. The TS logs a one-line diagnosis and carries on; every
// swallow-errors call site here does the same rather than surfacing a bookkeeping failure as a
// failed request.
func logf(format string, args ...any) { log.Printf(format, args...) }
