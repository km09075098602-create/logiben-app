// =============================================================
// ロジ弁の「お金と締め切りのルール」をすべてここにまとめています。
// ルールを変えたいときは、基本的にこのファイルだけを直します。
// (数値そのもの=上限額や締め切り時刻は、管理画面の「設定」で変えられます)
// =============================================================

// 設定の初期値(データベースに設定がないときに使う)
export const DEFAULT_SETTINGS = {
  deadline_days_before: 0, // 0=当日締め / 1=前日締め
  deadline_time: '09:30', // 締め切り時刻(日本時間)
  company_cap_excl: 7500, // 会社負担の上限(1人あたり月額・税抜き)
  tax_rate_percent: 8, // お弁当の消費税率(軽減税率)
  warn_percent: 80, // 上限の何%で社員に知らせるか
  company_share_percent: 50, // 会社が負担する割合
  service_fee: 150, // サービス利用料(1食あたり・会社へ請求)
  agency_fee_percent: 10, // 営業代行料(お店への支払いから差し引く)
  order_days_ahead: 14, // 何日先まで注文できるか
};

/** 会社負担の上限を「税込み」に直した額(例:7,500円 × 1.08 = 8,100円) */
export function capInclTax(s) {
  return Math.floor((s.company_cap_excl * (100 + s.tax_rate_percent)) / 100);
}

/**
 * 1か月分の注文について、会社負担と社員負担を計算する。
 * - 値段はお店が登録した税込み価格。
 * - 1食ごとに会社が半額(1円未満は切り捨て=端数は社員負担)。
 * - 会社負担の合計が上限に達したら、それ以降は社員が全額負担。
 *   上限をまたぐ注文は「会社は残り分だけ、残りは社員」。
 * - 注文は お届け日 → 注文番号 の順に上限を消費する。
 *
 * @param {Array<{id:number, delivery_date:string, price:number}>} orders
 */
export function allocateMonth(orders, s) {
  const cap = capInclTax(s);
  const sorted = [...orders].sort(
    (a, b) => a.delivery_date.localeCompare(b.delivery_date) || a.id - b.id
  );
  let used = 0;
  const rows = sorted.map((o) => {
    const share = Math.floor((o.price * s.company_share_percent) / 100);
    const company = Math.max(0, Math.min(share, cap - used));
    used += company;
    return { ...o, company_share: company, employee_share: o.price - company };
  });
  return {
    orders: rows,
    cap,
    used,
    remaining: cap - used,
    warn: used >= (cap * s.warn_percent) / 100 && used < cap,
    reached: used >= cap,
  };
}

/** 「その日に、この値段のお弁当を頼んだら自分はいくら払うか」の見込み */
export function previewShare(monthOrders, date, price, s) {
  const others = monthOrders.filter((o) => o.delivery_date !== date);
  const candidate = { id: Number.MAX_SAFE_INTEGER, delivery_date: date, price };
  const r = allocateMonth([...others, candidate], s);
  return r.orders.find((o) => o.id === candidate.id);
}

// ---------- 日付・締め切り(すべて日本時間で考える) ----------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の今日の日付 "YYYY-MM-DD" */
export function todayJST(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" に日数を足す */
export function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 土日なら true(祝日対応は今後) */
export function isWeekend(date) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

/** その日の注文締め切り時刻 */
export function deadlineFor(date, s) {
  const [hh, mm] = s.deadline_time.split(':').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - s.deadline_days_before, hh, mm) - JST_OFFSET_MS);
}

/** 今、その日の注文(変更・取り消し)ができるか */
export function isOrderOpen(date, s, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isWeekend(date)) return false;
  if (date > addDays(todayJST(now), s.order_days_ahead)) return false;
  return now < deadlineFor(date, s);
}

/** 注文できる日の一覧(社員の画面の日付タブ用) */
export function orderableDates(s, now = new Date()) {
  const out = [];
  const today = todayJST(now);
  for (let i = 0; i <= s.order_days_ahead; i++) {
    const d = addDays(today, i);
    if (!isWeekend(d)) out.push({ date: d, open: isOrderOpen(d, s, now) });
  }
  return out;
}
