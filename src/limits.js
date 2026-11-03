// =============================================================
// 1日に作れる数(上限)
//   いつもの上限:menu_items.daily_limit(お弁当ごと)/ shops.daily_limit(お店全体)
//   日ごとの上限:day_limits(特定の日だけ変える。あればこちらが優先)
//   どれも空 = 制限なし。だるまランチ(お店で食べる)は数えない
// =============================================================
import { InputError, limitOf } from './master.js';

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** その日の「日ごとの上限」 { items: Map(お弁当id → 上限), shops: Map(お店id → 上限) } */
export async function dayOverrides(db, date) {
  const { results } = await db.prepare('SELECT shop_id, menu_item_id, daily_limit FROM day_limits WHERE date = ?').bind(date).all();
  const items = new Map();
  const shops = new Map();
  for (const r of results) (r.menu_item_id ? items.set(r.menu_item_id, r.daily_limit) : shops.set(r.shop_id, r.daily_limit));
  return { items, shops };
}

/**
 * その日に使う上限(日ごとの上限があればそれ、なければいつもの上限)
 * @param {{id:number, shop_id:number, daily_limit:number|null, shop_limit:number|null}} item
 */
export function effectiveLimits(item, overrides) {
  return {
    daily_limit: overrides.items.has(item.id) ? overrides.items.get(item.id) : item.daily_limit ?? null,
    shop_limit: overrides.shops.has(item.shop_id) ? overrides.shops.get(item.shop_id) : item.shop_limit ?? null,
  };
}

/** あるお店の、ある日の上限の一覧(画面で編集するため) */
async function getDayLimits(db, shopId, date) {
  if (!isDate(date)) throw new InputError('日付を正しく入力してください');
  const shop = await db.prepare('SELECT id, name, daily_limit FROM shops WHERE id = ?').bind(shopId).first();
  if (!shop) throw new InputError('お店が見つかりません');
  const { results: items } = await db
    .prepare(`SELECT id, name, daily_limit FROM menu_items WHERE shop_id = ? AND kind = 'bento' AND active = 1 ORDER BY price, id`)
    .bind(shopId)
    .all();
  const o = await dayOverrides(db, date);
  const { results: upcoming } = await db
    .prepare(
      `SELECT d.date, d.menu_item_id, d.daily_limit, m.name AS item_name FROM day_limits d LEFT JOIN menu_items m ON m.id = d.menu_item_id
       WHERE d.shop_id = ? AND d.date >= date('now', '+9 hours') ORDER BY d.date, d.menu_item_id IS NOT NULL, m.name`
    )
    .bind(shopId)
    .all();
  return {
    date,
    shop: { usual: shop.daily_limit, day: o.shops.has(shopId) ? o.shops.get(shopId) : null },
    items: items.map((i) => ({ id: i.id, name: i.name, usual: i.daily_limit, day: o.items.has(i.id) ? o.items.get(i.id) : null })),
    upcoming, // これから先の、日ごとの上限が決まっている日
  };
}

/**
 * ある日の上限を保存する。空欄の項目は「いつもどおり」(日ごとの上限を消す)
 * body: { date, shop: 数|'' , items: { お弁当id: 数|'' } }
 */
async function saveDayLimits(db, shopId, body) {
  const { date } = body;
  if (!isDate(date)) throw new InputError('日付を正しく入力してください');
  const { results: own } = await db.prepare(`SELECT id FROM menu_items WHERE shop_id = ?`).bind(shopId).all();
  const ownIds = new Set(own.map((r) => r.id));
  const stmts = [];
  const put = (itemId, raw) => {
    const v = limitOf(raw);
    stmts.push(db.prepare('DELETE FROM day_limits WHERE shop_id = ? AND COALESCE(menu_item_id, 0) = ? AND date = ?').bind(shopId, itemId ?? 0, date));
    if (v !== null) stmts.push(db.prepare('INSERT INTO day_limits (shop_id, menu_item_id, date, daily_limit) VALUES (?, ?, ?, ?)').bind(shopId, itemId, date, v));
  };
  if ('shop' in body) put(null, body.shop);
  for (const [id, raw] of Object.entries(body.items || {})) {
    if (!ownIds.has(Number(id))) throw new InputError('このお店のメニューではありません');
    put(Number(id), raw);
  }
  if (stmts.length) await db.batch(stmts);
  return getDayLimits(db, shopId, date);
}

export function registerLimitRoutes(app) {
  // お店:自分のお店の分
  app.get('/api/shop/day-limits', async (c) => c.json(await getDayLimits(c.env.DB, c.get('user').shop_id, c.req.query('date'))));
  app.put('/api/shop/day-limits', async (c) => c.json(await saveDayLimits(c.env.DB, c.get('user').shop_id, await c.req.json().catch(() => ({})))));
  // 管理者:どのお店でも
  app.get('/api/admin/shops/:id/day-limits', async (c) => c.json(await getDayLimits(c.env.DB, Number(c.req.param('id')), c.req.query('date'))));
  app.put('/api/admin/shops/:id/day-limits', async (c) =>
    c.json(await saveDayLimits(c.env.DB, Number(c.req.param('id')), await c.req.json().catch(() => ({}))))
  );
}
