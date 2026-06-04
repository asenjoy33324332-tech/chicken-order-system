/** API 서버 전용 모듈 — DB Write 없음, Queue 적재만 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrderSharedModule } from './order-shared.module';
import { buildRedisOptions } from './infrastructure/redis/redis-connection.factory';
import { OrderQueueService, ORDERS_QUEUE_NAME, DLQ_QUEUE_NAME } from './infrastructure/queue/order-queue.service';
import { CreateOrderService } from './application/create-order.service';
import { OrderController } from './api/order.controller';
import { InternalBridgeController } from './api/internal-bridge.controller';
import { PublicController } from '../common/public.controller';

@Module({
  imports: [
    OrderSharedModule,
    BullModule.registerQueue(
      { name: ORDERS_QUEUE_NAME, connection: buildRedisOptions() },
      { name: DLQ_QUEUE_NAME,    connection: buildRedisOptions() },
    ),
  ],
  providers: [OrderQueueService, CreateOrderService],
  controllers: [OrderController, InternalBridgeController, PublicController],
})
export class OrderApiModule {}
