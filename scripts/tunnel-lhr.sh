#!/usr/bin/env bash
# 대체 터널: localhost.run (SSH). cloudflared 가 429(요청 제한)일 때 사용
cd "$(dirname "$0")/.."
PORT=${PORT:-3300}
mkdir -p run
[ -f run/lhr.pid ] && kill $(cat run/lhr.pid) 2>/dev/null
: > run/lhr.log
setsid nohup bash -c "while true; do ssh -tt -o IdentityAgent=none -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:localhost:$PORT nokey@localhost.run < /dev/null; sleep 5; done" >> run/lhr.log 2>&1 &
echo $! > run/lhr.pid
# URL 이 재연결로 바뀌면 run/public_url.txt 자동 갱신
[ -f run/lhr-watch.pid ] && kill $(cat run/lhr-watch.pid) 2>/dev/null
setsid nohup bash -c 'while true; do if [ -s run/cf_url.txt ]; then cp run/cf_url.txt run/public_url.txt; else U=$(grep -oE "[a-z0-9]+\.lhr\.life" run/lhr.log | tail -1); [ -n "$U" ] && echo "https://$U" > run/public_url.txt; fi; sleep 10; done' > /dev/null 2>&1 &
echo $! > run/lhr-watch.pid
for i in $(seq 1 40); do
  URL=$(grep -oE '[a-z0-9]+\.lhr\.life' run/lhr.log | tail -1)
  [ -n "$URL" ] && break; sleep 1
done
[ -n "$URL" ] && echo "https://$URL" | tee run/public_url.txt || echo "no URL yet (see run/lhr.log)"
