import { holidayName } from './holidays.js';

// =============================================================
// ポイント(社員への還元)のルール
//
// - もらえる:1回の利用につき point_per_use ポイント。
//   その月の利用分を、point_grant_delay_months か月後の「給料日の翌日」にまとめてもらえる
//   (初期値 1:11月の利用分 → 12月の給料日の翌日。給料から社員負担分を差し引いたあと)
//   給料日は会社ごとに登録(初期値25日)。給料日が土日祝なら、その前の平日を給料日とみなす
//   取り消した注文はもらえない。まだ食事をしていない注文は数えない
// - 使える :注文のときに選ぶ。1回 point_max_per_order ポイントまで、値段まで
// - 使ったポイントは「先にお弁当代から引いて、残りを会社と社員で半分ずつ」(B方式)。
//   お店への支払いは変わらない(ポイント分は達磨商事がお店に払う)
// - 有効期限:もらった日から point_expiry_months か月。古いポイントから先に使う
//
// 残高は、注文の記録から毎回計算する(別の帳簿を持たないので、取り消しなどでずれない)。
// =============================================================

/** "YYYY-MM-DD" に月数を足す(月末は調整:1/31 + 1か月 → 2/28) */
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const shiftDay = (date, days) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const isDayOff = (date) => {
  const w = new Date(date + 'T00:00:00Z').getUTCDay();
  return w === 0 || w === 6 || !!holidayName(date);
};

/** ある月(YYYY-MM)の給料日。土日祝なら前の平日。31日などがない月は月末 */
export function paydayOf(month, payday = 25) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let d = `${month}-${String(Math.min(payday, last)).padStart(2, '0')}`;
  while (isDayOff(d)) d = shiftDay(d, -1);
  return d;
}

/** その利用分のポイントをもらえる日(利用した月の delay か月後の給料日の翌日) */
export function grantDateOf(date, s, payday = 25) {
  const month = addMonths(date.slice(0, 7) + '-01', s.point_grant_delay_months ?? 1).slice(0, 7);
  return shiftDay(paydayOf(month, payday), 1);
}

/** データベースの時刻(UTC "YYYY-MM-DD HH:MM:SS")→ 日本時間の日付 */
export const jstDateOf = (utc) => new Date(new Date(utc.replace(' ', 'T') + 'Z').getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * ポイントの残高を計算する。
 * @param {Array<{delivery_date:string, used_at:string, points_used?:number}>} orders その社員の注文(取り消したものは含まない)
 *   used_at:ポイントを使った時刻(注文を最後に保存した時刻。UTC "YYYY-MM-DD HH:MM:SS")
 * @param {string} today 今日(日本時間)
 * @param {number} payday その社員の会社の給料日(1〜31)
 * @returns 残高・もらった合計・使った合計・期限切れ合計・次に期限が来る分・これからもらえる分(pending)
 */
export function pointBalance(orders, s, today, payday = 25) {
  if (!s.points_enabled) return { balance: 0, earned_total: 0, used_total: 0, expired_total: 0, next_expiry: null, pending: [] };
  const events = [];
  const pending = new Map(); // もらえる日 → ポイント(食事は済んだが、まだもらえる日が来ていない分)
  for (const o of orders) {
    if (o.delivery_date <= today) {
      const grant = grantDateOf(o.delivery_date, s, payday);
      if (grant <= today) events.push({ date: grant, type: 'earn', amount: s.point_per_use });
      else pending.set(grant, (pending.get(grant) || 0) + s.point_per_use);
    }
    if (o.points_used > 0) events.push({ date: jstDateOf(o.used_at), type: 'use', amount: o.points_used });
  }
  // 同じ日なら「もらう」を先に
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'earn' ? -1 : 1));

  let lots = []; // まだ使っていないポイントのかたまり {amount, expires}
  let earned = 0, used = 0, expired = 0;
  const expireUntil = (date) => {
    lots = lots.filter((l) => {
      if (l.expires <= date) {
        expired += l.amount;
        return false;
      }
      return true;
    });
  };
  for (const ev of events) {
    expireUntil(ev.date);
    if (ev.type === 'earn') {
      lots.push({ amount: ev.amount, expires: addMonths(ev.date, s.point_expiry_months) });
      earned += ev.amount;
    } else {
      let need = ev.amount;
      used += ev.amount;
      for (const l of lots) {
        const take = Math.min(l.amount, need);
        l.amount -= take;
        need -= take;
        if (!need) break;
      }
      lots = lots.filter((l) => l.amount > 0);
    }
  }
  expireUntil(today);
  const next = lots[0] ? { date: lots[0].expires, amount: lots.filter((l) => l.expires === lots[0].expires).reduce((a, l) => a + l.amount, 0) } : null;
  return {
    balance: lots.reduce((a, l) => a + l.amount, 0),
    earned_total: earned,
    used_total: used,
    expired_total: expired,
    next_expiry: next,
    pending: [...pending].sort().map(([date, amount]) => ({ date, amount })), // これからもらえる分
  };
}

/** この注文で使えるポイント(残高・1回の上限・値段のうち一番小さい数) */
export function usablePoints(balance, price, s) {
  if (!s.points_enabled) return 0;
  return Math.max(0, Math.min(balance, s.point_max_per_order, price));
}
