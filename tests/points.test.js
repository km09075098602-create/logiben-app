// ポイントのルールのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, allocateMonth } from '../src/rules.js';
import { pointBalance, usablePoints, addMonths, grantDateOf } from '../src/points.js';

const meal = (date, used = 0, usedAt = date) => ({ delivery_date: date, points_used: used, used_at: `${usedAt} 03:00:00` });

test('1回の利用で20ポイント。その月の利用分は翌月1日にまとめてもらえる', () => {
  const orders = [meal('2027-01-04'), meal('2027-01-05')];
  const jan = pointBalance(orders, S, '2027-01-31');
  assert.equal(jan.balance, 0);
  assert.deepEqual(jan.pending, [{ date: '2027-02-01', amount: 40 }]);
  const feb = pointBalance(orders, S, '2027-02-01');
  assert.equal(feb.balance, 40);
  assert.deepEqual(feb.pending, []);
});

test('まだ食事をしていない注文は、これからもらえる分にも数えない', () => {
  const r = pointBalance([meal('2027-01-04'), meal('2027-01-20')], S, '2027-01-10');
  assert.deepEqual(r.pending, [{ date: '2027-02-01', amount: 20 }]);
});

test('有効期限は、もらった日(1日)から1年', () => {
  const orders = [meal('2027-01-04'), meal('2027-01-05')]; // 2027-02-01 にもらう
  assert.equal(pointBalance(orders, S, '2028-01-31').balance, 40);
  const after = pointBalance(orders, S, '2028-02-01');
  assert.equal(after.balance, 0);
  assert.equal(after.expired_total, 40);
  assert.deepEqual(pointBalance(orders, S, '2027-12-01').next_expiry, { date: '2028-02-01', amount: 40 });
});

test('古いポイントから先に使う', () => {
  // 1月分(2/1にもらう20pt)と6月分(7/1にもらう20pt)。12/1に30pt使う → 1月分20pt + 6月分10pt
  const orders = [meal('2027-01-04'), meal('2027-06-01'), meal('2027-12-01', 30, '2027-12-01')];
  const r = pointBalance(orders, S, '2028-02-10');
  // 残り:6月分10pt + 12月分20pt(2028-01-01にもらう)= 30pt。1月分は使い切ったので期限切れなし
  assert.equal(r.used_total, 30);
  assert.equal(r.expired_total, 0);
  assert.equal(r.balance, 30);
});

test('もらえる時期は設定で変えられる(2=翌々月1日)', () => {
  assert.equal(grantDateOf('2027-01-20', S), '2027-02-01');
  assert.equal(grantDateOf('2027-12-20', S), '2028-01-01');
  assert.equal(grantDateOf('2027-01-20', { ...S, point_grant_delay_months: 2 }), '2027-03-01');
});

test('使えるポイントは、残高・1回の上限(50)・値段の小さい方', () => {
  assert.equal(usablePoints(120, 620, S), 50);
  assert.equal(usablePoints(30, 620, S), 30);
  assert.equal(usablePoints(120, 40, S), 40);
  assert.equal(usablePoints(120, 620, { ...S, points_enabled: 0 }), 0);
});

test('ポイントを使うと、先にお弁当代から引いて半分ずつ(B方式)', () => {
  // 620円のお弁当に20ポイント → 600円を半分ずつ:会社300円・社員300円
  const r = allocateMonth([{ id: 1, delivery_date: '2027-01-04', price: 620, points_used: 20 }], S);
  assert.equal(r.orders[0].company_share, 300);
  assert.equal(r.orders[0].employee_share, 300);
});

test('月末の計算', () => {
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2027-03-15', 12), '2028-03-15');
});

test('ポイント還元を止めている間は0', () => {
  assert.equal(pointBalance([meal('2027-01-04')], { ...S, points_enabled: 0 }, '2027-03-01').balance, 0);
});
