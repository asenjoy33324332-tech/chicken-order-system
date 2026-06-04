/** API 서버 전용 모듈 — DB Write 없음, Queue 적재만 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { OrderSharedModule } from './order-shared.module';
import { OrderQueueService, ORDERS_QUEUE_NAME, DLQ_QUEUE_NAME } from './infrastructure/queue/order-queue.service';
import { CreateOrderService } from './application/create-order.service';
import { OrderController } from './api/order.controller';
import { InternalBridgeController } from './api/internal-bridge.controller';

@Module({
  imports: [
    OrderSharedModule,
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
  providers: [OrderQueueService, CreateOrderService],
  controllers: [OrderController, InternalBridgeController],
})
export class OrderApiModule {}
