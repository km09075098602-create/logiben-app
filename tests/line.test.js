// LINE連携の部品のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, dateLabel } from '../src/line.js';

test('LINEからの署名を確かめる(本物だけ通す)', async () => {
  const body = '{"events":[]}';
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(await verifySignature(body, sig, 'secret'), true);
  assert.equal(await verifySignature(body, sig, 'other-secret'), false);
  assert.equal(await verifySignature(body + ' ', sig, 'secret'), false);
  assert.equal(await verifySignature(body, undefined, 'secret'), false);
  assert.equal(await verifySignature(body, sig, undefined), false);
});

test('日付の表示', () => {
  assert.equal(dateLabel('2027-01-04'), '1/4(月)');
});
