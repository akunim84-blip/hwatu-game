#!/usr/bin/env bash
cd "$(dirname "$0")/.."
for f in run/server.pid run/tunnel.pid run/lhr.pid run/lhr-watch.pid run/cfretry.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null; done
for p in $(pgrep -f '^node server[.]js'); do kill $p; done
for p in $(pgrep -f 'cloudflared tunnel --ur[l]'); do kill $p; done
for p in $(pgrep -f 'ssh -t[t] .*localhost.run'); do kill $p; done
echo stopped
