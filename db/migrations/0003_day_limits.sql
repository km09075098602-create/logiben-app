-- データを消さずに、データベースの形を新しくする(日ごとの上限)
-- 実行:npx wrangler d1 execute logiben --remote --file=db/migrations/0003_day_limits.sql
CREATE TABLE IF NOT EXISTS day_limits (
  id           INTEGER PRIMARY KEY,
  shop_id      INTEGER NOT NULL REFERENCES shops(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  date         TEXT NOT NULL,
  daily_limit  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS day_limits_unique ON day_limits (shop_id, COALESCE(menu_item_id, 0), date);
