# 04. 동시성 제어 전략

## 핵심 문제: 동일 요청 100건 동시 유입 시 단 1건만 처리

분산 환경에서 동일 요청 100건이 동시에 들어올 때 발생 가능한 시나리오:

1. **API 서버 100개 인스턴스가 동시에 Redis 검증** → 검증은 통과하나 race condition 가능
2. **BullMQ에 100개 job이 적재됨**
3. **Worker 여러 인스턴스가 동시에 동일 job 처리 시도**

이 문제를 단일 방어로는 해결할 수 없다. **3중 방어 레이어**가 필요하다.

---

## 방어 레이어 1: API 레벨 — Redis SETNX (멱등성 키)

### 메커니즘

```
클라이언트 요청 → idempotency_key 포함
API 서버 → Redis: SET idempotency:{key} "pending:{orderId}" NX EX 86400
```

- `NX` 플래그: 키가 없을 때만 설정 (Not eXists). **원자적 연산**.
- `EX 86400`: 24시간 TTL. 영구 저장 방지.
- 반환 `OK`: 새 요청 (최초 유입). 처리 계속.
- 반환 `nil`: 중복 요청. 기존 응답 반환.

### 왜 Redis SETNX가 원자적인가

Redis는 Single-threaded이므로 여러 클라이언트가 동시에 같은 키에 SETNX를 보내도 **한 번에 하나만** 성공한다. 이것이 Lua 스크립트 없이도 원자적인 이유다.

```
Client A: SET idempotency:key-123 "pending:order-1" NX EX 86400  → OK
Client B: SET idempotency:key-123 "pending:order-2" NX EX 86400  → nil (거부)
Client C: SET idempotency:key-123 "pending:order-3" NX EX 86400  → nil (거부)
```

100개 동시 요청 중 99개는 이 단계에서 차단된다.

### Queue 적재 실패 시 idempotency 키 보상

```typescript
// src/order/api/order.controller.ts

async createOrder(dto: CreateOrderDto): Promise<OrderAcceptedResponse> {
  const orderId = generateUUID();
  const redisKey = `idempotency:${dto.idempotencyKey}`;

  // 1) SETNX
  const isNew = await this.redis.set(redisKey, `pending:${orderId}`, 'NX', 'EX', 86400);

  if (!isNew) {
    // 중복 요청: 캐시된 응답 반환
    return this.getCachedResponse(dto.idempotencyKey);
  }

  try {
    // 2) 금액 검증 (Read Only)
    await this.validateAmount(dto);

    // 3) BullMQ 적재
    await this.ordersQueue.add('process-order', {
      orderId, traceId: dto.traceId, ...dto,
    });

    // 4) 응답 캐시 저장 (TTL 동일하게 유지)
    const response = { orderId, traceId: dto.traceId, status: 'QUEUED' };
    await this.redis.set(
      `idempotency:${dto.idempotencyKey}:response`,
      JSON.stringify(response),
      'EX', 86400,
    );

    return response;

  } catch (error) {
    // Queue 적재 실패 시: idempotency 키 삭제 (다음 재시도 허용)
    await this.redis.del(redisKey);
    throw error;
  }
}
```

---

## 방어 레이어 2: Worker 레벨 — Redis 분산 락 (Distributed Lock)

레이어 1을 통과한 요청도 (네트워크 이상, Redis Cluster failover 등으로) Worker에 중복으로 도달할 수 있다. Worker 레벨에서 분산 락으로 동시 처리를 차단한다.

### 락 획득/해제 흐름

```typescript
// src/order/worker/order.processor.ts

@Process('process-order')
async processOrder(job: Job<OrderJobPayload>): Promise<void> {
  const { orderId, traceId } = job.data;
  const lockKey = `lock:order:${orderId}`;
  const lockValue = `${this.workerId}:${job.id}`;
  const lockTTL = 60; // 60초: 처리 시간 최대 허용 시간

  // 락 획득
  const acquired = await this.redis.set(lockKey, lockValue, 'NX', 'EX', lockTTL);
  if (!acquired) {
    // 다른 Worker가 처리 중: job을 잠시 후 재시도 큐에 반환
    // (BullMQ의 delay 재시도 활용)
    throw new Error(`락 획득 실패: ${lockKey}`);
  }

  try {
    await this.processOrderInternal(job.data);
  } finally {
    // Lua 스크립트로 원자적 확인 후 삭제: 내가 설정한 락만 해제
    // 다른 Worker의 락을 실수로 해제하는 것 방지 (TTL 초과 후 재할당된 경우)
    await this.releaseLockSafely(lockKey, lockValue);
  }
}

private async releaseLockSafely(key: string, value: string): Promise<void> {
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await this.redis.eval(luaScript, 1, key, value);
}
```

### 왜 Lua 스크립트로 락을 해제하는가

단순 `DEL lockKey`는 위험하다:

```
T=0:  Worker A가 락 획득 (EX 60)
T=55: Worker A가 처리 완료, DEL 전
T=60: 락 TTL 만료
T=61: Worker B가 같은 락 키로 새 락 획득
T=62: Worker A가 DEL 실행 → Worker B의 락을 삭제해버림!
```

Lua 스크립트 `GET → 내 값이면 DEL` 은 Redis Single-thread에서 원자적으로 실행된다. 내가 설정한 락(`workerId:jobId`)이 아니면 삭제하지 않는다.

---

## 방어 레이어 3: DB 레벨 — Unique Constraint + Optimistic Lock

레이어 1, 2를 모두 통과하더라도 DB가 최후 보루다.

### 3A: DB Unique Constraint (중복 INSERT 차단)

```sql
-- idempotency_key UNIQUE 제약
-- 동일 키로 두 번째 INSERT 시 PostgreSQL이 오류 반환
INSERT INTO orders (idempotency_key, ...) VALUES ('key-123', ...);
-- → ERROR: duplicate key value violates unique constraint "orders_idempotency_key_key"

-- Worker는 이 오류를 정상적인 "이미 처리됨"으로 간주하고 job을 완료(ack) 처리
```

### 3B: Optimistic Locking (상태 전이 충돌 방지)

두 Worker가 동시에 동일 주문의 상태를 변경하려 할 때:

```
Worker A: SELECT * FROM orders WHERE id = '123' → {status: 'QUEUED', version: 0}
Worker B: SELECT * FROM orders WHERE id = '123' → {status: 'QUEUED', version: 0}

Worker A: UPDATE orders SET status='SAVED', version=1 WHERE id='123' AND version=0
          → rowCount: 1 (성공)

Worker B: UPDATE orders SET status='SAVED', version=1 WHERE id='123' AND version=0
          → rowCount: 0 (실패: version이 이미 1로 바뀜)
          → StaleOrderVersionError 발생 → BullMQ 재시도 또는 무시
```

version이 일치하지 않으면 UPDATE가 아무것도 건드리지 않으므로 Deadlock 위험 없이 안전하게 충돌을 감지한다.

---

## 동시성 제어 레이어 요약

```
동일 요청 100건 동시 유입
         │
         ▼
[레이어 1: Redis SETNX] ──── 99건 차단 ────▶ 중복 응답 반환
         │ 1건 통과
         ▼
[BullMQ에 1개 job 적재]
         │
         ▼
[레이어 2: Redis 분산 락] ── (Worker 중복 실행 시도) ── 차단
         │ 1개 처리
         ▼
[레이어 3A: DB UNIQUE] ──── (이미 존재하면) ──────────▶ 무시 처리
         │ 신규
         ▼
[레이어 3B: Optimistic Lock] ─ (버전 불일치) ──────────▶ 재시도
         │ 성공
         ▼
   단 1건 정상 처리 완료
```

---

## 금액 교차 검증 (결제 무결성)

결제 요청 금액과 서버 계산 금액의 불일치를 차단한다.

```typescript
// src/order/api/validators/amount.validator.ts

async validateAmount(items: OrderItemDto[], storeId: string): Promise<void> {
  // DB Read Replica에서 현재 메뉴 단가 조회
  const menuIds = items.map(i => i.menuId);
  const menus = await this.menuRepository.findByIds(menuIds, storeId);

  const menuMap = new Map(menus.map(m => [m.id, m]));

  let calculatedTotal = new Decimal(0);

  for (const item of items) {
    const menu = menuMap.get(item.menuId);
    if (!menu) {
      throw new MenuNotFoundException(`메뉴 없음: ${item.menuId}`);
    }
    if (!menu.isAvailable) {
      throw new MenuUnavailableException(`품절 메뉴: ${menu.name}`);
    }
    calculatedTotal = calculatedTotal.plus(
      new Decimal(menu.unitPrice).times(item.quantity)
    );
  }

  // 부동소수점 오류 방지: NUMERIC 타입으로 비교
  if (!calculatedTotal.equals(new Decimal(dto.totalAmount))) {
    throw new AmountMismatchException(
      `금액 불일치: 요청=${dto.totalAmount}, 계산=${calculatedTotal}`,
    );
  }
}
```

**Decimal 라이브러리 사용 이유**: JavaScript의 `number` 타입은 부동소수점 오류가 있다 (`0.1 + 0.2 !== 0.3`). 금액 계산에는 반드시 `decimal.js` 또는 `big.js`를 사용해야 한다.
