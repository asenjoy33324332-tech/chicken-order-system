FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Graceful shutdown: ECS는 SIGTERM을 보내므로 70초 대기 (60초 처리 + 10초 여유)
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
