-- POS가 직접 설정하는 상태값을 orders.status CHECK 제약에 추가
-- NestJS Worker 상태: QUEUED → SAVED → SENT_TO_POS → COMPLETED / FAILED
-- POS 상태:          ACCEPTED → COOKING → DONE / CANCELLED

ALTER TABLE orders DROP CONSTRAINT chk_order_status;

ALTER TABLE orders ADD CONSTRAINT chk_order_status CHECK (
  status IN (
    'QUEUED',       -- Worker: 큐 적재됨
    'SAVED',        -- Worker: DB 저장됨
    'SENT_TO_POS',  -- Worker: POS 전송됨
    'COMPLETED',    -- Worker: 처리 완료
    'FAILED',       -- Worker: 처리 실패
    'ACCEPTED',     -- POS: 접수
    'COOKING',      -- POS: 조리 중
    'DONE',         -- POS: 완료
    'CANCELLED'     -- POS: 취소
  )
);
