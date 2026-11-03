// =============================================================
// LINE公式アカウントとの連携
//
// しくみ
//   1. 社員がWebの注文画面で「LINE連携コード」(6けたの数字)を発行
//   2. LINE公式アカウントを友だち追加して、そのコードをトークに送る → 連携完了
//   3. あとはLINEのボタンで「注文する/確認/取り消し/今月の利用状況」ができる
//
// 費用について
//   社員の操作への「返信」は無料・無制限。こちらから送る「プッシュ」だけが
//   月の無料通数(無料プランは月200通)にかぞえられます。
//   プッシュを使うのは「休業日で注文を取り消したときのお知らせ」だけです。
//
// 必要な設定(Cloudflare の「シークレット」に入れる。README参照)
//   LINE_CHANNEL_SECRET        … チャネルシークレット(届いたメッセージが本物か確かめる)
//   LINE_CHANNEL_ACCESS_TOKEN  … チャネルアクセストークン(返信・プッシュに使う)
//   LINE_FRIEND_URL            … 友だち追加のURL(社員の画面に表示。なくても可)
// =============================================================
import { loadSettings } from './settings.js';
import { employeeSummary, dayMenu, placeOrder, cancelOrder } from './orders.js';
import { InputError } from './master.js';
import { todayJST } from './rules.js';

const LINK_CODE_MINUTES = 10; // 連携コードの有効時間
const RED = '#c0392b';

// ---------- 小さな道具 ----------

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export const dateLabel = (d) => {
  const dt = new Date(d + 'T00:00:00Z');
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEK[dt.getUTCDay()]})`;
};
const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const timeLabel = (iso) => {
  const jst = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${dateLabel(jst.toISOString().slice(0, 10))} ${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
};

const text = (t, quick) => ({ type: 'text', text: t, ...(quick ? { quickReply: { items: quick.slice(0, 13) } } : {}) });
/** クイックリプライ(トークの下に出るボタン)。label は20文字まで */
const qr = (label, data, displayText = label) => ({
  type: 'action',
  action: { type: 'postback', label: label.slice(0, 20), data, displayText },
});
const MAIN_MENU = [qr('🍱 注文する', 'a=dates'), qr('📋 注文の確認', 'a=list'), qr('↩️ 取り消す', 'a=cancelpick'), qr('💴 今月の利用状況', 'a=month')];

// ---------- 届いたメッセージが本物のLINEからか確かめる ----------

export async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ---------- LINEへ送る ----------

async function callLine(env, path, payload) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const res = await fetch(`${env.LINE_API_BASE || 'https://api.line.me'}/v2/bot/message/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('LINE API error', path, res.status, await res.text());
}
const reply = (env, replyToken, messages) => callLine(env, 'reply', { replyToken, messages: messages.slice(0, 5) });

/**
 * LINE連携している社員にお知らせを送る(プッシュ=月の無料通数にかぞえられる)
 * messagesByUser:Map(ユーザーID → 文)
 */
export async function pushToUsers(env, db, messagesByUser) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !messagesByUser.size) return 0;
  const ids = [...messagesByUser.keys()];
  const { results } = await db
    .prepare(`SELECT id, line_user_id FROM users WHERE line_user_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all();
  for (const u of results) await callLine(env, 'push', { to: u.line_user_id, messages: [text(messagesByUser.get(u.id))] });
  return results.length;
}

// ---------- 連携コード ----------

/** 社員のWeb画面から:連携コードを発行(前のコードは無効になる) */
export async function issueLinkCode(db, userId) {
  await db.prepare('DELETE FROM line_link_codes WHERE user_id = ? OR expires_at < datetime(\'now\')').bind(userId).run();
  for (let i = 0; i < 5; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    const code = String(n).padStart(6, '0');
    try {
      await db
        .prepare(`INSERT INTO line_link_codes (code, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
        .bind(code, userId, `+${LINK_CODE_MINUTES} minutes`)
        .run();
      return { code, minutes: LINK_CODE_MINUTES };
    } catch {
      // まれに同じ番号が使用中だったら作り直す
    }
  }
  throw new Error('連携コードを作れませんでした');
}

async function linkAccount(db, lineUserId, code) {
  const row = await db
    .prepare(`SELECT user_id FROM line_link_codes WHERE code = ? AND expires_at > datetime('now')`)
    .bind(code)
    .first();
  if (!row) return null;
  await db.batch([
    db.prepare('UPDATE users SET line_user_id = NULL WHERE line_user_id = ?').bind(lineUserId), // 別の社員と連携していたら外す
    db.prepare('UPDATE users SET line_user_id = ? WHERE id = ?').bind(lineUserId, row.user_id),
    db.prepare('DELETE FROM line_link_codes WHERE code = ?').bind(code),
  ]);
  return db.prepare('SELECT name FROM users WHERE id = ?').bind(row.user_id).first();
}

// ---------- メッセージを受けたときの処理 ----------

/** LINEのユーザーから、ロジ弁の社員を探す */
function findEmployee(db, lineUserId) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.department, u.company_id, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.line_user_id = ? AND u.role = 'employee' AND u.active = 1 AND c.active = 1`
    )
    .bind(lineUserId)
    .first();
}

const HOW_TO_LINK =
  'ロジ弁の注文画面(Web)にログインし、「LINEで注文する」から6けたの連携コードを発行して、このトークに送ってください。';

/** 1つのイベント(メッセージ・ボタン・友だち追加)を処理して、返信するメッセージを返す */
export async function handleEvent(env, event) {
  const db = env.DB;
  const lineUserId = event.source?.userId;
  if (!lineUserId) return [];

  if (event.type === 'follow') {
    return [text(`友だち追加ありがとうございます。ロジ弁です🍱\n\nLINEからお弁当を注文するには、はじめに連携が必要です。\n${HOW_TO_LINK}`)];
  }
  if (event.type === 'unfollow') {
    await db.prepare('UPDATE users SET line_user_id = NULL WHERE line_user_id = ?').bind(lineUserId).run();
    return [];
  }

  const message = event.type === 'message' && event.message?.type === 'text' ? event.message.text.trim() : '';
  // 全角数字も受け付ける
  const asCode = message.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/\s/g, '');
  if (/^\d{6}$/.test(asCode)) {
    const linked = await linkAccount(db, lineUserId, asCode);
    return linked
      ? [text(`${linked.name}さん、連携しました✅\n下のボタンから注文できます。`, MAIN_MENU)]
      : [text('連携コードが正しくないか、有効期限(10分)が切れています。もう一度発行してください。')];
  }

  const user = await findEmployee(db, lineUserId);
  if (!user) return [text(`まだロジ弁と連携していません。\n${HOW_TO_LINK}`)];

  // ボタン(postback)か、文字(キーワード)か
  let p = new URLSearchParams(event.type === 'postback' ? event.postback?.data : '');
  if (!p.get('a')) {
    if (/取り?消|キャンセル/.test(message)) p = new URLSearchParams('a=cancelpick');
    else if (/確認|一覧/.test(message)) p = new URLSearchParams('a=list');
    else if (/今月|利用|残り/.test(message)) p = new URLSearchParams('a=month');
    else if (/注文|弁当|メニュー/.test(message)) p = new URLSearchParams('a=dates');
    else return [text('ご用件を下のボタンから選んでください。', MAIN_MENU)];
  }

  const s = await loadSettings(db);
  try {
    return await ACTIONS[p.get('a')]?.({ db, user, s, p }) ?? [text('ご用件を下のボタンから選んでください。', MAIN_MENU)];
  } catch (err) {
    if (err instanceof InputError) return [text(`⚠️ ${err.message}`, MAIN_MENU)];
    throw err;
  }
}

const ACTIONS = {
  /** 日付を選ぶ */
  async dates({ db, user, s }) {
    const sum = await employeeSummary(db, user, s);
    const ordered = new Set(sum.orders.filter((o) => o.kind === 'bento').map((o) => o.delivery_date));
    const open = sum.dates.filter((d) => d.open);
    if (!open.length) return [text('いま注文できる日はありません。', MAIN_MENU)];
    return [
      text(
        'お届け日を選んでください。(✓は注文済み)',
        open.map((d) => qr(`${dateLabel(d.date)}${ordered.has(d.date) ? ' ✓' : ''}`, `a=menu&d=${d.date}`))
      ),
    ];
  },

  /** その日のメニュー(お店ごとのカード) */
  async menu({ db, user, s, p }) {
    const date = p.get('d');
    const m = await dayMenu(db, user, date, s);
    if (!m.open) return [text(`${dateLabel(date)} の注文は受け付けていません。`, MAIN_MENU)];
    const byShop = new Map();
    for (const it of m.items) {
      if (!byShop.has(it.shop_name)) byShop.set(it.shop_name, []);
      byShop.get(it.shop_name).push(it);
    }
    const bubbles = [...byShop].slice(0, 12).map(([shop, items]) => ({
      type: 'bubble',
      size: 'kilo',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: shop, weight: 'bold', color: RED }] },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        contents: items.map((it) => {
          const isCurrent = m.current?.menu_item_id === it.id;
          return {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: it.name, weight: 'bold', wrap: true },
              { type: 'text', text: `${yen(it.price)} → あなた ${yen(it.employee_share)}`, size: 'sm', color: '#666666' },
              // 残り○食(上限があるお弁当だけ)
              ...(it.remaining !== null && !isCurrent
                ? [{ type: 'text', text: it.sold_out ? '売り切れ' : `残り ${it.remaining}食`, size: 'xs', color: it.sold_out || it.remaining <= 3 ? RED : '#888888', weight: 'bold' }]
                : []),
              {
                type: 'button',
                style: isCurrent || it.sold_out ? 'secondary' : 'primary',
                color: isCurrent || it.sold_out ? undefined : RED,
                height: 'sm',
                action: isCurrent
                  ? { type: 'postback', label: '✓ 注文中', data: `a=menu&d=${date}` }
                  : it.sold_out
                  ? { type: 'postback', label: '売り切れ', data: `a=menu&d=${date}` }
                  : { type: 'postback', label: m.current ? 'これに変更' : 'これにする', data: `a=order&d=${date}&m=${it.id}`, displayText: `${dateLabel(date)} ${it.name}` },
              },
            ],
          };
        }),
      },
    }));
    const notes = [
      `${dateLabel(date)} のお弁当を選んでください。`,
      `締め切り:${timeLabel(m.deadline)}`,
      m.current ? `いまのご注文:${m.current.item_name}` : '',
      m.shops_closed.length ? `この日は ${m.shops_closed.join('・')} がお休みです。` : '',
    ].filter(Boolean);
    return [
      text(notes.join('\n')),
      { type: 'flex', altText: `${dateLabel(date)} のメニュー`, contents: { type: 'carousel', contents: bubbles } },
    ];
  },

  /** 注文する */
  async order({ db, user, s, p }) {
    const date = p.get('d');
    const r = await placeOrder(db, user, date, p.get('m'), s, 'line');
    const lines = [
      `✅ ${dateLabel(date)} 「${r.item.name}」を注文しました`,
      `お弁当代 ${yen(r.item.price)} → あなたのお支払い ${yen(r.order.employee_share)}`,
      `今月の会社負担の残り:${yen(r.month.remaining)}(税抜)`,
    ];
    if (r.month.reached) lines.push('', '⚠️ 今月の会社負担が上限に達しました。今月の残りのお弁当は全額ご自身の負担になります。');
    else if (r.month.warn) lines.push('', `⚠️ 今月の会社負担が上限の${s.warn_percent}%を超えました。上限に達すると、その月の残りは全額ご自身の負担になります。`);
    return [text(lines.join('\n'), [qr('🍱 別の日も注文', 'a=dates'), qr('📋 注文の確認', 'a=list')])];
  },

  /** これからの注文の一覧 */
  async list({ db, user, s }) {
    const upcoming = await upcomingOrders(db, user, s);
    if (!upcoming.length) return [text('これからのご注文はありません。', MAIN_MENU)];
    return [text(['これからのご注文', ...upcoming.map((o) => `・${dateLabel(o.delivery_date)} ${o.item_name}(あなた ${yen(o.employee_share)})`)].join('\n'), MAIN_MENU)];
  },

  /** 取り消す注文を選ぶ */
  async cancelpick({ db, user, s }) {
    const cancellable = (await upcomingOrders(db, user, s)).filter((o) => o.open);
    if (!cancellable.length) return [text('取り消せるご注文はありません(締め切りを過ぎた注文は取り消せません)。', MAIN_MENU)];
    return [text('どの日の注文を取り消しますか?', cancellable.map((o) => qr(`${dateLabel(o.delivery_date)} ${o.item_name}`, `a=cancelask&d=${o.delivery_date}`)))];
  },

  /** 取り消してよいか確認 */
  async cancelask({ p }) {
    const date = p.get('d');
    return [text(`${dateLabel(date)} の注文を取り消しますか?`, [qr('はい、取り消す', `a=cancel&d=${date}`), qr('やめる', 'a=list')])];
  },

  async cancel({ db, user, s, p }) {
    const date = p.get('d');
    const r = await cancelOrder(db, user, date, s);
    return [text(r.cancelled ? `↩️ ${dateLabel(date)} の注文を取り消しました。` : `${dateLabel(date)} のご注文はありません。`, MAIN_MENU)];
  },

  /** 今月の利用状況 */
  async month({ db, user, s }) {
    const sum = await employeeSummary(db, user, s);
    const pct = Math.round((sum.used / sum.cap) * 100);
    const mine = sum.orders.reduce((a, o) => a + o.employee_share, 0);
    const lunches = sum.orders.filter((o) => o.kind === 'daruma_lunch').length;
    const lines = [
      `${Number(sum.month.slice(5))}月のご利用(${sum.orders.length}食${lunches ? `、うちだるまランチ ${lunches}回` : ''})`,
      `会社負担:${yen(sum.used)} / 上限 ${yen(sum.cap)}(税抜・${pct}%)`,
      `会社負担の残り:${yen(sum.remaining)}(税抜)`,
      `あなたのお支払い:${yen(mine)}`,
      ...(sum.points.enabled ? [`ポイント:${sum.points.balance}pt(Webの画面で注文するときに使えます)`] : []),
    ];
    if (sum.reached) lines.push('', '⚠️ 上限に達しています。今月の残りは全額ご自身の負担です。');
    else if (sum.warn) lines.push('', `⚠️ 上限の${sum.warn_percent}%を超えています。`);
    return [text(lines.join('\n'), MAIN_MENU)];
  },
};

/** 今日以降の注文(負担額・取り消しできるか つき) */
async function upcomingOrders(db, user, s) {
  const today = todayJST();
  const months = [...new Set([today.slice(0, 7), ...(await employeeSummary(db, user, s)).dates.map((d) => d.date.slice(0, 7))])];
  const out = [];
  for (const m of months) {
    const sum = await employeeSummary(db, user, s, m);
    const open = new Set(sum.dates.filter((d) => d.open).map((d) => d.date));
    for (const o of sum.orders) if (o.kind === 'bento' && o.delivery_date >= today) out.push({ ...o, open: open.has(o.delivery_date) });
  }
  return out.sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
}

// ---------- ルートの登録 ----------

export function registerLineRoutes(app) {
  /** LINEからのWebhook(LINEのサーバーがここに送ってくる) */
  app.post('/api/line/webhook', async (c) => {
    const body = await c.req.text();
    if (!(await verifySignature(body, c.req.header('x-line-signature'), c.env.LINE_CHANNEL_SECRET))) {
      return c.json({ error: 'signature' }, 401);
    }
    const { events = [] } = JSON.parse(body || '{}');
    for (const event of events) {
      try {
        const messages = await handleEvent(c.env, event);
        if (messages.length && event.replyToken) await reply(c.env, event.replyToken, messages);
      } catch (err) {
        console.error('LINE event error', err);
        if (event.replyToken) await reply(c.env, event.replyToken, [text('エラーが起きました。時間をおいてもう一度お試しください。')]);
      }
    }
    return c.json({ ok: true }); // LINEには常に「受け取った」と返す
  });

  /** 社員:連携コードを発行 */
  app.post('/api/employee/line-code', async (c) => c.json(await issueLinkCode(c.env.DB, c.get('user').id)));

  /** 社員:LINE連携を解除 */
  app.delete('/api/employee/line', async (c) => {
    await c.env.DB.prepare('UPDATE users SET line_user_id = NULL WHERE id = ?').bind(c.get('user').id).run();
    return c.json({ ok: true });
  });
}
