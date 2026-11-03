// 本番用の初期データを作るスクリプト → db/production-init.sql
//   中身:設定の初期値 + 管理者アカウント1つ(お試し用の会社・社員・注文は入れない)
//   管理者のパスワードはここで自動で作り、画面に1回だけ表示します(ファイルには暗号化した形だけが入る)。
//   db/production-init.sql は GitHub に保存しません(.gitignore 済み)。
// 実行: node scripts/make-production-init.mjs [管理者のログインID]
import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/rules.js';
import { SETTING_LABELS } from './setting-labels.mjs';

const loginId = process.argv[2] || 'admin';
const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = Array.from({ length: 14 }, () => chars[randomInt(chars.length)]).join('');
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64')}`;
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

const lines = ['-- 本番用の初期データ(scripts/make-production-init.mjs で作成)'];
Object.entries(DEFAULT_SETTINGS).forEach(([k, v], i) =>
  lines.push(`INSERT INTO settings (key, value, label, sort_order) VALUES (${q(k)}, ${q(v)}, ${q(SETTING_LABELS[k] || k)}, ${i});`)
);
lines.push(`INSERT INTO users (role, login_id, password_hash, name) VALUES ('admin', ${q(loginId)}, ${q(hash)}, '達磨商事 管理者');`);
writeFileSync(new URL('../db/production-init.sql', import.meta.url), lines.join('\n') + '\n');

console.log('db/production-init.sql を作成しました。');
console.log(`管理者のログインID: ${loginId}`);
console.log(`管理者のパスワード: ${password}   ← 必ず控えてください(もう表示されません)`);
