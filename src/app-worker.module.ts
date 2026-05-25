import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { OrderWorkerModule } from './order/order-worker.module';

@Module({ imports: [AppModule, OrderWorkerModule] })
export class AppWorkerModule {}
