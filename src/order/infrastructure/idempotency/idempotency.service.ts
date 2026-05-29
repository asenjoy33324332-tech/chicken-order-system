import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { IDEMPOTENCY_REDIS } from '../redis/redis.tokens';

export interface IdempotencyEntry {
  orderId: string;
  status: 'pending' | 'completed';
  response?: Record<string, unknown>;
}

@Injectable()
export class IdempotencyService {
  private readonly ttl: number;

  constructor(
    @Inject(IDEMPOTENCY_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.ttl = this.config.get<number>('idempotency.ttlSeconds', 86400);
  }

  /**
   * 새 요청인 경우에만 true를 반환하며 동시에 키를 점유(SETNX).
   * Redis Single-thread 보장으로 100개 동시 요청 중 1개만 true.
   */
  async tryAcquire(key: string, orderId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.pendingKey(key),
      orderId,
      'EX',
      this.ttl,
      'NX',
    );
    return result === 'OK';
  }

  /** Queue 적재 실패 시 점유한 키를 반환해 재시도 허용 */
  async release(key: string): Promise<void> {
    await this.redis.del(this.pendingKey(key));
  }

  /** 처리 완료 후 응답 캐시 저장 */
  async setCompleted(
    key: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.redis.set(
      this.responseKey(key),
      JSON.stringify(response),
      'EX',
      this.ttl,
    );
  }

  /** 중복 요청 시 캐시된 응답 조회 */
  async getCachedResponse(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.redis.get(this.responseKey(key));
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  async isPending(key: string): Promise<boolean> {
    const v = await this.redis.exists(this.pendingKey(key));
    return v > 0;
  }

  private pendingKey(key: string): string {
    return `idempotency:${key}`;
  }

  private responseKey(key: string): string {
    return `idempotency:${key}:response`;
  }
}
