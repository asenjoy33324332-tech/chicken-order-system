import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { OrderSharedModule } from '../order/order-shared.module';
import { ORDERS_QUEUE_NAME, DLQ_QUEUE_NAME, OrderQueueService } from '../order/infrastructure/queue/order-queue.service';

@Module({
  imports: [
    OrderSharedModule,
    BullModule.registerQueueAsync(
      {
        name: ORDERS_QUEUE_NAME,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: {
            host: config.get<string>('redis.host', 'localhost'),
            port: config.get<number>('redis.port', 6379),
          },
        }),
      },
      {
        name: DLQ_QUEUE_NAME,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: {
            host: config.get<string>('redis.host', 'localhost'),
            port: config.get<number>('redis.port', 6379),
          },
        }),
      },
    ),
  ],
  providers: [AdminService, OrderQueueService],
  controllers: [AdminController],
})
export class AdminModule {}
