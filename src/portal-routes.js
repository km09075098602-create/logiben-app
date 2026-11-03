// =============================================================
// 会社の担当者・お店 の画面のAPI
//   /api/company/… 会社の担当者(自分の会社の分だけ見られる)
//   /api/shop/…    お店(自分のお店の分だけ見られる・メニューを登録できる)
// =============================================================
import { todayJST, addDays, deadlineFor, closedReason } from './rules.js';
import { companyInvoices, shopPayments, periodOf, recentPeriods, toCsv } from './billing.js';
import { loadSettings } from './settings.js';
import { ordersBetween, dayOrders } from './queries.js';
import { isMonth, monthRange } from './billing-routes.js';
import { menuFields } from './master.js';

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const bad = (c, message) => c.json({ error: message }, 400);

export function registerPortalRoutes(app, requireRole) {
  // ================= 会社の担当者 =================
  app.use('/api/company/*', requireRole('company'));

  /** 月の利用状況と請求額 */
  app.get('/api/company/summary', async (c) => {
    const user = c.get('user');
    const month = c.req.query('month') || todayJST().slice(0, 7);
    if (!isMonth(month)) return bad(c, '月を正しく指定してください');
    const s = await loadSettings(c.env.DB);
    const orders = await ordersBetween(c.env.DB, ...monthRange(month), { companyId: user.company_id });
    const [invoice] = companyInvoices(orders, s);
    // 日ごとの食数
    const daily = {};
    for (const o of orders) daily[o.delivery_date] = (daily[o.delivery_date] || 0) + 1;
    const { count } = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'employee' AND company_id = ? AND active = 1`)
      .bind(user.company_id)
      .first();
    return c.json({
      month,
      complete: month < todayJST().slice(0, 7),
      service_fee: s.service_fee,
      employee_count: count,
      invoice: invoice || null,
      daily: Object.entries(daily).map(([date, meals]) => ({ date, meals })),
    });
  });

  /** ある日の、自分の会社の注文一覧 */
  app.get('/api/company/day', async (c) => {
    const date = c.req.query('date');
    if (!isDate(date)) return bad(c, '日付が正しくありません');
    const orders = await ordersBetween(c.env.DB, date, date, { companyId: c.get('user').company_id });
    return c.json({
      date,
      orders: orders.map((o) => ({ department: o.department, login_id: o.login_id, user_name: o.user_name, item_name: o.item_name, shop_name: o.shop_name, price: o.price })),
    });
  });

  /** 社員ごとの内訳CSV(給料から差し引くときなどに) */
  app.get('/api/company/employees.csv', async (c) => {
    const user = c.get('user');
    const month = c.req.query('month');
    if (!isMonth(month)) return bad(c, '月を正しく指定してください');
    const s = await loadSettings(c.env.DB);
    const [inv] = companyInvoices(await ordersBetween(c.env.DB, ...monthRange(month), { companyId: user.company_id }), s);
    const rows = [['対象月', '部署', '社員番号', '名前', '食数', 'お弁当代合計(税込)', '会社負担', '社員負担']];
    for (const e of inv?.employees || []) rows.push([month, e.department, e.login_id, e.user_name, e.meals, e.bento_total, e.company_share, e.employee_share]);
    return c.body(toCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="logiben_${user.company_code}_${month}.csv"`,
    });
  });

  // ================= お店 =================
  app.use('/api/shop/*', requireRole('shop'));

  /** ある日の注文(数と中身) */
  app.get('/api/shop/orders', async (c) => {
    const date = c.req.query('date');
    if (!isDate(date)) return bad(c, '日付が正しくありません');
    const s = await loadSettings(c.env.DB);
    const deadline = deadlineFor(date, s);
    const shopId = c.get('user').shop_id;
    const r = await dayOrders(c.env.DB, date, { shopId });
    const shopClosed = await c.env.DB.prepare('SELECT note FROM closed_days WHERE shop_id = ? AND date = ?').bind(shopId, date).first();
    return c.json({
      date,
      closed_reason: closedReason(date, s) || (shopClosed ? `お店の休業日${shopClosed.note ? '(' + shopClosed.note + ')' : ''}` : null),
      deadline: deadline.toISOString(),
      fixed: new Date() >= deadline, // 締め切りを過ぎていれば数は確定
      total: r.total,
      items: r.shops[0]?.items || [],
      amount: r.shops[0]?.amount || 0,
      orders: r.orders.map((o) => ({ company_name: o.company_name, department: o.department, user_name: o.user_name, item_name: o.item_name })),
    });
  });

  /** 自分のお店のメニュー */
  app.get('/api/shop/menu', async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, description, price, active FROM menu_items WHERE shop_id = ? ORDER BY active DESC, price, id'
    )
      .bind(c.get('user').shop_id)
      .all();
    return c.json(results);
  });

  app.post('/api/shop/menu', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const r = await c.env.DB.prepare('INSERT INTO menu_items (shop_id, name, description, price) VALUES (?, ?, ?, ?)')
      .bind(c.get('user').shop_id, ...menuFields(b))
      .run();
    return c.json({ id: r.meta.last_row_id });
  });

  // 値段を変えても、すでに入っている注文の値段は変わらない
  app.put('/api/shop/menu/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const r = await c.env.DB.prepare('UPDATE menu_items SET name = ?, description = ?, price = ?, active = ? WHERE id = ? AND shop_id = ?')
      .bind(...menuFields(b), b.active === false || b.active === 0 ? 0 : 1, Number(c.req.param('id')), c.get('user').shop_id)
      .run();
    if (!r.meta.changes) return bad(c, 'メニューが見つかりません');
    return c.json({ ok: true });
  });

  /** お支払い(2週間ごと) */
  app.get('/api/shop/payments', async (c) => {
    const start = c.req.query('start');
    if (start && !isDate(start)) return bad(c, '日付が正しくありません');
    const s = await loadSettings(c.env.DB);
    const period = periodOf(start || todayJST(), s.shop_period_anchor);
    const orders = await ordersBetween(c.env.DB, period.start, period.end, { shopId: c.get('user').shop_id });
    return c.json({
      period,
      complete: period.end < todayJST(),
      periods: recentPeriods(addDays(todayJST(), 14), s.shop_period_anchor, 10),
      agency_fee_percent: s.agency_fee_percent,
      payment: shopPayments(orders, s)[0] || null,
    });
  });
}
