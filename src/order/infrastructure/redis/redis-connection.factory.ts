import type { RedisOptions } from 'ioredis';

/**
 * REDIS_URL(rediss://)이 있으면 URL에서 파싱, 없으면 개별 env 사용.
 * BullMQ connection 및 ioredis 직접 생성 양쪽에서 재사용한다.
 *
 * keepAlive: 30000 — Upstash Free 플랜은 60초 유휴 연결을 강제 종료한다.
 * 30초마다 TCP keepalive 패킷을 전송해 연결을 유지한다.
 */
export function buildRedisOptions(): RedisOptions {
  const url = process.env.REDIS_URL;

  const base: RedisOptions = {
    keepAlive: 30000,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  };

  if (url) {
    const parsed = new URL(url);
    return {
      ...base,
      host:     parsed.hostname,
      port:     parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      tls:      url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    ...base,
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}
