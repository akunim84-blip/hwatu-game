#!/usr/bin/env bash
# 서버 + cloudflared 임시 터널을 백그라운드로 (재)시작
cd "$(dirname "$0")/.."
PORT=${PORT:-3300}
mkdir -p run
[ -f run/server.pid ] && kill $(cat run/server.pid) 2>/dev/null
pkill -f "node server.js" 2>/dev/null
setsid nohup bash -c "while true; do PORT=$PORT node server.js >> run/server.log 2>&1; echo 'server exited, restarting' >> run/server.log; sleep 1; done" > /dev/null 2>&1 &
echo $! > run/server.pid
sleep 1
curl -s localhost:$PORT/health && echo
if [ "$1" != "--no-tunnel" ]; then
  [ -f run/tunnel.pid ] && kill $(cat run/tunnel.pid) 2>/dev/null
  pkill -f "cloudflared tunnel --url" 2>/dev/null
  URL=""
  for attempt in 1 2; do
    : > run/tunnel.log
    setsid nohup cloudflared tunnel --no-autoupdate --url http://localhost:$PORT > run/tunnel.log 2>&1 &
    echo $! > run/tunnel.pid
    for i in $(seq 1 30); do
      URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' run/tunnel.log | head -1)
      [ -n "$URL" ] && break
      grep -q "provisioning failed" run/tunnel.log && break
      sleep 1
    done
    [ -n "$URL" ] && break
    echo "tunnel attempt $attempt failed: $(grep -o 'provisioning failed.*' run/tunnel.log)"; kill $(cat run/tunnel.pid) 2>/dev/null
    sleep 10
  done
  if [ -z "$URL" ]; then
    echo 'cloudflared 실패 → localhost.run 대체 터널 사용'
    URL=$(./scripts/tunnel-lhr.sh | tail -1)
    # 백그라운드에서 cloudflared 재시도 (성공 시 run/public_url.txt 가 cloudflare 주소로 바뀜)
    [ -f run/cfretry.pid ] && kill $(cat run/cfretry.pid) 2>/dev/null
    setsid nohup ./scripts/cf-retry.sh > /dev/null 2>&1 &
    echo $! > run/cfretry.pid
  fi
  echo "PUBLIC URL: $URL"
  case "$URL" in https://*) echo "$URL" > run/public_url.txt;; esac
fi
