// =============================================================
// 休業日のAPI
//   管理者:全体の休業日(年末年始など)と、各お店の休業日
//   お店  :自分のお店の休業日
// 土日・祝日は自動でお休みなので、登録は不要です(src/holidays.js)。
// =============================================================
import { todayJST, addDays } from './rules.js';
import { holidaysBetween } from './holidays.js';
import { InputError } from './master.js';
import { pushToUsers, dateLabel } from './line.js';

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** 今日以降の休業日の一覧(shopId が null なら全体の休業日) */
async function listClosed(db, shopId) {
  const { results } = await db
    .prepare(
      `SELECT id, date, note FROM closed_days
       WHERE ((?1 IS NULL AND shop_id IS NULL) OR shop_id = ?1) AND date >= ?2 ORDER BY date`
    )
    .bind(shopId, todayJST())
    .all();
  return results;
}

/**
 * 休業日を追加する。
 * その日にすでに注文があるときは、force(取り消してよい)がない限り追加せず、件数を返す。
 */
async function addClosed(env, { shopId, date, note, force }) {
  const db = env.DB;
  if (!isDate(date)) throw new InputError('日付を正しく入力してください');
  if (date < todayJST()) throw new InputError('過ぎた日は休業日にできません');
  const memo = String(note ?? '').trim().slice(0, 30);
  const exists = await db
    .prepare('SELECT 1 FROM closed_days WHERE COALESCE(shop_id, 0) = COALESCE(?1, 0) AND date = ?2')
    .bind(shopId, date)
    .first();
  if (exists) throw new InputError('この日はすでに休業日です');

  const { n } = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE delivery_date = ?1 AND (?2 IS NULL OR shop_id = ?2)`)
    .bind(date, shopId)
    .first();
  if (n && !force) return { needs_confirm: true, count: n };

  // 取り消す注文(LINE連携している社員にはお知らせを送るため、先に控えておく)
  const { results: affected } = n
    ? await db
        .prepare(`SELECT user_id, item_name FROM orders WHERE delivery_date = ?1 AND (?2 IS NULL OR shop_id = ?2)`)
        .bind(date, shopId)
        .all()
    : { results: [] };

  const stmts = [];
  // 注文は削除する(社員の画面からも消える)。社員へのお知らせは今後の課題
  if (n) stmts.push(db.prepare(`DELETE FROM orders WHERE delivery_date = ?1 AND (?2 IS NULL OR shop_id = ?2)`).bind(date, shopId));
  stmts.push(db.prepare('INSERT INTO closed_days (shop_id, date, note) VALUES (?, ?, ?)').bind(shopId, date, memo));
  await db.batch(stmts);

  const reason = memo || (shopId ? 'お店の休業日' : '休業日');
  const notified = await pushToUsers(
    env,
    db,
    new Map(affected.map((o) => [o.user_id, `【ロジ弁】${dateLabel(date)}は${reason}のため、ご注文(${o.item_name})を取り消しました。ご迷惑をおかけします。`]))
  );
  return { ok: true, cancelled: n, notified };
}

/** 祝日の一覧(今日から1年先まで・参考表示用) */
const upcomingHolidays = () => holidaysBetween(todayJST(), addDays(todayJST(), 365));

const optionalShopId = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InputError('お店の指定が正しくありません');
  return n;
};

export function registerClosedDayRoutes(app) {
  // ---------- 管理者 ----------
  /** ?shop_id=… ならそのお店、なければ全体の休業日 */
  app.get('/api/admin/closed-days', async (c) => {
    return c.json({ holidays: upcomingHolidays(), closed: await listClosed(c.env.DB, optionalShopId(c.req.query('shop_id'))) });
  });

  app.post('/api/admin/closed-days', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await addClosed(c.env, { ...b, shopId: optionalShopId(b.shop_id) }));
  });

  app.delete('/api/admin/closed-days/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM closed_days WHERE id = ?').bind(Number(c.req.param('id'))).run();
    return c.json({ ok: true });
  });

  // ---------- お店(自分のお店の分だけ) ----------
  app.get('/api/shop/closed-days', async (c) => {
    const db = c.env.DB;
    return c.json({
      holidays: upcomingHolidays(),
      service_closed: await listClosed(db, null), // 全体の休業日(参考)
      closed: await listClosed(db, c.get('user').shop_id),
    });
  });

  app.post('/api/shop/closed-days', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await addClosed(c.env, { ...b, shopId: c.get('user').shop_id }));
  });

  app.delete('/api/shop/closed-days/:id', async (c) => {
    const r = await c.env.DB.prepare('DELETE FROM closed_days WHERE id = ? AND shop_id = ? AND date >= ?')
      .bind(Number(c.req.param('id')), c.get('user').shop_id, todayJST())
      .run();
    if (!r.meta.changes) throw new InputError('休業日が見つかりません');
    return c.json({ ok: true });
  });
}
