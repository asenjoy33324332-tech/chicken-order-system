import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { OrderEntity } from '../../domain/entities/order.entity';
import { OrderItemEntity } from '../../domain/entities/order-item.entity';
import { OrderStateTransitionEntity } from '../../domain/entities/order-state-transition.entity';
import { OrderStatus, OrderStateMachine } from '../../domain/order-state-machine';
import { StaleOrderVersionError } from '../../domain/errors/order.errors';

export interface CreateOrderParams {
  id: string;
  idempotencyKey: string;
  traceId: string;
  storeId: string;
  userId: string | null;
  requestedAmount: string;
  calculatedAmount: string;
  items: Array<{
    menuId: string;
    menuName: string;
    unitPrice: number;
    quantity: number;
  }>;
  workerId: string;
  jobId: string;
}

@Injectable()
export class OrderRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async findByIdempotencyKey(key: string): Promise<OrderEntity | null> {
    return this.ds
      .getRepository(OrderEntity)
      .findOne({ where: { idempotencyKey: key } });
  }

  async findById(id: string): Promise<OrderEntity | null> {
    return this.ds
      .getRepository(OrderEntity)
      .findOne({ where: { id }, relations: ['items'] });
  }

  /**
   * TX #1: 주문 최초 생성 (QUEUED 상태)
   * ON CONFLICT DO NOTHING 으로 중복 INSERT를 안전하게 무시.
   * returns null if duplicate (already processed)
   */
  async createOrder(params: CreateOrderParams): Promise<OrderEntity | null> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // idempotency_key UNIQUE 위반 시 0 rows 반환 (오류 없음)
      const result = await qr.query(
        `INSERT INTO orders
           (id, idempotency_key, trace_id, store_id, user_id,
            status, requested_amount, calculated_amount, version)
         VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,0)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          params.id,
          params.idempotencyKey,
          params.traceId,
          params.storeId,
          params.userId,
          params.requestedAmount,
          params.calculatedAmount,
        ],
      );

      if (result.length === 0) {
        // 이미 처리된 주문 — 중복 처리 방지
        await qr.rollbackTransaction();
        return null;
      }

      // order_items INSERT
      for (const item of params.items) {
        await qr.query(
          `INSERT INTO order_items
             (order_id, menu_id, menu_name, unit_price, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [params.id, item.menuId, item.menuName, item.unitPrice, item.quantity],
        );
      }

      // 상태 전이 감사 로그
      await this.insertTransition(qr, {
        orderId: params.id,
        fromStatus: null,
        toStatus: 'QUEUED',
        workerId: params.workerId,
        jobId: params.jobId,
      });

      await qr.commitTransaction();
      return this.ds.getRepository(OrderEntity).findOne({
        where: { id: params.id },
        relations: ['items'],
      });
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /**
   * 낙관적 락을 이용한 상태 전이.
   * WHERE status=expectedStatus AND version=currentVersion 조건으로
   * 동시 업데이트를 감지한다. 0 rows → StaleOrderVersionError
   */
  async transitionStatus(params: {
    orderId: string;
    expectedStatus: OrderStatus;
    nextStatus: OrderStatus;
    currentVersion: number;
    workerId: string;
    jobId?: string;
    reason?: string;
    posResponse?: Record<string, unknown>;
    posErrorMessage?: string;
  }): Promise<void> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      OrderStateMachine.validate(params.expectedStatus, params.nextStatus);

      const timestampCol = this.timestampColumn(params.nextStatus);
      // Base params: $1=nextStatus, $2=orderId, $3=expectedStatus, $4=currentVersion
      const queryValues: unknown[] = [
        params.nextStatus,
        params.orderId,
        params.expectedStatus,
        params.currentVersion,
      ];

      let paramIdx = 5;
      const extraClauses: string[] = [];

      if (params.posResponse !== undefined) {
        extraClauses.push(`, pos_response = $${paramIdx++}::jsonb`);
        queryValues.push(JSON.stringify(params.posResponse));
      }
      if (params.posErrorMessage) {
        extraClauses.push(`, pos_error_message = $${paramIdx++}`);
        queryValues.push(params.posErrorMessage);
      }
      if (params.reason) {
        extraClauses.push(`, failure_reason = $${paramIdx++}`);
        queryValues.push(params.reason);
      }

      const result = await qr.query(
        `UPDATE orders
         SET    status = $1,
                version = version + 1,
                ${timestampCol} = NOW()
                ${extraClauses.join('')}
         WHERE  id = $2
           AND  status = $3
           AND  version = $4`,
        queryValues,
      );

      const rowCount = result[1] as number;
      if (rowCount === 0) {
        throw new StaleOrderVersionError(params.orderId, params.currentVersion);
      }

      await this.insertTransition(qr, {
        orderId: params.orderId,
        fromStatus: params.expectedStatus,
        toStatus: params.nextStatus,
        workerId: params.workerId,
        jobId: params.jobId ?? null,
        reason: params.reason ?? null,
      });

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async markDlq(orderId: string, reason: string): Promise<void> {
    await this.ds.query(
      `UPDATE orders SET dlq_at = NOW(), failure_reason = $1 WHERE id = $2`,
      [reason, orderId],
    );
  }

  async incrementRetryCount(orderId: string): Promise<void> {
    await this.ds.query(
      `UPDATE orders SET retry_count = retry_count + 1 WHERE id = $1`,
      [orderId],
    );
  }

  async findFailedOrders(params: {
    storeId?: string;
    from?: Date;
    to?: Date;
    page: number;
    limit?: number;
  }): Promise<{ items: OrderEntity[]; total: number }> {
    const limit = params.limit ?? 20;
    const offset = (params.page - 1) * limit;

    const qb = this.ds
      .getRepository(OrderEntity)
      .createQueryBuilder('o')
      .where('o.status = :status', { status: 'FAILED' })
      .andWhere('o.dlq_at IS NOT NULL');

    if (params.storeId) qb.andWhere('o.storeId = :storeId', { storeId: params.storeId });
    if (params.from)    qb.andWhere('o.createdAt >= :from', { from: params.from });
    if (params.to)      qb.andWhere('o.createdAt <= :to', { to: params.to });

    const [items, total] = await qb
      .orderBy('o.dlqAt', 'DESC')
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return { items, total };
  }

  async findMenusByIds(
    menuIds: string[],
    storeId: string,
  ): Promise<Array<{ id: string; name: string; unitPrice: number; isAvailable: boolean }>> {
    if (menuIds.length === 0) return [];
    const rows = await this.ds.query(
      `SELECT id, name, unit_price, is_available
       FROM   menus
       WHERE  id = ANY($1::uuid[])
         AND  store_id = $2`,
      [menuIds, storeId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r['id'] as string,
      name: r['name'] as string,
      unitPrice: parseFloat(r['unit_price'] as string),
      isAvailable: r['is_available'] as boolean,
    }));
  }

  // ─── private helpers ──────────────────────────────────────

  private async insertTransition(
    qr: QueryRunner,
    params: {
      orderId: string;
      fromStatus: string | null;
      toStatus: string;
      workerId?: string;
      jobId?: string | null;
      reason?: string | null;
    },
  ): Promise<void> {
    await qr.query(
      `INSERT INTO order_state_transitions
         (order_id, from_status, to_status, worker_id, job_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        params.orderId,
        params.fromStatus,
        params.toStatus,
        params.workerId ?? null,
        params.jobId ?? null,
        params.reason ?? null,
      ],
    );
  }

  private timestampColumn(status: OrderStatus): string {
    const map: Record<OrderStatus, string> = {
      QUEUED:      'queued_at',
      SAVED:       'saved_at',
      SENT_TO_POS: 'sent_to_pos_at',
      COMPLETED:   'completed_at',
      FAILED:      'failed_at',
    };
    return map[status];
  }

}
