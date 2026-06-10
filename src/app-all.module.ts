import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { OrderApiModule } from './order/order-api.module';
import { OrderWorkerModule } from './order/order-worker.module';
import { AdminModule } from './admin/admin.module';
import { MenuAdminModule } from './menu/menu-admin.module';

@Module({ imports: [AppModule, OrderApiModule, OrderWorkerModule, AdminModule, MenuAdminModule] })
export class AppAllModule {}
