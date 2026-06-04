import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { CACHE_REDIS } from '../redis/redis.tokens';

const REDIS_CHANNEL = 'order-status';

@Injectable()
export class OrderStatusPublisherService {
  private readonly logger = new Logger(OrderStatusPublisherService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(CACHE_REDIS) private readonly redis: Redis,
  ) {}

  async publish(orderId: string, status: string, meta: Record<string, unknown> = {}): Promise<void> {
    const event = { orderId, status, ...meta, publishedAt: new Date().toISOString() };

    // ① Redis Pub/Sub — fire-and-forget, Worker 블로킹 없음
    this.redis.publish(REDIS_CHANNEL, JSON.stringify(event))
      .catch(err => this.logger.warn(JSON.stringify({ event: 'REDIS_PUBLISH_FAIL', error: err.message })));

    // ② PostgreSQL outbox — Redis 장애 폴백용
    await this.ds.query(
      `INSERT INTO order_status_outbox
         (order_id, status, payload, delivered, created_at)
       VALUES ($1, $2, $3, false, NOW())
       ON CONFLICT DO NOTHING`,
      [orderId, status, JSON.stringify(event)],
    );
  }
}
