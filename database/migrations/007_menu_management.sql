-- POS 메뉴 관리 지원: menus 테이블 확장 + 신규 테이블 3개
-- 모든 ALTER/CREATE는 IF NOT EXISTS 사용 → 재실행 안전

-- menus 테이블에 POS 전용 컬럼 추가
ALTER TABLE menus
  ADD COLUMN IF NOT EXISTS category   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sort_order INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta       JSONB       NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_menus_store_sort ON menus(store_id, sort_order);

-- 카테고리 테이블
CREATE TABLE IF NOT EXISTS menu_categories (
  id         TEXT        NOT NULL,
  store_id   UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  meta       JSONB       NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_categories_store ON menu_categories(store_id, sort_order);

-- 옵션 그룹 테이블
CREATE TABLE IF NOT EXISTS menu_options (
  id         TEXT        NOT NULL,
  store_id   UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  items      JSONB       NOT NULL DEFAULT '[]',
  PRIMARY KEY (id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_options_store ON menu_options(store_id, sort_order);

-- POS 설정 테이블 (가게별 1행)
CREATE TABLE IF NOT EXISTS pos_settings (
  store_id   UUID        PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  settings   JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
