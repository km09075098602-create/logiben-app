// 画面共通の部品
export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/login')) {
    location.href = '/';
    throw new Error('ログインしてください');
  }
  if (!res.ok) throw new Error(data.error || '通信に失敗しました');
  return data;
}

export const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** "2026-11-04" → "11/4(水)" */
export function dateLabel(d) {
  const dt = new Date(d + 'T00:00:00Z');
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEK[dt.getUTCDay()]})`;
}

/** 締め切り(ISO文字列) → "11/4(水) 9:30" (日本時間) */
export function deadlineLabel(iso) {
  const jst = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const d = jst.toISOString().slice(0, 10);
  return `${dateLabel(d)} ${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/** 文字を安全に HTML に入れる */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3000);
}
