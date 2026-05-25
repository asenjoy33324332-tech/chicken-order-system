export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 재시도해도 의미 없는 비즈니스 오류 — DLQ 이관 없이 즉시 FAILED */
export class BusinessLogicError extends OrderError {}

/** 재시도 가능한 인프라 오류 */
export class RetryableError extends OrderError {}

export class AmountMismatchError extends BusinessLogicError {
  constructor(requested: string, calculated: string) {
    super(`금액 불일치: 요청=${requested}, 서버계산=${calculated}`);
  }
}

export class MenuNotFoundError extends BusinessLogicError {
  constructor(menuId: string) {
    super(`메뉴 없음: ${menuId}`);
  }
}

export class MenuUnavailableError extends BusinessLogicError {
  constructor(menuName: string) {
    super(`품절 메뉴: ${menuName}`);
  }
}

export class InvalidStateTransitionError extends BusinessLogicError {
  constructor(from: string, to: string, allowed: string[]) {
    super(
      `상태 전이 불가: ${from} → ${to}. 허용: [${allowed.join(', ') || '없음 (종단 상태)'}]`,
    );
  }
}

export class StaleOrderVersionError extends RetryableError {
  constructor(orderId: string, expectedVersion: number) {
    super(`주문 ${orderId} 버전 충돌 (expected v${expectedVersion}). 다른 Worker가 먼저 처리함.`);
  }
}

export class LockAcquisitionError extends RetryableError {
  constructor(orderId: string) {
    super(`분산 락 획득 실패: ${orderId}. 다른 Worker 처리 중.`);
  }
}

export class PosUnavailableError extends RetryableError {
  constructor(storeId: string, reason: string) {
    super(`POS 연동 실패 (매장: ${storeId}): ${reason}`);
  }
}

export class CircuitBreakerOpenError extends RetryableError {
  constructor(storeId: string) {
    super(`서킷 브레이커 OPEN: 매장 ${storeId} POS 연동 일시 차단 중`);
  }
}
