import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { decideAttendanceAction, MIN_ACTION_INTERVAL_SECONDS } from './lib/attendance.js';
import { normalizeCardUid } from './lib/card.js';
import { ReaderService } from './lib/reader-service.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
const readerExecutable = join(root, 'reader-bridge', 'bin', 'KL9007ReaderBridge.exe');
const reader = new ReaderService({ executable: readerExecutable });

await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'cybercard.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    student_no TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    card_uid TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id),
    card_uid TEXT NOT NULL,
    check_in_at TEXT NOT NULL,
    check_out_at TEXT,
    duration_minutes INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_student_time
    ON attendance_records(student_id, check_in_at DESC);
  CREATE INDEX IF NOT EXISTS idx_attendance_check_in
    ON attendance_records(check_in_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_attendance_per_student
    ON attendance_records(student_id) WHERE check_out_at IS NULL;
`);

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('请求内容过大');
  }
  return raw ? JSON.parse(raw) : {};
}

function studentByCard(uid) {
  return db.prepare(`
    SELECT id, student_no, name, class_name, card_uid, status, created_at
    FROM students WHERE card_uid = ?
  `).get(uid);
}

function latestAttendance(studentId) {
  return db.prepare(`
    SELECT id, check_in_at, check_out_at, duration_minutes
    FROM attendance_records
    WHERE student_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(studentId);
}

function attendanceHistory({ query = '', date = '', limit = 100 } = {}) {
  const filters = [];
  const params = [];
  const normalizedQuery = String(query || '').trim();
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : '';

  if (normalizedQuery) {
    filters.push('(s.name LIKE ? OR s.student_no LIKE ? OR s.class_name LIKE ? OR s.card_uid LIKE ?)');
    const pattern = `%${normalizedQuery}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  if (normalizedDate) {
    filters.push("date(a.check_in_at, 'localtime') = ?");
    params.push(normalizedDate);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.min(200, Math.max(1, Number(limit) || 100)));
  return db.prepare(`
    SELECT a.id, a.card_uid, a.check_in_at, a.check_out_at, a.duration_minutes,
      s.student_no, s.name, s.class_name
    FROM attendance_records a JOIN students s ON s.id = a.student_id
    ${where}
    ORDER BY a.id DESC LIMIT ?
  `).all(...params);
}

function dashboard() {
  return {
    stats: {
      students: db.prepare("SELECT COUNT(*) AS value FROM students WHERE status = 'active'").get().value,
      todayCheckIns: db.prepare("SELECT COUNT(*) AS value FROM attendance_records WHERE date(check_in_at, 'localtime') = date('now', 'localtime')").get().value,
      present: db.prepare('SELECT COUNT(*) AS value FROM attendance_records WHERE check_out_at IS NULL').get().value,
      todayCheckOuts: db.prepare("SELECT COUNT(*) AS value FROM attendance_records WHERE check_out_at IS NOT NULL AND date(check_out_at, 'localtime') = date('now', 'localtime')").get().value,
    },
    presentStudents: db.prepare(`
      SELECT a.id, a.check_in_at, s.student_no, s.name, s.class_name, s.card_uid
      FROM attendance_records a JOIN students s ON s.id = a.student_id
      WHERE a.check_out_at IS NULL ORDER BY a.check_in_at
    `).all(),
    recentRecords: attendanceHistory({ limit: 12 }),
    minimumActionIntervalSeconds: MIN_ACTION_INTERVAL_SECONDS,
  };
}

function processCard(uid) {
  const now = new Date();
  const nowIso = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const student = studentByCard(uid);
    if (!student) {
      db.exec('ROLLBACK');
      return { status: 404, value: { error: '陌生卡片，尚未绑定学生', code: 'UNKNOWN_CARD', uid } };
    }
    if (student.status !== 'active') {
      db.exec('ROLLBACK');
      return { status: 403, value: { error: '该学生卡已停用', code: 'CARD_DISABLED', student } };
    }

    const latest = latestAttendance(student.id);
    const decision = decideAttendanceAction(latest, now);
    if (decision.action === 'duplicate') {
      db.exec('COMMIT');
      return {
        status: 200,
        value: { action: 'duplicate', student, record: latest, retryAfterSeconds: decision.retryAfterSeconds },
      };
    }

    if (decision.action === 'check_out') {
      db.prepare(`
        UPDATE attendance_records
        SET check_out_at = ?, duration_minutes = ?
        WHERE id = ? AND check_out_at IS NULL
      `).run(nowIso, decision.durationMinutes, latest.id);
      const record = db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(latest.id);
      db.exec('COMMIT');
      return { status: 200, value: { action: 'check_out', student, record } };
    }

    const record = db.prepare(`
      INSERT INTO attendance_records(student_id, card_uid, check_in_at)
      VALUES (?, ?, ?) RETURNING *
    `).get(student.id, uid, nowIso);
    db.exec('COMMIT');
    return { status: 201, value: { action: 'check_in', student, record } };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { }
    throw error;
  }
}

async function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/dashboard') return json(res, 200, dashboard());
  if (req.method === 'GET' && path === '/api/attendance') {
    return json(res, 200, {
      records: attendanceHistory({ query: url.searchParams.get('query'), date: url.searchParams.get('date') }),
    });
  }
  if (req.method === 'GET' && path === '/api/reader/status') return json(res, 200, reader.status());
  if (req.method === 'GET' && path === '/api/reader/events') {
    return json(res, 200, { events: reader.eventsAfter(url.searchParams.get('after')) });
  }
  if (req.method === 'GET' && path.startsWith('/api/students/card/')) {
    const uid = normalizeCardUid(decodeURIComponent(path.slice('/api/students/card/'.length)));
    if (!uid) return json(res, 400, { error: '卡号必须是 8—64 位偶数长度的十六进制字符' });
    const student = studentByCard(uid);
    return student ? json(res, 200, student) : json(res, 404, { error: '陌生卡片，尚未绑定学生', code: 'UNKNOWN_CARD', uid });
  }

  if (req.method !== 'POST') return json(res, 405, { error: '不支持的操作' });
  const input = await body(req);

  if (path === '/api/students') {
    const uid = normalizeCardUid(input.uid);
    const studentNo = String(input.studentNo || '').trim();
    const name = String(input.name || '').trim();
    const className = String(input.className || '').trim();
    if (!uid) return json(res, 400, { error: '卡号必须是 8—64 位偶数长度的十六进制字符' });
    if (!/^[0-9A-Za-z_-]{2,32}$/.test(studentNo)) return json(res, 400, { error: '学号需为 2—32 位字母、数字、下划线或短横线' });
    if (!name || name.length > 40 || !className || className.length > 60) return json(res, 400, { error: '请填写有效的姓名和班级' });
    try {
      const student = db.prepare(`
        INSERT INTO students(student_no, name, class_name, card_uid, created_at)
        VALUES (?, ?, ?, ?, ?) RETURNING *
      `).get(studentNo, name, className, uid, new Date().toISOString());
      return json(res, 201, student);
    } catch (error) {
      if (String(error.message).includes('students.student_no')) return json(res, 409, { error: '该学号已登记' });
      if (String(error.message).includes('students.card_uid')) return json(res, 409, { error: '该卡号已绑定其他学生' });
      throw error;
    }
  }

  if (path === '/api/attendance/scan') {
    const uid = normalizeCardUid(input.uid);
    if (!uid) return json(res, 400, { error: '无效卡号，已拒绝记录', code: 'INVALID_CARD' });
    const result = processCard(uid);
    return json(res, result.status, result.value);
  }

  if (path === '/api/reader/restart') {
    reader.restart();
    return json(res, 202, reader.status());
  }

  if (path === '/api/reader/simulate') {
    const uid = normalizeCardUid(input.uid);
    if (!uid) return json(res, 400, { error: '请输入有效的十六进制模拟卡号' });
    reader.simulate(uid);
    return json(res, 202, { accepted: true });
  }

  return json(res, 404, { error: '接口不存在' });
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const file = join(publicDir, safePath);
    if (!file.startsWith(publicDir)) return json(res, 403, { error: '禁止访问' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: '页面不存在' });
    if (error instanceof SyntaxError) return json(res, 400, { error: '请求数据格式错误' });
    console.error(error);
    json(res, 500, { error: '系统暂时无法完成操作' });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`RFID 一卡通考勤系统：http://127.0.0.1:${port}`);
  reader.start();
});

function shutdown() {
  reader.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
