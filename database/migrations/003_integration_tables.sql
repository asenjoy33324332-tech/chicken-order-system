-- Phase 2: NestJS → BBQ 상태 동기화용 outbox 테이블
-- Redis Pub/Sub 장애 시 최대 10초 이내 폴백 처리

CREATE TABLE IF NOT EXISTS order_status_outbox (
    id          BIGSERIAL PRIMARY KEY,
    order_id    VARCHAR(64)  NOT NULL,
    status      VARCHAR(32)  NOT NULL,
    payload     JSONB        NOT NULL DEFAULT '{}',
    delivered   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_outbox_pending
    ON order_status_outbox (delivered, created_at)
    WHERE delivered = FALSE;

CREATE INDEX IF NOT EXISTS idx_order_status_outbox_order_id
    ON order_status_outbox (order_id);

-- 10분 이상 지난 미전달 건은 처리 포기 (자동 정리 트리거 용)
CREATE INDEX IF NOT EXISTS idx_order_status_outbox_old
    ON order_status_outbox (created_at)
    WHERE delivered = FALSE;

COMMENT ON TABLE order_status_outbox IS
    'NestJS 처리 결과 → BBQ Gateway 전달 보장용 Outbox. Redis Pub/Sub 정상 시 10ms 이내, 장애 시 최대 10초 이내 처리.';
