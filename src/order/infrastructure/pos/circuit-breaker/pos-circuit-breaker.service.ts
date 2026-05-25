import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  handleAll,
  wrap,
  retry as makeRetry,
  circuitBreaker as makeCircuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  BrokenCircuitError,
} from 'cockatiel';
import Redis from 'ioredis';
import { CircuitBreakerOpenError } from '../../../domain/errors/order.errors';
import { REDIS_CLIENT } from '../../idempotency/idempotency.service';
import { AppLogger } from '../../../../common/logger/logger.service';

type CircuitPolicy = ReturnType<typeof wrap>;

/**
 * 매장별 독립 서킷 브레이커 레지스트리.
 * 단일 매장 POS 장애가 다른 매장이나 Worker 전체로 전파되지 않는다.
 */
@Injectable()
export class PosCircuitBreakerService {
  private readonly registry = new Map<string, CircuitPolicy>();
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.failureThreshold = this.config.get<number>('circuitBreaker.failureThreshold', 5);
    this.openDurationMs   = this.config.get<number>('circuitBreaker.openDurationMs', 30000);
  }

  async execute<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
    const policy = this.getOrCreate(storeId);

    try {
      return await (policy.execute(fn) as Promise<T>);
    } catch (err) {
      if (err instanceof BrokenCircuitError) {
        this.logger.warn({ event: 'CIRCUIT_BREAKER_OPEN', storeId });
        throw new CircuitBreakerOpenError(storeId);
      }
      throw err;
    }
  }

  async getStatus(storeId: string): Promise<'CLOSED' | 'OPEN' | 'UNKNOWN'> {
    const raw = await this.redis.hget(`cb:store:${storeId}`, 'state');
    if (!raw) return 'UNKNOWN';
    return raw as 'CLOSED' | 'OPEN';
  }

  private getOrCreate(storeId: string): CircuitPolicy {
    if (this.registry.has(storeId)) {
      return this.registry.get(storeId)!;
    }

    const cb = makeCircuitBreaker(handleAll, {
      halfOpenAfter: this.openDurationMs,
      breaker: new ConsecutiveBreaker(this.failureThreshold),
    });

    cb.onBreak(() => {
      this.logger.error({ event: 'CIRCUIT_BREAKER_OPEN', storeId });
      void this.redis.hset(`cb:store:${storeId}`, 'state', 'OPEN', 'updatedAt', new Date().toISOString());
    });
    cb.onReset(() => {
      this.logger.info({ event: 'CIRCUIT_BREAKER_CLOSE', storeId });
      void this.redis.hset(`cb:store:${storeId}`, 'state', 'CLOSED', 'updatedAt', new Date().toISOString());
    });

    const retryP = makeRetry(handleAll, {
      maxAttempts: 3,
      backoff: new ExponentialBackoff({ maxDelay: 4000, initialDelay: 1000 }),
    });

    const combined = wrap(retryP, cb);
    this.registry.set(storeId, combined);
    return combined;
  }
}
