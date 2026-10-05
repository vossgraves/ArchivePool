// SPDX-License-Identifier: GPL-3.0-or-later
package auth

import (
	"log"
	"runtime/debug"
)

// safeGo runs fn in a goroutine with panic recovery.
func safeGo(fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("auth goroutine panic: %v\n%s", r, debug.Stack())
			}
		}()
		fn()
	}()
}
