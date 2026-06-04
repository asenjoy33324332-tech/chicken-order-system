/**
 * API 서버와 Worker 서버 모두에서 공유하는 인프라 의존성.
 * DB, Redis, Repository, 공통 서비스를 여기서 제공한다.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { OrderEntity } from './domain/entities/order.entity';
import { OrderItemEntity } from './domain/entities/order-item.entity';
import { OrderStateTransitionEntity } from './domain/entities/order-state-transition.entity';
import { StoreEntity } from './domain/entities/store.entity';
import { MenuEntity } from './domain/entities/menu.entity';
import { OrderRepository } from './infrastructure/repositories/order.repository';
import { IdempotencyService } from './infrastructure/idempotency/idempotency.service';
import { DistributedLockService } from './infrastructure/lock/distributed-lock.service';
import { PosCircuitBreakerService } from './infrastructure/pos/circuit-breaker/pos-circuit-breaker.service';
import { PosAdapterFactory } from './infrastructure/pos/pos-adapter.factory';
import { AppLogger } from '../common/logger/logger.service';
import { IDEMPOTENCY_REDIS, LOCK_REDIS, CACHE_REDIS } from './infrastructure/redis/redis.tokens';

const TRANSIENT_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ENOTFOUND', 'ETIMEDOUT']);

const makeRedisProvider = (token: string, keyPrefix: string) => ({
  provide: token,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const redisUrl = process.env.REDIS_URL;
    const options = {
      keyPrefix,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
      reconnectOnError: (err: Error & { code?: string }) =>
        err.code === 'ECONNRESET' || (err.message?.includes('READONLY') ?? false),
    };

    // rediss:// URL 직접 사용 시 TLS가 자동 설정됨 (Upstash 권장 방식)
    const client = redisUrl
      ? new Redis(redisUrl, options)
      : new Redis({
          host:     config.get<string>('redis.host', 'localhost'),
          port:     config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
          tls:      config.get<boolean>('redis.tls', false) ? { rejectUnauthorized: false } : undefined,
          ...options,
        });

    // "Unhandled error event" 스팸 방지 — transient 에러는 ioredis가 자동 재연결
    client.on('error', (err: Error & { code?: string }) => {
      if (!TRANSIENT_ERRORS.has(err.code ?? '')) {
        console.error('[Redis] fatal error:', err.message);
      }
    });

    return client;
  },
});

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderItemEntity,
      OrderStateTransitionEntity,
      StoreEntity,
      MenuEntity,
    ]),
  ],
  providers: [
    makeRedisProvider(IDEMPOTENCY_REDIS, 'idp:'),
    makeRedisProvider(LOCK_REDIS,        'lck:'),
    makeRedisProvider(CACHE_REDIS,       'cch:'),
    OrderRepository,
    IdempotencyService,
    DistributedLockService,
    PosCircuitBreakerService,
    PosAdapterFactory,
    AppLogger,
  ],
  exports: [
    IDEMPOTENCY_REDIS,
    LOCK_REDIS,
    CACHE_REDIS,
    OrderRepository,
    IdempotencyService,
    DistributedLockService,
    PosCircuitBreakerService,
    PosAdapterFactory,
    AppLogger,
  ],
})
export class OrderSharedModule {}
