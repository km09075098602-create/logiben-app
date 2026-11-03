-- データを消さずに、データベースの形を新しくする(ポイント還元・給料日)
-- 対象:「公開の準備」(2026-11-03)の時点の形で作ったデータベース
-- 実行:npx wrangler d1 execute logiben --remote --file=db/migrations/0001_points_payday.sql
ALTER TABLE orders ADD COLUMN points_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN payday INTEGER NOT NULL DEFAULT 25;
INSERT OR IGNORE INTO settings (key, value, label, sort_order) VALUES
  ('points_enabled', '1', 'ポイント還元(1=使う / 0=使わない)', 12),
  ('point_per_use', '20', '1回の利用でもらえるポイント', 13),
  ('point_grant_delay_months', '1', 'ポイントをもらえる時期(利用した月の何か月後の給料日の翌日か。1=翌月)', 14),
  ('point_expiry_months', '12', 'ポイントの有効期限(か月)', 15),
  ('point_max_per_order', '50', '1回の注文で使えるポイントの上限', 16);
