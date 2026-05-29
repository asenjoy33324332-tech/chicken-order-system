import axios, { AxiosInstance } from 'axios';
import { PosAdapter, DomainOrder, PosOrderResult } from '../pos-adapter.interface';
import { PosUnavailableError } from '../../../domain/errors/order.errors';

/** LEGACY_V1 POS: XML 기반, 날짜 YYYYMMDD 형식, 금액 단위 '전' */
export class LegacyV1PosAdapter implements PosAdapter {
  private readonly client: AxiosInstance;

  constructor(endpoint: string, apiKey: string | null) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 8000,
      headers: {
        'Content-Type': 'application/xml',
        ...(apiKey && { 'X-Api-Key': apiKey }),
      },
    });
  }

  async sendOrder(order: DomainOrder): Promise<PosOrderResult> {
    try {
      const xml = this.buildXml(order);
      const response = await this.client.post('/order/receive', xml, {
        headers: {
          // 레거시 POS 고유 중복 방지 헤더 형식
          'X-IDEMPOTENCY': order.idempotencyKey.replace(/-/g, '').toUpperCase(),
        },
      });

      const posOrderId = this.parseOrderId(response.data as string);
      return { posOrderId, status: 'ACCEPTED', rawResponse: { xml: response.data } };
    } catch (err) {
      throw new PosUnavailableError(
        order.storeId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async cancelOrder(orderId: string, idempotencyKey: string): Promise<void> {
    try {
      const xml = `<CANCEL><ORDER_ID>${orderId}</ORDER_ID></CANCEL>`;
      await this.client.post('/order/cancel', xml, {
        headers: { 'X-IDEMPOTENCY': idempotencyKey.replace(/-/g, '').toUpperCase() },
      });
    } catch (err) {
      throw new PosUnavailableError(
        orderId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private buildXml(order: DomainOrder): string {
    const dateStr = order.createdAt
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');

    const itemsXml = order.items
      .map(
        (item) =>
          `<ITEM>` +
          `<MENU_CODE>${item.menuId}</MENU_CODE>` +
          `<QTY>${item.quantity}</QTY>` +
          // 레거시 POS는 금액을 '전' 단위로 처리 (1원 = 100전)
          `<PRICE>${Math.round(item.unitPrice * 100)}</PRICE>` +
          `</ITEM>`,
      )
      .join('');

    return (
      `<ORDER>` +
      `<STORE_ID>${order.storeId}</STORE_ID>` +
      `<ORDER_DATE>${dateStr}</ORDER_DATE>` +
      `<TOTAL>${Math.round(parseFloat(order.totalAmount) * 100)}</TOTAL>` +
      `<ITEMS>${itemsXml}</ITEMS>` +
      `</ORDER>`
    );
  }

  private parseOrderId(xml: string): string {
    const match = xml.match(/<ORDER_ID>([^<]+)<\/ORDER_ID>/);
    return match ? match[1] : `legacy-${Date.now()}`;
  }
}
