/** Worker 서버 전용 모듈 — Queue 소비 + 상태 머신 + DB Write + POS 연동 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { OrderSharedModule } from './order-shared.module';
import { ORDERS_QUEUE_NAME, DLQ_QUEUE_NAME, OrderQueueService } from './infrastructure/queue/order-queue.service';
import { ProcessOrderService } from './application/process-order.service';
import { OrderProcessor } from './worker/order.processor';
import { DlqProcessor } from './worker/dlq.processor';
import { QueueMetricsService } from './infrastructure/metrics/queue-metrics.service';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    OrderSharedModule,
    NotificationModule,
    BullModule.registerQueueAsync(
      {
        name: ORDERS_QUEUE_NAME,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: {
            host:     config.get<string>('redis.host', 'localhost'),
            port:     config.get<number>('redis.port', 6379),
            password: config.get<string>('redis.password') || undefined,
            tls:      config.get<boolean>('redis.tls', false) ? {} : undefined,
          },
          defaultJobOptions: {
            attempts: config.get<number>('retry.maxAttempts', 3),
            backoff: {
              type: 'exponential',
              delay: config.get<number>('retry.baseDelayMs', 1000),
            },
            removeOnComplete: { count: 1000 },
            removeOnFail: false,
          },
        }),
      },
      {
        name: DLQ_QUEUE_NAME,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: {
            host:     config.get<string>('redis.host', 'localhost'),
            port:     config.get<number>('redis.port', 6379),
            password: config.get<string>('redis.password') || undefined,
            tls:      config.get<boolean>('redis.tls', false) ? {} : undefined,
          },
        }),
      },
    ),
  ],
  providers: [
    OrderQueueService,
    ProcessOrderService,
    OrderProcessor,
    DlqProcessor,
    QueueMetricsService,
  ],
})
export class OrderWorkerModule {}
