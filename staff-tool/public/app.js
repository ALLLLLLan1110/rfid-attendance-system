const $ = selector => document.querySelector(selector);
const state = { view: 'students', page: 1, q: '', date: '', present: '', table: 'students', mode: 'files', token: '', info: null, tables: [], sequence: 0, pages: 1, student: null, attendance: null };
const views = {
  students: ['学生信息与卡片绑定', '学生资料', '搜索学生，点击「编辑」修改姓名、班级、学号或卡号。', '历史考勤会保留刷卡时的卡号，修改卡号不会覆盖旧记录。'],
  attendance: ['签到与签退时间维护', '考勤记录', '补充忘记的签退时间，或修正一条错误记录。时长自动计算。', '保存前请暂停刷卡。考勤按记录编号保持时间顺序，冲突的修改会被拒绝。'],
  backups: ['每次修改都有据可查', '备份与修改记录', '每次保存或删除前自动备份。也可以主动备份并下载留存。', '备份包含当时已提交的数据。恢复备份前，需关闭考勤系统和本工具。'],
  browse: ['查看原始表与字段', '数据表浏览', '查看数据库中的全部数据表，包含旧版网吧系统保留的数据。', '此处仅供查看原始字段。学生与考勤数据请在前两个页面修改。'],
};
const fieldNames = { student_no: '学号', name: '姓名', class_name: '班级', card_uid: '卡号', status: '状态', created_at: '登记时间', id: '编号', student_id: '学生编号', check_in_at: '签到时间', check_out_at: '签退时间', duration_minutes: '时长（分钟）' };
const actionNames = { create: '新增', update: '修改', delete: '删除' };
const tableNames = { students: '学生', attendance_records: '考勤' };
const fmt = value => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';

function node(tag, value, className) {
  const item = document.createElement(tag);
  if (value !== undefined && value !== null) item.textContent = String(value);
  if (className) item.className = className;
  return item;
}
function btn(label, handler, className = 'edit') {
  const item = node('button', label, className);
  item.type = 'button';
  item.addEventListener('click', () => Promise.resolve(handler()).catch(error => showError(error.message)));
  return item;
}
function showError(message) { $('#banner').textContent = message; $('#banner').hidden = !message; }
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500);
}

async function api(path, method = 'GET', input) {
  const options = { method, cache: 'no-store', headers: {} };
  if (method !== 'GET') {
    options.headers = { 'Content-Type': 'application/json', 'X-Staff-Token': state.token };
    options.body = JSON.stringify(input ?? {});
  }
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error('无法连接数据管理工具。请重新双击「启动数据管理.bat」。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成');
  return data;
}

function updateInfo(info) {
  state.info = info;
  state.token = info.token;
  for (const key of ['students', 'active', 'records', 'present']) $(`#stat-${key}`).textContent = info.stats[key];
}

function configureView() {
  const [kicker, title, description, hint] = views[state.view];
  $('#view-kicker').textContent = kicker;
  $('#view-title').textContent = title;
  $('#view-description').textContent = description;
  $('#view-hint').textContent = hint;
  document.querySelectorAll('.nav-item').forEach(item => { item.classList.toggle('active', item.dataset.view === state.view); item.setAttribute('aria-current', item.dataset.view === state.view ? 'page' : 'false'); });
  $('#search-form').hidden = !['students', 'attendance'].includes(state.view);
  $('#date-control').hidden = state.view !== 'attendance';
  $('#present-control').hidden = state.view !== 'attendance';
  $('#backup-tabs').hidden = state.view !== 'backups';
  $('#table-control').hidden = state.view !== 'browse';
  $('#schema').hidden = state.view !== 'browse';
  $('#add').hidden = !['students', 'attendance'].includes(state.view);
  $('#add').textContent = state.view === 'students' ? '＋ 新增学生' : '＋ 补记考勤';
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('selected', item.dataset.mode === state.mode));
}

function identity(row) {
  const item = node('div');
  item.append(node('div', row.name, 'name'), node('div', `${row.student_no} · ${row.class_name}`, 'sub'));
  return item;
}
function status(text, className) { return node('span', text, `state ${className || ''}`); }
function download(file) {
  const link = node('a', '下载');
  link.href = `/api/backup-file?file=${encodeURIComponent(file)}`;
  link.download = file;
  return link;
}
function renderTable(headers, rows) {
  $('#grid thead').replaceChildren();
  $('#grid tbody').replaceChildren();
  const head = node('tr');
  for (const label of headers) head.append(node('th', label));
  $('#grid thead').append(head);
  for (const values of rows) {
    const row = node('tr');
    values.forEach(value => {
      const cell = node('td');
      if (value instanceof Node) cell.append(value);
      else { cell.textContent = value === null || value === undefined ? '—' : String(value); cell.title = cell.textContent; }
      row.append(cell);
    });
    $('#grid tbody').append(row);
  }
  $('#empty').hidden = rows.length !== 0;
}

async function load() {
  const sequence = ++state.sequence;
  showError('');
  try {
    const info = await api('/api/info');
    if (sequence !== state.sequence) return;
    updateInfo(info);
    let data;
    const params = new URLSearchParams({ q: state.q, page: state.page, date: state.date, present: state.present, table: state.table });
    if (state.view === 'students') {
      data = await api(`/api/students?${params}`);
      if (sequence !== state.sequence) return;
      renderTable(['编号', '学生', 'RFID 卡号', '使用状态', '历史考勤', '当前状态', '操作'], data.items.map(item => [
        `#${item.id}`, identity(item), node('span', item.card_uid, 'mono'),
        status(item.status === 'active' ? '启用' : '停用', item.status === 'active' ? '' : 'disabled'),
        `${item.record_count} 条`, item.present ? status('未签退', 'open') : '—', btn('编辑', () => openStudent(item.id)),
      ]));
    } else if (state.view === 'attendance') {
      data = await api(`/api/attendance?${params}`);
      if (sequence !== state.sequence) return;
      renderTable(['记录编号', '学生', '签到时间', '签退时间', '时长', '操作'], data.items.map(item => [
        `#${item.id}`, identity(item), fmt(item.check_in_at), item.check_out_at ? fmt(item.check_out_at) : status('未签退', 'open'),
        item.duration_minutes === null ? '—' : `${item.duration_minutes} 分钟`, btn('修改', () => openAttendance(item.id)),
      ]));
    } else if (state.view === 'backups') {
      if (state.mode === 'files') {
        const all = await api('/api/backups');
        if (sequence !== state.sequence) return;
        data = { items: all.items.slice((state.page - 1) * 25, state.page * 25), total: all.items.length, pageSize: 25 };
        renderTable(['备份时间', '备份类型', '文件名', '大小', '操作'], data.items.map(item => [fmt(item.createdAt), item.file.startsWith('manual-') ? '手动备份' : '修改前自动备份', node('span', item.file, 'mono'), `${(item.bytes / 1024).toFixed(1)} KB`, download(item.file)]));
      } else {
        data = await api(`/api/changes?page=${state.page}`);
        if (sequence !== state.sequence) return;
        renderTable(['修改时间', '操作', '目标记录', '说明', '详情'], data.items.map(item => [fmt(item.changed_at), actionNames[item.action], `${tableNames[item.table_name] || item.table_name} #${item.row_id}`, item.reason || '未填写', btn('查看', () => openChange(item.id))]));
      }
    } else {
      const tables = await api('/api/tables');
      if (sequence !== state.sequence) return;
      state.tables = tables.items;
      const select = $('#table-select');
      select.replaceChildren();
      for (const table of tables.items) {
        const option = node('option', `${table.title} / ${table.name}（${table.count}）`);
        option.value = table.name;
        select.append(option);
      }
      if (!tables.items.some(item => item.name === state.table)) state.table = tables.items[0]?.name || '';
      select.value = state.table;
      if (!state.table) throw new Error('数据库中没有可显示的数据表');
      data = await api(`/api/browse?table=${encodeURIComponent(state.table)}&page=${state.page}`);
      if (sequence !== state.sequence) return;
      const table = tables.items.find(item => item.name === state.table);
      renderTable(table.columns.map(item => item.name), data.items.map(item => table.columns.map(column => item[column.name])));
      const schema = node('table');
      const head = node('tr');
      for (const label of ['字段', '类型', '主键', '必填', '默认值']) head.append(node('th', label));
      const thead = node('thead'); thead.append(head); schema.append(thead);
      const tbody = node('tbody');
      for (const column of table.columns) {
        const tr = node('tr');
        for (const value of [column.name, column.type, column.pk ? '是' : '—', column.notnull ? '是' : '—', column.dflt_value ?? '—']) tr.append(node('td', value));
        tbody.append(tr);
      }
      schema.append(tbody);
      $('#schema-content').replaceChildren(schema);
    }
    if (sequence !== state.sequence) return;
    state.pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (state.page > state.pages) { state.page = state.pages; return load(); }
    $('#total').textContent = `共 ${data.total} 条，每页 ${data.pageSize} 条`;
    $('#page-label').textContent = `${state.page} / ${state.pages}`;
    $('#previous').disabled = state.page <= 1;
    $('#next').disabled = state.page >= state.pages;
  } catch (error) { if (sequence === state.sequence) showError(error.message); }
}

function resetForm(form) {
  form.reset();
  form.querySelector('.form-error').hidden = true;
}
function setFields(form, item, fields) { for (const field of fields) form.elements.namedItem(field).value = item[field] ?? ''; }
function formValues(form) { return Object.fromEntries(new FormData(form)); }
async function submitForm(form, task) {
  const errorBox = form.querySelector('.form-error');
  errorBox.hidden = true;
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  form.dataset.saving = 'true';
  try { await task(); }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'nearest' }); }
  finally { buttons.forEach(button => { button.disabled = false; }); delete form.dataset.saving; }
}

async function openStudent(id) {
  if (state.opening || $('#student-dialog').open || $('#attendance-dialog').open) return;
  state.opening = true;
  try {
  state.student = id ? await api(`/api/students/${id}`) : null;
  const form = $('#student-form');
  resetForm(form);
  if (state.student) setFields(form, state.student, ['student_no', 'name', 'class_name', 'card_uid', 'status']);
  $('#student-title').textContent = id ? `编辑学生 #${id}` : '新增学生';
  $('#student-dialog').showModal();
  } finally { state.opening = false; }
}

function localTime(value = new Date().toISOString()) {
  if (!value) return '';
  const date = new Date(value);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function updateDuration() {
  const form = $('#attendance-form');
  const start = form.elements.check_in_at.value;
  const end = form.elements.check_out_at.value;
  const duration = (Date.parse(end) - Date.parse(start)) / 60000;
  $('#duration-preview').textContent = !end ? '未填写签退时间：该学生会计入「当前在校」。' : !start ? '请先填写签到时间。' : !Number.isFinite(duration) || duration < 0 ? '签退时间不能早于签到时间。' : `计算时长：${Math.max(1, Math.ceil(duration))} 分钟（向上取整）`;
}
async function openAttendance(id) {
  if (state.opening || $('#student-dialog').open || $('#attendance-dialog').open) return;
  state.opening = true;
  try {
  const [options, item] = await Promise.all([api('/api/student-options'), id ? api(`/api/attendance/${id}`) : Promise.resolve(null)]);
  if (!options.items.length) throw new Error('请先新增一名学生，再补记考勤');
  state.attendance = item;
  const form = $('#attendance-form');
  resetForm(form);
  const select = form.elements.student_id;
  select.replaceChildren();
  const placeholder = node('option', '请选择学生'); placeholder.value = ''; select.append(placeholder);
  for (const student of options.items) {
    const option = node('option', `${student.student_no}　${student.name}　${student.class_name}${student.status === 'disabled' ? '（已停用）' : ''}`);
    option.value = student.id;
    select.append(option);
  }
  select.disabled = Boolean(item);
  if (item) {
    select.value = item.student_id;
    form.elements.check_in_at.value = localTime(item.check_in_at);
    form.elements.check_out_at.value = item.check_out_at ? localTime(item.check_out_at) : '';
  } else form.elements.check_in_at.value = localTime();
  $('#student-lock-hint').textContent = item ? `原卡号：${item.card_uid}。已有记录的所属学生保持不变。` : '补记记录不会覆盖已有考勤。';
  $('#attendance-title').textContent = item ? `修改考勤 #${item.id}` : '补记考勤';
  $('#delete-attendance').hidden = !item;
  updateDuration();
  $('#attendance-dialog').showModal();
  } finally { state.opening = false; }
}

async function openChange(id) {
  const change = await api(`/api/changes/${id}`);
  $('#detail-title').textContent = `${actionNames[change.action]}${tableNames[change.table_name] || change.table_name} #${change.row_id}`;
  const content = $('#detail-content');
  content.replaceChildren(node('p', `${fmt(change.changed_at)}　${change.reason || '未填写修改说明'}`, 'change-meta'));
  const before = change.before_json ? JSON.parse(change.before_json) : {};
  const after = change.after_json ? JSON.parse(change.after_json) : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const table = node('table'); const thead = node('thead'); const tr = node('tr');
  ['字段', '修改前', '修改后'].forEach(label => tr.append(node('th', label))); thead.append(tr); table.append(thead);
  const tbody = node('tbody');
  for (const key of keys) {
    const row = node('tr'); if (before[key] !== after[key]) row.className = 'changed';
    for (const value of [fieldNames[key] || key, before[key] ?? '—', after[key] ?? '—']) row.append(node('td', value));
    tbody.append(row);
  }
  table.append(tbody); content.append(table);
  const line = node('p', '修改前备份：'); line.append(download(change.backup_file)); content.append(line);
  $('#detail-dialog').showModal();
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  state.page = 1;
  state.q = ''; state.date = ''; state.present = '';
  $('#search-form').reset();
  configureView(); load();
}));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { state.mode = button.dataset.mode; state.page = 1; configureView(); load(); }));
$('#search-form').addEventListener('submit', event => { event.preventDefault(); state.q = $('#query').value; state.date = $('#date-filter').value; state.present = $('#present-filter').value; state.page = 1; load(); });
$('#date-filter').addEventListener('change', () => $('#search-form').requestSubmit());
$('#present-filter').addEventListener('change', () => $('#search-form').requestSubmit());
$('#query').addEventListener('search', () => $('#search-form').requestSubmit());
$('#table-select').addEventListener('change', () => { state.table = $('#table-select').value; state.page = 1; load(); });
$('#refresh').addEventListener('click', load);
$('#previous').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
$('#next').addEventListener('click', () => { if (state.page < state.pages) { state.page++; load(); } });
$('#add').addEventListener('click', () => Promise.resolve(state.view === 'students' ? openStudent() : openAttendance()).catch(error => showError(error.message)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (dialog.querySelector('form')?.dataset.saving) event.preventDefault(); }));

$('#student-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  submitForm(form, async () => {
    const input = { ...formValues(form), revision: state.student?.revision };
    const result = await api(state.student ? `/api/students/${state.student.id}` : '/api/students', state.student ? 'PUT' : 'POST', input);
    $('#student-dialog').close();
    toast(`学生资料已保存，修改前数据库已自动备份。编号 #${result.item.id}`);
    await load();
  });
});
$('#attendance-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  submitForm(form, async () => {
    const input = formValues(form);
    input.student_id = state.attendance?.student_id ?? Number(input.student_id);
    input.check_in_at = new Date(input.check_in_at).toISOString();
    input.check_out_at = input.check_out_at ? new Date(input.check_out_at).toISOString() : null;
    input.revision = state.attendance?.revision;
    const result = await api(state.attendance ? `/api/attendance/${state.attendance.id}` : '/api/attendance', state.attendance ? 'PUT' : 'POST', input);
    $('#attendance-dialog').close();
    toast(`考勤记录已保存，时长已重新计算。修改前已自动备份。编号 #${result.item.id}`);
    await load();
  });
});
document.querySelectorAll('[data-now]').forEach(button => button.addEventListener('click', () => { $('#attendance-form').elements.namedItem(button.dataset.now).value = localTime(); updateDuration(); }));
$('#clear-checkout').addEventListener('click', () => { $('#attendance-form').elements.check_out_at.value = ''; updateDuration(); });
$('#attendance-form').addEventListener('input', updateDuration);
$('#delete-attendance').addEventListener('click', () => {
  resetForm($('#delete-form'));
  $('#delete-summary').textContent = `记录 #${state.attendance.id}：${state.attendance.name}，签到于 ${fmt(state.attendance.check_in_at)}。请输入编号 ${state.attendance.id} 确认。`;
  $('#delete-dialog').showModal();
});
$('#delete-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  submitForm(form, async () => {
    await api(`/api/attendance/${state.attendance.id}`, 'DELETE', { ...formValues(form), revision: state.attendance.revision });
    $('#delete-dialog').close(); $('#attendance-dialog').close();
    toast('考勤记录已删除。原记录与数据库备份可在「备份与修改记录」查看。');
    await load();
  });
});
$('#backup-now').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    await api('/api/backups', 'POST');
    toast('数据库已完整备份。可在「备份与修改记录」下载。');
    if (state.view === 'backups') await load();
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});
$('#show-location').addEventListener('click', () => {
  if (!state.info) return showError('还未连接数据库，请先重新启动工具');
  $('#detail-title').textContent = '数据库与备份位置';
  $('#detail-content').replaceChildren(node('p', '正在编辑的数据库'), node('div', state.info.databasePath, 'path'), node('p', '自动备份文件夹'), node('div', state.info.backupDirectory, 'path'), node('p', '这就是考勤系统使用的同一个数据库。备份无需停机，恢复时请先关闭两个程序。', 'form-note'));
  $('#detail-dialog').showModal();
});
$('#quit-tool').addEventListener('click', async () => {
  if (!window.confirm('关闭本机数据管理工具？之后双击启动入口即可重新打开。考勤系统不会受影响。')) return;
  try { await api('/api/quit', 'POST'); toast('管理工具已退出，可以关闭这个窗口。'); }
  catch (error) { showError(error.message); }
});

configureView();
load();
