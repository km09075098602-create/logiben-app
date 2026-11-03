// 設定(管理画面の「設定」)をデータベースから読み込む
import { DEFAULT_SETTINGS } from './rules.js';

export async function loadSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of results) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    s[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : value;
  }
  // 全体の休業日(年末年始など):日付 → メモ
  const { results: closed } = await db.prepare('SELECT date, note FROM closed_days WHERE shop_id IS NULL').all();
  s.closed_days = new Map(closed.map((r) => [r.date, r.note || '']));
  return s;
}
