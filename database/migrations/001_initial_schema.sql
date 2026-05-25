-- 차세대 프랜차이즈 통합 주문 시스템 초기 스키마
-- 모든 제약 조건은 애플리케이션 코드보다 먼저 무결성을 보장한다.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- stores
-- ============================================================
CREATE TABLE stores (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  pos_type        VARCHAR(50)  NOT NULL,
  CONSTRAINT chk_pos_type CHECK (pos_type IN ('LEGACY_V1', 'MODERN_V2', 'TABLET_V3')),
  pos_endpoint    VARCHAR(500) NOT NULL,
  pos_api_key_enc VARCHAR(500),
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- menus
-- ============================================================
CREATE TABLE menus (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID          NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name         VARCHAR(255)  NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  is_available BOOLEAN       NOT NULL DEFAULT TRUE,
  version      INTEGER       NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menus_store_id      ON menus(store_id);
CREATE INDEX idx_menus_store_avail   ON menus(store_id, is_available) WHERE is_available = TRUE;

-- ============================================================
-- orders
-- ============================================================
CREATE TABLE orders (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 중복 방어 최후 보루: DB UNIQUE 제약
  idempotency_key    VARCHAR(255)  NOT NULL,
  CONSTRAINT uq_orders_idempotency_key UNIQUE (idempotency_key),
  -- E2E 추적 키
  trace_id           VARCHAR(255)  NOT NULL,
  store_id           UUID          NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  user_id            UUID,
  -- 상태 머신 강제: DB CHECK로 유효하지 않은 값 물리적 차단
  status             VARCHAR(20)   NOT NULL DEFAULT 'QUEUED',
  CONSTRAINT chk_order_status CHECK (
    status IN ('QUEUED', 'SAVED', 'SENT_TO_POS', 'COMPLETED', 'FAILED')
  ),
  -- 금액 감사: 요청값 vs 서버 계산값
  requested_amount   NUMERIC(10,2) NOT NULL CHECK (requested_amount >= 0),
  calculated_amount  NUMERIC(10,2) NOT NULL CHECK (calculated_amount >= 0),
  -- 낙관적 락: version 불일치 시 UPDATE 0 rows → 충돌 감지
  version            INTEGER       NOT NULL DEFAULT 0,
  -- POS 연동 결과
  pos_response       JSONB,
  pos_error_message  TEXT,
  retry_count        INTEGER       NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  -- DLQ 추적
  dlq_at             TIMESTAMPTZ,
  failure_reason     TEXT,
  -- 상태별 타임스탬프
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  queued_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  saved_at           TIMESTAMPTZ,
  sent_to_pos_at     TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ
);

CREATE INDEX idx_orders_store_id      ON orders(store_id);
CREATE INDEX idx_orders_status        ON orders(status);
CREATE INDEX idx_orders_trace_id      ON orders(trace_id);
CREATE INDEX idx_orders_store_status  ON orders(store_id, status);
-- DLQ 관리 대시보드용
CREATE INDEX idx_orders_dlq           ON orders(dlq_at) WHERE dlq_at IS NOT NULL;
-- POS 전송 대기 주문 감시 (30분 이상 SAVED 상태)
CREATE INDEX idx_orders_stuck         ON orders(status, saved_at) WHERE status = 'SAVED';

-- ============================================================
-- order_items
-- ============================================================
CREATE TABLE order_items (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id     UUID          NOT NULL REFERENCES menus(id) ON DELETE RESTRICT,
  -- 주문 시점 스냅샷: 이후 메뉴 변경이 과거 주문에 영향 없음
  menu_name   VARCHAR(255)  NOT NULL,
  unit_price  NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity    INTEGER       NOT NULL CHECK (quantity > 0),
  subtotal    NUMERIC(10,2) NOT NULL GENERATED ALWAYS AS (unit_price * quantity) STORED,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);

-- ============================================================
-- order_state_transitions (감사 로그 — append-only)
-- ============================================================
CREATE TABLE order_state_transitions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status     VARCHAR(20),
  to_status       VARCHAR(20) NOT NULL,
  worker_id       VARCHAR(255),
  job_id          VARCHAR(255),
  reason          TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_state_trans_order_id ON order_state_transitions(order_id);

-- ============================================================
-- 시드 데이터 (개발/테스트용)
-- ============================================================
INSERT INTO stores (id, name, pos_type, pos_endpoint) VALUES
  ('11111111-1111-1111-1111-111111111111', '강남점', 'MODERN_V2', 'http://pos-modern:8080'),
  ('22222222-2222-2222-2222-222222222222', '홍대점', 'LEGACY_V1', 'http://pos-legacy:8080');

INSERT INTO menus (id, store_id, name, unit_price) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '후라이드치킨', 18000),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', '양념치킨',   19000),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', '간장치킨',   20000);
