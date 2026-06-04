/** Worker 서버 전용 모듈 — Queue 소비 + 상태 머신 + DB Write + POS 연동 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrderSharedModule } from './order-shared.module';
import { buildRedisOptions } from './infrastructure/redis/redis-connection.factory';
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
    BullModule.registerQueue(
      {
        name: ORDERS_QUEUE_NAME,
        connection: buildRedisOptions(),
        defaultJobOptions: {
          attempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10),
          backoff: {
            type: 'exponential',
            delay: parseInt(process.env.RETRY_BASE_DELAY_MS || '1000', 10),
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: false,
        },
      },
      { name: DLQ_QUEUE_NAME, connection: buildRedisOptions() },
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
