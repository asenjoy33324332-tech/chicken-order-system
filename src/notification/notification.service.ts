import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AppLogger } from '../common/logger/logger.service';

export interface AlertPayload {
  orderId: string;
  traceId: string;
  storeId: string;
  reason: string;
  attempts: number;
  dashboardUrl?: string;
}

@Injectable()
export class NotificationService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  async sendDlqAlert(payload: AlertPayload): Promise<void> {
    const webhookUrl = this.config.get<string>('slack.webhookUrl', '');
    if (!webhookUrl) {
      this.logger.warn({ event: 'SLACK_NOT_CONFIGURED', orderId: payload.orderId });
      return;
    }

    const text =
      `🚨 *주문 처리 최종 실패 — DLQ 이관*\n` +
      `• 주문 ID: \`${payload.orderId}\`\n` +
      `• 매장: \`${payload.storeId}\`\n` +
      `• 실패 사유: ${payload.reason}\n` +
      `• 재시도 횟수: ${payload.attempts}회\n` +
      `• traceId: \`${payload.traceId}\`\n` +
      (payload.dashboardUrl ? `• 대시보드: ${payload.dashboardUrl}` : '');

    try {
      await axios.post(webhookUrl, { text });
    } catch (err) {
      // 알림 실패가 주문 처리 실패로 이어지면 안 된다
      this.logger.error({
        event: 'SLACK_ALERT_FAILED',
        orderId: payload.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
