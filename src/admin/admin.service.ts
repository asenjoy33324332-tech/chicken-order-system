import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderRepository } from '../order/infrastructure/repositories/order.repository';
import { OrderQueueService, OrderJobPayload } from '../order/infrastructure/queue/order-queue.service';
import { PosCircuitBreakerService } from '../order/infrastructure/pos/circuit-breaker/pos-circuit-breaker.service';
import { AppLogger } from '../common/logger/logger.service';
import { getTraceContext } from '../common/trace/trace.context';

@Injectable()
export class AdminService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly queue: OrderQueueService,
    private readonly circuitBreaker: PosCircuitBreakerService,
    private readonly logger: AppLogger,
  ) {}

  /** 단일 주문 수동 재처리 (DLQ re-drive) */
  async redriveOrder(orderId: string): Promise<{ orderId: string; message: string }> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) throw new NotFoundException(`주문 없음: ${orderId}`);
    if (order.status !== 'FAILED') {
      throw new BadRequestException(`FAILED 상태인 주문만 재처리 가능합니다. 현재 상태: ${order.status}`);
    }

    const { traceId } = getTraceContext();

    // FAILED → QUEUED 전이 (관리자 전용)
    await this.orderRepo.transitionStatus({
      orderId,
      expectedStatus: 'FAILED',
      nextStatus: 'QUEUED',
      currentVersion: order.version,
      workerId: 'admin-redrive',
      reason: 'Admin manual re-drive',
    });

    const payload: OrderJobPayload = {
      orderId: order.id,
      traceId: traceId ?? order.traceId,
      storeId: order.storeId,
      userId: order.userId,
      idempotencyKey: order.idempotencyKey,
      requestedAmount: order.requestedAmount,
      calculatedAmount: order.calculatedAmount,
      items: order.items.map((item) => ({
        menuId: item.menuId,
        menuName: item.menuName,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
      })),
      isRedrive: true,
      redriveAt: new Date().toISOString(),
    };

    await this.queue.publishOrder(payload);

    this.logger.info({ event: 'ORDER_REDRIVEN', orderId });

    return { orderId, message: '재처리 요청이 접수되었습니다.' };
  }

  /** DLQ 목록 조회 */
  async getDlqOrders(query: {
    storeId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const { items, total } = await this.orderRepo.findFailedOrders({
      storeId: query.storeId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });

    return {
      items: items.map((o) => ({
        orderId: o.id,
        storeId: o.storeId,
        traceId: o.traceId,
        status: o.status,
        failureReason: o.failureReason,
        dlqAt: o.dlqAt,
        retryCount: o.retryCount,
        requestedAmount: o.requestedAmount,
        createdAt: o.createdAt,
      })),
      total,
      page: query.page ?? 1,
    };
  }

  /** 큐 깊이 + 서킷 브레이커 현황 (헬스 대시보드) */
  async getSystemStatus(storeIds: string[]) {
    const queueDepth = await this.queue.getQueueDepth();
    const cbStatuses = await Promise.all(
      storeIds.map(async (id) => ({
        storeId: id,
        circuitStatus: await this.circuitBreaker.getStatus(id),
      })),
    );

    return { queueDepth, circuitBreakers: cbStatuses };
  }
}
