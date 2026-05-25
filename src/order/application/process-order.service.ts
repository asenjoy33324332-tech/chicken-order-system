import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderRepository } from '../infrastructure/repositories/order.repository';
import { DistributedLockService } from '../infrastructure/lock/distributed-lock.service';
import { PosCircuitBreakerService } from '../infrastructure/pos/circuit-breaker/pos-circuit-breaker.service';
import { PosAdapterFactory } from '../infrastructure/pos/pos-adapter.factory';
import { OrderQueueService, OrderJobPayload } from '../infrastructure/queue/order-queue.service';
import { NotificationService } from '../../notification/notification.service';
import { AppLogger } from '../../common/logger/logger.service';
import { runWithTrace } from '../../common/trace/trace.context';
import {
  BusinessLogicError,
  LockAcquisitionError,
  StaleOrderVersionError,
} from '../domain/errors/order.errors';
import { OrderEntity } from '../domain/entities/order.entity';

@Injectable()
export class ProcessOrderService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly lock: DistributedLockService,
    private readonly circuitBreaker: PosCircuitBreakerService,
    private readonly posFactory: PosAdapterFactory,
    private readonly queue: OrderQueueService,
    private readonly notification: NotificationService,
    private readonly logger: AppLogger,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  async process(payload: OrderJobPayload, jobMeta: { jobId: string; workerId: string; attemptsMade: number }): Promise<void> {
    const { orderId, traceId, storeId } = payload;
    const lockToken = `${jobMeta.workerId}:${jobMeta.jobId}`;

    await runWithTrace({ traceId, orderId, storeId, workerId: jobMeta.workerId }, async () => {
      this.logger.info({ event: 'WORKER_JOB_START', attemptsMade: jobMeta.attemptsMade });

      // ─── Step 1: 분산 락 획득 ─────────────────────────────
      await this.lock.acquireOrThrow(orderId, lockToken);
      this.logger.debug({ event: 'LOCK_ACQUIRED' });

      try {
        await this.processWithLock(payload, jobMeta);
      } finally {
        // finally: 예외 발생 시에도 반드시 락 해제
        await this.lock.release(orderId, lockToken);
      }
    });
  }

  private async processWithLock(
    payload: OrderJobPayload,
    jobMeta: { jobId: string; workerId: string; attemptsMade: number },
  ): Promise<void> {
    const { orderId, storeId } = payload;

    // ─── Step 2: DB INSERT (QUEUED) — 중복 방어 2선 ──────────
    const order = await this.orderRepo.createOrder({
      id: orderId,
      idempotencyKey: payload.idempotencyKey,
      traceId: payload.traceId,
      storeId: payload.storeId,
      userId: payload.userId,
      requestedAmount: payload.requestedAmount,
      calculatedAmount: payload.calculatedAmount,
      items: payload.items,
      workerId: jobMeta.workerId,
      jobId: jobMeta.jobId,
    });

    if (!order) {
      // ON CONFLICT DO NOTHING → 이미 처리됨, 정상 완료로 간주
      this.logger.info({ event: 'DUPLICATE_DETECTED_DB', orderId });
      return;
    }

    this.logger.info({ event: 'STATE_TRANSITION', from: null, to: 'QUEUED' });

    // ─── Step 3: QUEUED → SAVED ───────────────────────────────
    await this.transitionToSaved(order, jobMeta);

    // ─── Step 4: POS 연동 ─────────────────────────────────────
    await this.sendToPos(order, payload, jobMeta);
  }

  private async transitionToSaved(
    order: OrderEntity,
    jobMeta: { jobId: string; workerId: string },
  ): Promise<void> {
    await this.orderRepo.transitionStatus({
      orderId: order.id,
      expectedStatus: 'QUEUED',
      nextStatus: 'SAVED',
      currentVersion: order.version,
      workerId: jobMeta.workerId,
      jobId: jobMeta.jobId,
    });
    this.logger.info({ event: 'STATE_TRANSITION', from: 'QUEUED', to: 'SAVED' });
  }

  private async sendToPos(
    order: OrderEntity,
    payload: OrderJobPayload,
    jobMeta: { jobId: string; workerId: string; attemptsMade: number },
  ): Promise<void> {
    const { orderId, storeId } = payload;

    // 매장 정보 조회 (POS 어댑터 생성용)
    const storeRow = await this.ds.query(
      'SELECT pos_type, pos_endpoint, pos_api_key_enc FROM stores WHERE id = $1',
      [storeId],
    ) as Array<{ pos_type: string; pos_endpoint: string; pos_api_key_enc: string | null }>;

    if (!storeRow.length) {
      throw new BusinessLogicError(`매장 없음: ${storeId}`);
    }

    const store = storeRow[0];
    const posAdapter = this.posFactory.create(
      store.pos_type,
      store.pos_endpoint,
      store.pos_api_key_enc,
    );

    this.logger.info({ event: 'POS_CALL_START', posType: store.pos_type });

    // POS 호출은 DB 트랜잭션 밖에서 실행
    // (트랜잭션 안에 외부 HTTP 호출 → DB 커넥션 점유 → Deadlock 원인)
    const posResult = await this.circuitBreaker.execute(storeId, () =>
      posAdapter.sendOrder({
        orderId,
        traceId: payload.traceId,
        storeId,
        idempotencyKey: payload.idempotencyKey,
        totalAmount: payload.calculatedAmount,
        items: payload.items,
        createdAt: new Date(),
      }),
    );

    this.logger.info({ event: 'POS_CALL_SUCCESS', posOrderId: posResult.posOrderId });

    // SAVED → SENT_TO_POS → COMPLETED 연속 전이
    const savedOrder = await this.orderRepo.findById(orderId);
    if (!savedOrder) throw new Error(`주문을 찾을 수 없음: ${orderId}`);

    await this.orderRepo.transitionStatus({
      orderId,
      expectedStatus: 'SAVED',
      nextStatus: 'SENT_TO_POS',
      currentVersion: savedOrder.version,
      workerId: jobMeta.workerId,
      jobId: jobMeta.jobId,
      posResponse: posResult.rawResponse,
    });
    this.logger.info({ event: 'STATE_TRANSITION', from: 'SAVED', to: 'SENT_TO_POS' });

    const sentOrder = await this.orderRepo.findById(orderId);
    if (!sentOrder) throw new Error(`주문을 찾을 수 없음: ${orderId}`);

    await this.orderRepo.transitionStatus({
      orderId,
      expectedStatus: 'SENT_TO_POS',
      nextStatus: 'COMPLETED',
      currentVersion: sentOrder.version,
      workerId: jobMeta.workerId,
      jobId: jobMeta.jobId,
    });
    this.logger.info({ event: 'ORDER_COMPLETED' });
  }

  async handleFailure(
    payload: OrderJobPayload,
    error: Error,
    jobMeta: { jobId: string; workerId: string; attemptsMade: number },
  ): Promise<void> {
    const { orderId, traceId, storeId } = payload;

    await runWithTrace({ traceId, orderId, storeId }, async () => {
      const isRetryable = !(error instanceof BusinessLogicError);
      const isExhausted = jobMeta.attemptsMade >= 3;

      if (!isRetryable || isExhausted) {
        await this.moveToDlq(payload, error, jobMeta);
        return;
      }

      await this.orderRepo.incrementRetryCount(orderId);
      this.logger.warn({
        event: 'ORDER_RETRY_SCHEDULED',
        attempt: jobMeta.attemptsMade,
        error: error.message,
      });
    });
  }

  private async moveToDlq(
    payload: OrderJobPayload,
    error: Error,
    jobMeta: { jobId: string; workerId: string; attemptsMade: number },
  ): Promise<void> {
    const { orderId, traceId, storeId } = payload;

    // DB 상태를 FAILED로 전이 (현재 상태가 QUEUED 또는 SAVED일 수 있음)
    try {
      const order = await this.orderRepo.findById(orderId);
      if (order && order.status !== 'FAILED' && order.status !== 'COMPLETED') {
        await this.orderRepo.transitionStatus({
          orderId,
          expectedStatus: order.status,
          nextStatus: 'FAILED',
          currentVersion: order.version,
          workerId: jobMeta.workerId,
          jobId: jobMeta.jobId,
          reason: error.message,
        });
      }
    } catch (transitionErr) {
      if (!(transitionErr instanceof StaleOrderVersionError)) throw transitionErr;
    }

    await this.orderRepo.markDlq(orderId, error.message);

    // DLQ 큐에 이관
    await this.queue.publishToDlq({
      ...payload,
      failureReason: error.message,
      attempts: jobMeta.attemptsMade,
    });

    // Slack 알림
    await this.notification.sendDlqAlert({
      orderId,
      traceId,
      storeId,
      reason: error.message,
      attempts: jobMeta.attemptsMade,
      dashboardUrl: `http://localhost:3000/admin/orders/${orderId}`,
    });

    this.logger.error({
      event: 'ORDER_MOVED_TO_DLQ',
      error: error.message,
      attempts: jobMeta.attemptsMade,
    });
  }
}
