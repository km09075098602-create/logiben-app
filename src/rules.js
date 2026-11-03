import { holidayName } from './holidays.js';

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
  eatin_tax_rate_percent: 10, // だるまランチ(お店で食べる)の消費税率
  warn_percent: 80, // 上限の何%で社員に知らせるか
  company_share_percent: 50, // 会社が負担する割合
  service_fee: 150, // サービス利用料(1食あたり・会社へ請求)
  agency_fee_percent: 10, // 営業代行料(お店への支払いから差し引く)
  order_days_ahead: 14, // 何日先まで注文できるか
  shop_period_anchor: '2027-01-04', // お店への支払いの「2週間の区切り」の起点日(この日から14日ずつ)
  points_enabled: 1, // ポイント還元を使う(1)/ 使わない(0)
  point_per_use: 20, // 1回の利用でもらえるポイント
  point_grant_delay_months: 1, // その月の利用分のポイントを、何か月後の給料日の翌日にもらえるか(1=翌月。給料日は会社ごと)
  point_expiry_months: 12, // ポイントの有効期限(もらってから何か月)
  point_max_per_order: 50, // 1回の注文で使えるポイントの上限
};

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a * b) / gcd(a, b);

/**
 * 1か月分の利用(お弁当・だるまランチ)について、会社負担と社員負担を計算する。
 * - 値段はお店が登録した税込み価格。
 * - 1食ごとに会社が半額(1円未満は切り捨て=端数は社員負担)。
 * - 会社負担の上限は「税抜き」で数える(お弁当は8%、だるまランチ=店内飲食は10%と税率が違うため)。
 *   上限に達したら、それ以降は社員が全額負担。上限をまたぐ食事は「会社は残り分だけ、残りは社員」。
 * - 日付 → 番号 の順に上限を使っていく。
 *
 * - ポイントを使った注文(points_used)は、値段からポイント分を引いてから半分ずつにする。
 * @param {Array<{id:number, delivery_date:string, price:number, tax_rate?:number, points_used?:number}>} orders
 *   tax_rate がない注文はお弁当の税率(s.tax_rate_percent)として扱う
 * @returns cap / used / remaining は「税抜き」の円。各注文の company_share / employee_share は実際に払う税込みの円
 */
export function allocateMonth(orders, s) {
  const rateOf = (o) => o.tax_rate ?? s.tax_rate_percent;
  // 端数が出ないよう、税抜き額を整数 L 倍して数える(L は 108 や 110 の最小公倍数)
  const L = orders.reduce((acc, o) => lcm(acc, 100 + rateOf(o)), 100 + s.tax_rate_percent);
  const capScaled = s.company_cap_excl * L;
  const sorted = [...orders].sort((a, b) => a.delivery_date.localeCompare(b.delivery_date) || a.id - b.id);
  let usedScaled = 0;
  let companyTotal = 0;
  const rows = sorted.map((o) => {
    const rate = rateOf(o);
    const perYen = (100 * L) / (100 + rate); // 税込み1円が、税抜きで何単位か
    // ポイントを使った注文は、先にポイント分を引いた額を半分ずつにする(ポイント分は達磨商事が負担)
    const base = o.price - (o.points_used || 0);
    const share = Math.floor((base * s.company_share_percent) / 100);
    const room = Math.floor((capScaled - usedScaled) / perYen); // 上限の残りで出せる税込み額
    const company = Math.max(0, Math.min(share, room));
    usedScaled += company * perYen;
    companyTotal += company;
    return { ...o, company_share: company, employee_share: base - company };
  });
  const used = Math.floor(usedScaled / L);
  const reached = capScaled - usedScaled < L; // 残りが税抜き1円未満
  return {
    orders: rows,
    cap: s.company_cap_excl, // 上限(税抜き)
    used, // 使った額(税抜き)
    remaining: Math.max(0, s.company_cap_excl - used), // 残り(税抜き)
    company_total: companyTotal, // 会社負担の合計(税込み・実際の金額)
    warn: !reached && usedScaled * 100 >= capScaled * s.warn_percent,
    reached,
  };
}

/** 「その日に、この値段の食事をしたら自分はいくら払うか」の見込み */
export function previewShare(monthOrders, date, price, s, taxRate = s.tax_rate_percent) {
  const others = monthOrders.filter((o) => o.delivery_date !== date);
  const candidate = { id: Number.MAX_SAFE_INTEGER, delivery_date: date, price, tax_rate: taxRate };
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

/** 土日なら true */
export function isWeekend(date) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

/**
 * お休みの日なら、その理由(「日曜日」「文化の日」「年末年始」など)を返す。営業日なら null。
 * お休み = 土日・祝日・管理者が決めた全体の休業日(s.closed_days:Map 日付→メモ)
 * ※ お店ごとの休業日は別(そのお店のお弁当だけが選べなくなる)
 */
export function closedReason(date, s) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (day === 0) return '日曜日';
  if (day === 6) return '土曜日';
  const holiday = holidayName(date);
  if (holiday) return holiday;
  if (s.closed_days?.has(date)) return s.closed_days.get(date) || '休業日';
  return null;
}

/** その日の注文締め切り時刻 */
export function deadlineFor(date, s) {
  const [hh, mm] = s.deadline_time.split(':').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - s.deadline_days_before, hh, mm) - JST_OFFSET_MS);
}

/** 今、その日の注文(変更・取り消し)ができるか */
export function isOrderOpen(date, s, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || closedReason(date, s)) return false;
  if (date > addDays(todayJST(now), s.order_days_ahead)) return false;
  return now < deadlineFor(date, s);
}

/** 注文できる日の一覧(社員の画面の日付タブ用) */
export function orderableDates(s, now = new Date()) {
  const out = [];
  const today = todayJST(now);
  for (let i = 0; i <= s.order_days_ahead; i++) {
    const d = addDays(today, i);
    if (!closedReason(d, s)) out.push({ date: d, open: isOrderOpen(d, s, now) });
  }
  return out;
}
