import { Injectable, ConflictException, UnprocessableEntityException, ServiceUnavailableException, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import Redis from 'ioredis';
import { IdempotencyService, REDIS_CLIENT } from '../infrastructure/idempotency/idempotency.service';
import { OrderQueueService, OrderJobPayload } from '../infrastructure/queue/order-queue.service';
import { OrderRepository } from '../infrastructure/repositories/order.repository';
import { AppLogger } from '../../common/logger/logger.service';
import { getTraceContext } from '../../common/trace/trace.context';
import { AmountMismatchError, MenuNotFoundError, MenuUnavailableError } from '../domain/errors/order.errors';

const MENU_CACHE_TTL_SECONDS = 300;

export interface CreateOrderCommand {
  idempotencyKey: string;
  storeId: string;
  userId: string | null;
  requestedAmount: string;
  items: Array<{ menuId: string; quantity: number }>;
}

export interface CreateOrderResult {
  orderId: string;
  traceId: string;
  status: 'QUEUED';
  replayed?: true;
}

@Injectable()
export class CreateOrderService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly queue: OrderQueueService,
    private readonly orderRepo: OrderRepository,
    private readonly logger: AppLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async execute(cmd: CreateOrderCommand): Promise<CreateOrderResult> {
    const { traceId } = getTraceContext();
    const orderId = uuidv4();

    this.logger.info({
      event: 'ORDER_RECEIVED',
      storeId: cmd.storeId,
      idempotencyKey: cmd.idempotencyKey,
    });

    // ─── Step 1: 멱등성 검증 (Redis SETNX) ───────────────────
    const isNew = await this.idempotency.tryAcquire(cmd.idempotencyKey, orderId);

    if (!isNew) {
      const cached = await this.idempotency.getCachedResponse(cmd.idempotencyKey);
      if (cached) {
        this.logger.info({ event: 'IDEMPOTENCY_DUPLICATE', idempotencyKey: cmd.idempotencyKey });
        return { ...(cached as unknown as CreateOrderResult), replayed: true };
      }
      // 처리 중인 상태 (pending) → 진행 중 응답
      this.logger.info({ event: 'IDEMPOTENCY_IN_PROGRESS', idempotencyKey: cmd.idempotencyKey });
      throw new ConflictException('동일한 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    this.logger.info({ event: 'IDEMPOTENCY_NEW', idempotencyKey: cmd.idempotencyKey });

    try {
      // ─── Step 2: 금액 교차 검증 (DB Read Only) ───────────────
      const { calculatedAmount, enrichedItems } =
        await this.validateAndEnrichItems(cmd);

      // ─── Step 3: BullMQ 적재 ─────────────────────────────────
      const payload: OrderJobPayload = {
        orderId,
        traceId: traceId ?? uuidv4(),
        storeId: cmd.storeId,
        userId: cmd.userId,
        idempotencyKey: cmd.idempotencyKey,
        requestedAmount: cmd.requestedAmount,
        calculatedAmount,
        items: enrichedItems,
      };

      await this.queue.publishOrder(payload);

      // ─── Step 4: 응답 캐시 및 반환 ───────────────────────────
      const result: CreateOrderResult = {
        orderId,
        traceId: traceId ?? uuidv4(),
        status: 'QUEUED',
      };

      await this.idempotency.setCompleted(cmd.idempotencyKey, result as unknown as Record<string, unknown>);

      this.logger.info({ event: 'ORDER_QUEUED', orderId });
      return result;

    } catch (err) {
      // Queue 적재 실패 시 idempotency 키 반환 (재시도 허용)
      await this.idempotency.release(cmd.idempotencyKey);

      if (
        err instanceof AmountMismatchError ||
        err instanceof MenuNotFoundError ||
        err instanceof MenuUnavailableError
      ) {
        throw new UnprocessableEntityException(err.message);
      }

      this.logger.error({ event: 'QUEUE_PUBLISH_FAIL', error: (err as Error).message });
      throw new ServiceUnavailableException('주문 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  private async getMenusCached(
    menuIds: string[],
    storeId: string,
  ): Promise<Array<{ id: string; name: string; unitPrice: string; isAvailable: boolean }>> {
    const cacheKey = `menu:${storeId}:${[...menuIds].sort().join(',')}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as Array<{ id: string; name: string; unitPrice: string; isAvailable: boolean }>;

    const menus = await this.orderRepo.findMenusByIds(menuIds, storeId);
    await this.redis.set(cacheKey, JSON.stringify(menus), 'EX', MENU_CACHE_TTL_SECONDS);
    return menus;
  }

  private async validateAndEnrichItems(cmd: CreateOrderCommand): Promise<{
    calculatedAmount: string;
    enrichedItems: OrderJobPayload['items'];
  }> {
    const menuIds = cmd.items.map((i) => i.menuId);
    const menus = await this.getMenusCached(menuIds, cmd.storeId);

    const menuMap = new Map(menus.map((m) => [m.id, m]));
    let calculatedTotal = new Decimal(0);

    const enrichedItems: OrderJobPayload['items'] = [];

    for (const item of cmd.items) {
      const menu = menuMap.get(item.menuId);
      if (!menu) throw new MenuNotFoundError(item.menuId);
      if (!menu.isAvailable) throw new MenuUnavailableError(menu.name);

      const lineTotal = new Decimal(menu.unitPrice).times(item.quantity);
      calculatedTotal = calculatedTotal.plus(lineTotal);

      enrichedItems.push({
        menuId: item.menuId,
        menuName: menu.name,
        unitPrice: menu.unitPrice,
        quantity: item.quantity,
      });
    }

    if (!calculatedTotal.equals(new Decimal(cmd.requestedAmount))) {
      throw new AmountMismatchError(cmd.requestedAmount, calculatedTotal.toFixed(2));
    }

    this.logger.info({
      event: 'AMOUNT_VALIDATION_PASS',
      requestedAmount: cmd.requestedAmount,
      calculatedAmount: calculatedTotal.toFixed(2),
    });

    return { calculatedAmount: calculatedTotal.toFixed(2), enrichedItems };
  }
}
