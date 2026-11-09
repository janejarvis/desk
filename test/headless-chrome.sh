#!/bin/sh
# Starts a headless Chrome on a Desk page for tests, and waits until it answers: test/headless-chrome.sh <debug port> [desk port]
P=$1; T=$(mktemp -d); ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --remote-debugging-port=$P --user-data-dir=$T/ch --window-size=1400,850 http://127.0.0.1:${2:-4848}/ >/dev/null 2>&1 &)
for i in $(seq 1 40); do curl -s localhost:$P/json >/dev/null 2>&1 && break; sleep 0.5; done; sleep 4
