# 06. 운영 관측성 (Observability)

## 핵심 원칙

"장애 발생 시 5분 안에 원인을 특정할 수 있어야 한다."

이를 위해 필요한 것:
1. **어디서 발생했는가** — 컴포넌트, 서비스, 인스턴스
2. **어떤 요청에서 발생했는가** — traceId로 전 구간 추적
3. **언제 발생했는가** — 정확한 타임스탬프, 각 단계 소요 시간
4. **무엇이 실패했는가** — 구조화된 에러 정보

---

## 1. traceId 기반 분산 추적

### traceId 발급 및 전파

모든 요청은 최초 진입 시 UUID v4의 `traceId`를 발급받는다. 이 값은 해당 주문의 생애 전 구간에 걸쳐 모든 로그에 포함된다.

```
클라이언트 요청
    │
    ▼ [API 서버] traceId 발급 (UUID v4)
    │ 로그: { traceId, event: "ORDER_RECEIVED" }
    │
    ▼ [BullMQ Job Payload] traceId 포함
    │
    ▼ [Worker] traceId를 Job에서 추출하여 모든 로그에 주입
    │ 로그: { traceId, event: "WORKER_PROCESSING" }
    │
    ▼ [POS 호출] HTTP 헤더 X-Trace-Id: {traceId}
    │ 로그: { traceId, event: "POS_CALL_START" }
    │
    ▼ [PostgreSQL 기록] trace_id 컬럼에 저장
```

traceId를 PostgreSQL `orders.trace_id`에 저장하는 이유: 로그 시스템이 다운되어도 DB에서 특정 주문의 traceId를 조회할 수 있다.

### AsyncLocalStorage를 이용한 자동 traceId 주입

모든 함수에 traceId 파라미터를 전달하는 것은 코드를 오염시킨다. `AsyncLocalStorage`를 사용하면 현재 실행 컨텍스트에서 자동으로 traceId를 읽을 수 있다.

```typescript
// src/common/trace-context.ts

import { AsyncLocalStorage } from 'async_hooks';

interface TraceContext {
  traceId: string;
  orderId?: string;
  storeId?: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): TraceContext {
  return traceStorage.getStore() ?? { traceId: 'no-trace' };
}

// src/common/logging/logger.ts

import pino from 'pino';
import { getTraceContext } from '../trace-context';

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export const logger = {
  info: (data: object) => baseLogger.info({ ...getTraceContext(), ...data }),
  warn: (data: object) => baseLogger.warn({ ...getTraceContext(), ...data }),
  error: (data: object) => baseLogger.error({ ...getTraceContext(), ...data }),
};
```

---

## 2. 구조화 로그 이벤트 목록

모든 로그는 JSON 형식이며, 아래 공통 필드를 포함한다:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "service": "api-server",
  "instanceId": "api-pod-3",
  "traceId": "550e8400-e29b-41d4-a716-446655440000",
  "orderId": "order-uuid",
  "storeId": "store-uuid",
  "event": "ORDER_QUEUED",
  "durationMs": 45
}
```

### 이벤트 목록

| 이벤트 | 서비스 | 레벨 | 의미 |
|-------|--------|------|------|
| `ORDER_RECEIVED` | api | info | 요청 수신, traceId 발급 |
| `IDEMPOTENCY_DUPLICATE` | api | info | 중복 요청 감지, 캐시 응답 반환 |
| `IDEMPOTENCY_NEW` | api | info | 새 요청 통과 |
| `AMOUNT_VALIDATION_PASS` | api | info | 금액 검증 통과 |
| `AMOUNT_VALIDATION_FAIL` | api | warn | 금액 불일치 |
| `ORDER_QUEUED` | api | info | BullMQ 적재 완료, HTTP 202 반환 |
| `QUEUE_PUBLISH_FAIL` | api | error | BullMQ 적재 실패, 503 반환 |
| `WORKER_JOB_START` | worker | info | Worker가 job 수신 |
| `LOCK_ACQUIRED` | worker | debug | 분산 락 획득 |
| `LOCK_FAILED` | worker | warn | 분산 락 획득 실패 (다른 Worker 처리 중) |
| `DUPLICATE_DETECTED_DB` | worker | info | DB Unique 위반 → 중복 확인, 정상 처리 |
| `STATE_TRANSITION` | worker | info | 상태 전이 발생 (from, to 포함) |
| `POS_CALL_START` | worker | info | POS API 호출 시작 |
| `POS_CALL_SUCCESS` | worker | info | POS 응답 수신, 성공 |
| `POS_CALL_FAIL` | worker | warn | POS 호출 실패 (attempt 번호 포함) |
| `CIRCUIT_BREAKER_OPEN` | worker | error | 서킷 브레이커 OPEN 상태 전환 |
| `CIRCUIT_BREAKER_CLOSE` | worker | info | 서킷 브레이커 CLOSED 복구 |
| `ORDER_COMPLETED` | worker | info | 주문 처리 완료 (전체 소요 시간 포함) |
| `ORDER_MOVED_TO_DLQ` | worker | error | 최종 실패, DLQ 이관 |
| `ORDER_REDRIVEN` | admin | info | 관리자 수동 재처리 트리거 |

---

## 3. 전체 E2E 추적 예시

하나의 주문에 대한 정상 흐름 로그:

```json
{"timestamp":"2024-01-15T10:30:00.001Z","level":"info","service":"api","traceId":"trace-001","event":"ORDER_RECEIVED","storeId":"store-123","userId":"user-456"}
{"timestamp":"2024-01-15T10:30:00.003Z","level":"info","service":"api","traceId":"trace-001","event":"IDEMPOTENCY_NEW","idempotencyKey":"key-xyz"}
{"timestamp":"2024-01-15T10:30:00.015Z","level":"info","service":"api","traceId":"trace-001","event":"AMOUNT_VALIDATION_PASS","requestedAmount":25000,"calculatedAmount":25000}
{"timestamp":"2024-01-15T10:30:00.018Z","level":"info","service":"api","traceId":"trace-001","orderId":"order-789","event":"ORDER_QUEUED","durationMs":17}

{"timestamp":"2024-01-15T10:30:00.050Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"WORKER_JOB_START","workerId":"worker-pod-2"}
{"timestamp":"2024-01-15T10:30:00.052Z","level":"debug","service":"worker","traceId":"trace-001","orderId":"order-789","event":"LOCK_ACQUIRED"}
{"timestamp":"2024-01-15T10:30:00.068Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"STATE_TRANSITION","from":null,"to":"QUEUED"}
{"timestamp":"2024-01-15T10:30:00.075Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"STATE_TRANSITION","from":"QUEUED","to":"SAVED"}
{"timestamp":"2024-01-15T10:30:00.076Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"POS_CALL_START","posType":"MODERN_V2"}
{"timestamp":"2024-01-15T10:30:00.312Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"POS_CALL_SUCCESS","durationMs":236}
{"timestamp":"2024-01-15T10:30:00.320Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"STATE_TRANSITION","from":"SAVED","to":"SENT_TO_POS"}
{"timestamp":"2024-01-15T10:30:00.328Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"STATE_TRANSITION","from":"SENT_TO_POS","to":"COMPLETED"}
{"timestamp":"2024-01-15T10:30:00.329Z","level":"info","service":"worker","traceId":"trace-001","orderId":"order-789","event":"ORDER_COMPLETED","totalDurationMs":279}
```

이 로그만으로 `traceId: "trace-001"` 필터로 해당 주문의 전 처리 과정을 재현할 수 있다.

---

## 4. 핵심 지표 (Metrics)

| 지표 | 측정 방법 | 알림 임계값 |
|-----|---------|-----------|
| API P99 레이턴시 | CloudWatch Metric Filter | > 500ms |
| BullMQ 큐 깊이 | BullMQ API polling | > 1000 |
| Worker 처리 실패율 | `ORDER_MOVED_TO_DLQ` 이벤트 수 | > 1% |
| POS 에러율 (매장별) | `POS_CALL_FAIL` / `POS_CALL_START` | > 50% (CB 자동 발동) |
| 서킷 브레이커 OPEN 수 | `CIRCUIT_BREAKER_OPEN` 이벤트 | > 0 (즉시 알림) |
| SAVED 상태 정체 주문 | DB 쿼리 | > 30분 체류 |
| DB 커넥션 사용률 | RDS CloudWatch | > 80% |

---

## 5. 운영 대시보드 (관리자)

```
┌──────────────────────────────────────────────────────────┐
│              주문 처리 현황 대시보드                         │
├──────────────┬──────────────┬──────────────┬─────────────┤
│  총 처리 건  │  실패 (DLQ)  │  진행 중     │  POS 장애   │
│   12,340     │     23       │    156       │  매장 2개   │
├──────────────┴──────────────┴──────────────┴─────────────┤
│  서킷 브레이커 현황                                          │
│  ● 매장-001: CLOSED  ● 매장-002: OPEN(12분 경과)           │
│  ● 매장-003: CLOSED  ● 매장-004: HALF-OPEN                 │
├─────────────────────────────────────────────────────────  │
│  DLQ 목록                              [전체 재처리]        │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ orderId      │ 매장   │ 실패 시각  │ 원인  │ [재처리]│  │
│  │ order-789    │ 매장-2 │ 10:30:00  │ POS   │ [재처리]│  │
│  │ order-790    │ 매장-2 │ 10:31:00  │ POS   │ [재처리]│  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```
