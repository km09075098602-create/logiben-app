// 「日ごとの上限」(特定の日だけ作れる数を変える)の画面部品(お店の画面・登録画面で共通)
import { api, esc, toast, dateLabel } from '/common.js';

const nextWeekday = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  do d.setUTCDate(d.getUTCDate() + 1);
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};
const usualLabel = (v) => (v === null || v === undefined ? 'なし' : `${v}食`);

/**
 * el の中に作る。base:'/api/shop/day-limits' または '/api/admin/shops/1/day-limits'
 */
export async function renderDayLimits(el, { base, date = nextWeekday() }) {
  let r;
  try {
    r = await api(`${base}?date=${date}`);
  } catch (e) {
    el.innerHTML = `<p class="sub">${esc(e.message)}</p>`;
    return;
  }
  // これから先の、上限を変えている日(日付ごとにまとめる)
  const byDate = new Map();
  for (const u of r.upcoming) {
    if (!byDate.has(u.date)) byDate.set(u.date, []);
    byDate.get(u.date).push(`${u.menu_item_id ? esc(u.item_name) : 'お店全体'} ${u.daily_limit}食`);
  }
  el.innerHTML = `
    <p class="sub" style="margin-top:0">特定の日だけ、作れる数を変えられます。空欄の項目は「いつもどおり」です。0にすると、その日は作りません(売り切れ)。</p>
    <div class="row" style="align-items:end">
      <div style="flex:0 1 190px"><label>日付</label><input type="date" class="dl-date" value="${r.date}"></div>
      <div class="sub" style="flex:1 1 auto;padding-bottom:10px">${dateLabel(r.date)} の上限</div>
    </div>
    <div class="table-wrap"><table>
      <tr><th></th><th class="num">いつもの上限</th><th class="num">この日の上限</th></tr>
      <tr><td><b>お店全体の合計</b></td><td class="num">${usualLabel(r.shop.usual)}</td>
        <td class="num"><input class="dl-shop" type="number" min="0" value="${r.shop.day ?? ''}" placeholder="いつもどおり" style="width:120px"></td></tr>
      ${r.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${usualLabel(i.usual)}</td>
        <td class="num"><input class="dl-item" data-id="${i.id}" type="number" min="0" value="${i.day ?? ''}" placeholder="いつもどおり" style="width:120px"></td></tr>`).join('')}
    </table></div>
    <p style="margin-bottom:0"><button type="button" class="dl-save">この日の上限を保存</button></p>
    ${byDate.size ? `<div class="sub" style="margin-top:10px">上限を変えている日:
      ${[...byDate].map(([d, list]) => `<a href="#" class="dl-jump" data-date="${d}">${dateLabel(d)}</a>(${list.join('、')})`).join(' / ')}</div>` : ''}`;

  el.querySelector('.dl-date').onchange = (e) => renderDayLimits(el, { base, date: e.target.value });
  el.querySelectorAll('.dl-jump').forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    renderDayLimits(el, { base, date: a.dataset.date });
  }));
  el.querySelector('.dl-save').onclick = async () => {
    const items = {};
    el.querySelectorAll('.dl-item').forEach((i) => (items[i.dataset.id] = i.value));
    try {
      await api(base, { method: 'PUT', body: { date: r.date, shop: el.querySelector('.dl-shop').value, items } });
      toast(`${dateLabel(r.date)} の上限を保存しました`);
      renderDayLimits(el, { base, date: r.date });
    } catch (e) {
      toast(e.message, true);
    }
  };
}
