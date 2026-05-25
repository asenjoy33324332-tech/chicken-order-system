import { InvalidStateTransitionError } from './errors/order.errors';

export type OrderStatus =
  | 'QUEUED'
  | 'SAVED'
  | 'SENT_TO_POS'
  | 'COMPLETED'
  | 'FAILED';

/**
 * 허용된 상태 전이 맵.
 * 코드 어디서도 이 맵을 우회할 수 없다.
 * FAILED → QUEUED 는 관리자 수동 재처리 전용 (isAdminRedrive 플래그로만 허용).
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  QUEUED:      ['SAVED', 'FAILED'],
  SAVED:       ['SENT_TO_POS', 'FAILED'],
  SENT_TO_POS: ['COMPLETED'],
  COMPLETED:   [],
  FAILED:      [],
};

const ADMIN_REDRIVE_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  FAILED: ['QUEUED'],
  QUEUED:      [],
  SAVED:       [],
  SENT_TO_POS: [],
  COMPLETED:   [],
};

export class OrderStateMachine {
  static validate(
    current: OrderStatus,
    next: OrderStatus,
    options: { isAdminRedrive?: boolean } = {},
  ): void {
    const allowed = options.isAdminRedrive
      ? ADMIN_REDRIVE_TRANSITIONS[current]
      : ALLOWED_TRANSITIONS[current];

    if (!allowed.includes(next)) {
      throw new InvalidStateTransitionError(current, next, allowed);
    }
  }

  static isTerminal(status: OrderStatus): boolean {
    return status === 'COMPLETED' || status === 'FAILED';
  }
}
