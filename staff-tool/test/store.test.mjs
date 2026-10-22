import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StaffStore } from '../store.mjs';
import { fixture } from './fixture.mjs';

function setup(t) {
  const files = fixture();
  const store = new StaffStore(files.databasePath, files.backupDirectory);
  t.after(() => { store.close(); files.cleanup(); });
  return { store, ...files };
}

test('opening and browsing do not modify schema or create audit records', t => {
  const { store } = setup(t);
  assert.deepEqual(store.info().stats, { students: 2, active: 2, records: 3, present: 1 });
  assert.equal(store.changes().total, 0);
  assert.equal(store.students({ q: '测试一班' }).total, 1);
  assert.equal(store.browse('members').items[0].balance_cents, 1000);
  assert.equal(store.tables().length, 3);
  assert.throws(() => store.browse('students; DROP TABLE students;'), /不存在/);
  assert.equal(store.backups().length, 0);
});

test('student edit normalizes card, preserves historical snapshots, and backs up WAL data', t => {
  const { store } = setup(t);
  const before = store.student(1);
  store.db.prepare('INSERT INTO members(name,balance_cents) VALUES(?,?)').run('WAL测试', 2000);
  const saved = store.saveStudent(1, { ...before, card_uid: 'e2 00 00 ff', name: '已更正', reason: '更换卡片' });
  assert.equal(store.student(1).card_uid, 'E20000FF');
  assert.equal(store.attendance(1).card_uid, 'E2000001');
  const backup = new DatabaseSync(store.backupPath(saved.backup.file), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT card_uid FROM students WHERE id=1').get().card_uid, 'E2000001');
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM members').get().n, 2);
  } finally { backup.close(); }
  const log = store.change(store.changes().items[0].id);
  assert.equal(log.action, 'update');
  assert.equal(JSON.parse(log.before_json).name, '测试甲');
  assert.equal(JSON.parse(log.after_json).name, '已更正');
  assert.equal(log.backup_file, saved.backup.file);
});

test('duplicate student numbers/cards and invalid cards leave data unchanged', t => {
  const { store } = setup(t);
  const before = store.student(1);
  assert.throws(() => store.saveStudent(1, { ...before, student_no: 'S002' }), /学号已存在/);
  assert.throws(() => store.saveStudent(1, { ...before, card_uid: 'E2000002' }), /绑定其他学生/);
  assert.throws(() => store.saveStudent(1, { ...before, card_uid: 'not-a-card' }), /卡号应为/);
  assert.equal(store.student(1).revision, before.revision);
  assert.equal(store.changes().total, 0);
});

test('stale edits cannot overwrite updates from the running attendance system', t => {
  const { store, databasePath } = setup(t);
  const before = store.student(1);
  const other = new DatabaseSync(databasePath);
  other.prepare('UPDATE students SET class_name=? WHERE id=1').run('新班级');
  other.close();
  assert.throws(() => store.saveStudent(1, { ...before, name: '不能覆盖' }), error => error.status === 409);
  assert.equal(store.student(1).name, '测试甲');
  assert.equal(store.student(1).class_name, '新班级');
});

test('editing checkout recalculates duration and an open record blocks disabling', t => {
  const { store } = setup(t);
  assert.throws(() => store.saveStudent(2, { ...store.student(2), status: 'disabled' }), /未签退记录/);
  const before = store.attendance(3);
  store.saveAttendance(3, { ...before, check_out_at: '2026-10-01T12:01:01.000Z' });
  assert.equal(store.attendance(3).duration_minutes, 2);
  store.saveStudent(2, { ...store.student(2), status: 'disabled' });
  assert.equal(store.student(2).status, 'disabled');
});

test('attendance rejects impossible dates, negative durations, overlap and historical appends', t => {
  const { store } = setup(t);
  const first = store.attendance(1);
  assert.throws(() => store.saveAttendance(1, { ...first, check_in_at: '2026-02-31T08:00:00.000Z' }), /日期不存在/);
  assert.throws(() => store.saveAttendance(1, { ...first, check_out_at: '2026-10-01T07:00:00.000Z' }), /不能早于/);
  assert.throws(() => store.saveAttendance(1, { ...first, check_out_at: '2026-10-01T10:01:00.000Z' }), /下一条/);
  assert.throws(() => store.saveAttendance(1, { ...first, check_out_at: null }), /下一条/);
  assert.throws(() => store.saveAttendance(null, { student_id: 1, check_in_at: '2026-09-01T08:00:00.000Z', check_out_at: '2026-09-01T09:00:00.000Z' }), /上一条/);
  assert.equal(store.attendance(1).revision, first.revision);
  assert.equal(store.info().stats.records, 3);
});

test('new attendance stays latest by id and cannot create a second open record', t => {
  const { store } = setup(t);
  const created = store.saveAttendance(null, { student_id: 1, check_in_at: '2026-10-01T13:00:00.000Z', check_out_at: null });
  assert.equal(created.item.id, 4);
  assert.equal(created.item.card_uid, 'E2000001');
  assert.throws(() => store.saveAttendance(null, { student_id: 1, check_in_at: '2026-10-01T14:00:00.000Z', check_out_at: null }), /上一条/);
  assert.equal(store.info().stats.present, 2);
});

test('record ownership is immutable and stale checkout correction is rejected', t => {
  const { store } = setup(t);
  const before = store.attendance(3);
  assert.throws(() => store.saveAttendance(3, { ...before, student_id: 1 }), /不能更换/);
  store.db.prepare('UPDATE attendance_records SET check_out_at=?, duration_minutes=60 WHERE id=3').run('2026-10-01T13:00:00.000Z');
  assert.throws(() => store.saveAttendance(3, { ...before, check_out_at: '2026-10-01T14:00:00.000Z' }), error => error.status === 409);
  assert.equal(store.attendance(3).duration_minutes, 60);
});

test('confirmed deletion logs the original record and produces a recoverable backup', t => {
  const { store } = setup(t);
  const before = store.attendance(1);
  assert.throws(() => store.deleteAttendance(1, { revision: before.revision, confirmation: '2', reason: '错误记录' }), /正确的记录编号/);
  assert.throws(() => store.deleteAttendance(1, { revision: before.revision, confirmation: '1' }), /填写删除原因/);
  const result = store.deleteAttendance(1, { revision: before.revision, confirmation: '1', reason: '错误记录' });
  assert.equal(store.info().stats.records, 2);
  assert.equal(store.info().stats.students, 2);
  const backup = new DatabaseSync(store.backupPath(result.backup.file), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) n FROM attendance_records WHERE id=1').get().n, 1); }
  finally { backup.close(); }
  assert.equal(store.changes().items[0].action, 'delete');
  assert.equal(JSON.parse(store.change(store.changes().items[0].id).before_json).id, 1);
});
