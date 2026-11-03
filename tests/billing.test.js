// 請求・支払いの計算のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S } from '../src/rules.js';
import { companyInvoices, shopPayments, periodOf, recentPeriods, includedTax, toCsv } from '../src/billing.js';

let id = 0;
const o = (user_id, company_id, day, price, extra = {}) => ({
  id: ++id, user_id, company_id, company_code: `C${company_id}`, company_name: `会社${company_id}`,
  login_id: String(user_id), user_name: `社員${user_id}`, department: '営業部',
  delivery_date: `2027-01-${String(day).padStart(2, '0')}`, price, shop_id: 1, shop_name: 'お店A', item_name: '日替わり', ...extra,
});

test('会社への請求:会社負担分+利用料150円/食(+消費税10%)', () => {
  // 社員1: 600円×2食 → 会社600 / 社員2: 545円×1食 → 会社272
  const r = companyInvoices([o(1, 1, 4, 600), o(1, 1, 5, 600), o(2, 1, 4, 545)], S);
  assert.equal(r.length, 1);
  const c = r[0];
  assert.equal(c.meals, 3);
  assert.equal(c.bento_total, 1745);
  assert.equal(c.company_share, 872);
  assert.equal(c.employee_share, 873);
  assert.equal(c.company_share_tax, 64); // 872 × 8/108 = 64.59…
  assert.equal(c.service_fee, 450);
  assert.equal(c.service_tax, 45);
  assert.equal(c.total, 872 + 450 + 45);
  assert.equal(c.employees.length, 2);
});

test('会社への請求:上限(8,100円)を超えた社員の分は会社負担に入らない', () => {
  const orders = Array.from({ length: 22 }, (_, i) => o(10, 2, i + 1, 800));
  const [c] = companyInvoices(orders, S);
  assert.equal(c.company_share, 8100);
  assert.equal(c.employee_share, 22 * 800 - 8100);
  assert.equal(c.service_fee, 22 * 150); // 利用料は全食にかかる
  assert.equal(c.employees[0].reached_cap, true);
});

test('会社ごとに分かれる', () => {
  const r = companyInvoices([o(1, 1, 4, 600), o(3, 2, 4, 700)], S);
  assert.deepEqual(r.map((c) => c.company_id), [1, 2]);
});

test('お店への支払い:お弁当代から営業代行料10%を引く', () => {
  const r = shopPayments([o(1, 1, 4, 600), o(2, 1, 4, 545), o(3, 1, 5, 600, { shop_id: 2, shop_name: 'お店B' })], S);
  assert.equal(r.length, 2);
  assert.equal(r[0].bento_total, 1145);
  assert.equal(r[0].agency_fee, 114);
  assert.equal(r[0].payment, 1031);
  assert.equal(r[0].agency_fee_tax, 10);
  assert.equal(r[1].payment, 540);
});

test('2週間の区切り', () => {
  const a = '2027-01-04';
  assert.deepEqual(periodOf('2027-01-04', a), { start: '2027-01-04', end: '2027-01-17' });
  assert.deepEqual(periodOf('2027-01-17', a), { start: '2027-01-04', end: '2027-01-17' });
  assert.deepEqual(periodOf('2027-01-18', a), { start: '2027-01-18', end: '2027-01-31' });
  assert.deepEqual(periodOf('2027-01-03', a), { start: '2026-12-21', end: '2027-01-03' }); // 起点より前
  assert.deepEqual(recentPeriods('2027-01-20', a, 2), [{ start: '2027-01-18', end: '2027-01-31' }, { start: '2027-01-04', end: '2027-01-17' }]);
});

test('税込み金額に含まれる消費税', () => {
  assert.equal(includedTax(1080, 8), 80);
  assert.equal(includedTax(110, 10), 10);
});

test('CSV:カンマや改行を含む値を正しく囲む', () => {
  assert.equal(toCsv([['a', 'b,c'], ['"x"', 1]]), '﻿a,"b,c"\r\n"""x""",1\r\n');
});
