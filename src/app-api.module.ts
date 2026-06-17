import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { OrderApiModule } from './order/order-api.module';
import { AdminModule } from './admin/admin.module';
import { MenuAdminModule } from './menu/menu-admin.module';
import { AuthModule } from './auth/auth.module';

@Module({ imports: [AppModule, OrderApiModule, AdminModule, MenuAdminModule, AuthModule] })
export class AppApiModule {}
