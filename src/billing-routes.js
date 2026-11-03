// =============================================================
// 請求・支払い・CSV保存のAPI(管理者だけが使える)
//   計算そのものは src/billing.js にあります。
// =============================================================
import { allocateMonth, todayJST, addDays } from './rules.js';
import { companyInvoices, shopPayments, periodOf, recentPeriods, toCsv } from './billing.js';
import { loadSettings } from './settings.js';
import { ordersBetween } from './queries.js';

export const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

export const monthRange = (month) => [`${month}-01`, `${month}-31`];

/** CSVファイルとして返す(ファイル名は英数字のみ:日本語は一部のブラウザで化けるため) */
const csvResponse = (c, filename, rows) =>
  c.body(toCsv(rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });

export function registerBillingRoutes(app) {
  const badMonth = (c) => c.json({ error: '月を正しく指定してください(例 2027-01)' }, 400);

  // ---------- 会社への請求(月ごと) ----------
  app.get('/api/admin/billing/companies', async (c) => {
    const month = c.req.query('month') || todayJST().slice(0, 7);
    if (!isMonth(month)) return badMonth(c);
    const s = await loadSettings(c.env.DB);
    const invoices = companyInvoices(await ordersBetween(c.env.DB, ...monthRange(month)), s);
    return c.json({
      month,
      complete: month < todayJST().slice(0, 7), // 月が終わっていれば確定
      service_fee: s.service_fee,
      tax_rate_percent: s.tax_rate_percent,
      companies: invoices,
    });
  });

  // ---------- お店への支払い(2週間ごと) ----------
  app.get('/api/admin/billing/shops', async (c) => {
    const s = await loadSettings(c.env.DB);
    const start = c.req.query('start');
    if (start && !isDate(start)) return c.json({ error: '日付が正しくありません' }, 400);
    const period = periodOf(start || todayJST(), s.shop_period_anchor);
    const orders = await ordersBetween(c.env.DB, period.start, period.end);
    return c.json({
      period,
      complete: period.end < todayJST(),
      periods: recentPeriods(addDays(todayJST(), 14), s.shop_period_anchor, 10),
      agency_fee_percent: s.agency_fee_percent,
      shops: shopPayments(orders, s),
    });
  });

  // ---------- CSV保存 ----------

  /** 注文の明細(1食1行。会社負担・社員負担つき) */
  app.get('/api/admin/export/orders.csv', async (c) => {
    const month = c.req.query('month');
    if (!isMonth(month)) return badMonth(c);
    const s = await loadSettings(c.env.DB);
    const orders = await ordersBetween(c.env.DB, ...monthRange(month));
    // 社員ごとに負担額を計算してから、元の並び順に戻す
    const shares = new Map();
    const byUser = new Map();
    for (const o of orders) (byUser.get(o.user_id) || byUser.set(o.user_id, []).get(o.user_id)).push(o);
    for (const list of byUser.values()) for (const r of allocateMonth(list, s).orders) shares.set(r.id, r);
    const rows = [['日付', '種類', '会社コード', '会社名', '部署', '社員番号', '名前', 'お店', 'メニュー', '値段(税込)', '税率(%)', '会社負担', '社員負担', '注文経路']];
    for (const o of orders) {
      const r = shares.get(o.id);
      const kind = o.kind === 'daruma_lunch' ? 'だるまランチ' : 'お弁当';
      rows.push([o.delivery_date, kind, o.company_code, o.company_name, o.department, o.login_id, o.user_name, o.shop_name, o.item_name, o.price, o.tax_rate, r.company_share, r.employee_share, o.channel]);
    }
    return csvResponse(c, `logiben_orders_${month}.csv`, rows);
  });

  /** 会社への請求(会社ごとに1行) */
  app.get('/api/admin/export/companies.csv', async (c) => {
    const month = c.req.query('month');
    if (!isMonth(month)) return badMonth(c);
    const s = await loadSettings(c.env.DB);
    const list = companyInvoices(await ordersBetween(c.env.DB, ...monthRange(month)), s);
    const rows = [['対象月', '会社コード', '会社名', '食数', 'うちお弁当', 'うちだるまランチ', 'お食事代合計(税込)', 'お弁当の会社負担分(税込)', 'うち消費税8%', 'だるまランチの会社負担分(税込)', 'うち消費税10%', `サービス利用料(税抜・${s.service_fee}円/食)`, 'サービス利用料の消費税10%', '請求額(税込)', '社員負担分合計(税込)']];
    for (const x of list)
      rows.push([month, x.company_code, x.company_name, x.meals, x.meals_bento, x.meals_lunch, x.bento_total, x.company_share_bento, x.company_share_tax, x.company_share_lunch, x.company_share_lunch_tax, x.service_fee, x.service_tax, x.total, x.employee_share]);
    return csvResponse(c, `logiben_invoices_${month}.csv`, rows);
  });

  /** 社員ごとの内訳(会社が給料から差し引くときなどに) */
  app.get('/api/admin/export/employees.csv', async (c) => {
    const month = c.req.query('month');
    if (!isMonth(month)) return badMonth(c);
    const s = await loadSettings(c.env.DB);
    const list = companyInvoices(await ordersBetween(c.env.DB, ...monthRange(month)), s);
    const rows = [['対象月', '会社コード', '会社名', '部署', '社員番号', '名前', '食数', 'うちだるまランチ', 'お食事代合計(税込)', '会社負担', '社員負担', '会社負担の上限に到達']];
    for (const x of list)
      for (const e of x.employees)
        rows.push([month, x.company_code, x.company_name, e.department, e.login_id, e.user_name, e.meals, e.meals_lunch, e.bento_total, e.company_share, e.employee_share, e.reached_cap ? 'はい' : '']);
    return csvResponse(c, `logiben_employees_${month}.csv`, rows);
  });

  /** お店への支払い(お店ごとに1行) */
  app.get('/api/admin/export/shops.csv', async (c) => {
    const s = await loadSettings(c.env.DB);
    const start = c.req.query('start');
    if (!isDate(start)) return c.json({ error: '日付が正しくありません' }, 400);
    const period = periodOf(start, s.shop_period_anchor);
    const list = shopPayments(await ordersBetween(c.env.DB, period.start, period.end), s);
    const rows = [['期間(から)', '期間(まで)', 'お店', '食数', 'うちだるまランチ', 'お食事代合計(税込)', `営業代行料(${s.agency_fee_percent}%・税込)`, 'うち消費税10%', 'お支払い額']];
    for (const x of list) rows.push([period.start, period.end, x.shop_name, x.meals, x.meals_lunch, x.bento_total, x.agency_fee, x.agency_fee_tax, x.payment]);
    return csvResponse(c, `logiben_shops_${period.start}.csv`, rows);
  });
}
