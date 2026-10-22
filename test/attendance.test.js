import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAttendanceAction, MIN_ACTION_INTERVAL_SECONDS } from '../lib/attendance.js';

const now = new Date('2026-10-08T08:30:00.000Z');

test('没有历史记录时判定为签到', () => {
  assert.deepEqual(decideAttendanceAction(null, now), { action: 'check_in' });
});

test('短时间重复刷卡不产生新记录', () => {
  assert.deepEqual(decideAttendanceAction({ check_in_at: '2026-10-08T08:29:55.000Z', check_out_at: null }, now), {
    action: 'duplicate',
    retryAfterSeconds: MIN_ACTION_INTERVAL_SECONDS - 5,
  });
});

test('存在未签退记录时再次刷卡判定为签退', () => {
  assert.deepEqual(decideAttendanceAction({ check_in_at: '2026-10-08T08:00:00.000Z', check_out_at: null }, now), {
    action: 'check_out',
    durationMinutes: 30,
  });
});

test('最近记录已签退时再次刷卡判定为新签到', () => {
  assert.deepEqual(decideAttendanceAction({ check_in_at: '2026-10-08T07:00:00.000Z', check_out_at: '2026-10-08T07:30:00.000Z' }, now), {
    action: 'check_in',
  });
});
