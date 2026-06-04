FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# 최소 권한 실행 유저
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER nestjs

# ECS 헬스 체크 (ALB healthcheck와 동일 엔드포인트)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/admin/health || exit 1

EXPOSE 3000

# ECS SIGTERM → Graceful shutdown (main.ts에 SIGTERM 핸들러 구현됨)
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
