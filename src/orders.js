// =============================================================
// 社員の注文の処理(Webの画面とLINEで共通に使う)
//   どちらから注文しても、同じルール(締め切り・お休み・半額・上限)で処理されます。
//   「だるまランチ」(お店で食べる)の記録もここで扱います。お弁当と同じ上限を使います。
// =============================================================
import { allocateMonth, previewShare, isOrderOpen, orderableDates, deadlineFor, closedReason, todayJST } from './rules.js';
import { InputError } from './master.js';
import { pointBalance, usablePoints } from './points.js';

/** いまの時刻(UTC "YYYY-MM-DD HH:MM:SS")。ポイントを使った時刻の記録に使う */
const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** ある社員の、ある月(YYYY-MM)の利用(お弁当もだるまランチも。上限は合わせて数えるため) */
export async function monthOrders(db, userId, month) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.delivery_date, o.price, o.item_name, o.channel, o.kind, o.tax_rate, o.points_used, o.created_at, s.name AS shop_name
       FROM orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.user_id = ? AND substr(o.delivery_date, 1, 7) = ?`
    )
    .bind(userId, month)
    .all();
  return results;
}

/**
 * ポイントの残高。exclude を渡すと、その日のその種類の注文を除いて数える
 * (注文を変更するとき、その注文で使っていたポイントを戻してから数えるため)
 */
export async function pointsOf(db, userId, s, exclude = null) {
  const { results } = await db
    .prepare('SELECT delivery_date, kind, points_used, updated_at AS used_at FROM orders WHERE user_id = ?')
    .bind(userId)
    .all();
  const rows = exclude ? results.filter((o) => !(o.delivery_date === exclude.date && o.kind === exclude.kind)) : results;
  // 会社の給料日(ポイントは給料日の翌日にもらえる)
  const company = await db.prepare('SELECT c.payday FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?').bind(userId).first();
  return { ...pointBalance(rows, s, todayJST(), company?.payday ?? 25), enabled: !!s.points_enabled, max_per_order: s.point_max_per_order, per_use: s.point_per_use };
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
    points: await pointsOf(db, user.id, s),
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
       WHERE m.active = 1 AND s.active = 1 AND m.kind = 'bento'
         AND s.id NOT IN (SELECT shop_id FROM closed_days WHERE date = ? AND shop_id IS NOT NULL) -- その日休みのお店は出さない
       ORDER BY s.id, m.price`
    )
    .bind(date)
    .all();
  const current = await db
    .prepare(`SELECT id, menu_item_id, item_name, price, points_used FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'bento'`)
    .bind(user.id, date)
    .first();
  const allocated = allocateMonth(orders, s).orders.find((o) => current && o.id === current.id);
  // この日に使えるポイント(この日の注文で使っているポイントは、戻して数える)
  const points = await pointsOf(db, user.id, s, { date, kind: 'bento' });
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
    points,
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
export async function placeOrder(db, user, date, menuItemId, s, channel = 'web', usePoints = false) {
  if (isDate(date) && closedReason(date, s)) throw new InputError(`この日はお休みです(${closedReason(date, s)})`);
  if (!isDate(date) || !isOrderOpen(date, s)) throw new InputError('この日の注文は締め切られています');
  const item = await db
    .prepare(`SELECT m.* FROM menu_items m JOIN shops s ON s.id = m.shop_id WHERE m.id = ? AND m.active = 1 AND s.active = 1 AND m.kind = 'bento'`)
    .bind(Number(menuItemId))
    .first();
  if (!item) throw new InputError('このお弁当は選べません');
  const shopClosed = await db.prepare('SELECT 1 FROM closed_days WHERE shop_id = ? AND date = ?').bind(item.shop_id, date).first();
  if (shopClosed) throw new InputError('このお店はこの日お休みです');
  if (await lunchOn(db, user.id, date)) throw new InputError('この日はだるまランチを利用済みです');
  // ポイント:この日の注文で使っていた分は戻してから数え直す
  const pointsUsed = usePoints ? usablePoints((await pointsOf(db, user.id, s, { date, kind: 'bento' })).balance, item.price, s) : 0;
  await db
    .prepare(
      `INSERT INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price, channel, tax_rate, points_used, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?10, ?10)
       ON CONFLICT (user_id, delivery_date, kind) DO UPDATE SET
         menu_item_id = excluded.menu_item_id, shop_id = excluded.shop_id,
         item_name = excluded.item_name, price = excluded.price, channel = excluded.channel,
         points_used = excluded.points_used, updated_at = excluded.updated_at`
    )
    .bind(user.id, date, item.id, item.shop_id, item.name, item.price, channel, s.tax_rate_percent, pointsUsed, nowUtc())
    .run();
  const month = allocateMonth(await monthOrders(db, user.id, date.slice(0, 7)), s);
  const mine = month.orders.find((o) => o.delivery_date === date && o.kind === 'bento');
  return { item, order: mine, month };
}

/** 注文を取り消す */
export async function cancelOrder(db, user, date, s) {
  if (!isDate(date) || !isOrderOpen(date, s)) throw new InputError('この日の注文は締め切られています');
  const r = await db.prepare(`DELETE FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'bento'`).bind(user.id, date).run();
  return { cancelled: r.meta.changes };
}

// =============================================================
// だるまランチ(お店で食べる)
//   社員がお店で「利用する」を押し、表示された画面をお店の人に見せる。
//   1日1回まで。お弁当を注文している日は使えない。土日祝・休業日は使えない。
//   社員は自分では取り消せない(食べたあとに取り消されるのを防ぐため)。間違いはお店か達磨商事が取り消す。
// =============================================================

const lunchOn = (db, userId, date) =>
  db.prepare(`SELECT id FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'daruma_lunch'`).bind(userId, date).first();

/** 今日だるまランチを使えるお店とメニュー(自分の支払い見込みつき)、今日の利用 */
export async function lunchOptions(db, user, s) {
  const today = todayJST();
  const orders = await monthOrders(db, user.id, today.slice(0, 7));
  const used = orders.find((o) => o.delivery_date === today && o.kind === 'daruma_lunch');
  const bento = orders.find((o) => o.delivery_date === today && o.kind === 'bento');
  const { results: items } = await db
    .prepare(
      `SELECT m.id, m.name, m.description, m.price, s.id AS shop_id, s.name AS shop_name
       FROM menu_items m JOIN shops s ON s.id = m.shop_id
       WHERE m.active = 1 AND s.active = 1 AND m.kind = 'lunch'
         AND s.id NOT IN (SELECT shop_id FROM closed_days WHERE date = ? AND shop_id IS NOT NULL)
       ORDER BY s.name, m.price`
    )
    .bind(today)
    .all();
  const month = allocateMonth(orders, s);
  return {
    date: today,
    points: await pointsOf(db, user.id, s),
    closed_reason: closedReason(today, s),
    used: used ? { ...used, ...month.orders.find((o) => o.id === used.id) } : null,
    bento_today: bento ? bento.item_name : null,
    items: items.map((it) => {
      const p = previewShare(orders, today, it.price, s, s.eatin_tax_rate_percent);
      return { ...it, company_share: p.company_share, employee_share: p.employee_share };
    }),
  };
}

/** だるまランチを利用する(今日の分を記録) */
export async function recordLunch(db, user, menuItemId, s, channel = 'web', usePoints = false) {
  const today = todayJST();
  const reason = closedReason(today, s);
  if (reason) throw new InputError(`今日はだるまランチを使えません(${reason})`);
  const item = await db
    .prepare(`SELECT m.* FROM menu_items m JOIN shops s ON s.id = m.shop_id WHERE m.id = ? AND m.active = 1 AND s.active = 1 AND m.kind = 'lunch'`)
    .bind(Number(menuItemId))
    .first();
  if (!item) throw new InputError('このメニューは選べません');
  if (await db.prepare('SELECT 1 FROM closed_days WHERE shop_id = ? AND date = ?').bind(item.shop_id, today).first())
    throw new InputError('このお店は今日お休みです');
  if (await lunchOn(db, user.id, today)) throw new InputError('だるまランチは1日1回までです(今日はもう利用済みです)');
  const bento = await db.prepare(`SELECT 1 FROM orders WHERE user_id = ? AND delivery_date = ? AND kind = 'bento'`).bind(user.id, today).first();
  if (bento) throw new InputError('今日はお弁当を注文しているため、だるまランチは使えません');
  const pointsUsed = usePoints ? usablePoints((await pointsOf(db, user.id, s)).balance, item.price, s) : 0;
  await db
    .prepare(
      `INSERT INTO orders (user_id, delivery_date, menu_item_id, shop_id, item_name, price, channel, kind, tax_rate, points_used, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'daruma_lunch', ?, ?, ?10, ?10)`
    )
    .bind(user.id, today, item.id, item.shop_id, item.name, item.price, channel, s.eatin_tax_rate_percent, pointsUsed, nowUtc())
    .run();
  return lunchOptions(db, user, s);
}
