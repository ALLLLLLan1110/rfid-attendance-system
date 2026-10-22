import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rfid-staff-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const backupDirectory = join(directory, 'backups');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE students(id INTEGER PRIMARY KEY,student_no TEXT NOT NULL UNIQUE,name TEXT NOT NULL,class_name TEXT NOT NULL,card_uid TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created_at TEXT NOT NULL);
    CREATE TABLE attendance_records(id INTEGER PRIMARY KEY,student_id INTEGER NOT NULL REFERENCES students(id),card_uid TEXT NOT NULL,check_in_at TEXT NOT NULL,check_out_at TEXT,duration_minutes INTEGER);
    CREATE UNIQUE INDEX idx_one_open_attendance_per_student ON attendance_records(student_id) WHERE check_out_at IS NULL;
    CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT NOT NULL,balance_cents INTEGER NOT NULL DEFAULT 0);
    INSERT INTO students VALUES(1,'S001','测试甲','测试一班','E2000001','active','2026-10-01T00:00:00.000Z'),(2,'S002','测试乙','测试二班','E2000002','active','2026-10-01T00:00:00.000Z');
    INSERT INTO attendance_records VALUES(1,1,'E2000001','2026-10-01T08:00:00.000Z','2026-10-01T09:00:00.000Z',60),(2,1,'E2000001','2026-10-01T10:00:00.000Z','2026-10-01T11:00:00.000Z',60),(3,2,'E2000002','2026-10-01T12:00:00.000Z',NULL,NULL);
    INSERT INTO members VALUES(1,'旧版测试会员',1000);
  `);
  db.close();
  return { directory, databasePath, backupDirectory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
