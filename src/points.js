// =============================================================
// ポイント(社員への還元)のルール
//
// - もらえる:食事をした日(お届け日・だるまランチの日)に、1回 point_per_use ポイント
//   (取り消した注文はもらえない。未来の注文は、その日が来たらもらえる)
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

/** データベースの時刻(UTC "YYYY-MM-DD HH:MM:SS")→ 日本時間の日付 */
export const jstDateOf = (utc) => new Date(new Date(utc.replace(' ', 'T') + 'Z').getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * ポイントの残高を計算する。
 * @param {Array<{delivery_date:string, used_at:string, points_used?:number}>} orders その社員の注文(取り消したものは含まない)
 *   used_at:ポイントを使った時刻(注文を最後に保存した時刻。UTC "YYYY-MM-DD HH:MM:SS")
 * @param {string} today 今日(日本時間)
 * @returns {{balance:number, earned_total:number, used_total:number, expired_total:number, next_expiry:{date:string, amount:number}|null}}
 */
export function pointBalance(orders, s, today) {
  if (!s.points_enabled) return { balance: 0, earned_total: 0, used_total: 0, expired_total: 0, next_expiry: null };
  const events = [];
  for (const o of orders) {
    if (o.delivery_date <= today) events.push({ date: o.delivery_date, type: 'earn', amount: s.point_per_use });
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
  return { balance: lots.reduce((a, l) => a + l.amount, 0), earned_total: earned, used_total: used, expired_total: expired, next_expiry: next };
}

/** この注文で使えるポイント(残高・1回の上限・値段のうち一番小さい数) */
export function usablePoints(balance, price, s) {
  if (!s.points_enabled) return 0;
  return Math.max(0, Math.min(balance, s.point_max_per_order, price));
}
