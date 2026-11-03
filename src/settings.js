// 設定(管理画面の「設定」)をデータベースから読み込む
import { DEFAULT_SETTINGS } from './rules.js';

export async function loadSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of results) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    s[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : value;
  }
  return s;
}
