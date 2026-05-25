import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { AppLogger } from '../common/logger/logger.service';

@Module({
  providers: [NotificationService, AppLogger],
  exports: [NotificationService],
})
export class NotificationModule {}
