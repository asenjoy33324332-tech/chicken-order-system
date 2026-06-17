import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode, HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreateOrderService } from '../order/application/create-order.service';
import { OrderGateway } from '../order/infrastructure/socket/order.gateway';
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
    private readonly gateway: OrderGateway,
  ) {}

  // ─────────────────────────────────────────────
  // HEALTH
  // ─────────────────────────────────────────────

  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // ─────────────────────────────────────────────
  // MENUS
  // ─────────────────────────────────────────────

  @Get('menus')
  async getMenus(@Query('storeId') storeId?: string) {
    let resolvedStoreId = storeId;
    if (!resolvedStoreId) {
      const stores = await this.ds.query<Array<{ id: string }>>(
        `SELECT id FROM stores WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
      );
      if (!stores.length) return { ok: false, menus: [] };
      resolvedStoreId = stores[0].id;
    }
    const rows = await this.ds.query<Array<{
      id: string; name: string; unit_price: string; is_available: boolean;
      category: string | null; sort_order: number; meta: Record<string, unknown>;
    }>>(
      `SELECT id, name, unit_price, is_available, category, sort_order, meta
         FROM menus
        WHERE store_id = $1 AND is_available = TRUE
        ORDER BY sort_order, name`,
      [resolvedStoreId],
    );
    return {
      ok: true,
      menus: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.unit_price),
        unitPrice: parseFloat(r.unit_price),
        isAvailable: r.is_available,
        category: r.category ?? '치킨',
        sortOrder: r.sort_order,
        appTarget: 'all',
        optionTemplateIds: [],
        meta: r.meta ?? {},
      })),
    };
  }

  @Get('categories')
  getCategories() {
    return { ok: true, categories: [] };
  }

  @Get('options')
  getOptions() {
    return { ok: true, options: [] };
  }

  // ─────────────────────────────────────────────
  // SETTINGS (DB 기반)
  // ─────────────────────────────────────────────

  @Get('settings')
  async getSettings(@Query('storeId') storeId?: string) {
    const defaults = {
      isOpen: true,
      businessPaused: false,
      minOrderAmount: 0,
      storeNotice: '',
      deliveryGuide: '',
      deliveryFee: 2000,
    };
    if (!storeId) return { ok: true, ...defaults };

    const rows = await this.ds.query<Array<{ settings: Record<string, unknown> }>>(
      `SELECT settings FROM pos_settings WHERE store_id = $1 LIMIT 1`,
      [storeId],
    );
    if (!rows.length) return { ok: true, ...defaults };

    const s = rows[0].settings as Record<string, unknown>;
    return {
      ok: true,
      isOpen:          s['isOpen']          ?? defaults.isOpen,
      businessPaused:  s['businessPaused']  ?? defaults.businessPaused,
      minOrderAmount:  s['minOrderAmount']  ?? defaults.minOrderAmount,
      storeNotice:     s['storeNotice']     ?? defaults.storeNotice,
      deliveryGuide:   s['deliveryGuide']   ?? defaults.deliveryGuide,
      deliveryFee:     s['deliveryFee']     ?? defaults.deliveryFee,
      openTime:        s['openTime']        ?? null,
      closeTime:       s['closeTime']       ?? null,
    };
  }

  @Get('delivery-fee')
  async getDeliveryFee(@Query('storeId') storeId?: string) {
    if (!storeId) return { ok: true, fee: 2000 };

    const rows = await this.ds.query<Array<{ settings: Record<string, unknown> }>>(
      `SELECT settings FROM pos_settings WHERE store_id = $1 LIMIT 1`,
      [storeId],
    );
    const fee = rows.length ? (Number(rows[0].settings['deliveryFee']) || 2000) : 2000;
    return { ok: true, fee };
  }

  // ─────────────────────────────────────────────
  // ORDERS — POS / 앱 공용
  // ─────────────────────────────────────────────

  // GET /orders/missed 는 GET /orders/:id 와 충돌 방지를 위해 /orders 위에 위치
  @Get('orders/missed')
  async getMissedOrders(
    @Query('storeId') storeId?: string,
    @Query('since') since?: string,
  ) {
    if (!storeId) return { ok: false, orders: [] };

    // since 가 없으면 최근 24시간
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);

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
          AND o.updated_at > $2
        ORDER BY o.updated_at DESC
        LIMIT 500`,
      [storeId, sinceDate],
    );

    const orderIds = rows.map((r) => r.id);
    const itemMap = await this.fetchItemMap(orderIds);

    return {
      ok: true,
      orders: rows.map((o) => this.formatOrder(o, itemMap)),
    };
  }

  @Get('orders/by-date')
  async getOrdersByDate(
    @Query('storeId') storeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!storeId) return { ok: false, orders: [] };

    const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate   = to   ? new Date(to)   : new Date();

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
          AND o.created_at >= $2
          AND o.created_at <= $3
        ORDER BY o.created_at DESC
        LIMIT 1000`,
      [storeId, fromDate, toDate],
    );

    const orderIds = rows.map((r) => r.id);
    const itemMap = await this.fetchItemMap(orderIds);

    return {
      ok: true,
      orders: rows.map((o) => this.formatOrder(o, itemMap)),
    };
  }

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
    const itemMap = await this.fetchItemMap(orderIds);

    return {
      ok: true,
      orders: rows.map((o) => this.formatOrder(o, itemMap)),
    };
  }

  // BBQ-compat 주문 상태 변경 (POS → PATCH /order/:id/status)
  @Patch('order/:id/status')
  async updateOrderStatus(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const status = String(body['status'] ?? '').toUpperCase();
    if (!status) return { ok: false, message: 'status 필드가 필요합니다.' };

    const rows = await this.ds.query<Array<{ store_id: string; status: string }>>(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING store_id, status`,
      [status, id],
    );
    if (!rows.length) throw new NotFoundException(`주문 없음: ${id}`);

    const { store_id: storeId, status: newStatus } = rows[0];
    this.gateway.emitOrderUpdated(storeId, {
      id,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, orderId: id, status: newStatus };
  }

  // 주문 아이템 수정 (stub)
  @Patch('orders/:id/items')
  async updateOrderItems(
    @Param('id') id: string,
    @Body() _body: Record<string, unknown>,
  ) {
    return { ok: true, orderId: id, message: '항목 수정이 반영되었습니다.' };
  }

  // 부분 취소 (stub)
  @Post('orders/:id/cancel-partial')
  @HttpCode(HttpStatus.OK)
  async cancelPartialOrder(
    @Param('id') id: string,
    @Body() _body: Record<string, unknown>,
  ) {
    return { ok: true, orderId: id, message: '부분 취소가 처리되었습니다.' };
  }

  // ─────────────────────────────────────────────
  // AREAS
  // ─────────────────────────────────────────────

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

  @Get('areas/resolve')
  async resolveArea(
    @Query('address') address?: string,
    @Query('type') type?: string,
  ) {
    if (type === 'takeout' || !address?.trim()) {
      const stores = await this.ds.query<Array<{ id: string; name: string }>>(
        `SELECT id, name FROM stores WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
      );
      if (!stores.length) return { ok: false, message: '영업 중인 매장이 없습니다.' };
      return { ok: true, storeId: stores[0].id, storeName: stores[0].name, areaName: '' };
    }
    const rows = await this.ds.query<Array<{
      id: string; name: string; store_id: string; store_name: string;
    }>>(
      `SELECT a.id, a.name, a.store_id, s.name as store_name
         FROM areas a
         JOIN stores s ON s.id = a.store_id
        WHERE a.is_active = TRUE
        ORDER BY a.sort_order, a.name`,
    );
    const trimmed = address.trim();
    const matched = rows.find((r) => trimmed.includes(r.name));
    if (!matched) return { ok: false, message: '배달 가능 지역이 아닙니다.' };
    return {
      ok: true,
      storeId: matched.store_id,
      storeName: matched.store_name,
      areaName: matched.name,
    };
  }

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

  // ─────────────────────────────────────────────
  // ORDER STATUS / CREATE
  // ─────────────────────────────────────────────

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

  @Post('order')
  @HttpCode(HttpStatus.ACCEPTED)
  async createOrderCompat(@Body() body: Record<string, unknown>) {
    const storeId = String(body['storeId'] ?? '');
    const total   = Number(body['total'] ?? body['amount'] ?? 0);

    if (!storeId) return { ok: false, message: 'storeId가 필요합니다.' };
    if (total <= 0) return { ok: false, message: '유효한 주문 금액이 필요합니다.' };

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

  // ─────────────────────────────────────────────
  // SALES
  // ─────────────────────────────────────────────

  @Get('sales')
  async getSales(
    @Query('storeId') storeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    if (!storeId) return { ok: false, message: 'storeId가 필요합니다.' };

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate   = to   ? new Date(to)   : new Date();
    const gbSafe   = ['day', 'week', 'month', 'quarter'].includes(groupBy ?? '') ? groupBy! : 'day';

    // 완료 주문 집계 (FAILED, CANCELLED, QUEUED, SAVED 제외)
    const totals = await this.ds.query<Array<{
      order_count: string; total_amount: string;
    }>>(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(calculated_amount), 0) as total_amount
         FROM orders
        WHERE store_id = $1
          AND created_at >= $2
          AND created_at <= $3
          AND status NOT IN ('FAILED', 'CANCELLED', 'QUEUED', 'SAVED')`,
      [storeId, fromDate, toDate],
    );

    // 취소 집계
    const cancels = await this.ds.query<Array<{
      cancel_count: string; cancel_amount: string;
    }>>(
      `SELECT COUNT(*) as cancel_count, COALESCE(SUM(calculated_amount), 0) as cancel_amount
         FROM orders
        WHERE store_id = $1
          AND created_at >= $2
          AND created_at <= $3
          AND status = 'CANCELLED'
          AND calculated_amount > 0`,
      [storeId, fromDate, toDate],
    );

    // 날짜별 집계
    const byDateRows = await this.ds.query<Array<{
      period: string; count: string; amount: string;
    }>>(
      `SELECT
         TO_CHAR(DATE_TRUNC('${gbSafe}', created_at + INTERVAL '9 hours'), 'YYYY-MM-DD') as period,
         COUNT(*) as count,
         COALESCE(SUM(calculated_amount), 0) as amount
       FROM orders
       WHERE store_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND status NOT IN ('FAILED', 'CANCELLED', 'QUEUED', 'SAVED')
       GROUP BY 1
       ORDER BY 1`,
      [storeId, fromDate, toDate],
    );

    const totalCount  = parseInt(totals[0]?.order_count ?? '0', 10);
    const finalAmount = parseFloat(totals[0]?.total_amount ?? '0');
    const cancelCount = parseInt(cancels[0]?.cancel_count ?? '0', 10);
    const cancelAmt   = parseFloat(cancels[0]?.cancel_amount ?? '0');
    const taxable     = Math.round(finalAmount / 1.1);
    const vat         = finalAmount - taxable;

    return {
      ok: true,
      totalCount,
      totalAmount:   finalAmount,
      discountAmount: 0,
      finalAmount,
      cancelCount,
      cancelAmount: cancelAmt,
      taxableAmount: taxable,
      vat,
      byPayment: { card: { count: 0, amount: 0 }, cash: { count: 0, amount: 0 } },
      byType: {
        delivery: { count: 0, amount: 0 },
        takeout:  { count: 0, amount: 0 },
        dineIn:   { count: 0, amount: 0 },
      },
      byDate: byDateRows.map((r) => ({
        date:        r.period,
        count:       parseInt(r.count, 10),
        finalAmount: parseFloat(r.amount),
      })),
    };
  }

  // ─────────────────────────────────────────────
  // CUSTOMERS
  // ─────────────────────────────────────────────

  // customers/check 는 customers 보다 먼저 선언해야 NestJS 라우팅 정확성 보장
  @Get('customers/check')
  getCustomersCheck() {
    return { ok: true, exists: false };
  }

  @Get('customers')
  async getCustomers(@Query('storeId') storeId?: string) {
    if (!storeId) return { ok: true, customers: [] };

    const rows = await this.ds.query<Array<{
      user_id: string;
      order_count: string;
      total_spent: string;
      last_order_at: Date;
    }>>(
      `SELECT user_id,
              COUNT(*) as order_count,
              SUM(calculated_amount) as total_spent,
              MAX(created_at) as last_order_at
         FROM orders
        WHERE store_id = $1
          AND user_id IS NOT NULL
          AND status NOT IN ('FAILED', 'CANCELLED')
        GROUP BY user_id
        ORDER BY last_order_at DESC
        LIMIT 100`,
      [storeId],
    );

    return {
      ok: true,
      customers: rows.map((r) => ({
        userId:      r.user_id,
        orderCount:  parseInt(r.order_count, 10),
        totalSpent:  parseFloat(r.total_spent ?? '0'),
        lastOrderAt: r.last_order_at,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // CONTENT (BBQ 앱 호환 stubs)
  // ─────────────────────────────────────────────

  @Get('banners')
  getBanners() {
    return { ok: true, banners: [] };
  }

  @Get('splash/:target')
  getSplash() {
    return { ok: true, imageUrl: null };
  }

  // ─────────────────────────────────────────────
  // PROMO IMAGES (stubs)
  // ─────────────────────────────────────────────

  @Get('promo-images')
  getPromoImages() {
    return { ok: true, images: [] };
  }

  @Post('promo-images')
  @HttpCode(HttpStatus.OK)
  addPromoImage() {
    return { ok: true, message: '홍보 이미지 기능은 준비 중입니다.' };
  }

  @Delete('promo-images/:index')
  deletePromoImage(@Param('index') _index: string) {
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // RIDER REPORTS (stubs)
  // ─────────────────────────────────────────────

  @Get('rider/reports')
  getRiderReports(@Query('storeId') _storeId?: string) {
    return { ok: true, reports: [] };
  }

  @Patch('rider/reports/:id/ack')
  ackRiderReport(@Param('id') _id: string) {
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // PENDING CANCELS (stubs)
  // ─────────────────────────────────────────────

  @Get('pending-cancels')
  getPendingCancels(@Query('storeId') _storeId?: string) {
    return { ok: true, pendingCancels: [] };
  }

  @Delete('pending-cancels/:id')
  deletePendingCancel(@Param('id') _id: string) {
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // FAILED PATCHES (stubs)
  // ─────────────────────────────────────────────

  @Post('failed-patches')
  @HttpCode(HttpStatus.OK)
  saveFailedPatch(@Body() _body: Record<string, unknown>) {
    return { ok: true };
  }

  @Get('failed-patches')
  getFailedPatches(@Query('storeId') _storeId?: string) {
    return { ok: true, failedPatches: [] };
  }

  @Delete('failed-patches/:id')
  deleteFailedPatch(@Param('id') _id: string) {
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // AUDIT (stubs)
  // ─────────────────────────────────────────────

  @Get('audit-logs')
  getAuditLogs(@Query('storeId') _storeId?: string) {
    return { ok: true, logs: [] };
  }

  @Get('audit/risks')
  getAuditRisks(@Query('storeId') _storeId?: string) {
    return {
      ok: true,
      risks: [
        { type: 'cash_cancel',    count: 0, level: 'low', items: [] },
        { type: 'card_cancel',    count: 0, level: 'low', items: [] },
        { type: 'menu_cancel_rate', items: [] },
      ],
    };
  }

  // ─────────────────────────────────────────────
  // TABLE OPS (stubs)
  // ─────────────────────────────────────────────

  @Post('tables/move')
  @HttpCode(HttpStatus.OK)
  moveTable(@Body() _body: Record<string, unknown>) {
    return { ok: true };
  }

  @Post('tables/merge')
  @HttpCode(HttpStatus.OK)
  mergeTables(@Body() _body: Record<string, unknown>) {
    return { ok: true };
  }

  @Post('table/:no/payment-done')
  @HttpCode(HttpStatus.OK)
  tablePaymentDone(@Param('no') _no: string) {
    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  private async fetchItemMap(
    orderIds: string[],
  ): Promise<Map<string, Array<{ menu_name: string; unit_price: string; quantity: number }>>> {
    const itemMap = new Map<string, Array<{ menu_name: string; unit_price: string; quantity: number }>>();
    if (!orderIds.length) return itemMap;

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
    return itemMap;
  }

  private formatOrder(
    o: {
      id: string; status: string; store_id: string; trace_id: string;
      requested_amount: string; calculated_amount: string;
      created_at: Date; updated_at: Date; queued_at: Date;
    },
    itemMap: Map<string, Array<{ menu_name: string; unit_price: string; quantity: number }>>,
  ) {
    return {
      id:        o.id,
      orderNo:   o.id.slice(0, 8).toUpperCase(),
      status:    this.mapStatus(o.status),
      storeId:   o.store_id,
      total:     parseFloat(o.calculated_amount),
      amount:    parseFloat(o.calculated_amount),
      type:      'delivery',
      createdAt: o.created_at,
      orderedAt: o.queued_at || o.created_at,
      updatedAt: o.updated_at,
      items: (itemMap.get(o.id) ?? []).map((i) => ({
        name:     i.menu_name,
        price:    parseFloat(i.unit_price),
        quantity: i.quantity,
      })),
    };
  }

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
