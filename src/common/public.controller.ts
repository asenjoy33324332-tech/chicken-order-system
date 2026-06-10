import {
  Controller, Get, Post, Param, Query, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreateOrderService } from '../order/application/create-order.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * Flutter 앱이 공통으로 사용하는 공개 엔드포인트.
 * BBQ 서버와 동일한 경로명을 유지해 앱 API 호출 경로 변경을 최소화한다.
 */
@Controller()
export class PublicController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly createOrder: CreateOrderService,
  ) {}

  // BBQ 앱 호환 헬스체크
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // 매장 메뉴 목록 (BBQ GET /menus?app=order 호환)
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
        optionTemplateIds: [],
      })),
    };
  }

  // 빈 카테고리/옵션 응답 (앱 크래시 방지)
  @Get('categories')
  getCategories() {
    return { ok: true, categories: [] };
  }

  @Get('options')
  getOptions() {
    return { ok: true, options: [] };
  }

  // 매장 기본 설정 (BBQ GET /settings 호환)
  @Get('settings')
  async getSettings(@Query('storeId') storeId?: string) {
    return {
      ok: true,
      isOpen: true,
      businessPaused: false,
      minOrderAmount: 0,
      storeNotice: '',
      deliveryGuide: '',
    };
  }

  // POS 주문 목록 조회 (BBQ GET /orders 호환)
  @Get('orders')
  async getOrders(@Query('storeId') storeId?: string) {
    if (!storeId) return { ok: false, orders: [] };
    const rows = await this.ds.query<Array<{
      id: string; status: string; store_id: string; trace_id: string;
      requested_amount: string; calculated_amount: string;
      created_at: Date; updated_at: Date; queued_at: Date;
    }>>(
      `SELECT o.id, o.status, o.store_id, o.trace_id,
              o.requested_amount, o.calculated_amount,
              o.created_at, o.updated_at, o.queued_at
         FROM orders o
        WHERE o.store_id = $1
          AND o.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [storeId],
    );

    const orderIds = rows.map((r) => r.id);
    let itemMap: Map<string, Array<{ menu_name: string; unit_price: string; quantity: number }>> = new Map();

    if (orderIds.length > 0) {
      const items = await this.ds.query<Array<{
        order_id: string; menu_name: string; unit_price: string; quantity: number;
      }>>(
        `SELECT order_id, menu_name, unit_price, quantity
           FROM order_items
          WHERE order_id = ANY($1)`,
        [orderIds],
      );
      for (const item of items) {
        if (!itemMap.has(item.order_id)) itemMap.set(item.order_id, []);
        itemMap.get(item.order_id)!.push(item);
      }
    }

    return {
      ok: true,
      orders: rows.map((o) => ({
        id: o.id,
        orderNo: o.id.slice(0, 8).toUpperCase(),
        status: this.mapStatus(o.status),
        storeId: o.store_id,
        total: parseFloat(o.calculated_amount),
        amount: parseFloat(o.calculated_amount),
        type: 'delivery',
        createdAt: o.created_at,
        orderedAt: o.queued_at || o.created_at,
        items: (itemMap.get(o.id) ?? []).map((i) => ({
          name: i.menu_name,
          price: parseFloat(i.unit_price),
          quantity: i.quantity,
        })),
      })),
    };
  }

  // 전체 지역 목록 (앱 지역 선택 화면용)
  @Get('areas')
  async getAreas() {
    const rows = await this.ds.query<Array<{
      id: string; name: string; store_id: string; sort_order: number;
    }>>(
      `SELECT a.id, a.name, a.store_id, a.sort_order
         FROM areas a
        WHERE a.is_active = TRUE
        ORDER BY a.store_id, a.sort_order`,
    );
    return {
      ok: true,
      areas: rows.map((r) => ({
        id: r.id,
        name: r.name,
        storeId: r.store_id,
        sortOrder: r.sort_order,
      })),
    };
  }

  // 특정 지역 조회 (storeId 반환)
  @Get('areas/:id')
  async getArea(@Param('id') id: string) {
    const rows = await this.ds.query<Array<{
      id: string; name: string; store_id: string;
    }>>(
      `SELECT id, name, store_id FROM areas WHERE id = $1 AND is_active = TRUE`,
      [id],
    );
    if (!rows.length) return { ok: false, message: '지역 없음' };
    return { ok: true, id: rows[0].id, name: rows[0].name, storeId: rows[0].store_id };
  }

  // 주문 상태 조회 (BBQ GET /order-status/:id 호환)
  @Get('order-status/:id')
  async getOrderStatus(@Param('id') id: string) {
    const rows = await this.ds.query<Array<{
      id: string; status: string; store_id: string;
      created_at: Date; updated_at: Date;
    }>>(
      `SELECT id, status, store_id, created_at, updated_at FROM orders WHERE id = $1`,
      [id],
    );
    if (!rows.length) return { ok: false, message: '주문 없음' };
    const o = rows[0];
    return {
      ok: true,
      id: o.id,
      status: this.mapStatus(o.status),
      storeId: o.store_id,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    };
  }

  // BBQ 앱 호환 주문 생성 (POST /order)
  @Post('order')
  @HttpCode(HttpStatus.ACCEPTED)
  async createOrderCompat(@Body() body: Record<string, unknown>) {
    const storeId = String(body['storeId'] ?? '');
    const total   = Number(body['total'] ?? body['amount'] ?? 0);

    if (!storeId) {
      return { ok: false, message: 'storeId가 필요합니다.' };
    }
    if (total <= 0) {
      return { ok: false, message: '유효한 주문 금액이 필요합니다.' };
    }

    const rawItems = (body['items'] as Array<Record<string, unknown>>) ?? [];
    const idempotencyKey = String(body['idempotencyKey'] ?? uuidv4());

    const items = rawItems.map((i) => ({
      menuId: String(i['id'] ?? i['menuId'] ?? ''),
      quantity: Number(i['quantity'] ?? 1),
    }));

    const result = await this.createOrder.execute({
      idempotencyKey,
      storeId,
      userId: null,
      requestedAmount: String(total),
      items,
    });

    return {
      ok: true,
      id: result.orderId,
      orderId: result.orderId,
      status: result.status,
      replayed: result.replayed,
    };
  }

  // 배너 목록 (BBQ 앱 호환 — 현재 미운영, 빈 배열 반환)
  @Get('banners')
  getBanners() {
    return { ok: true, banners: [] };
  }

  // 스플래시 / 로고 이미지 URL (BBQ 앱 호환 — 현재 미운영)
  @Get('splash/:target')
  getSplash() {
    return { ok: true, imageUrl: null };
  }

  // 닉네임 중복 확인 (BBQ 앱 호환 — 현재 미운영)
  @Get('customers/check')
  getCustomersCheck() {
    return { ok: true, exists: false };
  }

  // 배달비 조회 (BBQ 앱 호환 — 고정값 반환)
  @Get('delivery-fee')
  getDeliveryFee() {
    return { ok: true, fee: 2000 };
  }

  // NestJS 상태 → BBQ 호환 상태 매핑
  private mapStatus(status: string): string {
    const map: Record<string, string> = {
      QUEUED:      'PLACED',
      SAVED:       'PLACED',
      SENT_TO_POS: 'ACCEPTED',
      COMPLETED:   'DONE',
      FAILED:      'CANCELLED',
      ACCEPTED:    'ACCEPTED',
      COOKING:     'ACCEPTED',
      DONE:        'DONE',
      CANCELLED:   'CANCELLED',
    };
    return map[status] ?? status;
  }
}
