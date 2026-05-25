import {
  Controller, Post, Get, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** DLQ 목록 조회 */
  @Get('orders/dlq')
  getDlqOrders(
    @Query('storeId') storeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.getDlqOrders({
      storeId,
      from,
      to,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  /** 단일 주문 수동 재처리 */
  @Post('orders/:orderId/redrive')
  @HttpCode(HttpStatus.OK)
  redriveOrder(@Param('orderId') orderId: string) {
    return this.admin.redriveOrder(orderId);
  }

  /** 시스템 상태 (큐 깊이, 서킷 브레이커) */
  @Get('system/status')
  getStatus(@Query('storeIds') storeIds?: string) {
    const ids = storeIds ? storeIds.split(',') : [];
    return this.admin.getSystemStatus(ids);
  }

  /** 헬스 체크 */
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
