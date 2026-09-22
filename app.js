/* =========================================================
 *  事项追踪 · 纯前端本地文件版
 *  技术栈：HTML + CSS + 原生 JavaScript（无框架、无构建）
 *  存储约定（强制）：不使用 localStorage / sessionStorage / Cookie /
 *  IndexedDB / 数据库 / 后端接口 / 网络请求。
 *  全部数据只存在于「内存 + 用户自己指定的本地 JSON 文件」。
 * ========================================================= */

/* ---------- 1. 常量与全局状态 ---------- */

// 内置固定状态及配色（待处理灰 / 处理中蓝 / 已完成绿 / 作废红）
const STATUS = {
  '待处理':   { color: '#6b7280', bg: '#f3f4f6' },
  '处理中':   { color: '#1d4ed8', bg: '#dbeafe' },
  '暂缓处理': { color: '#b45309', bg: '#fef3c7' },
  '已完成':   { color: '#15803d', bg: '#dcfce7' },
  '已作废':   { color: '#b91c1c', bg: '#fee2e2' }
};
const STATUS_LIST = Object.keys(STATUS);
const DEFAULT_STATUS = '待处理';

// 参与变更对比 / 日志记录的字段
const EDIT_FIELDS = [
  { key: 'title',    label: '标题' },
  { key: 'category', label: '分类' },
  { key: 'desc',     label: '描述' },
  { key: 'deadline', label: '截止时间' }
];

// 全局内存状态（刷新即空，必须从本地 JSON 文件导入还原）
const state = {
  events: [],        // 事件数组
  systemLogs: [],    // 全局操作日志（删除事件后仍可追溯）
  fileHandle: null,  // File System Access API 文件句柄
  fileName: '',
  dirty: false,      // 是否有未写入文件的改动
  autoDownload: false,
  filters: { keyword: '', status: 'ALL', category: 'ALL', sort: 'createTime', order: 'desc' },
  editingId: null,   // 当前编辑的事件 id（null = 新增）
  progressId: null,  // 当前添加进度的事件 id
  detailId: null
};

// 浏览器是否支持直连本地文件（Chrome / Edge 支持，Firefox 走上传下载兜底）
const FS_SUPPORT = typeof window.showOpenFilePicker === 'function';

/* ---------- 2. 通用工具函数 ---------- */

function pad(n) { return String(n).padStart(2, '0'); }

// 当前时间：YYYY-MM-DD HH:mm:ss（精确到秒）
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 唯一 ID：时间戳 + 随机串，保证不重复
function genId() {
  return 'E' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// HTML 转义，防止内容破坏页面结构
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 时间字符串 -> 毫秒（用于排序 / 逾期判断）
function toTs(t) {
  if (!t) return 0;
  const ms = new Date(String(t).replace(' ', 'T')).getTime();
  return isNaN(ms) ? 0 : ms;
}

// 截止时间展示（datetime-local 存的是 2026-09-30T18:00）
function fmtDeadline(t) { return t ? String(t).replace('T', ' ') : ''; }

function findEvent(id) { return state.events.find(e => e.id === id) || null; }

function $(id) { return document.getElementById(id); }

/* ---------- 3. 轻提示 / 确认弹窗 ---------- */

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

let confirmResolve = null;
function confirmBox(title, text, okText = '确定') {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okText;
  $('modalConfirm').hidden = false;
  return new Promise(res => { confirmResolve = res; });
}
function closeConfirm(result) {
  $('modalConfirm').hidden = true;
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

/* ---------- 4. 弹窗开关 ---------- */

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

// 关闭按钮 / 遮罩层：绑定事件委托
document.addEventListener('click', e => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) {
    const modal = closeBtn.closest('.modal');
    if (modal) modal.hidden = true;
    return;
  }
  if (e.target.classList.contains('mask')) {
    const modal = e.target.closest('.modal');
    if (modal && modal.id !== 'modalSource') modal.hidden = true;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach(m => { if (m.id !== 'modalSource') m.hidden = true; });
  }
});

/* ---------- 5. 本地 JSON 文件：读取 / 写入 / 导出 ---------- */

// 组装待保存的完整数据结构
function serialize() {
  return {
    app: '事项追踪',
    version: 1,
    exportTime: nowStr(),
    events: state.events,
    systemLogs: state.systemLogs
  };
}

// 解析并校验导入的 JSON
function deserialize(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('文件内容不是合法的 JSON 对象');
  if (!Array.isArray(obj.events)) throw new Error('文件缺少 events 事件数组');
  state.events = obj.events.map(normalizeEvent);
  state.systemLogs = Array.isArray(obj.systemLogs) ? obj.systemLogs : [];
}

// 补全字段，兼容手工编辑过的 JSON
function normalizeEvent(e) {
  return {
    id: e.id || genId(),
    title: String(e.title || '未命名事件'),
    category: String(e.category || ''),
    desc: String(e.desc || ''),
    createTime: e.createTime || nowStr(),
    deadline: String(e.deadline || ''),
    status: STATUS[e.status] ? e.status : DEFAULT_STATUS,
    progress: Math.min(100, Math.max(0, Number(e.progress) || 0)),
    progressLog: Array.isArray(e.progressLog) ? e.progressLog : [],
    logs: Array.isArray(e.logs) ? e.logs : []
  };
}

// 触发浏览器下载 JSON 文件（兜底保存方式 / 手动备份）
function downloadJSON(text, filename) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || ('事项追踪数据_' + nowStr().replace(/[-: ]/g, '') + '.json');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 检查 / 申请文件写入权限
async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

// 统一落盘入口：每一次增删改后调用
async function persist(silent) {
  const text = JSON.stringify(serialize(), null, 2);

  if (state.fileHandle) {
    try {
      if (await ensurePermission(state.fileHandle)) {
        const w = await state.fileHandle.createWritable();
        await w.write(text);
        await w.close();
        state.dirty = false;
        updateFileInfo();
        if (!silent) toast('已保存到 ' + state.fileName, 'ok');
        return true;
      }
      toast('文件写入权限被拒绝，请改用「导出备份文件」', 'warn');
    } catch (err) {
      toast('写入文件失败：' + err.message, 'err');
    }
  }

  // 未连接文件：标记为未保存，并按开关自动下载
  state.dirty = true;
  updateFileInfo();
  if (state.autoDownload) downloadJSON(text);
  return false;
}

// 顶部文件状态标签
function updateFileInfo() {
  const dot = $('saveDot'), text = $('fileText');
  if (state.fileHandle) {
    dot.className = 'dot ' + (state.dirty ? 'unsaved' : 'ok');
    text.textContent = (state.dirty ? '● 有改动未保存 · ' : '已连接 · ') + state.fileName;
  } else if (state.events.length) {
    dot.className = 'dot unsaved';
    text.textContent = '未连接文件 · 请导出保存';
  } else {
    dot.className = 'dot';
    text.textContent = '未连接数据文件';
  }
}

// 新建空白数据文件（Chrome / Edge 直连）
async function createNewFile() {
  if (!FS_SUPPORT) { fallbackNewFile(); return; }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: '事项追踪数据.json',
      types: [{ description: 'JSON 数据文件', accept: { 'application/json': ['.json'] } }]
    });
    state.fileHandle = handle;
    state.fileName = handle.name;
    await rememberHandle(handle);          // 记住该文件，下次打开免选
    if (state.events.length === 0) addLog({ type: '新建数据文件', detail: '创建空白数据文件：' + handle.name });
    await persist(true);
    hideRestoreBar();
    toast('已创建并连接数据文件：' + handle.name, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') toast('创建文件失败：' + err.message, 'err');
  }
}

// 导入已有数据文件
async function importFile() {
  if (FS_SUPPORT) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'JSON 数据文件', accept: { 'application/json': ['.json'] } }]
      });
      const text = await (await handle.getFile()).text();
      loadText(text, handle.name);
      state.fileHandle = handle;
      state.fileName = handle.name;
      await rememberHandle(handle);      // 记住该文件，下次打开免选
      hideRestoreBar();
      updateFileInfo();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      toast('导入失败：' + err.message, 'err');
      return;
    }
  }
  $('fileInput').click(); // 兜底：普通文件选择
}

// 兜底：新建文件 = 导出一份空白 JSON 让用户保存
function fallbackNewFile() {
  downloadJSON(JSON.stringify(serialize(), null, 2), '事项追踪数据.json');
  toast('已生成数据文件，保存后可用「导入数据文件」打开', 'warn');
}

// 解析文本并载入
function loadText(text, name) {
  try {
    deserialize(JSON.parse(text));
    addLog({ type: '导入数据', detail: '导入数据文件：' + name + '，共 ' + state.events.length + ' 条事件' });
    renderAll();
    closeModal('modalSource');
    toast('已导入 ' + state.events.length + ' 条事件', 'ok');
  } catch (err) {
    toast('文件解析失败：' + err.message, 'err');
  }
}

/* ---------- 5.5 记住上次的数据文件（刷新后免重新选择） ----------
 * 说明：这里只在浏览器本地保存「文件句柄引用」（相当于记住文件地址），
 *      绝不保存任何事件数据 —— 业务数据始终只存在于用户自己的 JSON 文件中。
 *      即使该记录被浏览器清空，也只需重新选择一次文件，数据不会丢失。
 */
const HANDLE_DB = '事项追踪_文件句柄库';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'lastDataFile';

// 打开（必要时创建）句柄存储
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 写入 / 读取 / 删除句柄
function idbWrite(mode, fn) {
  return openHandleDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, mode);
    const req = fn(tx.objectStore(HANDLE_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}
const rememberHandle = h => idbWrite('readwrite', s => s.put(h, HANDLE_KEY)).catch(() => {});
const readHandle = () => idbWrite('readonly', s => s.get(HANDLE_KEY)).catch(() => null);
const forgetHandle = () => idbWrite('readwrite', s => s.delete(HANDLE_KEY)).catch(() => {});

// 从已保存的句柄读取文件内容
async function loadFromHandle(handle) {
  try {
    const text = await (await handle.getFile()).text();
    loadText(text, handle.name);
    state.fileHandle = handle;
    state.fileName = handle.name;
    state.dirty = false;
    hideRestoreBar();
    closeModal('modalSource');
    updateFileInfo();
    toast('已自动载入 ' + handle.name, 'ok');
  } catch (err) {
    toast('读取已记住的文件失败：' + err.message + '，请重新选择', 'err');
    state.fileHandle = null; state.fileName = '';
    openSourceModal();
  }
}

// 刷新后尝试恢复：权限仍在则直接载入，否则显示「恢复连接」按钮
async function tryRestoreHandle() {
  if (!FS_SUPPORT) return false;
  const handle = await readHandle();
  if (!handle) return false;

  state.fileHandle = handle;
  state.fileName = handle.name;
  updateFileInfo();

  let perm = 'prompt';
  try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* 忽略 */ }

  if (perm === 'granted') { await loadFromHandle(handle); return true; }
  showRestoreBar(handle);
  return true;
}

function showRestoreBar(handle) {
  $('restoreText').textContent = '已记住上次的数据文件「' + handle.name + '」，点击右侧按钮即可继续读写（浏览器要求每次打开页面确认一次授权）。';
  $('restoreBar').hidden = false;
}
function hideRestoreBar() { $('restoreBar').hidden = true; }

/* ---------- 6. 操作日志 ---------- */

/**
 * 记录一条操作日志
 * @param {Object} o {type, eventId, title, detail, changes}
 */
function addLog(o) {
  const entry = {
    id: genId(),
    type: o.type,
    time: nowStr(),
    eventId: o.eventId || '',
    title: o.title || '',
    detail: o.detail || '',
    changes: o.changes || []
  };
  if (o.eventId) {                       // 事件内日志（随事件一起保存）
    const ev = findEvent(o.eventId);
    if (ev) ev.logs.push(entry);
  }
  state.systemLogs.push(entry);          // 全局日志（删除事件后依然可追溯）
  if (state.systemLogs.length > 5000) state.systemLogs.splice(0, state.systemLogs.length - 5000);
}

// 对比修改前后，产出变更明细
function diffChanges(oldEv, newEv, fields) {
  const changes = [];
  fields.forEach(f => {
    const a = String(oldEv[f.key] == null ? '' : oldEv[f.key]);
    const b = String(newEv[f.key] == null ? '' : newEv[f.key]);
    if (a !== b) changes.push({ label: f.label, old: a || '（空）', new: b || '（空）' });
  });
  return changes;
}

/* ---------- 7. 渲染 ---------- */

// 当前筛选 + 排序后的列表
function getVisibleEvents() {
  const f = state.filters;
  const kw = f.keyword.trim().toLowerCase();

  let list = state.events.filter(e => {
    if (kw) {
      const hay = [e.title, e.desc, e.category].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (f.status !== 'ALL' && e.status !== f.status) return false;
    if (f.category !== 'ALL') {
      const c = e.category || '未分类';
      if (c !== f.category) return false;
    }
    return true;
  });

  const dir = f.order === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let r = 0;
    if (f.sort === 'deadline') {
      const av = a.deadline ? toTs(a.deadline) : Infinity;   // 无截止时间排最后
      const bv = b.deadline ? toTs(b.deadline) : Infinity;
      r = av - bv;
    } else if (f.sort === 'progress') {
      r = (a.progress || 0) - (b.progress || 0);
    } else {
      r = toTs(a.createTime) - toTs(b.createTime);
    }
    if (r === 0) r = a.id < b.id ? -1 : 1;
    return r * dir;
  });
  return list;
}

function renderAll() {
  renderStats();
  renderCategoryOptions();
  renderCards();
  updateFileInfo();
}

// 统计卡片：可点击筛选对应状态（再次点击取消筛选）
function renderStats() {
  const cur = state.filters.status;
  let html = statCard('ALL', '事件总数', state.events.length, cur === 'ALL', '点击查看全部');
  STATUS_LIST.forEach(s => {
    const n = state.events.filter(e => e.status === s).length;
    html += statCard(s, s, n, cur === s, cur === s ? '点击取消筛选' : '点击只看此类');
  });
  $('stats').innerHTML = html;
}

function statCard(status, label, num, active, hint) {
  return `<div class="stat-card s-${label} ${active ? 'active' : ''}" data-status="${esc(status)}" title="${esc(hint)}">
    <div class="v">${num}</div>
    <div class="k"><span>${esc(label)}</span><span class="hint">${esc(hint)}</span></div>
  </div>`;
}

function renderCategoryOptions() {
  const cats = [...new Set(state.events.map(e => e.category || '未分类'))].sort();
  const sel = $('filterCategory');
  const cur = state.filters.category;
  sel.innerHTML = '<option value="ALL">全部分类</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = cats.includes(cur) ? cur : 'ALL';
  state.filters.category = sel.value;

  // 分类输入联想
  $('categoryList').innerHTML = cats.filter(c => c !== '未分类').map(c => `<option value="${esc(c)}">`).join('');
}

function renderCards() {
  const list = getVisibleEvents();
  const box = $('eventList');
  $('emptyState').hidden = state.events.length !== 0;

  if (state.events.length === 0) { box.innerHTML = ''; return; }
  if (list.length === 0) {
    box.innerHTML = `<div class="no-data" style="grid-column:1/-1">没有符合当前筛选条件的事件</div>`;
    return;
  }

  box.innerHTML = list.map(e => {
    const st = STATUS[e.status] || STATUS[DEFAULT_STATUS];
    const done = e.status === '已完成';
    const invalid = e.status === '已作废';
    const barColor = invalid ? '#9ca3af' : (e.progress >= 100 ? '#16a34a' : '#2563eb');

    // 逾期判断
    let deadlineHtml = '';
    if (e.deadline) {
      const over = toTs(e.deadline) < Date.now() && !done && !invalid;
      deadlineHtml = `<span class="chip ${over ? 'warn' : ''}">截止 ${fmtDeadline(e.deadline)}${over ? '（已逾期）' : ''}</span>`;
    }

    // 最新进展：直接展示最后一条跟进内容 + 时间，无需点开
    const last = e.progressLog.length ? e.progressLog[e.progressLog.length - 1] : null;
    const stepCls = invalid ? 'invalid' : (done ? 'done' : (e.status === '暂缓处理' ? 'hold' : ''));
    const stepHtml = last
      ? `<div class="step-box ${stepCls}">
           <div class="step-head">
             <span class="step-tag">最新进展 · 第 ${e.progressLog.length} 步</span>
             <span>${esc(last.time)} · ${last.progress}%</span>
           </div>
           <div class="step-text">${esc(last.content)}</div>
         </div>`
      : `<div class="step-empty">暂无进展记录 · 点「＋ 加进度」写下第一步</div>`;

    return `
    <div class="card">
      <div class="card-top">
        <div class="card-title ${done || invalid ? 'done' : ''}">${esc(e.title)}</div>
        <span class="badge" style="color:${st.color};background:${st.bg}">${esc(e.status)}</span>
      </div>
      <div class="card-meta">
        <span class="chip">${esc(e.category || '未分类')}</span>
        <span class="chip">创建 ${esc(e.createTime)}</span>
        ${deadlineHtml}
        <span class="chip">共 ${e.progressLog.length} 条跟进</span>
      </div>
      ${e.desc ? `<div class="card-desc">${esc(e.desc)}</div>` : ''}
      ${stepHtml}
      <div class="bar-wrap">
        <span class="pct" style="color:${barColor}">${e.progress}%</span>
        <div class="bar"><div class="bar-inner" style="width:${e.progress}%;background:${barColor}"></div></div>
      </div>
      <div class="card-foot">
        <button class="mini-btn primary" data-act="progress" data-id="${e.id}" title="记录这一步做了什么">＋ 加进度</button>
        <button class="mini-btn" data-act="log" data-id="${e.id}">日志</button>
        <button class="mini-btn ${done ? 'undo' : 'ok'}" data-act="done" data-id="${e.id}" title="${done ? '撤销完成，回到处理中' : '快速标记为已完成'}">${done ? '撤销完成' : '✓ 标记完成'}</button>
        <span class="grow"></span>
        <button class="mini-btn" data-act="edit" data-id="${e.id}">编辑</button>
        <button class="mini-btn del" data-act="del" data-id="${e.id}">删除</button>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 8. 事件 CRUD ---------- */

// 打开新增 / 编辑弹窗
function openEventModal(id) {
  state.editingId = id || null;
  const ev = id ? findEvent(id) : null;

  $('eventModalTitle').textContent = ev ? '编辑事件' : '新增事件';
  $('fTitle').value = ev ? ev.title : '';
  $('fCategory').value = ev ? ev.category : '';
  $('fDesc').value = ev ? ev.desc : '';
  $('fDeadline').value = ev ? ev.deadline : '';
  $('fStatus').innerHTML = STATUS_LIST.map(s => `<option value="${s}" ${ev && ev.status === s ? 'selected' : ''}>${s}</option>`).join('');
  $('fProgress').value = ev ? ev.progress : 0;
  $('editOnlyRow').hidden = !ev;      // 新增时固定为「待处理 / 0%」
  $('eventError').hidden = true;

  openModal('modalEvent');
  setTimeout(() => $('fTitle').focus(), 50);
}

// 保存新增 / 编辑
async function saveEvent() {
  const title = $('fTitle').value.trim();
  if (!title) {                        // 必填校验
    $('eventError').textContent = '事件标题不能为空';
    $('eventError').hidden = false;
    $('fTitle').focus();
    return;
  }

  // 表单取值
  const form = {
    title,
    category: $('fCategory').value.trim(),
    desc: $('fDesc').value.trim(),
    deadline: $('fDeadline').value
  };
  let needFinish = false;   // 是否需要提示切换为「已完成」

  if (state.editingId) {
    const old = findEvent(state.editingId);
    if (!old) return;
    const before = Object.assign({}, old);

    // 基础字段
    Object.assign(old, form);

    // 基础字段变更 -> 编辑事件日志
    const baseChanges = diffChanges(before, old, EDIT_FIELDS);
    if (baseChanges.length) {
      addLog({ type: '编辑事件', eventId: old.id, title: old.title, changes: baseChanges });
    }

    // 状态变更
    const newStatus = $('fStatus').value;
    if (before.status !== newStatus) {
      addLog({
        type: '修改状态', eventId: old.id, title: old.title,
        changes: [{ label: '状态', old: before.status, new: newStatus }]
      });
      old.status = newStatus;
    }

    // 进度变更
    const newProgress = clampProgress($('fProgress').value);
    if (before.progress !== newProgress) {
      old.progress = newProgress;
      old.progressLog.push({ time: nowStr(), content: '直接更新进度为 ' + newProgress + '%', progress: newProgress });
      addLog({
        type: '更新进度', eventId: old.id, title: old.title,
        changes: [{ label: '进度', old: before.progress + '%', new: newProgress + '%' }]
      });
      needFinish = newProgress >= 100;
    }
    toast('事件已更新', 'ok');
  } else {
    // 新增
    const ev = {
      id: genId(),
      title: form.title,
      category: form.category,
      desc: form.desc,
      createTime: nowStr(),
      deadline: form.deadline,
      status: DEFAULT_STATUS,
      progress: 0,
      progressLog: [],
      logs: []
    };
    state.events.push(ev);
    addLog({ type: '新增事件', eventId: ev.id, title: ev.title, detail: '创建事件，初始状态：' + DEFAULT_STATUS + '，进度 0%' });
    toast('事件已新增', 'ok');
  }

  closeModal('modalEvent');
  renderAll();
  await persist();

  // 进度达到 100% 时，询问是否自动切换为「已完成」
  if (needFinish && state.editingId) {
    const ok = await askFinish(state.editingId);
    if (ok) { renderAll(); await persist(); }
  }
  state.editingId = null;
}

function clampProgress(v) {
  const n = Number(v);
  if (isNaN(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// 一键完成 / 撤销完成（无需二次确认，快速切换）
async function toggleDone(id) {
  const ev = findEvent(id);
  if (!ev) return;

  if (ev.status === '已完成') {
    const before = ev.status;
    ev.status = '处理中';
    addLog({ type: '修改状态', eventId: ev.id, title: ev.title, changes: [{ label: '状态', old: before, new: '处理中' }] });
    toast('已撤销完成，回到「处理中」', 'ok');
  } else {
    const before = ev.status, beforeP = ev.progress;
    ev.status = '已完成';
    if (beforeP < 100) {                       // 一键完成时自动把进度补齐到 100%
      ev.progress = 100;
      ev.progressLog.push({ time: nowStr(), content: '一键标记为已完成', progress: 100 });
      addLog({ type: '更新进度', eventId: ev.id, title: ev.title, changes: [{ label: '进度', old: beforeP + '%', new: '100%' }] });
    }
    addLog({ type: '修改状态', eventId: ev.id, title: ev.title, changes: [{ label: '状态', old: before, new: '已完成' }] });
    toast('已标记为「已完成」', 'ok');
  }

  renderAll();
  await persist();
}

// 删除事件（含二次确认）
async function deleteEvent(id) {
  const ev = findEvent(id);
  if (!ev) return;
  const ok = await confirmBox(
    '删除确认',
    `确定删除事件「${ev.title}」吗？\n该事件的所有进度日志与操作日志将一并删除，且不可恢复。`,
    '确认删除'
  );
  if (!ok) return;

  state.events = state.events.filter(e => e.id !== id);
  addLog({ type: '删除事件', eventId: id, title: ev.title, detail: '删除事件，同时清除 ' + ev.progressLog.length + ' 条进度日志' });
  toast('事件已删除', 'ok');
  renderAll();
  await persist();
}

/* ---------- 9. 进度跟进 ---------- */

function openProgressModal(id) {
  const ev = findEvent(id);
  if (!ev) return;
  state.progressId = id;
  $('progressModalTitle').textContent = '进度跟进 · ' + ev.title;
  $('pValue').value = ev.progress;
  $('pContent').value = '';
  $('progressError').hidden = true;
  renderProgressHistory(ev);
  openModal('modalProgress');
  setTimeout(() => $('pContent').focus(), 50);
}

function renderProgressHistory(ev) {
  const list = ev.progressLog.slice().reverse();
  $('progressHistory').innerHTML = list.length
    ? list.map(p => `
      <div class="item done">
        <div class="t">${esc(p.time)} · 进度 ${p.progress}%</div>
        <div class="c">${esc(p.content)}</div>
      </div>`).join('')
    : '<div class="no-data">暂无进度记录</div>';
}

async function saveProgress() {
  const ev = findEvent(state.progressId);
  if (!ev) return;
  const content = $('pContent').value.trim();
  if (!content) {
    $('progressError').textContent = '请填写跟进备注';
    $('progressError').hidden = false;
    return;
  }
  const next = clampProgress($('pValue').value);
  const before = ev.progress;

  ev.progress = next;
  ev.progressLog.push({ time: nowStr(), content, progress: next });

  const changes = before === next ? [] : [{ label: '进度', old: before + '%', new: next + '%' }];
  addLog({ type: '更新进度', eventId: ev.id, title: ev.title, detail: '跟进备注：' + content, changes });

  toast('进度已记录', 'ok');
  renderProgressHistory(ev);
  $('pContent').value = '';
  renderAll();
  await persist();

  // 进度 100% 提示切换为「已完成」
  if (next >= 100) {
    const ok = await askFinish(ev.id);
    if (ok) { renderProgressHistory(ev); renderAll(); await persist(); }
  }
}

// 进度到 100% 时询问是否标记为已完成
async function askFinish(id) {
  const ev = findEvent(id);
  if (!ev || ev.status === '已完成' || ev.status === '已作废') return false;
  const ok = await confirmBox('进度已完成', `「${ev.title}」进度已达 100%，是否将状态切换为「已完成」？`, '切换为已完成');
  if (!ok) return false;
  const before = ev.status;
  ev.status = '已完成';
  addLog({ type: '修改状态', eventId: ev.id, title: ev.title, changes: [{ label: '状态', old: before, new: '已完成' }] });
  toast('状态已更新为「已完成」', 'ok');
  return true;
}

/* ---------- 10. 详情 / 日志查看 ---------- */

function openDetailModal(id) {
  const ev = findEvent(id);
  if (!ev) return;
  state.detailId = id;
  $('detailTitle').textContent = ev.title;
  switchTab('info');
  openModal('modalDetail');
}

function switchTab(name) {
  document.querySelectorAll('#detailTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['info', 'progress', 'log'].forEach(n => { $('panel-' + n).hidden = n !== name; });
  renderDetailPanels();
}

function renderDetailPanels() {
  const ev = findEvent(state.detailId);
  if (!ev) return;
  const st = STATUS[ev.status] || STATUS[DEFAULT_STATUS];

  $('panel-info').innerHTML = `
    <div class="kv"><div class="k">标题</div><div class="v">${esc(ev.title)}</div></div>
    <div class="kv"><div class="k">分类</div><div class="v">${esc(ev.category || '（空）')}</div></div>
    <div class="kv"><div class="k">状态</div><div class="v"><span class="badge" style="color:${st.color};background:${st.bg}">${esc(ev.status)}</span></div></div>
    <div class="kv"><div class="k">进度</div><div class="v">${ev.progress}%</div></div>
    <div class="kv"><div class="k">创建时间</div><div class="v">${esc(ev.createTime)}</div></div>
    <div class="kv"><div class="k">截止时间</div><div class="v">${esc(fmtDeadline(ev.deadline) || '（未设置）')}</div></div>
    <div class="kv"><div class="k">事件 ID</div><div class="v">${esc(ev.id)}</div></div>
    <div class="kv"><div class="k">描述</div><div class="v">${esc(ev.desc || '（空）')}</div></div>`;

  const pl = ev.progressLog.slice().reverse();
  $('panel-progress').innerHTML = pl.length ? pl.map(p => `
      <div class="item done">
        <div class="t">${esc(p.time)} · 进度 ${p.progress}%</div>
        <div class="c">${esc(p.content)}</div>
      </div>`).join('') : '<div class="no-data">暂无进度跟进记录</div>';

  const ll = ev.logs.slice().reverse();
  $('panel-log').innerHTML = ll.length ? ll.map(l => logItemHtml(l)).join('') : '<div class="no-data">暂无操作日志</div>';
}

function logItemHtml(l) {
  const cls = l.type === '删除事件' ? 'del' : (l.type === '新增事件' ? 'new' : '');
  let html = `<div class="item ${cls}">
      <div class="t">${esc(l.time)} · ${esc(l.type)}${l.title ? ' · ' + esc(l.title) : ''}</div>`;
  if (l.detail) html += `<div class="c">${esc(l.detail)}</div>`;
  (l.changes || []).forEach(c => {
    html += `<div class="change"><b>${esc(c.label)}</b>：${esc(c.old)} → ${esc(c.new)}</div>`;
  });
  return html + '</div>';
}

// 全部日志弹窗
function openAllLogs() {
  renderAllLogs();
  openModal('modalLogs');
}

function renderAllLogs() {
  const kw = $('logSearch').value.trim().toLowerCase();
  let list = state.systemLogs.slice().reverse();
  if (kw) {
    list = list.filter(l => {
      const hay = [l.type, l.title, l.detail, (l.changes || []).map(c => c.label + c.old + c.new).join('')].join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }
  $('allLogList').innerHTML = list.length ? list.map(l => logItemHtml(l)).join('') : '<div class="no-data">暂无日志记录</div>';
}

/* ---------- 11. 事件绑定 ---------- */

function bindEvents() {
  // 顶部按钮
  $('btnNew').onclick = () => openEventModal(null);
  $('emptyNew').onclick = () => openEventModal(null);
  $('btnImport').onclick = importFile;
  $('btnExport').onclick = () => {
    downloadJSON(JSON.stringify(serialize(), null, 2));
    addLog({ type: '导出备份', detail: '手动导出备份文件，共 ' + state.events.length + ' 条事件' });
    toast('备份文件已下载', 'ok');
    if (state.fileHandle) persist(true);
  };
  $('btnAllLogs').onclick = openAllLogs;
  $('fileInfo').onclick = openSourceModal;

  // 恢复连接 / 忘记已记住的文件
  $('btnRestore').onclick = async () => {
    const h = state.fileHandle || await readHandle();
    if (!h) return;
    let granted = false;
    try { granted = (await h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { /* 忽略 */ }
    if (granted) { await rememberHandle(h); await loadFromHandle(h); }
    else toast('未获得文件访问权限，请重新选择数据文件', 'warn');
  };
  $('btnForget').onclick = async () => {
    await forgetHandle();
    state.fileHandle = null; state.fileName = ''; state.dirty = false;
    hideRestoreBar(); updateFileInfo();
    toast('已忘记该文件，下次需重新选择', 'ok');
    openSourceModal();
  };
  $('srcForget').onclick = $('btnForget').onclick;

  // 数据源弹窗
  $('srcNew').onclick = async () => { await createNewFile(); closeModal('modalSource'); renderAll(); };
  $('srcImport').onclick = async () => { await importFile(); renderAll(); };
  $('srcLater').onclick = () => closeModal('modalSource');

  // 兜底文件选择
  $('fileInput').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), f.name);
    reader.readAsText(f, 'utf-8');
    e.target.value = '';
  };

  // 拖拽导入
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), f.name);
    reader.readAsText(f, 'utf-8');
  });

  // 搜索 / 筛选 / 排序
  $('searchInput').oninput = e => { state.filters.keyword = e.target.value; renderCards(); };
  $('clearSearch').onclick = () => { $('searchInput').value = ''; state.filters.keyword = ''; renderCards(); };
  $('filterStatus').onchange = e => { state.filters.status = e.target.value; renderCards(); };
  $('filterCategory').onchange = e => { state.filters.category = e.target.value; renderCards(); };
  $('sortBy').onchange = e => { state.filters.sort = e.target.value; renderCards(); };
  $('sortOrder').onclick = e => {
    state.filters.order = state.filters.order === 'desc' ? 'asc' : 'desc';
    e.target.textContent = state.filters.order === 'desc' ? '降序 ↓' : '升序 ↑';
    renderCards();
  };
  $('autoDownload').onchange = e => { state.autoDownload = e.target.checked; };

  // 表单按钮
  $('saveEvent').onclick = saveEvent;
  $('saveProgress').onclick = saveProgress;
  $('quickProgress').onclick = e => {
    const b = e.target.closest('button');
    if (b) $('pValue').value = b.dataset.v;
  };

  // 确认弹窗
  $('confirmOk').onclick = () => closeConfirm(true);
  $('confirmCancel').onclick = () => closeConfirm(false);

  // 详情 tabs
  $('detailTabs').onclick = e => {
    const t = e.target.closest('.tab');
    if (t) switchTab(t.dataset.tab);
  };
  $('logSearch').oninput = renderAllLogs;

  // 卡片按钮（事件委托）
  $('eventList').onclick = e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'edit') openEventModal(id);
    if (btn.dataset.act === 'del') deleteEvent(id);
    if (btn.dataset.act === 'done') toggleDone(id);
    if (btn.dataset.act === 'progress') openProgressModal(id);
    if (btn.dataset.act === 'log') openDetailModal(id);
  };

  // 统计卡片：点击筛选对应状态，再点一次取消筛选
  $('stats').onclick = e => {
    const card = e.target.closest('.stat-card');
    if (!card) return;
    const s = card.dataset.status;
    state.filters.status = (state.filters.status === s && s !== 'ALL') ? 'ALL' : s;
    $('filterStatus').value = state.filters.status;   // 同步顶部下拉
    renderAll();
  };

  // 离开页面前提醒未保存改动（不写入任何浏览器缓存）
  window.onbeforeunload = e => {
    if (state.dirty && state.events.length) { e.preventDefault(); e.returnValue = ''; }
  };
}

/* ---------- 12. 初始化 ---------- */

// 打开数据源选择弹窗（会根据是否已记住文件调整文案）
function openSourceModal() {
  $('sourceTip').textContent = state.fileHandle
    ? '已记住数据文件：' + state.fileName + '。刷新页面后会自动连接，无需重新选择。'
    : '本工具不使用浏览器缓存，数据全部存放在你自己指定的本地 JSON 文件中。';
  $('srcForget').hidden = !state.fileHandle;
  openModal('modalSource');
}

async function init() {
  // 状态筛选下拉
  $('filterStatus').innerHTML = '<option value="ALL">全部状态</option>' +
    STATUS_LIST.map(s => `<option value="${s}">${s}</option>`).join('');

  bindEvents();
  renderAll();

  // 以 file:// 方式双击打开时，浏览器禁用本地文件直连与记忆能力，必须提示
  if (location.protocol === 'file:') {
    $('protoText').textContent = '当前是「双击 HTML 文件」方式打开，浏览器出于安全限制禁止网页记住并直连本地文件，因此刷新后必须重新导入。请关闭本页，双击「启动.bat」打开即可自动记住数据文件。';
    $('protoBar').hidden = false;
  } else if (!FS_SUPPORT) {
    $('protoText').textContent = '当前浏览器不支持本地文件直连（Chrome / Edge 支持），只能通过「导入数据文件 / 导出备份文件」保存数据，刷新后需重新导入。';
    $('protoBar').hidden = false;
  }

  // 尝试自动恢复上次的数据文件；失败才弹选择框
  const restored = await tryRestoreHandle();
  if (!restored) openSourceModal();
}

init();
