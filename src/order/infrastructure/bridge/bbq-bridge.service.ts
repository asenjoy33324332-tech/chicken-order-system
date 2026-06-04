import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class BbqBridgeService {
  private readonly logger = new Logger(BbqBridgeService.name);
  private readonly bbqUrl: string;
  private readonly bbqApiKey: string;

  constructor(private readonly config: ConfigService) {
    this.bbqUrl    = config.get<string>('bbq.gatewayUrl', '');
    this.bbqApiKey = config.get<string>('bbq.apiKey', '');
  }

  async requestCompensation(params: {
    orderId: string;
    kcpTno?: string;
    reason: string;
  }): Promise<void> {
    if (!this.bbqUrl) {
      this.logger.warn({ event: 'BBQ_BRIDGE_DISABLED', ...params });
      return;
    }

    try {
      await axios.post(
        `${this.bbqUrl}/webhook/compensate`,
        params,
        {
          headers: {
            'x-api-key': this.bbqApiKey,
            'x-client-role': 'nestjs-worker',
          },
          timeout: 10_000,
        },
      );
      this.logger.log(JSON.stringify({ event: 'BBQ_COMPENSATION_SENT', orderId: params.orderId }));
    } catch (e: any) {
      this.logger.error({ event: 'BBQ_COMPENSATION_FAILED', orderId: params.orderId, error: e.message });
    }
  }

  async notifyOrderStatus(params: {
    orderId: string;
    status: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.bbqUrl) return;

    try {
      await axios.post(
        `${this.bbqUrl}/internal/order-status`,
        params,
        {
          headers: {
            'x-api-key': this.bbqApiKey,
            'x-client-role': 'nestjs-worker',
          },
          timeout: 5_000,
        },
      );
    } catch (e: any) {
      this.logger.warn({ event: 'BBQ_STATUS_NOTIFY_FAILED', orderId: params.orderId, error: e.message });
    }
  }
}
