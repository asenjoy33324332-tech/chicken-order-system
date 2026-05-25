import axios, { AxiosInstance } from 'axios';
import { PosAdapter, DomainOrder, PosOrderResult } from '../pos-adapter.interface';
import { PosUnavailableError } from '../../../domain/errors/order.errors';

/** MODERN_V2 POS: REST JSON API */
export class ModernV2PosAdapter implements PosAdapter {
  private readonly client: AxiosInstance;

  constructor(endpoint: string, apiKey: string | null) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
    });
  }

  async sendOrder(order: DomainOrder): Promise<PosOrderResult> {
    try {
      const response = await this.client.post('/orders', {
        storeCode: order.storeId,
        orderTime: order.createdAt.toISOString(),
        totalAmountKrw: order.totalAmount,
        menuItems: order.items.map((item) => ({
          code: item.menuId,
          name: item.menuName,
          count: item.quantity,
          priceKrw: item.unitPrice,
        })),
      }, {
        headers: {
          // POS에도 멱등성 키 전달: POS가 중복 전송을 감지해 기존 응답 반환
          'X-Idempotency-Key': order.idempotencyKey,
          'X-Trace-Id': order.traceId,
        },
      });

      return {
        posOrderId: response.data.id as string,
        status: 'ACCEPTED',
        rawResponse: response.data as Record<string, unknown>,
      };
    } catch (err) {
      throw new PosUnavailableError(
        order.storeId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async cancelOrder(orderId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.client.delete(`/orders/${orderId}`, {
        headers: { 'X-Idempotency-Key': idempotencyKey },
      });
    } catch (err) {
      throw new PosUnavailableError(
        orderId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
