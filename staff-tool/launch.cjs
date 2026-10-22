const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const address = 'http://127.0.0.1:8788/';

function probe() {
  return new Promise(resolve => {
    const request = http.get(`${address}api/info`, { timeout: 1200 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(info.application === 'rfid-staff-tool' && typeof info.databasePath === 'string' && path.resolve(info.databasePath).toLowerCase() === path.join(root, 'data', 'cybercard.db').toLowerCase() ? 'ready' : 'occupied');
        } catch { resolve('occupied'); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve('offline'));
  });
}

async function openWindow() {
  const chrome = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(file => fs.existsSync(file));
  if (!chrome) throw new Error(`未找到 Chrome。请手动在浏览器打开：${address}`);
  await new Promise((resolve, reject) => {
    const browser = spawn(chrome, [`--app=${address}`], { detached: true, stdio: 'ignore' });
    browser.once('error', reject);
    browser.once('spawn', () => { browser.unref(); resolve(); });
  });
}

(async () => {
  let status = await probe();
  if (status === 'occupied') throw new Error('8788 端口被其他程序占用。请关闭占用该端口的程序后重试。');
  if (status !== 'ready') {
    const logs = path.join(__dirname, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const out = fs.openSync(path.join(logs, 'tool.log'), 'a');
    const err = fs.openSync(path.join(logs, 'tool-error.log'), 'a');
    let spawnError;
    const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err],
      env: { ...process.env, STAFF_PORT: '8788', STAFF_DB_PATH: path.join(root, 'data', 'cybercard.db'), STAFF_BACKUP_DIRECTORY: path.join(root, 'data', 'staff-backups') },
    });
    child.once('error', error => { spawnError = error; });
    child.unref();
    fs.closeSync(out);
    fs.closeSync(err);
    for (let i = 0; i < 40; i++) {
      if (spawnError) throw spawnError;
      await new Promise(resolve => setTimeout(resolve, 300));
      status = await probe();
      if (status === 'ready') break;
      if (status === 'occupied') throw new Error('端口被其他程序占用，请查看工具日志。');
    }
    if (status !== 'ready') throw new Error(`数据管理工具未能启动。请查看：${path.join(logs, 'tool-error.log')}`);
  }
  await openWindow();
  console.log('已打开内部数据管理工具。');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
