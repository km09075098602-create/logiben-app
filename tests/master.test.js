// 登録まわりの部品のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword } from '../src/master.js';
import { hashPassword, verifyPassword } from '../src/password.js';

test('初期パスワードは8文字で、紛らわしい文字を使わない', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword();
    assert.equal(pw.length, 8);
    assert.doesNotMatch(pw, /[0O1lI]/);
  }
});

test('パスワードの保存と照合', async () => {
  const stored = await hashPassword('abc12345');
  assert.equal(await verifyPassword('abc12345', stored), true);
  assert.equal(await verifyPassword('abc12346', stored), false);
});
