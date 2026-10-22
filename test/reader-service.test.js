import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeLine } from '../lib/reader-service.js';

test('解析读卡桥接程序事件', () => {
  assert.deepEqual(parseBridgeLine('{"type":"card","uid":"E2000017221101441890ABCD"}'), {
    type: 'card',
    uid: 'E2000017221101441890ABCD',
  });
});

test('忽略非 JSON 桥接输出', () => {
  assert.equal(parseBridgeLine('串口日志'), null);
});
