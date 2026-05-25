import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ProcessOrderService } from '../application/process-order.service';
import { OrderJobPayload, ORDERS_QUEUE_NAME } from '../infrastructure/queue/order-queue.service';
import { AppLogger } from '../../common/logger/logger.service';
import { LockAcquisitionError } from '../domain/errors/order.errors';

const WORKER_ID = `worker-${process.env.HOSTNAME || 'local'}-${process.pid}`;

@Processor(ORDERS_QUEUE_NAME, {
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '20', 10),
  limiter: {
    max: parseInt(process.env.WORKER_RATE_LIMIT || '100', 10),
    duration: 1000,
  },
})
export class OrderProcessor extends WorkerHost {
  constructor(
    private readonly processOrder: ProcessOrderService,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  async process(job: Job<OrderJobPayload>): Promise<void> {
    try {
      await this.processOrder.process(job.data, {
        jobId: job.id as string,
        workerId: WORKER_ID,
        attemptsMade: job.attemptsMade,
      });
    } catch (err) {
      if (err instanceof LockAcquisitionError) {
        // 락 획득 실패: BullMQ가 backoff 후 재시도
        throw err;
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<OrderJobPayload>, error: Error): Promise<void> {
    await this.processOrder.handleFailure(job.data, error, {
      jobId: job.id as string,
      workerId: WORKER_ID,
      attemptsMade: job.attemptsMade,
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug({ event: 'JOB_COMPLETED', jobId: job.id });
  }
}
