// 日ごとの上限の保存のテスト(お店の画面・登録画面から使う処理)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createTestDb } from './helpers/fake-d1.js';
import { registerLimitRoutes } from '../src/limits.js';
import { registerMasterRoutes } from '../src/master.js';

mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-06T02:30:00Z') });

function setup() {
  const db = createTestDb();
  db.raw.exec(`
    INSERT INTO shops (id, name, daily_limit) VALUES (1, 'まつえ弁当', 50), (2, '和食処 しんじ', NULL);
    INSERT INTO menu_items (id, shop_id, name, price, kind, daily_limit) VALUES
      (1, 1, '日替わり弁当', 540, 'bento', 20), (2, 1, '唐揚げ弁当', 600, 'bento', NULL), (3, 2, '焼き魚弁当', 750, 'bento', NULL);
  `);
  const app = new Hono();
  // お店のログインのかわりに、お店1の人として扱う
  app.use('/api/shop/*', async (c, next) => { c.set('user', { role: 'shop', shop_id: 1 }); await next(); });
  registerMasterRoutes(app); // 入力エラーをわかりやすくする部分
  registerLimitRoutes(app);
  const call = (method, path, body) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, { DB: db }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { db, call };
}

test('ある日の上限を保存すると、その日だけ変わる。空欄で「いつもどおり」に戻る', async () => {
  const { db, call } = setup();
  let r = await call('GET', '/api/shop/day-limits?date=2027-01-15');
  assert.deepEqual(r.json.shop, { usual: 50, day: null });
  assert.deepEqual(r.json.items.map((i) => [i.name, i.usual, i.day]), [['日替わり弁当', 20, null], ['唐揚げ弁当', null, null]]);
  r = await call('PUT', '/api/shop/day-limits', { date: '2027-01-15', shop: '80', items: { 1: '30', 2: '10' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.shop, { usual: 50, day: 80 });
  assert.deepEqual(r.json.items.map((i) => i.day), [30, 10]);
  assert.equal(r.json.upcoming.length, 3);
  // 空欄にすると消える(いつもどおり)
  r = await call('PUT', '/api/shop/day-limits', { date: '2027-01-15', shop: '', items: { 1: '', 2: '10' } });
  assert.deepEqual([r.json.shop.day, ...r.json.items.map((i) => i.day)], [null, null, 10]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM day_limits').first()).n, 1);
});

test('ほかのお店のメニューの上限は変えられない', async () => {
  const { call } = setup();
  const r = await call('PUT', '/api/shop/day-limits', { date: '2027-01-15', items: { 3: '5' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /このお店のメニューではありません/);
});

test('数でない値はエラー', async () => {
  const { call } = setup();
  const r = await call('PUT', '/api/shop/day-limits', { date: '2027-01-15', items: { 1: 'たくさん' } });
  assert.equal(r.status, 400);
});
