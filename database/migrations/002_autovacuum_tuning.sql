-- ============================================================
-- orders 테이블 Autovacuum 튜닝
-- ============================================================
-- orders는 주문당 UPDATE 3회 (QUEUED→SAVED→SENT_TO_POS→COMPLETED)
-- 글로벌 설정보다 더 공격적으로 설정해 dead tuple을 빠르게 제거

ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor   = 0.005, -- 0.5% dead tuple 이상 시 vacuum
  autovacuum_analyze_scale_factor  = 0.002,
  autovacuum_vacuum_threshold      = 20,    -- 최소 20행
  autovacuum_vacuum_cost_delay     = 1      -- 거의 즉시 실행
);

-- ============================================================
-- order_state_transitions: append-only → 덜 공격적으로 설정
-- ============================================================
ALTER TABLE order_state_transitions SET (
  autovacuum_vacuum_scale_factor  = 0.1,
  autovacuum_analyze_scale_factor = 0.05
);

-- ============================================================
-- 모니터링 뷰: dead tuple 현황 조회
-- ============================================================
-- 사용법: SELECT * FROM v_vacuum_health ORDER BY dead_ratio DESC;
CREATE OR REPLACE VIEW v_vacuum_health AS
SELECT
  schemaname,
  relname                                                  AS table_name,
  n_live_tup                                               AS live_rows,
  n_dead_tup                                               AS dead_rows,
  CASE WHEN n_live_tup > 0
       THEN ROUND(n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100, 2)
       ELSE 0
  END                                                      AS dead_ratio,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
