// 注文とだるまランチのルールのテスト(メモリ上のデータベースで、本物の処理を動かす)
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/fake-d1.js';
import { loadSettings } from '../src/settings.js';
import { placeOrder, cancelOrder, recordLunch, lunchOptions, employeeSummary, dayMenu } from '../src/orders.js';

let db, s;
const user = { id: 1 };

// 「いま」を 2027-01-06(水)11:30(日本時間)にする
mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-06T02:30:00Z') });

beforeEach(async () => {
  db = createTestDb();
  db.raw.exec(`
    INSERT INTO companies (id, code, name) VALUES (1, 'MT01', '松江テック');
    INSERT INTO shops (id, name) VALUES (1, 'まつえ弁当'), (2, '和食処 しんじ');
    INSERT INTO menu_items (id, shop_id, name, price, kind) VALUES
      (1, 1, '日替わり弁当', 540, 'bento'),
      (2, 2, '日替わり定食', 1100, 'lunch'),
      (3, 2, '焼き魚弁当', 750, 'bento');
    INSERT INTO users (id, role, company_id, login_id, password_hash, name) VALUES (1, 'employee', 1, '1001', 'x', '山田');
  `);
  s = await loadSettings(db);
});

test('お弁当の注文:翌日分は注文でき、税率8%で記録される', async () => {
  const r = await placeOrder(db, user, '2027-01-07', 1, s);
  assert.equal(r.order.company_share, 270);
  const row = await db.prepare('SELECT kind, tax_rate, channel FROM orders').first();
  assert.deepEqual(row, { kind: 'bento', tax_rate: 8, channel: 'web' });
});

test('お弁当の注文:今日の分は9:30で締め切り', async () => {
  await assert.rejects(placeOrder(db, user, '2027-01-06', 1, s), /締め切/);
});

test('お弁当の注文:だるまランチのメニューはお弁当として注文できない', async () => {
  await assert.rejects(placeOrder(db, user, '2027-01-07', 2, s), /選べません/);
  const m = await dayMenu(db, user, '2027-01-07', s);
  assert.deepEqual(m.items.map((i) => i.name).sort(), ['日替わり弁当', '焼き魚弁当']);
});

test('だるまランチ:今日の分を記録でき、税率10%・会社が半額', async () => {
  const opt = await lunchOptions(db, user, s);
  assert.deepEqual(opt.items.map((i) => i.name), ['日替わり定食']);
  assert.equal(opt.items[0].employee_share, 550);
  const r = await recordLunch(db, user, 2, s);
  assert.equal(r.used.item_name, '日替わり定食');
  assert.equal(r.used.company_share, 550);
  const row = await db.prepare('SELECT delivery_date, kind, tax_rate FROM orders').first();
  assert.deepEqual(row, { delivery_date: '2027-01-06', kind: 'daruma_lunch', tax_rate: 10 });
});

test('だるまランチ:1日1回まで', async () => {
  await recordLunch(db, user, 2, s);
  await assert.rejects(recordLunch(db, user, 2, s), /1日1回/);
});

test('だるまランチ:お弁当を注文している日は使えない(逆も同じ)', async () => {
  db.raw.exec(`INSERT INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price) VALUES (1, '2027-01-06', 1, 1, '日替わり弁当', 540)`);
  await assert.rejects(recordLunch(db, user, 2, s), /お弁当を注文/);
  db.raw.exec(`DELETE FROM orders`);
  await recordLunch(db, user, 2, s);
  // ランチを使った日のお弁当は注文できない(翌日分の締め切り前でも、その日でなければ関係なし)
  db.raw.exec(`UPDATE orders SET delivery_date = '2027-01-07'`);
  await assert.rejects(placeOrder(db, user, '2027-01-07', 1, s), /だるまランチを利用済み/);
});

test('だるまランチ:お店の休業日・全体の休業日は使えない', async () => {
  db.raw.exec(`INSERT INTO closed_days (shop_id, date, note) VALUES (2, '2027-01-06', '店休日')`);
  assert.equal((await lunchOptions(db, user, s)).items.length, 0);
  await assert.rejects(recordLunch(db, user, 2, s), /お休み/);
  db.raw.exec(`DELETE FROM closed_days; INSERT INTO closed_days (shop_id, date, note) VALUES (NULL, '2027-01-06', '臨時休業')`);
  s = await loadSettings(db);
  await assert.rejects(recordLunch(db, user, 2, s), /臨時休業/);
});

test('だるまランチ:社員の取り消し(お弁当用)では消えない', async () => {
  await recordLunch(db, user, 2, s);
  await assert.rejects(cancelOrder(db, user, '2027-01-06', s), /締め切/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM orders').first()).n, 1);
});

test('だるまランチとお弁当は同じ上限(税抜7,500円)を使う', async () => {
  // 1月の平日にランチ1,100円(会社550円=税抜500円)を14回 → 税抜7,000円
  const days = ['04', '05', '07', '08', '12', '13', '14', '15', '18', '20', '21', '22', '25', '26'];
  for (const d of days)
    db.raw.exec(`INSERT INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price, kind, tax_rate) VALUES (1, '2027-01-${d}', 2, 2, '日替わり定食', 1100, 'daruma_lunch', 10)`);
  const sum = await employeeSummary(db, user, s);
  assert.equal(sum.used, 7000);
  assert.equal(sum.remaining, 500);
  assert.equal(sum.warn, true);
  // 1/19 にお弁当750円(会社375円=税抜347.2円)→ 合計 税抜7,347円、残り153円
  const r = await placeOrder(db, user, '2027-01-19', 3, s);
  assert.equal(r.order.company_share, 375);
  assert.equal(r.month.used, 7347);
  assert.equal(r.month.remaining, 153);
  assert.equal(r.month.company_total, 14 * 550 + 375);
});
