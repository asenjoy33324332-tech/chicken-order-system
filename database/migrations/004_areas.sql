-- 배달 지역 테이블
-- 앱 하나로 여러 지역을 커버하기 위한 지역-매장 매핑

CREATE TABLE areas (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  store_id   UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_areas_store_id ON areas(store_id);
CREATE INDEX idx_areas_active   ON areas(is_active) WHERE is_active = TRUE;

-- 시드 데이터 (예시)
INSERT INTO areas (name, store_id, sort_order) VALUES
  ('남동구 구월동', '11111111-1111-1111-1111-111111111111', 1),
  ('남동구 만수동', '11111111-1111-1111-1111-111111111111', 2),
  ('남동구 간석동', '11111111-1111-1111-1111-111111111111', 3),
  ('남동구 논현동', '11111111-1111-1111-1111-111111111111', 4),
  ('홍대입구역',    '22222222-2222-2222-2222-222222222222', 1),
  ('합정동',        '22222222-2222-2222-2222-222222222222', 2);
