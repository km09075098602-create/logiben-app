// =============================================================
// 日本の祝日の計算(「国民の祝日に関する法律」のルールどおりに計算)
//   外部のサービスを使わないので、無料で、ネットがなくても動きます。
//   法律が変わって祝日が増えたり移動したりしたときは、ここを直します。
//   ※ 春分の日・秋分の日は計算式で求めています(2099年まで有効)。
//     正式には毎年2月に官報で発表されるので、念のため確認してください。
// =============================================================

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日曜

/** その月の第n月曜日 */
function nthMonday(y, m, n) {
  const first = weekday(y, m, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

function addDay(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** その年の祝日の一覧 Map("YYYY-MM-DD" → 名前) */
export function holidaysOfYear(y) {
  const base = new Map([
    [ymd(y, 1, 1), '元日'],
    [ymd(y, 1, nthMonday(y, 1, 2)), '成人の日'],
    [ymd(y, 2, 11), '建国記念の日'],
    [ymd(y, 2, 23), '天皇誕生日'],
    [ymd(y, 3, Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4))), '春分の日'],
    [ymd(y, 4, 29), '昭和の日'],
    [ymd(y, 5, 3), '憲法記念日'],
    [ymd(y, 5, 4), 'みどりの日'],
    [ymd(y, 5, 5), 'こどもの日'],
    [ymd(y, 7, nthMonday(y, 7, 3)), '海の日'],
    [ymd(y, 8, 11), '山の日'],
    [ymd(y, 9, nthMonday(y, 9, 3)), '敬老の日'],
    [ymd(y, 9, Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4))), '秋分の日'],
    [ymd(y, 10, nthMonday(y, 10, 2)), 'スポーツの日'],
    [ymd(y, 11, 3), '文化の日'],
    [ymd(y, 11, 23), '勤労感謝の日'],
  ]);
  const result = new Map(base);

  // 国民の休日:祝日にはさまれた平日(例:2026年9月22日)
  for (const date of base.keys()) {
    const mid = addDay(date, 1);
    if (!base.has(mid) && base.has(addDay(date, 2)) && new Date(mid + 'T00:00:00Z').getUTCDay() !== 0) {
      result.set(mid, '国民の休日');
    }
  }
  // 振替休日:祝日が日曜なら、その後の最初の「祝日でない日」が休み
  for (const date of [...base.keys()].sort()) {
    if (new Date(date + 'T00:00:00Z').getUTCDay() !== 0) continue;
    let next = addDay(date, 1);
    while (result.has(next)) next = addDay(next, 1);
    result.set(next, '振替休日');
  }
  return new Map([...result].sort());
}

const cache = new Map();
/** 祝日なら名前を、そうでなければ null を返す */
export function holidayName(date) {
  const y = Number(date.slice(0, 4));
  if (!cache.has(y)) cache.set(y, holidaysOfYear(y));
  return cache.get(y).get(date) || null;
}

/** 期間内の祝日の一覧 [{date, name}] */
export function holidaysBetween(from, to) {
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const [date, name] of holidaysOfYear(y)) if (date >= from && date <= to) out.push({ date, name });
  }
  return out;
}
