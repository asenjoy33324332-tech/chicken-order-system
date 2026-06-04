import { Controller, Get, Param, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Flutter 앱이 공통으로 사용하는 공개 엔드포인트.
 * BBQ 서버와 동일한 경로명을 유지해 앱 API 호출 경로 변경을 최소화한다.
 */
@Controller()
export class PublicController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  // BBQ 앱 호환 헬스체크 경로
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // 매장 메뉴 목록 (BBQ의 GET /menus?app=order 와 호환)
  @Get('menus')
  async getMenus(@Query('storeId') storeId?: string) {
    if (!storeId) return { ok: false, menus: [] };
    const rows = await this.ds.query<Array<{
      id: string; name: string; unit_price: string; is_available: boolean;
    }>>(
      `SELECT id, name, unit_price, is_available
         FROM menus
        WHERE store_id = $1 AND is_available = TRUE
        ORDER BY name`,
      [storeId],
    );
    return {
      ok: true,
      menus: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.unit_price),
        unitPrice: parseFloat(r.unit_price),
        isAvailable: r.is_available,
        category: '치킨',
        appTarget: 'all',
      })),
    };
  }

  // BBQ 앱 호환 주문 상태 조회
  @Get('order-status/:id')
  async getOrderStatus(@Param('id') id: string) {
    const rows = await this.ds.query<Array<{
      id: string; status: string; store_id: string;
      created_at: Date; updated_at: Date;
    }>>(
      `SELECT id, status, store_id, created_at, updated_at
         FROM orders WHERE id = $1`,
      [id],
    );
    if (!rows.length) return { ok: false, message: '주문 없음' };
    const o = rows[0];
    return {
      ok: true,
      id: o.id,
      status: o.status,
      storeId: o.store_id,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    };
  }
}
