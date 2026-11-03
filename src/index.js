// =============================================================
// ロジ弁 サーバー本体
// 画面(public フォルダ)からの問い合わせに答える「API」を定義しています。
//   /api/login …… ログイン
//   /api/employee/… 社員用
//   /api/admin/…    管理者用(登録画面のAPIは src/master.js)
//   /api/company/… 会社の担当者用、/api/shop/… お店用(src/portal-routes.js)
//   /api/line/webhook LINEから届くメッセージ(src/line.js)
// =============================================================
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { verifyPassword } from './password.js';
import { registerMasterRoutes } from './master.js';
import { registerBillingRoutes } from './billing-routes.js';
import { loadSettings } from './settings.js';
import { dayOrders } from './queries.js';
import { employeeSummary, dayMenu, placeOrder, cancelOrder } from './orders.js';
import { registerPortalRoutes } from './portal-routes.js';
import { registerClosedDayRoutes } from './closed-days.js';
import { registerLineRoutes } from './line.js';
import { DEFAULT_SETTINGS, deadlineFor, closedReason } from './rules.js';

const app = new Hono();
const SESSION_DAYS = 30;

// ---------- 共通の部品 ----------


const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const fail = (c, status, message) => c.json({ error: message }, status);

// ログインしている人を調べる
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, 'session');
  if (token) {
    const user = await c.env.DB.prepare(
      `SELECT u.id, u.role, u.name, u.department, u.company_id, c.name AS company_name, c.code AS company_code,
              u.shop_id, sh.name AS shop_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN companies c ON c.id = u.company_id
       LEFT JOIN shops sh ON sh.id = u.shop_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1
         AND (u.company_id IS NULL OR c.active = 1)
         AND (u.shop_id IS NULL OR sh.active = 1)`
    )
      .bind(token)
      .first();
    if (user) c.set('user', user);
  }
  await next();
});

/** 指定した役割の人だけ通す */
const requireRole = (role) => async (c, next) => {
  const user = c.get('user');
  if (!user) return fail(c, 401, 'ログインしてください');
  if (user.role !== role) return fail(c, 403, 'この画面を使う権限がありません');
  await next();
};

// ---------- ログイン ----------

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = c.env.DB;
  let user;
  if (body.type === 'admin') {
    user = await db
      .prepare(`SELECT * FROM users WHERE role = 'admin' AND login_id = ? AND active = 1`)
      .bind(String(body.login_id || ''))
      .first();
  } else if (body.type === 'shop') {
    // お店:ログインIDだけで入る
    user = await db
      .prepare(
        `SELECT u.* FROM users u JOIN shops s ON s.id = u.shop_id
         WHERE u.role = 'shop' AND u.login_id = ? AND u.active = 1 AND s.active = 1`
      )
      .bind(String(body.login_id || '').trim())
      .first();
  } else {
    // 社員・会社の担当者:会社コード+ログインID
    const role = body.type === 'company' ? 'company' : 'employee';
    user = await db
      .prepare(
        `SELECT u.* FROM users u JOIN companies c ON c.id = u.company_id
         WHERE u.role = ? AND c.code = ? AND u.login_id = ? AND u.active = 1 AND c.active = 1`
      )
      .bind(role, String(body.company_code || '').trim().toUpperCase(), String(body.login_id || '').trim())
      .first();
  }
  if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
    return fail(c, 401, 'ログイン情報が正しくありません');
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  await db
    .prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(token, user.id, `+${SESSION_DAYS} days`)
    .run();
  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return c.json({ role: user.role });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'session');
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', (c) => {
  const user = c.get('user');
  return user ? c.json(user) : fail(c, 401, 'ログインしてください');
});

// ---------- 社員用 ----------

app.use('/api/employee/*', requireRole('employee'));

/** 注文できる日の一覧と、今月の利用状況(LINE連携の状態も) */
app.get('/api/employee/summary', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const s = await loadSettings(db);
  const summary = await employeeSummary(db, user, s, c.req.query('month') || undefined);
  const line = await db.prepare('SELECT line_user_id FROM users WHERE id = ?').bind(user.id).first();
  return c.json({
    ...summary,
    line_linked: !!line?.line_user_id,
    line_enabled: !!c.env.LINE_CHANNEL_SECRET, // LINE公式アカウントとつながっているか
    line_friend_url: c.env.LINE_FRIEND_URL || null, // 友だち追加のURL
  });
});

/** ある日のメニュー(自分の支払い見込み付き)と、その日の自分の注文 */
app.get('/api/employee/menu', async (c) => {
  const s = await loadSettings(c.env.DB);
  return c.json(await dayMenu(c.env.DB, c.get('user'), c.req.query('date'), s));
});

/** 注文する(同じ日にすでに注文があれば、お弁当を変更) */
app.post('/api/employee/orders', async (c) => {
  const { date, menu_item_id } = await c.req.json().catch(() => ({}));
  const s = await loadSettings(c.env.DB);
  await placeOrder(c.env.DB, c.get('user'), date, menu_item_id, s, 'web');
  return c.json({ ok: true });
});

/** 注文を取り消す */
app.delete('/api/employee/orders/:date', async (c) => {
  const s = await loadSettings(c.env.DB);
  await cancelOrder(c.env.DB, c.get('user'), c.req.param('date'), s);
  return c.json({ ok: true });
});

// ---------- 管理者用 ----------

app.use('/api/admin/*', requireRole('admin'));

/** ある日の注文一覧(お店ごと・会社/部署ごとの集計付き) */
app.get('/api/admin/orders', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) return fail(c, 400, '日付が正しくありません');
  const s = await loadSettings(c.env.DB);
  const { results: shopsClosed } = await c.env.DB.prepare(
    'SELECT s.name, d.note FROM closed_days d JOIN shops s ON s.id = d.shop_id WHERE d.date = ?'
  )
    .bind(date)
    .all();
  return c.json({
    date,
    deadline: deadlineFor(date, s).toISOString(),
    closed_reason: closedReason(date, s), // 土日祝・全体の休業日なら理由
    shops_closed: shopsClosed, // その日休みのお店
    ...(await dayOrders(c.env.DB, date)),
  });
});

/** 設定の一覧 */
app.get('/api/admin/settings', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value, label FROM settings ORDER BY sort_order').all();
  return c.json(results);
});

/** 設定を保存 */
app.put('/api/admin/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updates = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const value = String(raw).trim();
    if (key === 'deadline_time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fail(c, 400, '締め切り時刻は 09:30 のように入力してください');
    } else if (key === 'shop_period_anchor') {
      if (!isDate(value) || Number.isNaN(Date.parse(value))) return fail(c, 400, '日付を正しく入力してください');
    } else if (!/^\d+$/.test(value)) {
      return fail(c, 400, `「${key}」には0以上の整数を入力してください`);
    }
    updates.push(c.env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(value, key));
  }
  if (updates.length) await c.env.DB.batch(updates);
  return c.json({ ok: true });
});

// お店・メニュー・会社・社員の登録(src/master.js)
registerMasterRoutes(app);
// 請求・支払い・CSV(src/billing-routes.js)
registerBillingRoutes(app);
// 会社の担当者・お店の画面(src/portal-routes.js)
registerPortalRoutes(app, requireRole);
// 休業日(src/closed-days.js)
registerClosedDayRoutes(app);
// LINE公式アカウントとの連携(src/line.js)
registerLineRoutes(app);

app.all('/api/*', (c) => fail(c, 404, '見つかりません'));

export default app;
