// パスワードを安全な形(ハッシュ)にして保存・照合する
// 形式: pbkdf2$回数$ソルト(base64)$ハッシュ(base64)
// scripts/make-seed.mjs も同じ形式で作っています。

const ITERATIONS = 100000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = b64(await derive(password, unb64(salt), Number(iter)));
  // 長さが同じ文字列を1文字ずつ比べる(時間差で推測されにくくする)
  if (bits.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
