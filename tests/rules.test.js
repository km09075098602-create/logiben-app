// お金と締め切りのルールが正しいかを自動で確かめるテスト(npm test で実行)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, allocateMonth, previewShare, deadlineFor, isOrderOpen, orderableDates, closedReason } from '../src/rules.js';

const order = (id, day, price) => ({ id, delivery_date: `2027-01-${String(day).padStart(2, '0')}`, price });

test('上限は税抜き7,500円(お弁当だけなら税込み8,100円分)', () => {
  const r = allocateMonth(Array.from({ length: 30 }, (_, i) => ({ id: i + 1, delivery_date: `2027-01-${String(i + 1).padStart(2, '0')}`, price: 1000 })), S);
  assert.equal(r.company_total, 8100);
  assert.equal(r.used, 7500);
  assert.equal(r.cap, 7500);
});

test('会社と社員で半分ずつ。奇数の端数は社員が負担', () => {
  const r = allocateMonth([order(1, 5, 545)], S);
  assert.equal(r.orders[0].company_share, 272);
  assert.equal(r.orders[0].employee_share, 273);
});

test('上限をまたぐ注文は会社が残りだけ負担し、その後は社員が全額', () => {
  // 1食800円(会社400円)×20食=8,000円 → 21食目は残り100円だけ会社
  const orders = Array.from({ length: 22 }, (_, i) => order(i + 1, i + 1, 800));
  const r = allocateMonth(orders, S);
  assert.equal(r.orders[19].company_share, 400);
  assert.equal(r.orders[20].company_share, 100);
  assert.equal(r.orders[20].employee_share, 700);
  assert.equal(r.orders[21].company_share, 0);
  assert.equal(r.orders[21].employee_share, 800);
  assert.equal(r.company_total, 8100);
  assert.equal(r.used, 7500);
  assert.equal(r.remaining, 0);
  assert.equal(r.reached, true);
  assert.equal(r.warn, false);
});

test('上限の8割(6,480円)で知らせる', () => {
  const at = (n) => allocateMonth(Array.from({ length: n }, (_, i) => order(i + 1, i + 1, 800)), S);
  assert.equal(at(16).warn, false); // 6,400円
  assert.equal(at(17).warn, true); // 6,800円
});

test('お届け日の早い順に上限を使う(注文した順番ではない)', () => {
  const orders = [...Array.from({ length: 20 }, (_, i) => order(i + 2, i + 2, 800)), order(99, 1, 800)];
  const r = allocateMonth(orders, S);
  assert.equal(r.orders[0].id, 99);
  assert.equal(r.orders[0].company_share, 400);
});

test('注文の見込み額', () => {
  const orders = Array.from({ length: 20 }, (_, i) => order(i + 1, i + 1, 800));
  assert.equal(previewShare(orders, '2027-01-25', 600, S).employee_share, 500); // 会社は残り100円
});

test('当日9:30締め:9:29までは注文でき、9:30を過ぎたら締め切り', () => {
  // 2027-01-06(水)9:30 JST = 00:30 UTC
  assert.equal(deadlineFor('2027-01-06', S).toISOString(), '2027-01-06T00:30:00.000Z');
  assert.equal(isOrderOpen('2027-01-06', S, new Date('2027-01-06T00:29:00Z')), true);
  assert.equal(isOrderOpen('2027-01-06', S, new Date('2027-01-06T00:30:00Z')), false);
});

test('前日17:00締めにも切りかえられる', () => {
  const s = { ...S, deadline_days_before: 1, deadline_time: '17:00' };
  assert.equal(deadlineFor('2027-01-06', s).toISOString(), '2027-01-05T08:00:00.000Z');
});

test('土日は注文できない', () => {
  assert.equal(isOrderOpen('2027-01-09', S, new Date('2027-01-04T00:00:00Z')), false);
  const dates = orderableDates(S, new Date('2027-01-04T00:00:00Z')).map((d) => d.date);
  assert.ok(!dates.includes('2027-01-09') && dates.includes('2027-01-08'));
});

test('何日も先の注文はできない', () => {
  assert.equal(isOrderOpen('2027-02-26', S, new Date('2027-01-04T00:00:00Z')), false);
});

test('祝日・全体の休業日は注文できない', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(isOrderOpen('2026-11-03', S, now), false); // 文化の日
  assert.equal(isOrderOpen('2026-11-04', S, now), true);
  const s = { ...S, closed_days: new Map([['2026-11-05', '臨時休業']]) };
  assert.equal(isOrderOpen('2026-11-05', s, now), false);
  assert.equal(closedReason('2026-11-05', s), '臨時休業');
  assert.equal(closedReason('2026-11-03', s), '文化の日');
  assert.equal(closedReason('2026-11-07', s), '土曜日');
  const dates = orderableDates(s, now).map((d) => d.date);
  assert.ok(!dates.includes('2026-11-03') && !dates.includes('2026-11-05') && dates.includes('2026-11-04'));
});

test('だるまランチ(税率10%)とお弁当(8%)が混ざっても、上限は税抜き7,500円で数える', () => {
  // だるまランチ1,100円(会社550円=税抜500円)×14回 = 税抜7,000円 → 残り税抜500円
  const lunches = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, delivery_date: `2027-01-${String(i + 1).padStart(2, '0')}`, price: 1100, tax_rate: 10 }));
  const r1 = allocateMonth(lunches, S);
  assert.equal(r1.used, 7000);
  assert.equal(r1.remaining, 500);
  // 次にお弁当1,200円(会社600円=税抜555.5円)→ 残り税抜500円 = 税込540円まで
  const r2 = allocateMonth([...lunches, { id: 99, delivery_date: '2027-01-20', price: 1200 }], S);
  const bento = r2.orders.find((o) => o.id === 99);
  assert.equal(bento.company_share, 540);
  assert.equal(bento.employee_share, 660);
  assert.equal(r2.reached, true);
  assert.equal(r2.company_total, 14 * 550 + 540);
});

test('8割のお知らせも税抜きで判定(6,000円)', () => {
  const lunch = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, delivery_date: `2027-01-${String(i + 1).padStart(2, '0')}`, price: 1100, tax_rate: 10 }));
  assert.equal(allocateMonth(lunch(11), S).warn, false); // 税抜5,500円
  assert.equal(allocateMonth(lunch(12), S).warn, true); // 税抜6,000円
});
