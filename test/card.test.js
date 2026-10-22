import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardUid } from '../lib/card.js';

test('卡号去空格并统一为大写十六进制', () => {
  assert.equal(normalizeCardUid('e2 00 00 17'), 'E2000017');
});

test('拒绝奇数长度、非十六进制和过短卡号', () => {
  assert.equal(normalizeCardUid('ABC'), null);
  assert.equal(normalizeCardUid('CARD-001'), null);
  assert.equal(normalizeCardUid('A1B2'), null);
});
