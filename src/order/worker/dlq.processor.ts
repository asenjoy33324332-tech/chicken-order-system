import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DLQ_QUEUE_NAME } from '../infrastructure/queue/order-queue.service';
import { AppLogger } from '../../common/logger/logger.service';
import { runWithTrace } from '../../common/trace/trace.context';
import { NotificationService } from '../../notification/notification.service';

interface DlqJobPayload {
  orderId: string;
  traceId: string;
  storeId: string;
  failureReason: string;
  attempts: number;
}

/**
 * DLQ 프로세서는 실패 주문을 수신해 로깅하고 보관한다.
 * 자동 재처리는 하지 않는다 — 운영자 판단 후 수동 re-drive 전용.
 */
@Processor(DLQ_QUEUE_NAME, { concurrency: 2 })
export class DlqProcessor extends WorkerHost {
  constructor(
    private readonly logger: AppLogger,
    private readonly notification: NotificationService,
  ) {
    super();
  }

  async process(job: Job<DlqJobPayload>): Promise<void> {
    const { orderId, traceId, storeId, failureReason, attempts } = job.data;

    await runWithTrace({ traceId, orderId, storeId }, async () => {
      this.logger.error({
        event: 'DLQ_JOB_RECEIVED',
        failureReason,
        attempts,
        jobId: job.id,
      });

      await this.notification.sendDlqAlert({ orderId, traceId, storeId, reason: failureReason, attempts });
      // DLQ job은 성공으로 ack 처리
      // (무한 재처리 방지 — 운영자가 /admin API로 수동 재처리)
    });
  }
}
