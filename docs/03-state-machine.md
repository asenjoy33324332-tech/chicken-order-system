# 03. 상태 머신 (Order State Machine)

## 왜 상태 머신이 필수인가

상태를 코드로만 제어하면 다음과 같은 위험이 존재한다:
- 버그로 인한 잘못된 상태 기록
- 재시도 로직의 중복 실행으로 인한 상태 역행
- Worker 크래시 후 복구 시 현재 상태 불명확

**상태 머신의 역할**: 어떤 경로로든 상태 전이가 발생할 때 반드시 정해진 규칙을 통과하도록 강제한다. DB 레벨 + 애플리케이션 레벨의 이중 강제를 통해 임의 변경을 물리적으로 차단한다.

---

## 상태 정의

| 상태 | 의미 | 소유자 |
|------|------|--------|
| `QUEUED` | BullMQ에서 Job을 수신, DB에 최초 기록됨 | Worker |
| `SAVED` | 비즈니스 로직 처리 완료, DB 영속화 완료 | Worker |
| `SENT_TO_POS` | POS 시스템에 주문 전송 완료 | Worker |
| `COMPLETED` | POS가 주문 수신 확인 완료 | Worker |
| `FAILED` | 복구 불가 실패 (3회 재시도 소진 후 DLQ 이관) | Worker |

---

## 허용된 전이 (Allowed Transitions)

```
         ┌─────────────────────────────────────────────────┐
         │                                                 │
         ▼                                                 │ (재시도 소진)
[QUEUED] ──▶ [SAVED] ──▶ [SENT_TO_POS] ──▶ [COMPLETED]   │
                │                                          │
                └─────────────────────────────────────────▶[FAILED]
```

### 허용 전이 테이블

| from | to | 조건 |
|------|----|------|
| `QUEUED` | `SAVED` | 비즈니스 검증 통과, DB Insert 완료 |
| `QUEUED` | `FAILED` | 비즈니스 검증 실패 (재시도 불필요한 오류) |
| `SAVED` | `SENT_TO_POS` | POS API 호출 성공 |
| `SAVED` | `FAILED` | POS 재시도 3회 소진 |
| `SENT_TO_POS` | `COMPLETED` | POS 확인 응답 수신 |
| `SENT_TO_POS` | `SAVED` | **절대 금지** (역행) |
| `COMPLETED` | * | **절대 금지** (종단 상태) |
| `FAILED` | `QUEUED` | **관리자 수동 재처리만 허용** (DLQ re-drive) |

---

## 구현: 이중 강제

### 1계층: DB CHECK 제약 (물리적 차단)

```sql
-- 유효하지 않은 상태 값 자체를 DB가 거부
CONSTRAINT chk_order_status CHECK (
  status IN ('QUEUED', 'SAVED', 'SENT_TO_POS', 'COMPLETED', 'FAILED')
)
```

DB는 상태 값의 유효성만 체크한다. 상태 전이의 순서는 애플리케이션 레벨에서 강제한다.

### 2계층: 애플리케이션 상태 머신 (TypeScript)

```typescript
// src/order/domain/order-state-machine.ts

type OrderStatus = 'QUEUED' | 'SAVED' | 'SENT_TO_POS' | 'COMPLETED' | 'FAILED';

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  QUEUED:       ['SAVED', 'FAILED'],
  SAVED:        ['SENT_TO_POS', 'FAILED'],
  SENT_TO_POS:  ['COMPLETED'],
  COMPLETED:    [],          // 종단 상태: 어떤 전이도 불가
  FAILED:       ['QUEUED'],  // 관리자 수동 재처리 전용
};

export class OrderStateMachine {
  /**
   * 전이 가능 여부를 검증한다.
   * Worker 코드에서 DB UPDATE 직전에 반드시 호출해야 한다.
   */
  static validateTransition(
    currentStatus: OrderStatus,
    nextStatus: OrderStatus,
  ): void {
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed.includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `상태 전이 불가: ${currentStatus} → ${nextStatus}. ` +
        `허용 전이: ${allowed.join(', ') || '없음 (종단 상태)'}`,
      );
    }
  }
}
```

### 3계층: DB Optimistic Lock (동시성 방어)

```typescript
// src/order/infrastructure/order.repository.ts

async transitionStatus(
  orderId: string,
  expectedCurrentStatus: OrderStatus,
  nextStatus: OrderStatus,
  currentVersion: number,
  workerId: string,
): Promise<void> {
  // 1) 상태 머신 유효성 검증
  OrderStateMachine.validateTransition(expectedCurrentStatus, nextStatus);

  // 2) DB UPDATE with optimistic lock
  const result = await this.db.query(
    `UPDATE orders
     SET    status = $1,
            version = version + 1,
            ${nextStatus.toLowerCase()}_at = NOW()
     WHERE  id = $2
       AND  status = $3     -- 현재 상태 검증
       AND  version = $4    -- 낙관적 락 버전 검증
    `,
    [nextStatus, orderId, expectedCurrentStatus, currentVersion],
  );

  if (result.rowCount === 0) {
    // 0 rows = 다른 Worker가 이미 상태를 변경했거나, 예상과 다른 상태
    throw new StaleOrderVersionError(
      `주문 ${orderId}: 상태 전이 충돌. ` +
      `예상 상태: ${expectedCurrentStatus} (v${currentVersion})`,
    );
  }

  // 3) 감사 로그 기록 (별도 INSERT, 트랜잭션 동일 범위)
  await this.db.query(
    `INSERT INTO order_state_transitions
       (order_id, from_status, to_status, worker_id)
     VALUES ($1, $2, $3, $4)`,
    [orderId, expectedCurrentStatus, nextStatus, workerId],
  );
}
```

---

## 상태별 타임아웃 감시 (운영 안전망)

`SAVED` 상태로 30분 이상 머무는 주문은 POS 연동이 조용히 실패한 것으로 간주한다.

```sql
-- 스케줄러(cron)가 5분마다 실행: 장시간 SAVED 주문 감지
SELECT id, store_id, trace_id, saved_at,
       NOW() - saved_at AS stuck_duration
FROM   orders
WHERE  status = 'SAVED'
  AND  saved_at < NOW() - INTERVAL '30 minutes';
```

감지 시 처리:
1. Slack 알림 트리거 (운영자 인지)
2. 자동으로 DLQ 이관 후 FAILED 처리 (운영자 수동 판단 후 재처리)

---

## 장애 시나리오별 상태 머신 동작

### 시나리오 A: Worker가 SAVED 처리 중 크래시

```
Worker → DB UPDATE(SAVED) 완료
Worker → POS 호출 시도 중 → Worker 프로세스 크래시
```

결과: DB에는 `SAVED` 상태로 기록됨. BullMQ의 job은 `active` 상태로 남음.

BullMQ 복구: `lockDuration` (기본 30초) 이후 job이 `waiting` 상태로 복귀.
다른 Worker가 job을 재수신:
- Step 2 (DB 중복 확인)에서 `SAVED` 상태의 레코드 발견
- `SAVED` 상태이므로 POS 전송(SENT_TO_POS) 단계로 이동
- 중복 DB INSERT 없음 → 데이터 정합성 유지

### 시나리오 B: POS 전송 성공 후 DB UPDATE 실패 (SENT_TO_POS 기록 실패)

```
Worker → POS 호출 성공 (POS는 주문 수신)
Worker → DB UPDATE(SENT_TO_POS) 실패 (DB 순간 장애)
```

결과: POS에는 주문이 있지만 DB는 `SAVED` 상태.
BullMQ 재시도: Worker가 다시 POS를 호출하면 **POS에 중복 주문이 전송될 위험**.

해결책:
1. POS 호출 시 `idempotency_key`를 POS API 헤더에 포함
2. POS 시스템이 중복 키를 감지하면 기존 응답을 반환
3. Worker는 POS 응답(성공)을 기준으로 DB 상태를 갱신

```typescript
// POS 호출 시 idempotency_key를 요청에 포함
await posAdapter.sendOrder({
  order: orderPayload,
  idempotencyKey: order.idempotencyKey,  // POS에도 멱등성 키 전달
});
```

이것이 ACL(Anti-Corruption Layer)이 중요한 이유다: 내부 도메인의 `idempotency_key` 개념을 각 POS 시스템의 고유 헤더 형식으로 변환하는 역할을 ACL이 담당한다.
