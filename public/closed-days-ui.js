// 休業日の一覧・追加・削除の部品(管理者の画面・登録画面・お店の画面で共通)
import { api, esc, toast, dateLabel } from '/common.js';

/**
 * el の中に休業日の画面を作る。
 * base:APIの場所('/api/admin/closed-days' または '/api/shop/closed-days')
 * shopId:管理者がお店の休業日を扱うときのお店ID(全体の休業日なら null)
 * showHolidays:祝日の一覧も出すか
 */
export async function renderClosedDays(el, { base, shopId = null, showHolidays = false }) {
  const q = shopId ? `?shop_id=${shopId}` : '';
  const r = await api(base + q);
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  el.innerHTML = `
    <p class="sub" style="margin-top:0">土日・祝日は自動でお休みになります(登録は不要です)。それ以外にお休みにする日を登録してください。</p>
    <div class="table-wrap"><table>
      <tr><th>休業日</th><th>メモ</th><th></th></tr>
      ${r.closed.map((d) => `<tr data-id="${d.id}"><td>${dateLabel(d.date)}</td><td>${esc(d.note || '')}</td>
        <td class="num"><button type="button" class="secondary small" data-del="${d.id}">取り消す</button></td></tr>`).join('') ||
        '<tr><td colspan="3" class="sub">登録されている休業日はありません</td></tr>'}
    </table></div>
    <form class="row cd-add" style="margin-top:8px">
      <div style="flex:0 1 170px"><input type="date" name="date" min="${today}" required></div>
      <div><input name="note" placeholder="メモ(例:年末年始、店休日)" maxlength="30"></div>
      <div style="flex:0 0 auto"><button type="submit">休業日を追加</button></div>
    </form>
    ${r.service_closed?.length ? `<p class="sub">全体の休業日(達磨商事が設定):${r.service_closed.map((d) => `${dateLabel(d.date)} ${esc(d.note || '')}`).join('、')}</p>` : ''}
    ${showHolidays ? `<details style="margin-top:8px"><summary class="sub">今後1年の祝日(自動でお休み)</summary>
      <p class="sub">${r.holidays.map((h) => `${dateLabel(h.date)} ${esc(h.name)}`).join('、')}</p></details>` : ''}`;

  el.querySelector('.cd-add').onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(e.target)), shop_id: shopId };
    try {
      let res = await api(base, { method: 'POST', body });
      if (res.needs_confirm) {
        // その日にすでに注文が入っている
        if (!confirm(`${dateLabel(body.date)} にはすでに ${res.count}件 の注文が入っています。\n休業日にすると、これらの注文は取り消されます。よろしいですか?\n(LINE連携している社員にはLINEでお知らせします。それ以外の方には別途お知らせください)`)) return;
        res = await api(base, { method: 'POST', body: { ...body, force: true } });
      }
      toast(
        res.cancelled
          ? `休業日を追加しました(注文 ${res.cancelled}件を取り消し、うち ${res.notified}人にLINEでお知らせしました)`
          : '休業日を追加しました'
      );
      renderClosedDays(el, { base, shopId, showHolidays });
    } catch (err) {
      toast(err.message, true);
    }
  };
  el.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('この休業日を取り消して、注文を受け付けるようにしますか?')) return;
      try {
        await api(`${base}/${b.dataset.del}`, { method: 'DELETE' });
        toast('休業日を取り消しました');
        renderClosedDays(el, { base, shopId, showHolidays });
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
}
