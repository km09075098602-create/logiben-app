// =============================================================
// 社員の注文の処理(Webの画面とLINEで共通に使う)
//   どちらから注文しても、同じルール(締め切り・お休み・半額・上限)で処理されます。
// =============================================================
import { allocateMonth, previewShare, isOrderOpen, orderableDates, deadlineFor, closedReason, todayJST } from './rules.js';
import { InputError } from './master.js';

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** ある社員の、ある月(YYYY-MM)の注文 */
export async function monthOrders(db, userId, month) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.delivery_date, o.price, o.item_name, o.channel, s.name AS shop_name
       FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.user_id = ? AND o.kind = 'bento' AND substr(o.delivery_date, 1, 7) = ?`
    )
    .bind(userId, month)
    .all();
  return results;
}

/** 今月の利用状況(会社負担の使用額・残り・お知らせ)と、注文できる日 */
export async function employeeSummary(db, user, s, month = todayJST().slice(0, 7)) {
  const r = allocateMonth(await monthOrders(db, user.id, month), s);
  return {
    month,
    dates: orderableDates(s),
    cap: r.cap,
    used: r.used,
    remaining: r.remaining,
    warn: r.warn,
    reached: r.reached,
    warn_percent: s.warn_percent,
    orders: r.orders,
  };
}

/** ある日のメニュー(自分の支払い見込み付き)と、その日の自分の注文 */
export async function dayMenu(db, user, date, s) {
  if (!isDate(date)) throw new InputError('日付が正しくありません');
  const orders = await monthOrders(db, user.id, date.slice(0, 7));
  const { results: items } = await db
    .prepare(
      `SELECT m.id, m.name, m.description, m.price, s.id AS shop_id, s.name AS shop_name
       FROM menu_items m JOIN shops s ON s.id = m.shop_id
       WHERE m.active = 1 AND s.active = 1
         AND s.id NOT IN (SELECT shop_id FROM closed_days WHERE date = ? AND shop_id IS NOT NULL) -- その日休みのお店は出さない
       ORDER BY s.id, m.price`
    )
    .bind(date)
    .all();
  const current = await db
    .prepare(`SELECT id, menu_item_id, item_name, price FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'bento'`)
    .bind(user.id, date)
    .first();
  const allocated = allocateMonth(orders, s).orders.find((o) => current && o.id === current.id);
  const { results: closedShops } = await db
    .prepare('SELECT s.name FROM closed_days d JOIN shops s ON s.id = d.shop_id WHERE d.date = ? AND s.active = 1')
    .bind(date)
    .all();
  return {
    date,
    open: isOrderOpen(date, s),
    closed_reason: closedReason(date, s),
    shops_closed: closedShops.map((r) => r.name), // この日お休みのお店
    deadline: deadlineFor(date, s).toISOString(),
    current: current ? { ...current, ...allocated } : null,
    items: items.map((it) => {
      const p = previewShare(orders, date, it.price, s);
      return { ...it, company_share: p.company_share, employee_share: p.employee_share };
    }),
  };
}

/**
 * 注文する(同じ日にすでに注文があれば、お弁当を変更)。
 * channel:注文経路('web' / 'line')
 * 戻り値:注文したお弁当と、その注文の負担額、注文後の今月の利用状況
 */
export async function placeOrder(db, user, date, menuItemId, s, channel = 'web') {
  if (isDate(date) && closedReason(date, s)) throw new InputError(`この日はお休みです(${closedReason(date, s)})`);
  if (!isDate(date) || !isOrderOpen(date, s)) throw new InputError('この日の注文は締め切られています');
  const item = await db
    .prepare(`SELECT m.* FROM menu_items m JOIN shops s ON s.id = m.shop_id WHERE m.id = ? AND m.active = 1 AND s.active = 1`)
    .bind(Number(menuItemId))
    .first();
  if (!item) throw new InputError('このお弁当は選べません');
  const shopClosed = await db.prepare('SELECT 1 FROM closed_days WHERE shop_id = ? AND date = ?').bind(item.shop_id, date).first();
  if (shopClosed) throw new InputError('このお店はこの日お休みです');
  await db
    .prepare(
      `INSERT INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, delivery_date, kind) DO UPDATE SET
         menu_item_id = excluded.menu_item_id, shop_id = excluded.shop_id,
         item_name = excluded.item_name, price = excluded.price, channel = excluded.channel, updated_at = datetime('now')`
    )
    .bind(user.id, date, item.id, item.shop_id, item.name, item.price, channel)
    .run();
  const month = allocateMonth(await monthOrders(db, user.id, date.slice(0, 7)), s);
  const mine = month.orders.find((o) => o.delivery_date === date);
  return { item, order: mine, month };
}

/** 注文を取り消す */
export async function cancelOrder(db, user, date, s) {
  if (!isDate(date) || !isOrderOpen(date, s)) throw new InputError('この日の注文は締め切られています');
  const r = await db.prepare(`DELETE FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'bento'`).bind(user.id, date).run();
  return { cancelled: r.meta.changes };
}
