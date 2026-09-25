#!/usr/bin/env bash
# cloudflared 빠른 터널을 429 해제될 때까지 5분마다 재시도. 성공하면 계속 유지하고 run/cf_url.txt 에 기록.
cd "$(dirname "$0")/.."
PORT=${PORT:-3300}
while true; do
  if [ -f run/tunnel.pid ] && kill -0 $(cat run/tunnel.pid) 2>/dev/null && [ -s run/cf_url.txt ]; then sleep 30; continue; fi
  rm -f run/cf_url.txt; : > run/tunnel.log
  cloudflared tunnel --no-autoupdate --url http://localhost:$PORT >> run/tunnel.log 2>&1 &
  echo $! > run/tunnel.pid
  for i in $(seq 1 30); do
    U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' run/tunnel.log | head -1)
    [ -n "$U" ] && { echo "$U" > run/cf_url.txt; break; }
    grep -q "provisioning failed" run/tunnel.log && break
    sleep 1
  done
  [ -s run/cf_url.txt ] || { kill $(cat run/tunnel.pid) 2>/dev/null; sleep 300; }
done
