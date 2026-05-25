# 02. 데이터 모델 설계

## 설계 원칙

DB 스키마는 **애플리케이션 코드보다 먼저, 더 강력하게** 무결성을 보장해야 한다. 코드는 실수가 가능하지만, DB 제약 조건은 물리적으로 위반이 불가능하다.

- 모든 상태 값은 CHECK 제약으로 유효 값만 허용
- idempotency_key는 UNIQUE 제약으로 DB 레벨 중복 차단
- 낙관적 락을 위한 version 컬럼 필수
- 주문 금액은 요청 금액(requested_amount)과 서버 계산 금액(calculated_amount)을 모두 저장하여 감사 추적 가능

---

## ERD (Entity Relationship)

```
stores ─────┬──── menus
            │
            └──── orders ─────┬──── order_items
                               │
                               └──── order_state_transitions
```

---

## 테이블 정의

### stores

```sql
CREATE TABLE stores (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  pos_type        VARCHAR(50)  NOT NULL,
  -- 허용 POS 타입을 CHECK로 강제 → 알 수 없는 POS 유형 추가 방지
  CONSTRAINT chk_pos_type CHECK (pos_type IN ('LEGACY_V1', 'MODERN_V2', 'TABLET_V3')),
  pos_endpoint    VARCHAR(500) NOT NULL,
  pos_api_key_enc VARCHAR(500),           -- AES-256 암호화 저장
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### menus

```sql
CREATE TABLE menus (
  id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID           NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name         VARCHAR(255)   NOT NULL,
  unit_price   NUMERIC(10,2)  NOT NULL CHECK (unit_price >= 0),
  is_available BOOLEAN        NOT NULL DEFAULT TRUE,
  version      INTEGER        NOT NULL DEFAULT 0,  -- 낙관적 락용
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menus_store_id ON menus(store_id);
-- API 서버의 금액 검증 쿼리 성능 최적화
CREATE INDEX idx_menus_store_available ON menus(store_id, is_available) WHERE is_available = TRUE;
```

### orders

```sql
CREATE TABLE orders (
  id                 UUID           PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 중복 방어의 최후 보루: DB 레벨 UNIQUE 제약
  idempotency_key    VARCHAR(255)   NOT NULL UNIQUE,

  -- 옵저버빌리티: 요청부터 완료까지 단일 추적 키
  trace_id           VARCHAR(255)   NOT NULL,

  store_id           UUID           NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  user_id            UUID,          -- nullable: 비회원/키오스크 주문 허용

  -- 상태 머신 강제: DB 레벨에서 유효하지 않은 상태값 물리적 차단
  status             VARCHAR(20)    NOT NULL DEFAULT 'QUEUED',
  CONSTRAINT chk_order_status CHECK (
    status IN ('QUEUED', 'SAVED', 'SENT_TO_POS', 'COMPLETED', 'FAILED')
  ),

  -- 금액 감사: 요청값 vs 서버 계산값 모두 보존
  requested_amount   NUMERIC(10,2)  NOT NULL CHECK (requested_amount >= 0),
  calculated_amount  NUMERIC(10,2)  NOT NULL CHECK (calculated_amount >= 0),

  -- 낙관적 락: UPDATE 시 version 불일치 → 0 rows affected → 재시도 트리거
  version            INTEGER        NOT NULL DEFAULT 0,

  -- POS 연동 결과
  pos_response       JSONB,
  pos_error_message  TEXT,
  retry_count        INTEGER        NOT NULL DEFAULT 0 CHECK (retry_count >= 0),

  -- DLQ 이관 추적
  dlq_at             TIMESTAMPTZ,
  failure_reason     TEXT,

  -- 상태별 타임스탬프: 각 상태 전이 시각을 개별 컬럼으로 기록
  -- NULL이면 아직 해당 상태에 도달하지 않은 것
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  queued_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  saved_at           TIMESTAMPTZ,
  sent_to_pos_at     TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ
);

-- 조회 패턴 기반 인덱스
CREATE INDEX idx_orders_store_id      ON orders(store_id);
CREATE INDEX idx_orders_status        ON orders(status);
CREATE INDEX idx_orders_trace_id      ON orders(trace_id);
CREATE INDEX idx_orders_store_status  ON orders(store_id, status);
-- DLQ 관리 대시보드용: 미완료 주문 조회
CREATE INDEX idx_orders_dlq           ON orders(dlq_at) WHERE dlq_at IS NOT NULL;
-- 재처리 대상 조회: SAVED 상태로 오래된 주문 (POS 전송 실패 의심)
CREATE INDEX idx_orders_stuck         ON orders(status, saved_at)
  WHERE status = 'SAVED';
```

### order_items

```sql
CREATE TABLE order_items (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id     UUID           NOT NULL REFERENCES menus(id) ON DELETE RESTRICT,

  -- 주문 시점의 메뉴명/가격 스냅샷: 이후 메뉴 변경이 과거 주문에 영향 없음
  menu_name   VARCHAR(255)   NOT NULL,
  unit_price  NUMERIC(10,2)  NOT NULL CHECK (unit_price >= 0),
  quantity    INTEGER        NOT NULL CHECK (quantity > 0),
  subtotal    NUMERIC(10,2)  NOT NULL
                GENERATED ALWAYS AS (unit_price * quantity) STORED,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
```

**설계 근거 — 스냅샷 저장**: 주문 시점 이후 메뉴 가격이 변경되더라도 기존 주문 금액이 바뀌지 않아야 한다. `menu_name`, `unit_price`를 스냅샷으로 저장하면 `menus` 테이블 변경이 `order_items`에 영향을 주지 않는다.

### order_state_transitions (상태 전이 감사 로그)

```sql
CREATE TABLE order_state_transitions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status   VARCHAR(20),  -- NULL: 최초 생성
  to_status     VARCHAR(20)  NOT NULL,
  worker_id     VARCHAR(255), -- 어떤 Worker 인스턴스가 처리했는지
  job_id        VARCHAR(255), -- BullMQ job ID
  reason        TEXT,         -- 실패 시 원인
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_state_trans_order_id ON order_state_transitions(order_id);
```

**설계 근거 — 별도 감사 테이블**: `orders` 테이블에 현재 상태만 저장하고 전이 이력은 별도 테이블에 append-only로 기록한다. 이 구조는:
1. `orders` 테이블 락 경합 최소화 (UPDATE 1 row vs INSERT 1 row)
2. 전체 상태 전이 이력 완전 보존 → 사후 원인 분석 가능
3. 특정 상태에서 오래 멈춘 주문 감지 용이

---

## 인덱스 전략

### Deadlock 방지를 위한 일관된 락 순서

다중 테이블에 락을 걸 때는 반드시 동일한 순서로 접근한다:
```
orders → order_items → order_state_transitions
```
역순 접근을 허용하면 T1이 orders → order_items, T2가 order_items → orders 대기 시 Deadlock 발생.

### 트랜잭션 최소화 전략

| 트랜잭션 | 포함 작업 | 이유 |
|---------|---------|------|
| TX #1 (INSERT) | orders INSERT + order_items INSERT + transition(→QUEUED) | 주문 생성은 원자적으로 |
| TX #2 (SAVE) | orders UPDATE(SAVED) + transition(QUEUED→SAVED) | 최소 rows 업데이트, 락 보유 시간 최소 |
| TX #3 (POS) | orders UPDATE(SENT_TO_POS) + transition | POS 호출은 TX 밖에서, 성공 확인 후 TX |
| TX #4 (COMPLETE) | orders UPDATE(COMPLETED) + transition | 동일 |

**핵심**: POS API 호출을 DB 트랜잭션 안에 넣으면 POS 응답 대기 동안 DB Row Lock을 보유하게 된다. 이는 DB 커넥션 고갈과 Deadlock의 주 원인이다. POS 호출은 반드시 트랜잭션 외부에서 수행한다.

---

## 낙관적 락 동작 예시

```sql
-- Worker가 QUEUED → SAVED 전이를 시도
UPDATE orders
SET    status = 'SAVED',
       saved_at = NOW(),
       version = version + 1
WHERE  id = '550e8400-...'
  AND  status = 'QUEUED'    -- 현재 상태 검증
  AND  version = 0;          -- 낙관적 락 버전 검증

-- affected rows = 0 이면:
--   a) 이미 다른 Worker가 상태를 바꿈 (version 불일치)
--   b) 상태가 이미 QUEUED가 아님 (중복 처리 감지)
-- → ApplicationException 발생 → Worker가 재시도 또는 무시
```
