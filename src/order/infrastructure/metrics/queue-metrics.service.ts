import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { OrderQueueService, ORDERS_QUEUE_NAME } from '../queue/order-queue.service';
import { AppLogger } from '../../../common/logger/logger.service';

const PUBLISH_INTERVAL_MS = 30_000;

@Injectable()
export class QueueMetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private readonly cw: CloudWatchClient;
  private readonly stage: string;
  private readonly enabled: boolean;

  constructor(
    private readonly queue: OrderQueueService,
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.stage = config.get<string>('nodeEnv', 'production') === 'production' ? 'production' : 'staging';
    // CloudWatch 발행은 NODE_ENV=production 또는 명시적 활성화 시에만
    this.enabled = !!process.env.AWS_REGION || !!process.env.AWS_DEFAULT_REGION;
    this.cw = new CloudWatchClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-2',
    });
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.warn({ event: 'QUEUE_METRICS_DISABLED', reason: 'AWS_REGION not set' });
      return;
    }
    // 즉시 1회 발행 후 30초 간격 반복
    this.publish();
    this.timer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async publish(): Promise<void> {
    try {
      const { waiting, active } = await this.queue.getQueueDepth();

      await this.cw.send(new PutMetricDataCommand({
        Namespace: 'OrderSystem/Queue',
        MetricData: [
          {
            MetricName: 'WaitingJobCount',
            Value: waiting,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Stage',     Value: this.stage },
              { Name: 'QueueName', Value: ORDERS_QUEUE_NAME },
            ],
          },
          {
            MetricName: 'ActiveJobCount',
            Value: active,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Stage',     Value: this.stage },
              { Name: 'QueueName', Value: ORDERS_QUEUE_NAME },
            ],
          },
        ],
      }));

      this.logger.debug({ event: 'QUEUE_METRICS_PUBLISHED', waiting, active });
    } catch (err) {
      // 메트릭 발행 실패는 주문 처리에 영향 없음
      this.logger.warn({
        event: 'QUEUE_METRICS_PUBLISH_FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
