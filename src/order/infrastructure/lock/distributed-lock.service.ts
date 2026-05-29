import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { LOCK_REDIS } from '../redis/redis.tokens';
import { LockAcquisitionError } from '../../domain/errors/order.errors';

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class DistributedLockService {
  private readonly ttl: number;

  constructor(
    @Inject(LOCK_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.ttl = this.config.get<number>('lock.ttlSeconds', 60);
  }

  /**
   * 분산 락 획득.
   * Redis SET NX EX 는 단일 원자 명령으로 경쟁 조건 없음.
   */
  async acquire(orderId: string, holderToken: string): Promise<boolean> {
    const result = await this.redis.set(
      this.key(orderId),
      holderToken,
      'EX',
      this.ttl,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * 내가 설정한 락만 해제 (Lua 스크립트로 원자적 GET → DEL).
   * TTL 초과로 락이 재할당된 경우 다른 Worker의 락을 실수로 지우지 않는다.
   */
  async release(orderId: string, holderToken: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key(orderId), holderToken);
  }

  async acquireOrThrow(orderId: string, holderToken: string): Promise<void> {
    const acquired = await this.acquire(orderId, holderToken);
    if (!acquired) {
      throw new LockAcquisitionError(orderId);
    }
  }

  private key(orderId: string): string {
    return `lock:order:${orderId}`;
  }
}
