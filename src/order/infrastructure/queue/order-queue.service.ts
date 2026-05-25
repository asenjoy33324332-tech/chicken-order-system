import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import { ConfigService } from '@nestjs/config';

export const ORDERS_QUEUE_NAME = 'orders-main';
export const DLQ_QUEUE_NAME = 'orders-dlq';

export interface OrderJobPayload {
  orderId: string;
  traceId: string;
  storeId: string;
  userId: string | null;
  idempotencyKey: string;
  requestedAmount: string;
  calculatedAmount: string;
  items: Array<{
    menuId: string;
    menuName: string;
    unitPrice: string;
    quantity: number;
  }>;
  isRedrive?: boolean;
  redriveAt?: string;
}

@Injectable()
export class OrderQueueService {
  private readonly defaultJobOptions: JobsOptions;

  constructor(
    @InjectQueue(ORDERS_QUEUE_NAME) private readonly mainQueue: Queue,
    @InjectQueue(DLQ_QUEUE_NAME)    private readonly dlqQueue: Queue,
    private readonly config: ConfigService,
  ) {
    const maxAttempts = this.config.get<number>('retry.maxAttempts', 3);
    const baseDelay   = this.config.get<number>('retry.baseDelayMs', 1000);

    this.defaultJobOptions = {
      attempts: maxAttempts,
      backoff: {
        type: 'exponential',
        delay: baseDelay,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    };
  }

  async publishOrder(payload: OrderJobPayload): Promise<string> {
    const job = await this.mainQueue.add('process-order', payload, {
      ...this.defaultJobOptions,
      jobId: `order-${payload.orderId}`,
    });
    return job.id as string;
  }

  async publishToDlq(
    payload: OrderJobPayload & { failureReason: string; attempts: number },
  ): Promise<void> {
    await this.dlqQueue.add('failed-order', payload, {
      jobId: `dlq-${payload.orderId}-${Date.now()}`,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  async getQueueDepth(): Promise<{ waiting: number; active: number; failed: number }> {
    const [waiting, active, failed] = await Promise.all([
      this.mainQueue.getWaitingCount(),
      this.mainQueue.getActiveCount(),
      this.mainQueue.getFailedCount(),
    ]);
    return { waiting, active, failed };
  }
}
