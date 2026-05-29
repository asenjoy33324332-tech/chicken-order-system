export default () => ({
  appMode: process.env.APP_MODE || 'all',
  port: parseInt(process.env.PORT || '3000', 10),

  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'orderuser',
    password: process.env.DATABASE_PASSWORD || 'orderpass',
    database: process.env.DATABASE_NAME || 'orderdb',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    // 역할별 DB 분리 (BullMQ는 DB 0 사용)
    idempotencyDb: parseInt(process.env.REDIS_IDEMPOTENCY_DB || '1', 10),
    lockDb:        parseInt(process.env.REDIS_LOCK_DB        || '2', 10),
    cacheDb:       parseInt(process.env.REDIS_CACHE_DB       || '3', 10),
  },

  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
    openDurationMs: parseInt(process.env.CB_OPEN_DURATION_MS || '30000', 10),
  },

  retry: {
    maxAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10),
    baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '1000', 10),
  },

  lock: {
    ttlSeconds: parseInt(process.env.LOCK_TTL_SECONDS || '60', 10),
  },

  idempotency: {
    ttlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10),
  },

  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    alertChannel: process.env.SLACK_ALERT_CHANNEL || '#order-failures',
  },

  adminBaseUrl: process.env.ADMIN_BASE_URL || 'http://localhost:3000',
});
