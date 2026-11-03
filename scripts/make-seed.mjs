// 試作用の「仮データ」を作るスクリプト → db/seed.sql を書き出します。
// 実行: node scripts/make-seed.mjs (npm run db:reset の中で自動実行)
import { pbkdf2Sync, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/rules.js';
import { holidaysBetween } from '../src/holidays.js';
import { SETTING_LABELS } from './setting-labels.mjs';

// お試し用データなので、毎回同じ結果になるようにソルトを固定(本番の登録では毎回ランダム)
const hash = (pw, login) => {
  const salt = createHash('sha256').update('logiben-demo:' + login).digest().subarray(0, 16);
  const h = pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
  return `pbkdf2$100000$${salt.toString('base64')}$${h.toString('base64')}`;
};
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);


const companies = [
  [1, 'MT01', '松江テック株式会社'],
  [2, 'SS02', '宍道湖物産株式会社'],
];
const shops = [
  [1, 'まつえ弁当'],
  [2, 'キッチン大橋'],
  [3, '和食処 しんじ'],
];
// [id, shop_id, 名前, 説明, 税込み価格]
const menu = [
  [1, 1, '日替わり弁当', 'おかず5品とご飯', 540],
  [2, 1, '唐揚げ弁当', '大きな唐揚げ4個', 600],
  [3, 1, 'のり弁当', '白身フライとちくわ天', 450],
  [4, 2, 'ハンバーグ弁当', 'デミグラスソース', 680],
  [5, 2, 'ヘルシー野菜弁当', '野菜たっぷり・500kcal以下', 620],
  [6, 3, '焼き魚弁当', '旬の焼き魚と小鉢', 750],
  [7, 3, 'しじみご飯弁当', '宍道湖しじみの炊き込みご飯', 700],
];
// だるまランチ(お店で食べる)のメニュー [id, shop_id, 名前, 説明, 税込み価格]
const lunchMenu = [
  [8, 3, '日替わり定食', '小鉢2品・味噌汁つき', 900],
  [9, 3, 'しじみ汁定食', '宍道湖しじみ汁と焼き魚', 1000],
];
// [id, 役割, 会社id, ログインID, パスワード, 名前, 部署]
const users = [
  [1, 'admin', null, 'admin', 'admin1234', '達磨商事 管理者', null],
  [2, 'employee', 1, '1001', 'demo1234', '山田 太郎', '営業部'],
  [3, 'employee', 1, '1002', 'demo1234', '佐藤 花子', '営業部'],
  [4, 'employee', 1, '1003', 'demo1234', '鈴木 一郎', '開発部'],
  [5, 'employee', 1, '1004', 'demo1234', '高橋 美咲', '開発部'],
  [6, 'employee', 2, '2001', 'demo1234', '田中 健', '総務部'],
  [7, 'employee', 2, '2002', 'demo1234', '伊藤 さくら', '製造部'],
  [8, 'employee', 2, '2003', 'demo1234', '渡辺 翔', '製造部'],
  [9, 'company', 1, 'tanto', 'demo1234', '総務課 木村', null],
  [10, 'company', 2, 'tanto', 'demo1234', '総務課 石田', null],
];
// お店のログイン用アカウント [id, shop_id, ログインID, パスワード, 名前]
const shopUsers = [
  [11, 1, 'matsue', 'demo1234', 'まつえ弁当'],
  [12, 2, 'ohashi', 'demo1234', 'キッチン大橋'],
  [13, 3, 'shinji', 'demo1234', '和食処 しんじ'],
];

const lines = ['-- 自動生成ファイル(scripts/make-seed.mjs)。直接編集しないでください。'];
Object.entries(DEFAULT_SETTINGS).forEach(([k, v], i) =>
  lines.push(`INSERT INTO settings (key, value, label, sort_order) VALUES (${q(k)}, ${q(String(v))}, ${q(SETTING_LABELS[k] || k)}, ${i});`)
);
for (const c of companies) lines.push(`INSERT INTO companies (id, code, name) VALUES (${c.map(q).join(', ')});`);
for (const s of shops) lines.push(`INSERT INTO shops (id, name) VALUES (${s.map(q).join(', ')});`);
for (const m of menu) lines.push(`INSERT INTO menu_items (id, shop_id, name, description, price) VALUES (${m.map(q).join(', ')});`);
for (const m of lunchMenu) lines.push(`INSERT INTO menu_items (id, shop_id, name, description, price, kind) VALUES (${m.map(q).join(', ')}, 'lunch');`);
for (const [id, role, cid, login, pw, name, dept] of users)
  lines.push(
    `INSERT INTO users (id, role, company_id, login_id, password_hash, name, department) VALUES (${[id, role, cid, login, hash(pw, login), name, dept].map(q).join(', ')});`
  );

for (const [id, shopId, login, pw, name] of shopUsers)
  lines.push(
    `INSERT INTO users (id, role, shop_id, login_id, password_hash, name) VALUES (${[id, 'shop', shopId, login, hash(pw, 'shop:' + login), name].map(q).join(', ')});`
  );

// 日付は「このSQLを実行した日(日本時間)」を基準に SQLite で計算する
const jst = "date('now', '+9 hours'";
const orderSql = (uid, item, dateExpr, extraWhere = '') =>
  `INSERT OR IGNORE INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price) ` +
  `SELECT ${uid}, d, ${item[0]}, ${item[1]}, ${q(item[2])}, ${item[4]} FROM (SELECT ${dateExpr} AS d) ` +
  `WHERE strftime('%w', d) NOT IN ('0', '6')${extraWhere};`;

// 山田さん(id 2)は今月の平日すべてを注文済み →「上限の8割を超えた」状態を見せる
for (let day = 0; day < 31; day++) {
  lines.push(orderSql(2, menu[5], `${jst}, 'start of month', '+${day} days')`, ` AND strftime('%m', d) = strftime('%m', ${jst}))`));
}
// 2か月前の利用(ポイントは先月の給料日の翌日にもらえている状態になる):山田さん・佐藤さん・鈴木さんが何回か利用
for (const [uid, days] of [[2, [6, 7, 8]], [3, [6, 13]], [4, [9, 10]]]) {
  for (const day of days) {
    lines.push(orderSql(uid, menu[0], `${jst}, 'start of month', '-2 months', '+${day} days')`));
  }
}
// ほかの社員:今日から2週間ぶん、ところどころ注文した状態
for (let day = 0; day <= 14; day++) {
  for (const [uid] of users.filter((u) => u[1] === 'employee' && u[0] !== 2)) {
    if ((uid + day) % 3 === 0) continue; // 適当に間引く
    lines.push(orderSql(uid, menu[(uid * 3 + day) % menu.length], `${jst}, '+${day} days')`));
  }
}

// だるまランチの利用の例:何人かが、ここ数日のうちにお店で食べた(その日にお弁当を頼んでいない人だけ)
for (const [uid, daysAgo, item] of [[4, 1, lunchMenu[0]], [6, 1, lunchMenu[1]], [7, 2, lunchMenu[0]], [3, 3, lunchMenu[1]]]) {
  lines.push(
    `INSERT OR IGNORE INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price, kind, tax_rate, created_at) ` +
      `SELECT ${uid}, d, ${item[0]}, ${item[1]}, ${q(item[2])}, ${item[4]}, 'daruma_lunch', 10, d || ' 03:15:00' FROM (SELECT ${jst}, '-${daysAgo} days') AS d) ` +
      `WHERE strftime('%w', d) NOT IN ('0', '6') AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = ${uid} AND delivery_date = d);`
  );
}

// 休業日の例:年末年始(全体)と、キッチン大橋の店休日(1週間後)
for (const d of ['2026-12-29', '2026-12-30', '2026-12-31'])
  lines.push(`INSERT INTO closed_days (shop_id, date, note) VALUES (NULL, '${d}', '年末年始');`);
lines.push(`INSERT INTO closed_days (shop_id, date, note) SELECT 2, ${jst}, '+7 days'), '店休日';`);
// 祝日・休業日の注文は消す(上の仮注文は土日だけを除いているため)
const holidays = holidaysBetween('2026-01-01', '2028-12-31').map((h) => `'${h.date}'`).join(', ');
lines.push(`DELETE FROM orders WHERE delivery_date IN (${holidays});`);
lines.push(`DELETE FROM orders WHERE delivery_date IN (SELECT date FROM closed_days WHERE shop_id IS NULL);`);
lines.push(`DELETE FROM orders WHERE EXISTS (SELECT 1 FROM closed_days d WHERE d.shop_id = orders.shop_id AND d.date = orders.delivery_date);`);

writeFileSync(new URL('../db/seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log('db/seed.sql を作成しました');
