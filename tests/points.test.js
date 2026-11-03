// ポイントのルールのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, allocateMonth } from '../src/rules.js';
import { pointBalance, usablePoints, addMonths, grantDateOf, paydayOf } from '../src/points.js';

const meal = (date, used = 0, usedAt = date) => ({ delivery_date: date, points_used: used, used_at: `${usedAt} 03:00:00` });

test('1回の利用で20ポイント。その月の利用分は、翌月の給料日(25日)の翌日にもらえる', () => {
  const orders = [meal('2027-01-04'), meal('2027-01-05')];
  // 2027年2月25日(木)が給料日 → 2月26日にもらえる
  const before = pointBalance(orders, S, '2027-02-25');
  assert.equal(before.balance, 0);
  assert.deepEqual(before.pending, [{ date: '2027-02-26', amount: 40 }]);
  const after = pointBalance(orders, S, '2027-02-26');
  assert.equal(after.balance, 40);
  assert.deepEqual(after.pending, []);
});

test('まだ食事をしていない注文は、これからもらえる分にも数えない', () => {
  const r = pointBalance([meal('2027-01-04'), meal('2027-01-20')], S, '2027-01-10');
  assert.deepEqual(r.pending, [{ date: '2027-02-26', amount: 20 }]);
});

test('有効期限は、もらった日から1年', () => {
  const orders = [meal('2027-01-04'), meal('2027-01-05')]; // 2027-02-26 にもらう
  assert.equal(pointBalance(orders, S, '2028-02-25').balance, 40);
  const after = pointBalance(orders, S, '2028-02-26');
  assert.equal(after.balance, 0);
  assert.equal(after.expired_total, 40);
  assert.deepEqual(pointBalance(orders, S, '2027-12-01').next_expiry, { date: '2028-02-26', amount: 40 });
});

test('古いポイントから先に使う', () => {
  // 1月分(2/26にもらう20pt)と6月分(7/24にもらう20pt)。12/1に30pt使う → 1月分20pt + 6月分10pt
  const orders = [meal('2027-01-04'), meal('2027-06-01'), meal('2027-12-01', 30, '2027-12-01')];
  const r = pointBalance(orders, S, '2028-03-10');
  // 残り:6月分10pt + 12月分20pt(2028-01-26にもらう)= 30pt。1月分は使い切ったので期限切れなし
  assert.equal(r.used_total, 30);
  assert.equal(r.expired_total, 0);
  assert.equal(r.balance, 30);
});

test('給料日が土日祝なら前の平日を給料日とみなし、その翌日にもらえる', () => {
  assert.equal(paydayOf('2027-02', 25), '2027-02-25'); // 木曜
  assert.equal(paydayOf('2027-07', 25), '2027-07-23'); // 25日が日曜 → 23日(金)
  assert.equal(paydayOf('2026-11', 23), '2026-11-20'); // 23日が勤労感謝の日(月)→ 20日(金)
  assert.equal(paydayOf('2027-02', 31), '2027-02-26'); // 月末(28日が日曜)→ 26日(金)
  assert.equal(grantDateOf('2027-06-10', S, 25), '2027-07-24');
  assert.equal(grantDateOf('2026-10-05', S, 23), '2026-11-21');
});

test('会社ごとの給料日で、もらえる日が変わる', () => {
  assert.equal(grantDateOf('2027-01-20', S, 25), '2027-02-26');
  assert.equal(grantDateOf('2027-01-20', S, 10), '2027-02-11'); // 2/10(水)の翌日
  assert.equal(grantDateOf('2027-12-20', S, 25), '2028-01-26');
});

test('もらえる時期は設定で変えられる(2=翌々月の給料日の翌日)', () => {
  assert.equal(grantDateOf('2027-01-20', { ...S, point_grant_delay_months: 2 }, 25), '2027-03-26');
  assert.equal(grantDateOf('2027-01-20', { ...S, point_grant_delay_months: 0 }, 25), '2027-01-26'); // 0=同じ月の給料日の翌日
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
  assert.equal(pointBalance([meal('2027-01-04')], { ...S, points_enabled: 0 }, '2027-04-01').balance, 0);
});
