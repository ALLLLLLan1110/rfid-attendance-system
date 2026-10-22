import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { normalizeCardUid } from '../lib/card.js';

export class StaffError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const revision = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const tableTitles = { students: '学生资料', attendance_records: '考勤记录', members: '旧版会员', cards: '旧版会员卡', sessions: '旧版上机记录', transactions: '旧版账务流水', staff_change_log: '内部工具修改记录' };

function identifier(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new StaffError('记录编号不正确');
  return result;
}

function isoTime(value, optional = false) {
  if (!value && optional) return null;
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match || +match[4] > 23 || +match[5] > 59 || +match[6] > 59) throw new StaffError('请选择有效的日期和时间');
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) throw new StaffError('日期不存在，请重新选择');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StaffError('请选择有效的日期和时间');
  return parsed.toISOString();
}

export class StaffStore {
  constructor(databasePath, backupDirectory) {
    this.databasePath = resolve(databasePath);
    this.backupDirectory = resolve(backupDirectory);
    if (!existsSync(this.databasePath)) throw new StaffError('找不到数据库，请确认工具位于完整项目中。', 503);
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    for (const name of ['students', 'attendance_records']) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
        this.db.close();
        throw new StaffError('数据库缺少学生或考勤表，请先正常启动一次考勤系统。', 503);
      }
    }
  }

  close() { this.db.close(); }

  info() {
    return {
      application: 'rfid-staff-tool', databasePath: this.databasePath, backupDirectory: this.backupDirectory,
      stats: {
        students: this.db.prepare('SELECT COUNT(*) n FROM students').get().n,
        active: this.db.prepare("SELECT COUNT(*) n FROM students WHERE status='active'").get().n,
        records: this.db.prepare('SELECT COUNT(*) n FROM attendance_records').get().n,
        present: this.db.prepare('SELECT COUNT(*) n FROM attendance_records WHERE check_out_at IS NULL').get().n,
      },
    };
  }

  pagination(params) {
    const page = Math.min(1000000, Math.max(1, Number.parseInt(params.page, 10) || 1));
    return { page, pageSize: 25, offset: (page - 1) * 25 };
  }

  student(id) {
    const row = this.db.prepare('SELECT * FROM students WHERE id=?').get(identifier(id));
    if (!row) throw new StaffError('这名学生已不存在，请刷新列表', 404);
    return { ...row, revision: revision(row) };
  }

  students(params = {}) {
    const { page, pageSize, offset } = this.pagination(params);
    const q = `%${String(params.q || '').trim().slice(0, 100)}%`;
    const filter = '(s.name LIKE ? OR s.student_no LIKE ? OR s.class_name LIKE ? OR s.card_uid LIKE ?)';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM students s WHERE ${filter}`).get(q, q, q, q).n;
    const items = this.db.prepare(`SELECT s.* FROM students s WHERE ${filter} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(q, q, q, q, pageSize, offset).map(row => ({
      ...row, revision: revision(row),
      record_count: this.db.prepare('SELECT COUNT(*) n FROM attendance_records WHERE student_id=?').get(row.id).n,
      present: this.db.prepare('SELECT COUNT(*) n FROM attendance_records WHERE student_id=? AND check_out_at IS NULL').get(row.id).n > 0,
    }));
    return { items, total, page, pageSize };
  }

  studentOptions() {
    return this.db.prepare('SELECT id, student_no, name, class_name, card_uid, status FROM students ORDER BY student_no').all();
  }

  attendance(id) {
    const row = this.db.prepare('SELECT * FROM attendance_records WHERE id=?').get(identifier(id));
    if (!row) throw new StaffError('这条考勤记录已不存在，请刷新列表', 404);
    const student = this.student(row.student_id);
    return { ...row, revision: revision(row), name: student.name, student_no: student.student_no, class_name: student.class_name };
  }

  attendanceList(params = {}) {
    const { page, pageSize, offset } = this.pagination(params);
    const q = `%${String(params.q || '').trim().slice(0, 100)}%`;
    let where = '(s.name LIKE ? OR s.student_no LIKE ? OR s.class_name LIKE ? OR a.card_uid LIKE ?)';
    const args = [q, q, q, q];
    if (params.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) throw new StaffError('日期格式不正确');
      where += " AND date(a.check_in_at, 'localtime')=?";
      args.push(params.date);
    }
    if (params.present === 'true') where += ' AND a.check_out_at IS NULL';
    const from = 'attendance_records a JOIN students s ON s.id=a.student_id';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM ${from} WHERE ${where}`).get(...args).n;
    const items = this.db.prepare(`SELECT a.* FROM ${from} WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset).map(row => {
      const student = this.student(row.student_id);
      return { ...row, revision: revision(row), name: student.name, student_no: student.student_no, class_name: student.class_name };
    });
    return { items, total, page, pageSize };
  }

  backup(kind = 'manual') {
    mkdirSync(this.backupDirectory, { recursive: true });
    const file = `${kind === 'before' ? 'before' : 'manual'}-${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${randomUUID()}.sqlite`;
    const destination = join(this.backupDirectory, file);
    // VACUUM INTO copies a consistent SQLite snapshot, including committed WAL data.
    // Copying just cybercard.db while the attendance app is running would omit WAL data.
    this.db.prepare('VACUUM INTO ?').run(destination);
    return { file, createdAt: new Date().toISOString(), bytes: statSync(destination).size };
  }

  backups() {
    if (!existsSync(this.backupDirectory)) return [];
    return readdirSync(this.backupDirectory).filter(file => /^(before|manual)-[0-9TZ]+-[0-9a-f-]+\.sqlite$/.test(file)).map(file => {
      const stat = statSync(join(this.backupDirectory, file));
      return { file, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
  }

  backupPath(file) {
    if (!this.backups().some(item => item.file === file)) throw new StaffError('备份文件不存在', 404);
    return join(this.backupDirectory, file);
  }

  mutate(table, id, expectedRevision, reason, change) {
    if (id && (typeof expectedRevision !== 'string' || expectedRevision.length !== 64)) throw new StaffError('缺少版本信息，请刷新列表后重新编辑', 409);
    const backup = this.backup('before');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = id ? this.db.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(identifier(id)) : null;
      if (id && (!before || revision(before) !== expectedRevision)) throw new StaffError('数据刚刚被考勤系统或其他窗口修改了。请重新打开这条数据再编辑。', 409);
      const after = change(before);
      this.db.exec(`CREATE TABLE IF NOT EXISTS staff_change_log (
        id INTEGER PRIMARY KEY, changed_at TEXT NOT NULL, table_name TEXT NOT NULL,
        row_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
        backup_file TEXT NOT NULL, before_json TEXT, after_json TEXT
      )`);
      const action = !before ? 'create' : !after ? 'delete' : 'update';
      this.db.prepare('INSERT INTO staff_change_log(changed_at,table_name,row_id,action,reason,backup_file,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)').run(
        new Date().toISOString(), table, after?.id ?? before.id, action, String(reason || '').trim().slice(0, 300), backup.file,
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      );
      this.db.exec('COMMIT');
      return { item: after, backup };
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof StaffError) throw error;
      if (error.message.includes('students.student_no')) throw new StaffError('这个学号已存在，请使用其他学号', 409);
      if (error.message.includes('students.card_uid')) throw new StaffError('这张卡已绑定其他学生，请先核对卡号', 409);
      if (error.message.includes('attendance_records.student_id')) throw new StaffError('该学生已经有一条未签退记录，请先处理原记录', 409);
      throw error;
    }
  }

  saveStudent(id, input) {
    const studentNo = String(input.student_no || '').trim();
    const name = String(input.name || '').trim();
    const className = String(input.class_name || '').trim();
    const uid = normalizeCardUid(input.card_uid);
    const status = input.status || 'active';
    if (!/^[0-9A-Za-z_-]{2,32}$/.test(studentNo)) throw new StaffError('学号需为 2—32 位字母、数字、下划线或短横线');
    if (!name || name.length > 40) throw new StaffError('姓名必填，且不能超过 40 个字');
    if (!className || className.length > 60) throw new StaffError('班级必填，且不能超过 60 个字');
    if (!uid) throw new StaffError('卡号应为 8—64 位偶数长度的十六进制字符，可输入空格');
    if (!['active', 'disabled'].includes(status)) throw new StaffError('学生状态不正确');
    return this.mutate('students', id, input.revision, input.reason, before => {
      if (before && status === 'disabled' && this.db.prepare('SELECT 1 FROM attendance_records WHERE student_id=? AND check_out_at IS NULL').get(before.id)) throw new StaffError('该学生仍有未签退记录，请先补充签退时间再停用');
      if (before) {
        this.db.prepare('UPDATE students SET student_no=?,name=?,class_name=?,card_uid=?,status=? WHERE id=?').run(studentNo, name, className, uid, status, before.id);
        return this.db.prepare('SELECT * FROM students WHERE id=?').get(before.id);
      }
      return this.db.prepare('INSERT INTO students(student_no,name,class_name,card_uid,status,created_at) VALUES(?,?,?,?,?,?) RETURNING *').get(studentNo, name, className, uid, status, new Date().toISOString());
    });
  }

  validateTimeline(studentId, id, checkIn, checkOut) {
    const start = Date.parse(checkIn);
    const end = checkOut ? Date.parse(checkOut) : Infinity;
    if (end < start) throw new StaffError('签退时间不能早于签到时间');
    const previous = this.db.prepare('SELECT * FROM attendance_records WHERE student_id=? AND id<? ORDER BY id DESC LIMIT 1').get(studentId, id);
    const next = this.db.prepare('SELECT * FROM attendance_records WHERE student_id=? AND id>? ORDER BY id LIMIT 1').get(studentId, id);
    if (previous && (!previous.check_out_at || start <= Date.parse(previous.check_in_at) || start < Date.parse(previous.check_out_at))) throw new StaffError(`与上一条记录 #${previous.id} 冲突。请先签退上一条记录，并保持时间顺序。`);
    if (next && (end > Date.parse(next.check_in_at) || start >= Date.parse(next.check_in_at))) throw new StaffError(`与下一条记录 #${next.id} 冲突。旧记录不能晚于新记录，未签退记录只能是最后一条。`);
    const otherOpen = this.db.prepare('SELECT id FROM attendance_records WHERE student_id=? AND check_out_at IS NULL AND id<>?').get(studentId, id);
    if (!checkOut && otherOpen) throw new StaffError(`该学生还有未签退记录 #${otherOpen.id}，请先处理原记录`);
  }

  saveAttendance(id, input) {
    const checkIn = isoTime(input.check_in_at);
    const checkOut = isoTime(input.check_out_at, true);
    return this.mutate('attendance_records', id, input.revision, input.reason, before => {
      const studentId = before?.student_id ?? identifier(input.student_id);
      if (before && input.student_id !== undefined && identifier(input.student_id) !== before.student_id) throw new StaffError('已有记录不能更换所属学生，请核对记录编号');
      const student = this.student(studentId);
      if (!checkOut && student.status !== 'active') throw new StaffError('停用学生不能新增未签退记录；请填写签退时间或先启用学生');
      const recordId = before?.id ?? (this.db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM attendance_records').get().n);
      this.validateTimeline(studentId, recordId, checkIn, checkOut);
      const duration = checkOut ? Math.max(1, Math.ceil((Date.parse(checkOut) - Date.parse(checkIn)) / 60000)) : null;
      if (before) {
        this.db.prepare('UPDATE attendance_records SET check_in_at=?,check_out_at=?,duration_minutes=? WHERE id=?').run(checkIn, checkOut, duration, before.id);
        return this.db.prepare('SELECT * FROM attendance_records WHERE id=?').get(before.id);
      }
      return this.db.prepare('INSERT INTO attendance_records(student_id,card_uid,check_in_at,check_out_at,duration_minutes) VALUES(?,?,?,?,?) RETURNING *').get(studentId, student.card_uid, checkIn, checkOut, duration);
    });
  }

  deleteAttendance(id, input) {
    if (String(input.confirmation) !== String(identifier(id))) throw new StaffError('请输入正确的记录编号，确认删除');
    if (!String(input.reason || '').trim()) throw new StaffError('请填写删除原因');
    return this.mutate('attendance_records', id, input.revision, input.reason, before => {
      this.db.prepare('DELETE FROM attendance_records WHERE id=?').run(before.id);
      return null;
    });
  }

  changes(params = {}) {
    const { page, pageSize, offset } = this.pagination(params);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_change_log' AND type='table'").get()) return { items: [], total: 0, page, pageSize };
    return {
      items: this.db.prepare('SELECT id,changed_at,table_name,row_id,action,reason,backup_file FROM staff_change_log ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset),
      total: this.db.prepare('SELECT COUNT(*) n FROM staff_change_log').get().n, page, pageSize,
    };
  }

  change(id) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_change_log' AND type='table'").get()) throw new StaffError('修改记录不存在', 404);
    const row = this.db.prepare('SELECT * FROM staff_change_log WHERE id=?').get(identifier(id));
    if (!row) throw new StaffError('修改记录不存在', 404);
    return row;
  }

  tables() {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({
      name, title: tableTitles[name] || name, count: this.db.prepare(`SELECT COUNT(*) n FROM ${quote(name)}`).get().n,
      columns: this.db.prepare(`PRAGMA table_info(${quote(name)})`).all(),
    }));
  }

  browse(name, params = {}) {
    if (!this.tables().some(table => table.name === name)) throw new StaffError('数据表不存在', 404);
    const { page, pageSize, offset } = this.pagination(params);
    return { items: this.db.prepare(`SELECT * FROM ${quote(name)} LIMIT ? OFFSET ?`).all(pageSize, offset), total: this.db.prepare(`SELECT COUNT(*) n FROM ${quote(name)}`).get().n, page, pageSize };
  }
}
