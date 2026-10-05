# 혁게임 프로덕션 이미지 (Synology NAS 등 셀프 호스팅용)
# 빌드: docker build -t hwatu-game .
# 실행: docker run -p 3300:3300 -e DATABASE_URL=... -e ADMIN_KEY=... hwatu-game
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3300 \
    TRUST_PROXY=1 \
    TZ=Asia/Seoul

# 시간대 데이터 (로그 시각을 한국 시간으로)
RUN apk add --no-cache tzdata

WORKDIR /app

# 의존성 먼저 (캐시 재사용)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 실행에 필요한 파일만
COPY server.js ./
COPY lib ./lib
COPY shared ./shared
COPY public ./public
COPY public-admin ./public-admin

# DATABASE_URL 이 없을 때 쓰는 JSON 저장소 폴더 (쓰기 가능해야 함) + 비루트 사용자
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node

EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
