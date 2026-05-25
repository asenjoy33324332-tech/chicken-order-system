export interface DomainOrderItem {
  menuId: string;
  menuName: string;
  unitPrice: string;
  quantity: number;
}

export interface DomainOrder {
  orderId: string;
  traceId: string;
  storeId: string;
  idempotencyKey: string;
  totalAmount: string;
  items: DomainOrderItem[];
  createdAt: Date;
}

export interface PosOrderResult {
  posOrderId: string;
  status: 'ACCEPTED' | 'REJECTED';
  message?: string;
  rawResponse?: Record<string, unknown>;
}

/** ACL 인터페이스: 내부 도메인 ↔ 외부 POS 스펙 변환을 전담 */
export interface PosAdapter {
  sendOrder(order: DomainOrder): Promise<PosOrderResult>;
  cancelOrder(orderId: string, idempotencyKey: string): Promise<void>;
}
