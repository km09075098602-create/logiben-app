// ポイントのルールのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, allocateMonth } from '../src/rules.js';
import { pointBalance, usablePoints, addMonths } from '../src/points.js';

const meal = (date, used = 0, usedAt = date) => ({ delivery_date: date, points_used: used, used_at: `${usedAt} 03:00:00` });

test('1回の利用で10ポイント。まだ来ていない日の注文はもらえない', () => {
  const r = pointBalance([meal('2027-01-04'), meal('2027-01-05'), meal('2027-01-20')], S, '2027-01-10');
  assert.equal(r.balance, 20);
  assert.equal(r.earned_total, 20);
});

test('有効期限は1年(もらった日から12か月で消える)', () => {
  const orders = [meal('2027-01-04'), meal('2027-06-01')];
  assert.equal(pointBalance(orders, S, '2028-01-03').balance, 20);
  const after = pointBalance(orders, S, '2028-01-04');
  assert.equal(after.balance, 10);
  assert.equal(after.expired_total, 10);
  assert.deepEqual(pointBalance(orders, S, '2027-12-01').next_expiry, { date: '2028-01-04', amount: 10 });
});

test('古いポイントから先に使う', () => {
  // 1/4・6/1 にもらった20ポイントのうち、12/1 に10ポイント使う → 1/4 の分が消費される
  const orders = [meal('2027-01-04'), meal('2027-06-01'), meal('2027-12-01', 10, '2027-12-01')];
  // 12/1 自身の10ポイントもあるので、残りは 6/1 と 12/1 の20ポイント。1/4 期限で消えるものはない
  const r = pointBalance(orders, S, '2028-01-10');
  assert.equal(r.used_total, 10);
  assert.equal(r.expired_total, 0);
  assert.equal(r.balance, 20);
});

test('使えるポイントは、残高・1回の上限(50)・値段の小さい方', () => {
  assert.equal(usablePoints(120, 620, S), 50);
  assert.equal(usablePoints(30, 620, S), 30);
  assert.equal(usablePoints(120, 40, S), 40);
  assert.equal(usablePoints(120, 620, { ...S, points_enabled: 0 }), 0);
});

test('ポイントを使うと、先にお弁当代から引いて半分ずつ(B方式)', () => {
  // 620円のお弁当に10ポイント → 610円を半分ずつ:会社305円・社員305円
  const r = allocateMonth([{ id: 1, delivery_date: '2027-01-04', price: 620, points_used: 10 }], S);
  assert.equal(r.orders[0].company_share, 305);
  assert.equal(r.orders[0].employee_share, 305);
});

test('月末の有効期限の計算', () => {
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2027-03-15', 12), '2028-03-15');
});

test('ポイント還元を止めている間は0', () => {
  assert.equal(pointBalance([meal('2027-01-04')], { ...S, points_enabled: 0 }, '2027-02-01').balance, 0);
});
