import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { normalizeCardUid } from './card.js';

export function parseBridgeLine(line) {
  try {
    const value = JSON.parse(String(line).trim());
    return value && typeof value.type === 'string' ? value : null;
  } catch {
    return null;
  }
}

export class ReaderService extends EventEmitter {
  constructor({ executable, port = process.env.READER_PORT || 'auto' }) {
    super();
    this.executable = executable;
    this.port = port;
    this.process = null;
    this.restartTimer = null;
    this.lineBuffer = '';
    this.eventId = 0;
    this.events = [];
    this.stopping = false;
    this.state = {
      available: existsSync(executable),
      status: existsSync(executable) ? 'starting' : 'unavailable',
      port: null,
      firmware: null,
      power: null,
      lastCard: null,
      lastReadAt: null,
      error: existsSync(executable) ? null : '读卡桥接程序尚未构建',
    };
  }

  start() {
    if (this.process || this.stopping || !this.state.available) return;
    this.state.status = 'starting';
    this.state.error = null;
    const args = this.port === 'auto' ? [] : ['--port', this.port];
    const child = spawn(this.executable, args, {
      cwd: new URL('../reader-bridge/bin/', import.meta.url),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const message = chunk.trim();
      if (message) this.update({ error: message });
    });
    child.on('error', error => this.update({ status: 'error', error: error.message }));
    child.on('exit', code => {
      if (this.process !== child) return;
      this.process = null;
      if (this.stopping) return;
      this.update({ status: 'disconnected', error: code ? `读卡桥接程序退出，代码 ${code}` : null });
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.process) this.process.kill();
    this.process = null;
    this.update({ status: 'stopped' });
  }

  restart() {
    clearTimeout(this.restartTimer);
    if (this.process) this.process.kill();
    this.process = null;
    this.stopping = false;
    setTimeout(() => this.start(), 250);
  }

  consume(chunk) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
      const event = parseBridgeLine(line);
      if (event) this.handle(event);
    }
  }

  handle(event) {
    if (event.type === 'connected') {
      this.update({ status: 'connected', port: event.port, firmware: event.firmware, power: Number(event.power), error: null });
    } else if (event.type === 'disconnected') {
      this.update({ status: 'disconnected' });
    } else if (event.type === 'error') {
      this.update({ status: 'error', error: event.message || `设备错误 ${event.code || ''}`.trim() });
    } else if (event.type === 'card' && event.uid) {
      const uid = normalizeCardUid(event.uid);
      if (!uid) {
        this.update({ error: '读卡器返回了无效卡号，已忽略' });
        return;
      }
      const cardEvent = {
        id: ++this.eventId,
        uid,
        protocol: event.protocol || 'EPC-C1G2',
        readAt: new Date().toISOString(),
      };
      this.events.push(cardEvent);
      if (this.events.length > 100) this.events.shift();
      this.update({ lastCard: cardEvent.uid, lastReadAt: cardEvent.readAt });
      this.emit('card', cardEvent);
    }
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.status());
  }

  status() {
    return { ...this.state, configuredPort: this.port, latestEventId: this.eventId };
  }

  eventsAfter(id) {
    const after = Number(id) || 0;
    return this.events.filter(event => event.id > after);
  }

  simulate(uid) {
    this.handle({ type: 'card', uid, protocol: 'SIMULATED' });
  }
}
