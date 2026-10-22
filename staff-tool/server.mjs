import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';
import { StaffStore, StaffError } from './store.mjs';

const toolRoot = dirname(fileURLToPath(import.meta.url));
export function createStaffServer({ databasePath = resolve(toolRoot, '../data/cybercard.db'), backupDirectory = resolve(toolRoot, '../data/staff-backups'), port = 8788 } = {}) {
  const store = new StaffStore(databasePath, backupDirectory);
  const token = randomBytes(32).toString('hex');
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const isAllowedHost = (host, actualPort) => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host);
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new StaffError('请求格式不正确', 415);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new StaffError('填写内容过长', 413);
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new StaffError('请求格式不正确');
    return value;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const actualPort = server.address()?.port ?? port;
      if (!isAllowedHost(req.headers.host, actualPort)) throw new StaffError('仅允许通过本机地址打开工具', 403);
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      const params = Object.fromEntries(url.searchParams);
      if (req.method === 'GET') {
        if (url.pathname === '/api/info') return json(res, 200, { ...store.info(), token, processId: process.pid });
        if (url.pathname === '/api/students') return json(res, 200, store.students(params));
        if (url.pathname === '/api/student-options') return json(res, 200, { items: store.studentOptions() });
        if (url.pathname === '/api/attendance') return json(res, 200, store.attendanceList(params));
        if (url.pathname === '/api/backups') return json(res, 200, { items: store.backups() });
        if (url.pathname === '/api/changes') return json(res, 200, store.changes(params));
        if (/^\/api\/changes\/\d+$/.test(url.pathname)) return json(res, 200, store.change(url.pathname.split('/').at(-1)));
        if (url.pathname === '/api/tables') return json(res, 200, { items: store.tables() });
        if (url.pathname === '/api/browse') return json(res, 200, store.browse(params.table, params));
        if (/^\/api\/students\/\d+$/.test(url.pathname)) return json(res, 200, store.student(url.pathname.split('/').at(-1)));
        if (/^\/api\/attendance\/\d+$/.test(url.pathname)) return json(res, 200, store.attendance(url.pathname.split('/').at(-1)));
        if (url.pathname === '/api/backup-file') {
          const file = store.backupPath(params.file);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${basename(file)}"`, 'Cache-Control': 'no-store' });
          return res.end(await readFile(file));
        }
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
        if (!assets[url.pathname]) throw new StaffError('页面或接口不存在', 404);
        const [file, type] = assets[url.pathname];
        const content = await readFile(join(toolRoot, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(content);
      }
      if (!['POST', 'PUT', 'DELETE'].includes(req.method)) throw new StaffError('不支持的操作', 405);
      const supplied = Buffer.from(String(req.headers['x-staff-token'] || ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new StaffError('页面会话已失效，请刷新后再保存', 403);
      if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) throw new StaffError('请在本机工具页面操作', 403);
      const input = await body(req);
      if (req.method === 'POST' && url.pathname === '/api/quit') {
        json(res, 200, { stopped: true });
        setImmediate(() => { server.close(); server.closeIdleConnections(); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/backups') return json(res, 201, { backup: store.backup() });
      if (req.method === 'POST' && url.pathname === '/api/students') return json(res, 201, store.saveStudent(null, input));
      if (req.method === 'PUT' && /^\/api\/students\/\d+$/.test(url.pathname)) return json(res, 200, store.saveStudent(url.pathname.split('/').at(-1), input));
      if (req.method === 'POST' && url.pathname === '/api/attendance') return json(res, 201, store.saveAttendance(null, input));
      if (req.method === 'PUT' && /^\/api\/attendance\/\d+$/.test(url.pathname)) return json(res, 200, store.saveAttendance(url.pathname.split('/').at(-1), input));
      if (req.method === 'DELETE' && /^\/api\/attendance\/\d+$/.test(url.pathname)) return json(res, 200, store.deleteAttendance(url.pathname.split('/').at(-1), input));
      throw new StaffError('接口不存在', 404);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof StaffError) return json(res, error.status, { error: error.message });
      if (error instanceof SyntaxError) return json(res, 400, { error: '请求内容格式有误，请刷新页面重试' });
      console.error(error);
      const busy = /locked|busy/i.test(error.message);
      json(res, busy ? 503 : 500, { error: busy ? '数据库正在使用中，请稍后重试；修正考勤时请暂停刷卡。' : '操作未完成，请检查工具日志。' });
    }
  });
  server.requestTimeout = 15000;
  server.on('close', () => store.close());
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.STAFF_PORT || 8788);
  const { server } = createStaffServer({ port, databasePath: process.env.STAFF_DB_PATH, backupDirectory: process.env.STAFF_BACKUP_DIRECTORY });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已占用，请重新双击启动入口，或检查 8788 端口。' : error); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`内部数据管理工具：http://127.0.0.1:${port}/`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
