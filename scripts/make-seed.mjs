// 試作用の「仮データ」を作るスクリプト → db/seed.sql を書き出します。
// 実行: node scripts/make-seed.mjs (npm run db:reset の中で自動実行)
import { pbkdf2Sync, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/rules.js';

// お試し用データなので、毎回同じ結果になるようにソルトを固定(本番の登録では毎回ランダム)
const hash = (pw, login) => {
  const salt = createHash('sha256').update('logiben-demo:' + login).digest().subarray(0, 16);
  const h = pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
  return `pbkdf2$100000$${salt.toString('base64')}$${h.toString('base64')}`;
};
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const SETTING_LABELS = {
  deadline_days_before: '締め切り日(0=当日 / 1=前日)',
  deadline_time: '締め切り時刻(日本時間)',
  company_cap_excl: '会社負担の上限(1人・月・税抜き 円)',
  tax_rate_percent: 'お弁当の消費税率(%)',
  warn_percent: '上限の何%で社員に知らせるか(%)',
  company_share_percent: '会社が負担する割合(%)',
  service_fee: 'サービス利用料(1食 円)',
  agency_fee_percent: '営業代行料(%)',
  order_days_ahead: '何日先まで注文できるか(日)',
  shop_period_anchor: 'お店への支払いの区切りの起点日(この日から2週間ずつ)',
};

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
];

const lines = ['-- 自動生成ファイル(scripts/make-seed.mjs)。直接編集しないでください。'];
Object.entries(DEFAULT_SETTINGS).forEach(([k, v], i) =>
  lines.push(`INSERT INTO settings (key, value, label, sort_order) VALUES (${q(k)}, ${q(String(v))}, ${q(SETTING_LABELS[k] || k)}, ${i});`)
);
for (const c of companies) lines.push(`INSERT INTO companies (id, code, name) VALUES (${c.map(q).join(', ')});`);
for (const s of shops) lines.push(`INSERT INTO shops (id, name) VALUES (${s.map(q).join(', ')});`);
for (const m of menu) lines.push(`INSERT INTO menu_items (id, shop_id, name, description, price) VALUES (${m.map(q).join(', ')});`);
for (const [id, role, cid, login, pw, name, dept] of users)
  lines.push(
    `INSERT INTO users (id, role, company_id, login_id, password_hash, name, department) VALUES (${[id, role, cid, login, hash(pw, login), name, dept].map(q).join(', ')});`
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
// ほかの社員:今日から2週間ぶん、ところどころ注文した状態
for (let day = 0; day <= 14; day++) {
  for (const [uid] of users.filter((u) => u[1] === 'employee' && u[0] !== 2)) {
    if ((uid + day) % 3 === 0) continue; // 適当に間引く
    lines.push(orderSql(uid, menu[(uid * 3 + day) % menu.length], `${jst}, '+${day} days')`));
  }
}

writeFileSync(new URL('../db/seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log('db/seed.sql を作成しました');
