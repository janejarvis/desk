#!/bin/sh
# Opens a link in Google Chrome (used as BROWSER for Claude's sign-in, so it doesn't open in Safari: 12 Nov 2026).
exec open -a "Google Chrome" "$@"
