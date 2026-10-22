const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => {
  const element = document.createElement('div');
  element.textContent = value ?? '';
  return element.innerHTML;
};
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}) : '—';
const shortTime = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';

let currentUid = '';
let lastReaderEventId = 0;
let readerInitialized = false;
let cardQueue = Promise.resolve();

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '操作失败');
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = error ? 'show error' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ''; }, 2800);
}

function clearResult({ clearUid = true } = {}) {
  currentUid = '';
  if (clearUid) $('#uid').value = '';
  $('#scan-title').textContent = '请将学生卡放到读卡器上';
  $('#scan-help').textContent = '第一次刷卡自动签到，再次刷卡自动签退。';
  $('#enroll-open').disabled = true;
  $('#result-panel').className = 'result-panel';
  $('#result-panel').innerHTML = `
    <div class="empty-state">
      <div class="rfid-symbol" aria-hidden="true"></div>
      <h2>放卡，即刻签到</h2>
      <p>将学生卡靠近读卡器<br>识别结果会显示在这里</p>
    </div>`;
}

function studentIdentity(student) {
  return `
    <div class="student-identity">
      <div class="student-avatar">${escapeHtml(student.name.slice(0, 1))}</div>
      <div><p class="eyebrow">${escapeHtml(student.class_name)}</p><h2>${escapeHtml(student.name)}</h2>
      <p>${escapeHtml(student.student_no)} · 卡号 ${escapeHtml(student.card_uid)}</p></div>
    </div>`;
}

function renderAttendance(result) {
  const { action, student, record } = result;
  $('#enroll-open').disabled = true;
  if (action === 'duplicate') {
    $('#scan-title').textContent = `${student.name} · 重复刷卡已忽略`;
    $('#scan-help').textContent = `请等待 ${result.retryAfterSeconds} 秒后再刷，数据库没有新增记录。`;
    $('#result-panel').className = 'result-panel warning';
    $('#result-panel').innerHTML = `${studentIdentity(student)}
      <div class="result-status"><span>防重复保护</span><strong>未写入</strong><small>上一次操作：${dateTime(record.check_out_at || record.check_in_at)}</small></div>`;
    return;
  }

  const checkedIn = action === 'check_in';
  $('#scan-title').textContent = `${student.name} · ${checkedIn ? '签到成功' : '签退成功'}`;
  $('#scan-help').textContent = checkedIn ? '考勤记录已保存，再次刷卡将自动签退。' : '本次考勤已经完成并写入数据库。';
  $('#result-panel').className = `result-panel ${checkedIn ? 'success' : 'complete'}`;
  $('#result-panel').innerHTML = `${studentIdentity(student)}
    <div class="result-status">
      <span>${checkedIn ? 'CHECK IN · 签到' : 'CHECK OUT · 签退'}</span>
      <strong>${checkedIn ? shortTime(record.check_in_at) : shortTime(record.check_out_at)}</strong>
      <small>${checkedIn ? `签到时间 ${dateTime(record.check_in_at)}` : `在校 ${record.duration_minutes} 分钟 · 签到 ${dateTime(record.check_in_at)}`}</small>
    </div>`;
}

function renderUnknown(uid) {
  currentUid = uid;
  $('#scan-title').textContent = '检测到未登记卡片';
  $('#scan-help').textContent = '系统没有写入考勤，请先绑定学生信息。';
  $('#enroll-open').disabled = false;
  $('#enroll-form [name="uid"]').value = uid;
  $('#result-panel').className = 'result-panel unknown';
  $('#result-panel').innerHTML = `
    <div class="unknown-card">
      <div class="unknown-symbol" aria-hidden="true">?</div><div><p class="eyebrow">陌生卡片</p><h2>尚未绑定学生</h2>
      <p>卡号 <code>${escapeHtml(uid)}</code></p><small>点击下方“登记学生卡”，绑定后自动完成首次签到。</small></div>
    </div>`;
}

async function handleCard(rawUid) {
  const uid = String(rawUid || '').replace(/\s+/g, '').toUpperCase();
  if (!uid) return;
  currentUid = uid;
  $('#uid').value = uid;
  try {
    const result = await request('/api/attendance/scan', { method: 'POST', body: JSON.stringify({ uid }) });
    renderAttendance(result);
    if (result.action === 'check_in') toast('签到成功，记录已保存');
    else if (result.action === 'check_out') toast('签退成功，记录已完成');
    else toast('重复刷卡已忽略');
    await Promise.all([refreshDashboard(), loadHistory()]);
  } catch (error) {
    if (error.code === 'UNKNOWN_CARD') {
      renderUnknown(error.data.uid || uid);
      toast('陌生卡片，请先登记', true);
    } else {
      $('#scan-title').textContent = '本次刷卡未记录';
      $('#scan-help').textContent = error.message;
      toast(error.message, true);
    }
  }
}

function enqueueCard(uid) {
  cardQueue = cardQueue.then(() => handleCard(uid)).catch((error) => toast(error.message, true));
  return cardQueue;
}

function recordRow(record) {
  const complete = Boolean(record.check_out_at);
  return `<tr>
    <td class="record-person"><strong>${escapeHtml(record.name)}</strong><span>${escapeHtml(record.student_no)}</span></td>
    <td class="record-class">${escapeHtml(record.class_name)}</td>
    <td class="record-time">${escapeHtml(dateTime(record.check_in_at))}</td>
    <td class="record-time">${escapeHtml(dateTime(record.check_out_at))}</td>
    <td class="record-state ${complete ? 'done' : 'active'}"><b>${complete ? '已签退' : '在校'}</b><small>${complete ? `${record.duration_minutes} 分钟` : '计时中'}</small></td>
  </tr>`;
}

function renderRecords(container, records, emptyText) {
  $(container).innerHTML = records.length ? records.map(recordRow).join('') : `<tr><td colspan="5" class="list-empty"><span class="empty-lines" aria-hidden="true">≡</span><strong>${emptyText}</strong><small>刷卡后，记录将在这里显示</small></td></tr>`;
}

async function refreshDashboard() {
  const data = await request('/api/dashboard');
  $('#stat-students').textContent = data.stats.students;
  $('#stat-checkins').textContent = data.stats.todayCheckIns;
  $('#stat-present').textContent = data.stats.present;
  $('#stat-checkouts').textContent = data.stats.todayCheckOuts;
  $('#present-count').textContent = `${data.presentStudents.length} 人`;
  const presentRecords = data.presentStudents.map((item) => ({ ...item, check_out_at: null, duration_minutes: null }));
  renderRecords('#present-list', presentRecords, '暂无未签退学生');
}

async function loadHistory() {
  const form = new FormData($('#history-filter'));
  const params = new URLSearchParams();
  if (String(form.get('query') || '').trim()) params.set('query', String(form.get('query')).trim());
  if (form.get('date')) params.set('date', form.get('date'));
  const data = await request(`/api/attendance?${params}`);
  renderRecords('#history-list', data.records, '没有符合条件的考勤记录');
}

function renderReaderStatus(state) {
  const root = $('#reader-status');
  root.dataset.status = state.status;
  root.querySelector('span').textContent = state.status === 'connected'
    ? `${state.port || '串口'} 已连接`
    : state.status === 'starting' ? '正在连接读卡器' : '读卡器未连接';
  if (state.status === 'connected') {
    $('#reader-detail').textContent = `KL9007U 固件 ${state.firmware || '未知'} · 功率 ${state.power ?? '—'} dBm · EPC 十六进制读取正常`;
  } else {
    $('#reader-detail').textContent = state.error || '请检查 USB、电源和 COM 口，然后点击重连。';
  }
}

async function pollReader() {
  try {
    const state = await request('/api/reader/status');
    renderReaderStatus(state);
    if (!readerInitialized) {
      lastReaderEventId = Number(state.latestEventId || 0);
      readerInitialized = true;
      return;
    }
    const payload = await request(`/api/reader/events?after=${lastReaderEventId}`);
    for (const event of payload.events) {
      lastReaderEventId = Math.max(lastReaderEventId, event.id);
      await enqueueCard(event.uid);
    }
  } catch (error) {
    renderReaderStatus({ status: 'error', error: error.message });
  } finally {
    setTimeout(pollReader, 650);
  }
}

$('#scan-form').addEventListener('submit', (event) => {
  event.preventDefault();
  enqueueCard($('#uid').value);
  $('#uid').select();
});
$('#demo-card').addEventListener('click', async () => {
  try {
    await request('/api/reader/simulate', { method: 'POST', body: JSON.stringify({ uid: '10086001' }) });
    toast('模拟卡事件已发送');
  } catch (error) { toast(error.message, true); }
});
$('#reader-retry').addEventListener('click', async () => {
  try {
    await request('/api/reader/restart', { method: 'POST', body: '{}' });
    toast('正在重新连接读卡器');
  } catch (error) { toast(error.message, true); }
});
$('#clear-result').addEventListener('click', () => { clearResult(); $('#uid').focus(); });
$('#enroll-open').addEventListener('click', () => {
  if (!currentUid) return toast('请先读取一张陌生卡', true);
  $('#enroll-form [name="uid"]').value = currentUid;
  $('#enroll-dialog').showModal();
});
$('#enroll-close').addEventListener('click', () => $('#enroll-dialog').close());
$('#enroll-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  try {
    await request('/api/students', { method: 'POST', body: JSON.stringify(input) });
    $('#enroll-dialog').close();
    toast('学生卡绑定成功，正在签到');
    await enqueueCard(input.uid);
    const uid = input.uid;
    form.reset();
    form.querySelector('[name="uid"]').value = uid;
  } catch (error) { toast(error.message, true); }
});
$('#history-filter').addEventListener('submit', (event) => { event.preventDefault(); loadHistory().catch((error) => toast(error.message, true)); });
$('#history-reset').addEventListener('click', () => { $('#history-filter').reset(); loadHistory().catch((error) => toast(error.message, true)); });

function selectRecordTab(type) {
  for (const name of ['history', 'present']) {
    const selected = name === type;
    const tab = $(`#${name}-tab`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${name}-view`).hidden = !selected;
  }
}
for (const name of ['history', 'present']) {
  $(`#${name}-tab`).addEventListener('click', () => selectRecordTab(name));
  $(`#${name}-tab`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'history' : event.key === 'End' ? 'present' : name === 'history' ? 'present' : 'history';
    selectRecordTab(next);
    $(`#${next}-tab`).focus();
  });
}

clearResult();
Promise.all([refreshDashboard(), loadHistory()]).catch((error) => toast(error.message, true));
setInterval(() => refreshDashboard().catch(() => {}), 15000);
pollReader();
