-- データを消さずに、データベースの形を新しくする(1日に作れる数)
-- 実行:npx wrangler d1 execute logiben --remote --file=db/migrations/0002_daily_limits.sql
ALTER TABLE menu_items ADD COLUMN daily_limit INTEGER;
ALTER TABLE shops ADD COLUMN daily_limit INTEGER;
