import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MenuAdminController } from './menu-admin.controller';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [MenuAdminController],
})
export class MenuAdminModule {}
