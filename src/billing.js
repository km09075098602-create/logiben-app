// =============================================================
// 請求・支払いの計算(お金のルールその2)
//   会社への請求 … 月ごと
//   お店への支払い … 2週間ごと
// 計算のしかたを変えたいときは、このファイルを直します(tests/billing.test.js で確認)。
// =============================================================
import { allocateMonth, addDays } from './rules.js';

const SERVICE_TAX_PERCENT = 10; // サービス利用料にかかる消費税(標準税率)

/** 税込み金額に含まれる消費税(1円未満切り捨て) */
export const includedTax = (amount, percent) => Math.floor((amount * percent) / (100 + percent));

/**
 * 会社への月の請求。
 * 1人ずつ、その月の利用(お弁当・だるまランチ)に「半額・上限」のルールを当てはめ、会社ごとに合計する。
 * - お弁当代の会社負担分(税込み・軽減税率8%)
 * - だるまランチの会社負担分(税込み・10%)
 * - サービス利用料:1食あたり service_fee 円(税抜き)+ 消費税10%(お弁当・だるまランチとも)
 * 社員負担分は、会社が給料から差し引くときなどの参考として一緒に出す。
 *
 * @param {Array} orders その月の利用(id, delivery_date, price, kind, tax_rate, user_id, company_id, company_name, user_name, department, login_id)
 */
export function companyInvoices(orders, s) {
  const byUser = groupBy(orders, (o) => o.user_id);
  const companies = new Map();
  for (const userOrders of byUser.values()) {
    const first = userOrders[0];
    const r = allocateMonth(userOrders, s);
    const c = getOrCreate(companies, first.company_id, () => ({
      company_id: first.company_id,
      company_code: first.company_code,
      company_name: first.company_name,
      meals: 0,
      meals_bento: 0,
      meals_lunch: 0,
      bento_total: 0, // お食事代の合計(お弁当+だるまランチ・税込み)
      company_share: 0,
      company_share_bento: 0,
      company_share_lunch: 0,
      employee_share: 0,
      points_used: 0, // 使われたポイント(先にお弁当代から引いた額。達磨商事がお店に払う)
      employees: [],
    }));
    const lunch = r.orders.filter((o) => o.kind === 'daruma_lunch');
    const bento = r.orders.filter((o) => o.kind !== 'daruma_lunch');
    const e = {
      login_id: first.login_id,
      user_name: first.user_name,
      department: first.department || '',
      meals: r.orders.length,
      meals_bento: bento.length,
      meals_lunch: lunch.length,
      bento_total: sum(r.orders, 'price'),
      company_share: r.company_total,
      employee_share: sum(r.orders, 'employee_share'),
      points_used: r.orders.reduce((a, o) => a + (o.points_used || 0), 0),
      reached_cap: r.reached,
    };
    c.employees.push(e);
    c.meals += e.meals;
    c.meals_bento += e.meals_bento;
    c.meals_lunch += e.meals_lunch;
    c.bento_total += e.bento_total;
    c.company_share += e.company_share;
    c.company_share_bento += sum(bento, 'company_share');
    c.company_share_lunch += sum(lunch, 'company_share');
    c.employee_share += e.employee_share;
    c.points_used += e.points_used;
  }
  return [...companies.values()]
    .map((c) => {
      const service_fee = c.meals * s.service_fee;
      const service_tax = Math.floor((service_fee * SERVICE_TAX_PERCENT) / 100);
      c.employees.sort((a, b) => a.department.localeCompare(b.department, 'ja') || String(a.login_id).localeCompare(String(b.login_id)));
      return {
        ...c,
        company_share_tax: includedTax(c.company_share_bento, s.tax_rate_percent), // お弁当の会社負担分に含まれる消費税(8%)
        company_share_lunch_tax: includedTax(c.company_share_lunch, s.eatin_tax_rate_percent), // だるまランチの会社負担分に含まれる消費税(10%)
        service_fee, // サービス利用料(税抜き)
        service_tax, // その消費税(10%)
        total: c.company_share + service_fee + service_tax, // 請求額(税込み)
      };
    })
    .sort((a, b) => a.company_id - b.company_id);
}

// ---------- お店への支払い(2週間ごと) ----------

/** dateを含む「2週間の区切り」。anchor(区切りの始まりの日)から14日ずつ数える */
export function periodOf(date, anchor) {
  const days = Math.floor((Date.parse(date) - Date.parse(anchor)) / 86400000);
  const start = addDays(anchor, Math.floor(days / 14) * 14);
  return { start, end: addDays(start, 13) };
}

/** 最近の区切りの一覧(新しい順) */
export function recentPeriods(today, anchor, count = 8) {
  const out = [];
  let p = periodOf(today, anchor);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = { start: addDays(p.start, -14), end: addDays(p.start, -1) };
  }
  return out;
}

/**
 * お店への支払い。
 * お食事代(お弁当+だるまランチ・税込み)の合計から、営業代行料(合計の agency_fee_percent %・税込み・1円未満切り捨て)を引いた額。
 * @param {Array} orders その期間の注文(shop_id, shop_name, item_name, price)
 */
export function shopPayments(orders, s) {
  const shops = new Map();
  for (const o of orders) {
    const shop = getOrCreate(shops, o.shop_id, () => ({ shop_id: o.shop_id, shop_name: o.shop_name, meals: 0, meals_lunch: 0, bento_total: 0, items: new Map() }));
    shop.meals++;
    if (o.kind === 'daruma_lunch') shop.meals_lunch++;
    shop.points_used = (shop.points_used || 0) + (o.points_used || 0); // うちポイント分(達磨商事が負担)
    shop.bento_total += o.price; // お食事代の合計(お弁当+だるまランチ)
    const item = getOrCreate(shop.items, `${o.kind}\t${o.item_name}\t${o.price}`, () => ({ item_name: o.item_name, price: o.price, kind: o.kind || 'bento', count: 0 }));
    item.count++;
  }
  return [...shops.values()]
    .map((shop) => {
      const agency_fee = Math.floor((shop.bento_total * s.agency_fee_percent) / 100);
      return {
        ...shop,
        items: [...shop.items.values()].sort((a, b) => b.count - a.count),
        agency_fee, // 営業代行料(税込み)
        agency_fee_tax: includedTax(agency_fee, SERVICE_TAX_PERCENT), // うち消費税
        payment: shop.bento_total - agency_fee, // お店への支払額
      };
    })
    .sort((a, b) => a.shop_id - b.shop_id);
}

// ---------- CSV ----------

/** 表(配列の配列)をCSVの文字列にする。Excelで文字化けしないよう先頭にBOMをつける */
export function toCsv(rows) {
  const cell = (v) => {
    const t = String(v ?? '');
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- 小さな道具 ----------

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) getOrCreate(m, key(x), () => []).push(x);
  return m;
}
function getOrCreate(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}
const sum = (list, key) => list.reduce((a, x) => a + x[key], 0);
