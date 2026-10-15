// src/renderer/settings/settings.js
// 日程管理界面（浏览器世界，碰不到系统；要读写一律走 window.settingsAPI → 主进程）。
//
// 它只管三件事：把日程列出来、让主人填表、把填好的东西交上去。
//
// ⚠ 校验只做「不填就拦一下」的轻量提示（不然主人会一头雾水），
//   真正的规则校验全部交给主进程的 schedules.js —— 免得两套规则不一致，
//   出现「界面上说没问题、存盘却被拒」这种怪事。

const api = window.settingsAPI;

// ---------- 元素 ----------
const el = {
  form: document.getElementById('form'),
  formTitle: document.getElementById('form-title'),
  title: document.getElementById('f-title'),
  time: document.getElementById('f-time'),
  kind: document.getElementById('f-kind'),
  endTime: document.getElementById('f-endtime'),
  rowEndTime: document.getElementById('row-endtime'),
  repeat: document.getElementById('f-repeat'),
  date: document.getElementById('f-date'),
  rowDate: document.getElementById('row-date'),
  rowWeekdays: document.getElementById('row-weekdays'),
  wdList: document.getElementById('wd-list'),
  formError: document.getElementById('form-error'),
  list: document.getElementById('list'),
  listWrap: document.querySelector('.list-wrap'),
  empty: document.getElementById('empty'),
  week: document.getElementById('week'),
  weekHead: document.getElementById('week-head'),
  weekGrid: document.getElementById('week-grid'),
  weekCanvas: document.getElementById('week-canvas'),
  btnAdd: document.getElementById('btn-add'),
  btnPreview: document.getElementById('btn-preview'),
  btnWeek: document.getElementById('btn-week'),
  btnCancel: document.getElementById('btn-cancel'),
  btnSave: document.getElementById('btn-save'),
  // 专注页（v3）
  btnFocus: document.getElementById('btn-focus'),
  focusPage: document.getElementById('focus-page'),
  btnFocusBack: document.getElementById('btn-focus-back'),
  fDomainInput: document.getElementById('f-domain-input'),
  btnAddDomain: document.getElementById('btn-add-domain'),
  focusDomains: document.getElementById('focus-domains'),
  fExeInput: document.getElementById('f-exe-input'),
  btnAddExe: document.getElementById('btn-add-exe'),
  focusExes: document.getElementById('focus-exes'),
  // v4 批次 1：已安装软件选择器
  btnBrowseApps: document.getElementById('btn-browse-apps'),
  appPicker: document.getElementById('app-picker'),
  pickerPanel: document.querySelector('.picker-panel'),
  btnPickerClose: document.getElementById('btn-picker-close'),
  pickerSearch: document.getElementById('picker-search'),
  pickerGrid: document.getElementById('picker-grid'),
  pickerEmpty: document.getElementById('picker-empty'),
  pickerCount: document.getElementById('picker-count'),
  pickerHint: document.getElementById('picker-hint'),
  btnPickerRescan: document.getElementById('btn-picker-rescan'),
  focusError: document.getElementById('focus-error'),
  focusDoh: document.getElementById('focus-doh'),
  focusPresets: document.getElementById('focus-presets'),
  focusCustomRow: document.getElementById('focus-custom-row'),
  fCustomMin: document.getElementById('f-custom-min'),
  btnCustomOk: document.getElementById('btn-custom-ok'),
  focusIdle: document.getElementById('focus-idle'),
  focusRunning: document.getElementById('focus-running'),
  btnFocusStart: document.getElementById('btn-focus-start'),
  btnFocusStop: document.getElementById('btn-focus-stop'),
  focusCountdown: document.getElementById('focus-countdown'),
  focusRingFg: document.getElementById('focus-ring-fg'),
  focusStopHint: document.getElementById('focus-stop-hint'),
};

// 星期几的显示顺序按中文习惯：周一在前、周日在最后。
// 但存进文件的数字是 JS 的 getDay() 规则（0 = 周日），所以这里要把两件事分开。
const WEEKDAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
const REPEAT_LABEL = { once: '只一次', daily: '每天', weekdays: '工作日', weekly: '每周' };

let items = [];
let editingId = null;    // null = 正在新增；否则是正在改的那条 id
let pendingDelete = null; // 「删」要按两下才真删，这里记着第一下的状态
let mode = 'list';        // 'list' | 'week' | 'focus'
let weekData = null;      // 最近一次从主进程拿到的周视图布局

// ---- 专注页的状态（v3）----
let focusData = null;      // 最近一次从主进程拿到的专注状态
let draftDomains = [];     // 界面上的黑名单草稿（网站）—— 加一条就整份存回去
let draftExes = [];        // 界面上的黑名单草稿（软件）
let countdownTimer = null; // 专注中每秒刷新倒计时的定时器
let holdTimer = null;      // 「长按结束」的计时器
let holdStart = null;      // 「长按结束」按下那一刻

// ---- 软件选择器（v4 批次 1）----
let installedApps = null;  // 最近一次从主进程拿到的「已安装软件」列表（null = 还没扫）
let appsLoading = false;   // 正在扫（防连点两次按钮）
let pickerFilter = '';     // 搜索框里的关键词

// 每小时的像素高度。方块的位置和高度都由这个值乘出来 ——
// 比例是主进程算的（week.js），像素才是界面的事。
const HOUR_H = 40;

// ---------- 小工具 ----------

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 底部飘一条提示，2.4 秒后自己消失（比 alert 温和，也不打断操作）
let toastTimer = null;
function toast(msg) {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    Object.assign(box.style, {
      position: 'fixed', left: '50%', bottom: '22px', transform: 'translateX(-50%)',
      background: 'rgba(31,41,55,.92)', color: '#fff', fontSize: '12.5px',
      padding: '7px 15px', borderRadius: '8px', pointerEvents: 'none',
      transition: 'opacity .25s', opacity: '0', zIndex: '99',
    });
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.style.opacity = '0'; }, 2400);
}

function showFormError(msg) {
  el.formError.textContent = msg;
  el.formError.classList.remove('hidden');
}
function hideFormError() {
  el.formError.classList.add('hidden');
}

// ---------- 列表渲染 ----------

// 列表上那一栏时间：时间点就是「09:30」，时段显示成「09:30–11:00」。
// ⚠ 主进程算周视图时要复述同一份文案（settings-window.js 里的 repeatText），
//   两边暂时各有一份 —— 改这里记得顺手看一眼那边。
function timeText(it) {
  return it.kind === 'span' && it.endTime ? `${it.time}–${it.endTime}` : it.time;
}

function repeatText(it) {
  if (it.repeat === 'once') return `只一次 · ${it.date}`;
  if (it.repeat === 'weekly') {
    const names = WEEKDAYS.filter(([v]) => (it.weekdays || []).includes(v)).map(([, l]) => l);
    return `每周 ${names.join('')}`;
  }
  return REPEAT_LABEL[it.repeat] || it.repeat;
}

function buildItem(it) {
  const li = document.createElement('li');
  li.className = 'item' + (it.enabled ? '' : ' off');

  // 开关：临时静音，不删除（删掉再想加回来太麻烦）
  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.setAttribute('aria-pressed', String(it.enabled));
  sw.title = it.enabled ? '点一下临时关掉（不会删除）' : '点一下重新打开';
  sw.addEventListener('click', () => onToggle(it));

  const main = document.createElement('div');
  main.className = 'main';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeText(it);
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = it.title; // 用 textContent 而不是 innerHTML：标题是主人自己输的，别当代码解析
  title.title = it.title;
  const rep = document.createElement('span');
  rep.className = 'repeat';
  rep.textContent = repeatText(it);
  main.append(time, title, rep);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const edit = document.createElement('button');
  edit.className = 'ghost';
  edit.textContent = '改';
  edit.addEventListener('click', () => openForm(it));
  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '删';
  del.addEventListener('click', () => onDelete(it, del));
  actions.append(edit, del);

  li.append(sw, main, actions);
  return li;
}

function renderList() {
  el.list.textContent = ''; // 清空
  el.empty.classList.toggle('hidden', items.length > 0);
  for (const it of items) el.list.appendChild(buildItem(it));
}

async function load() {
  const list = await api.list();
  items = Array.isArray(list) ? list : [];
  renderList();
  if (mode === 'week') await loadWeek(); // 周视图开着时，改完日程顺手把它也刷新
}

// ---------- 周视图 ----------

// 把主进程算好的布局画出来。
// ⚠ 这里**不做任何日期运算**：哪天有哪些方块、方块从几点到几点、什么颜色，
//   全部是主进程给的。界面只把 0~1 的比例乘成像素。
function renderWeek(data) {
  if (!data || !Array.isArray(data.days) || !data.axis) return;

  const { startHour, endHour } = data.axis;
  const gridH = (endHour - startHour) * HOUR_H;

  // ---- 列头：周一到周日，今天那一列标出来 ----
  el.weekHead.textContent = '';
  el.weekHead.appendChild(document.createElement('div')); // 左上角空出来给时间刻度
  for (const d of data.days) {
    const h = document.createElement('div');
    h.className = 'day-head' + (d.isToday ? ' today' : '');
    h.textContent = d.label;
    el.weekHead.appendChild(h);
  }

  // ---- 网格 ----
  el.weekCanvas.textContent = '';

  // 时间刻度列
  const hourCol = document.createElement('div');
  hourCol.className = 'hour-col';
  hourCol.style.height = gridH + 'px';
  for (let h = startHour; h < endHour; h++) {
    const cell = document.createElement('div');
    cell.className = 'hour';
    cell.style.height = HOUR_H + 'px';
    cell.textContent = `${String(h).padStart(2, '0')}:00`;
    hourCol.appendChild(cell);
  }
  el.weekCanvas.appendChild(hourCol);

  // 七天，每天一列
  for (const d of data.days) {
    const col = document.createElement('div');
    col.className = 'day-col' + (d.isToday ? ' today' : '');
    col.style.height = gridH + 'px';

    // 每小时的空白格（点它新建日程）—— 先铺，方块后铺，方块自然压在上面
    for (let h = startHour; h < endHour; h++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.top = (h - startHour) * HOUR_H + 'px';
      slot.style.height = HOUR_H + 'px';
      slot.dataset.day = d.key;
      slot.dataset.hour = String(h);
      // 点空白格 → 就在那一格新建一条
      slot.addEventListener('click', () => openFromBlank(d.key, h));
      col.appendChild(slot);
    }

    for (const b of d.blocks) {
      const blk = document.createElement('div');
      blk.className = 'blk' + (b.kind === 'point' ? ' point' : '') + (b.enabled ? '' : ' off');
      blk.dataset.color = b.color;
      blk.dataset.id = b.id;
      blk.style.top = b.topRatio * gridH + 'px';
      // 时段用比例算高度；时间点固定 22px 的扁条（最矮也给 22，不然一条线看不清）
      blk.style.height = (b.kind === 'point' ? 22 : Math.max(22, b.heightRatio * gridH)) + 'px';
      blk.title = `${b.title}　${timeText(b)}　${b.repeatText}`;

      const t = document.createElement('span');
      t.className = 'blk-title';
      t.textContent = b.title; // ★ textContent：标题是主人自己输的，绝不当 HTML 解析
      blk.appendChild(t);

      // 点方块 → 开表单改这一条
      blk.addEventListener('click', () => openFromWeek(b.id));

      col.appendChild(blk);
    }

    el.weekCanvas.appendChild(col);
  }

  // 打开时自动滚到「今天最早的日程」；今天没事就滚到 08:00，别让人对着半夜的空网格
  const today = data.days.find((d) => d.isToday);
  const tops = today ? today.blocks.map((b) => b.topRatio) : [];
  const target = tops.length
    ? Math.max(0, Math.min(...tops) * gridH - HOUR_H)
    : Math.max(0, (8 - startHour) * HOUR_H);
  el.weekGrid.scrollTop = target;
}

async function loadWeek() {
  weekData = await api.weekData();
  renderWeek(weekData);
}

// 只负责「哪块显示、按钮上写什么」——窗口尺寸是主进程的事
function applyMode() {
  const isWeek = mode === 'week';
  const isFocus = mode === 'focus';
  el.week.classList.toggle('hidden', !isWeek);
  el.listWrap.classList.toggle('hidden', isWeek || isFocus);
  el.focusPage.classList.toggle('hidden', !isFocus);
  // 专注页把「日程那一套」（header / 工具栏 / 表单 / 列表 / 周视图）整体藏起来，
  // 用一个 body 上的类来切，比逐个元素 toggle 更不容易漏。
  document.body.classList.toggle('focus-mode', isFocus);
  el.btnWeek.textContent = isWeek ? '列表' : '周视图';
}

async function setMode(next) {
  mode = (next === 'week' || next === 'focus') ? next : 'list';
  applyMode();
  await api.setMode(mode); // 主进程换窗口尺寸并重新摆位
  if (mode === 'week') await loadWeek();
  if (mode === 'focus') {
    await loadFocus();
    startCountdown();
  } else {
    stopCountdown();
  }
}

async function toggleMode() {
  await setMode(mode === 'week' ? 'list' : 'week');
}

// 点周视图上的一个方块 → 开表单改这一条。
// ⚠ 故意**不**用「点的时候闭包捕获的那份数据」—— 周视图可能是几分钟前渲染的，
//   中间主人在别处改过。一律按 id 重新去主进程拿最新的。
async function openFromWeek(id) {
  const latest = await api.list();
  const item = (Array.isArray(latest) ? latest : []).find((x) => x.id === id);
  if (!item) {
    toast('这条日程已经不在了，我刷新一下');
    await load();
    return;
  }
  // 表单会被周视图的网格盖住，所以先切回列表再开表单
  await setMode('list');
  openForm(item);
}

// 点周视图的空白格 → 就在那一格新建：标题空着，时间预填那一格，重复默认「只一次」、日期就是那天。
async function openFromBlank(dayKey, hour) {
  await setMode('list'); // 同样先切回列表，不然表单被网格盖住
  openForm(null); // 先把表单恢复成「干净的新建状态」，再覆盖几个字段
  el.time.value = `${String(hour).padStart(2, '0')}:00`;
  el.kind.value = 'point';
  el.repeat.value = 'once';
  el.date.value = dayKey;
  syncRepeatRows();
  syncKindRows();
}

// ---------- 专注页（v3）----------
//
// 界面在这里只做两件事：把主进程给的状态画出来、把主人的操作递上去。
// ⚠ 「哪条网址 / 程序名能加」「专注中能不能改配置」「能不能提前结束」——
//   这些规则**全在主进程**，界面不许自己判（判了就会跟主进程不一致）。
//   「长按 3 秒」这个时长也是主进程给的（focusData.holdMs），别在这里写死。

// 毫秒 → 「MM:SS」（超过 1 小时就显示「H:MM:SS」）
function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function showFocusError(msg) {
  el.focusError.textContent = msg;
  el.focusError.classList.remove('hidden');
}
function hideFocusError() {
  el.focusError.classList.add('hidden');
}

// 画黑名单两栏。⚠ 一律 textContent —— 主人自己输的网址不能当 HTML 解析。
function renderFocusLists() {
  const build = (ul, arr, kind) => {
    ul.textContent = '';
    for (const value of arr) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'focus-val';
      span.textContent = value;
      const del = document.createElement('button');
      del.className = 'focus-del';
      del.textContent = '×';
      del.title = '从名单里去掉';
      del.addEventListener('click', () => removeFocusItem(kind, value));
      li.append(span, del);
      ul.appendChild(li);
    }
  };
  build(el.focusDomains, draftDomains, 'domain');
  build(el.focusExes, draftExes, 'exe');
}

// 预设按钮：25 / 45 / 60 / 自定义。选中的高亮，跟主进程的 lastMinutes 对上。
function renderFocusPresets() {
  const presets = (focusData && focusData.presets) || [25, 45, 60];
  const last = focusData ? focusData.lastMinutes : 25;
  el.focusPresets.textContent = '';
  for (const m of presets) {
    const b = document.createElement('button');
    b.textContent = `${m} 分钟`;
    b.dataset.minutes = String(m);
    if (m === last) b.classList.add('on');
    b.addEventListener('click', () => choosePreset(m));
    el.focusPresets.appendChild(b);
  }
  const custom = document.createElement('button');
  custom.textContent = '自定义';
  custom.dataset.minutes = 'custom';
  // 自定义时：如果当前值不在预设里，把「自定义」也点亮
  if (!presets.includes(last)) custom.classList.add('on');
  custom.addEventListener('click', () => {
    el.focusCustomRow.classList.remove('hidden');
    el.fCustomMin.value = presets.includes(last) ? '' : String(last);
    el.fCustomMin.focus();
  });
  el.focusPresets.appendChild(custom);
}

// 画「开始 / 倒计时」那一块
function renderFocusRun() {
  const running = !!(focusData && focusData.running);
  el.focusIdle.classList.toggle('hidden', running);
  el.focusRunning.classList.toggle('hidden', !running);
  if (running) refreshCountdownFrom(focusData);
}

// 用一份状态刷新倒计时数字 + 进度环
function refreshCountdownFrom(data) {
  if (!data || !data.session) return;
  el.focusCountdown.textContent = fmtClock(data.remainingMs);

  // 进度环：圆周长按半径算，dashoffset 越大环越空
  const r = 52;
  const C = 2 * Math.PI * r;
  el.focusRingFg.style.strokeDasharray = String(C);
  const ratio = Math.max(0, Math.min(1, data.progressRatio || 0));
  el.focusRingFg.style.strokeDashoffset = String(C * ratio);
}

function renderFocus(data) {
  focusData = data;
  if (data) {
    draftDomains = Array.isArray(data.domains) ? data.domains.slice() : [];
    draftExes = Array.isArray(data.exes) ? data.exes.slice() : [];
  }
  renderFocusLists();
  renderFocusPresets();
  renderFocusRun();
}

async function loadFocus() {
  const data = await api.focusGet();
  renderFocus(data);
  // 顺手查一遍「安全 DNS」——它开着的话 hosts 屏蔽会被绕过，得让主人看见
  refreshDoh();
}

// 安全 DNS 提醒条。
// 三态各一种颜色：warn（开着，会绕过屏蔽）/ ok（关着，放心）/ unknown（查不到，别乱保证）。
// ⚠ 文本一律 textContent —— advice 里有浏览器名之类的动态内容。
function renderDoh(info) {
  const box = el.focusDoh;
  if (!box) return;
  if (!info || !info.advice) { box.classList.add('hidden'); return; }

  box.classList.remove('hidden', 'warn', 'ok', 'unknown');
  box.classList.add(info.level === 'on' ? 'warn' : info.level === 'off' ? 'ok' : 'unknown');

  const head = document.createElement('b');
  head.textContent = info.level === 'on'
    ? '⚠ 安全 DNS 开着，网站可能拦不住'
    : info.level === 'off'
      ? '✓ 屏蔽会正常生效'
      : '安全 DNS：没能确认';

  box.textContent = '';
  box.appendChild(head);
  box.appendChild(document.createTextNode('　' + info.advice));
}

async function refreshDoh() {
  try {
    renderDoh(await api.focusDoh());
  } catch {
    renderDoh(null);
  }
}

// 专注中每 1 秒问一次主进程「还剩多久」——倒计时以主进程为准，界面不自己减。
// ⚠ 只在专注页可见时跑，切走就停（别在后台白耗电）。
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(async () => {
    if (mode !== 'focus') { stopCountdown(); return; }
    const data = await api.focusState();
    focusData = data;
    if (data && data.running) {
      refreshCountdownFrom(data);
    } else {
      // 到点自动结束了 → 把界面切回「可以再开始」的样子
      stopCountdown();
      renderFocus(data);
      toast('专注结束，休息一下吧～');
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ---- 黑名单增删 ----

async function addFocusItem(kind) {
  const input = kind === 'exe' ? el.fExeInput : el.fDomainInput;
  const raw = input.value.trim();
  if (!raw) return;

  // 先问主进程「这条行不行」——立刻拿到人话原因，不用先写盘再回滚
  const r = await api.focusNormalize(kind, raw);
  if (!r || r.ok !== true) {
    showFocusError((r && r.error) || '这条看着不太对');
    return;
  }

  const next = kind === 'exe'
    ? { domains: draftDomains, exes: [...draftExes, r.value] }
    : { domains: [...draftDomains, r.value], exes: draftExes };

  const res = await api.focusSetBlacklist(next);
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '没能保存，稍后再试');
    return;
  }

  input.value = '';
  hideFocusError();
  focusData = Object.assign({}, focusData, { domains: res.domains, exes: res.exes });
  draftDomains = res.domains.slice();
  draftExes = res.exes.slice();
  renderFocusLists();
  toast('已加入名单');
}

async function removeFocusItem(kind, value) {
  const next = kind === 'exe'
    ? { domains: draftDomains, exes: draftExes.filter((v) => v !== value) }
    : { domains: draftDomains.filter((v) => v !== value), exes: draftExes };

  const res = await api.focusSetBlacklist(next);
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '没能去掉，稍后再试');
    return;
  }
  hideFocusError();
  focusData = Object.assign({}, focusData, { domains: res.domains, exes: res.exes });
  draftDomains = res.domains.slice();
  draftExes = res.exes.slice();
  renderFocusLists();
}

// ---- 时长 ----

async function choosePreset(minutes) {
  const res = await api.focusSetPreset(minutes);
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '没能记住这个时长');
    return;
  }
  hideFocusError();
  if (focusData) focusData.lastMinutes = res.lastMinutes;
  renderFocusPresets();
}

async function applyCustomMinutes() {
  const n = Number(el.fCustomMin.value);
  if (!Number.isInteger(n) || n <= 0) return showFocusError('请填一个大于 0 的整数分钟数');
  await choosePreset(n);
  el.focusCustomRow.classList.add('hidden');
}

// ---- 开始 / 结束 ----

async function startFocus() {
  const minutes = focusData ? focusData.lastMinutes : 25;
  // ⚠ 这一步现在会等主人点 UAC 的「是」——可能要好几秒，界面得有个「正在等」的样子
  el.btnFocusStart.disabled = true;
  el.btnFocusStart.textContent = '正在等授权…';
  let res;
  try {
    res = await api.focusStart({ minutes });
  } finally {
    el.btnFocusStart.disabled = false;
    el.btnFocusStart.textContent = '开始专注';
  }
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '开始失败');
    if (res && res.doh) renderDoh(res.doh);
    return;
  }
  hideFocusError();
  if (res.doh) renderDoh(res.doh);
  await loadFocus();
  startCountdown();
  toast('专注开始，我陪着你～');
}

async function finishStop() {
  // 把「按下那一刻」报给主进程，由它判断够没够 3 秒（规则只有一处）
  const pressedAt = holdStart;
  endHold(true);
  const res = await api.focusStop({ pressedAt });
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '还结束不了');
    return;
  }
  hideFocusError();
  stopCountdown();
  await loadFocus();
  toast('已结束专注，休息一下～');
}

// 长按：pointerdown 记时刻 → 每 100ms 看够没够 → 够了自动结束。
// 中途松手 / 移开就取消（这就是「长按 3 秒」的界面实现）。
function beginHold() {
  if (holdStart) return;
  if (focusData && focusData.running === false) return;
  holdStart = Date.now();
  el.btnFocusStop.classList.add('holding');
  el.focusStopHint.textContent = '按住别松手…';

  const need = (focusData && focusData.holdMs) || 3000;
  holdTimer = setInterval(() => {
    if (!holdStart) return;
    const elapsed = Date.now() - holdStart;
    if (elapsed >= need) {
      finishStop();
    } else {
      el.focusStopHint.textContent = `按住别松手… 还差 ${((need - elapsed) / 1000).toFixed(1)} 秒`;
    }
  }, 100);
}

// 松手（cancel = true 表示「没按够就松了」，给一句提示）
function endHold(completed) {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  const wasHolding = holdStart !== null;
  holdStart = null;
  el.btnFocusStop.classList.remove('holding');
  if (!completed && wasHolding) el.focusStopHint.textContent = '松手太早啦，得按住 3 秒才行';
  if (completed) el.focusStopHint.textContent = '';
}

// ---------- 已安装软件选择器（v4 批次 1）----------
//
// 主人不用再记 `steam.exe` 怎么拼了 —— 打开面板，点图标就能加。
//
// ⚠ 这个面板**自己能做的事很少**：
//   「你电脑上装了哪些软件」「哪些已经加过」「哪些拦不住」——
//   全部是主进程扫出来、算好之后送过来的。这里只负责画 + 把点击递上去。
//   一旦这里自己判「哪些软件该出现」，就会和主进程的过滤规则长歪。

// 按名字给兜底色块挑一个稳定的颜色。
// ★ 同一个软件每次打开都该是同一个色（和桌宠那套周视图取色同思路）。
//   为什么不用图标？因为有些软件（Office 部分组件 / 解析不出 exe 的）
//   提不出图标 —— 与其留个空洞，不如给一个认得出的色块。
const SWATCH = ['#3b82f6', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#fb7185', '#0ea5e9'];
function swatchFor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SWATCH[h % SWATCH.length];
}

// 一个软件格子：图标（提不到就画首字母）+ 名字 + 可选的小标记
function buildAppCell(app) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'app-cell' + (app.added ? ' added' : '');
  cell.dataset.exe = app.exe || '';
  cell.dataset.name = app.name || '';
  if (app.added) cell.title = '已经在名单里了';

  const icon = document.createElement('div');
  icon.className = 'app-icon';
  if (app.icon) {
    // ⚠ 图标是主进程提的 base64 data URL（CSP 只允许内联图片，不能传路径）。
    //   用 createElement + src 赋值，绝不拼 innerHTML。
    const img = document.createElement('img');
    img.src = app.icon;
    img.alt = '';
    icon.appendChild(img);
  } else {
    // ★ 兜底：提不到图标就画首字母色块 —— 不能留空洞
    icon.style.background = swatchFor(app.name);
    icon.textContent = (String(app.name || '?').trim()[0] || '?').toUpperCase();
  }

  const name = document.createElement('span');
  name.className = 'app-name';
  name.textContent = app.name || '(无名)'; // ★ 一律 textContent：软件名不是我们写的
  name.title = app.name || '';

  cell.append(icon, name);

  // 「点了可能拦不住」——如实标出来，不假装能用
  if (app.blocked) {
    const warn = document.createElement('span');
    warn.className = 'app-warn';
    warn.textContent = '⚠ 没找到程序文件';
    warn.title = '这个快捷方式里没有程序路径，加进名单可能不起作用';
    cell.appendChild(warn);
  }

  if (!app.added) {
    cell.addEventListener('click', () => pickApp(app));
  }
  return cell;
}

// 按搜索词过滤（只在界面上过滤，不动主进程那份数据 —— 搜索不该触发重扫）
function renderPickerGrid() {
  const kw = pickerFilter.trim().toLowerCase();
  const list = Array.isArray(installedApps) ? installedApps : [];
  const shown = kw
    ? list.filter((a) => String(a.name).toLowerCase().includes(kw) || String(a.exe).toLowerCase().includes(kw))
    : list;

  el.pickerGrid.textContent = '';
  for (const a of shown) el.pickerGrid.appendChild(buildAppCell(a));

  const none = shown.length === 0;
  el.pickerEmpty.classList.toggle('hidden', !none);
  el.pickerEmpty.textContent = kw
    ? `没找到「${pickerFilter.trim()}」。换个词试试？`
    : (list.length ? '这台电脑上没扫到软件。' : '还没扫到东西。');

  const addedN = list.filter((a) => a.added).length;
  el.pickerCount.textContent = `${list.length} 个软件 · 已加 ${addedN} 个`;
}

// 打开面板：先开（有个正在加载的样子），再去主进程要数据。
async function openAppPicker() {
  el.appPicker.classList.remove('hidden');
  el.pickerSearch.value = '';
  pickerFilter = '';

  if (installedApps) {
    // 已经有缓存（主进程一次会话只扫一次）→ 立刻画出来，不闪
    renderPickerGrid();
    el.pickerSearch.focus();
    return;
  }

  el.pickerGrid.textContent = '';
  el.pickerEmpty.classList.add('hidden');
  el.pickerCount.textContent = '';
  el.pickerHint.textContent = '正在看这台电脑上装了哪些软件…（第一次会慢一两秒）';

  await loadInstalledApps();
  el.pickerSearch.focus();
}

async function loadInstalledApps() {
  if (appsLoading) return;
  appsLoading = true;
  try {
    const res = await api.appsList();
    if (!res || res.ok === false) {
      installedApps = [];
      el.pickerHint.textContent = (res && res.error) || '没能读到软件列表';
    } else {
      installedApps = Array.isArray(res.apps) ? res.apps : [];
      el.pickerHint.textContent = '这些是你电脑上装了的软件。点一个就加进名单。';
    }
  } catch {
    installedApps = [];
    el.pickerHint.textContent = '扫软件列表时出错了';
  } finally {
    appsLoading = false;
  }
  renderPickerGrid();
}

function closeAppPicker() {
  el.appPicker.classList.add('hidden');
}

// 点了一个软件 → 加进黑名单。
// ⚠ 「加完到底成不成功」以主进程的返回为准（和手动输入那条路走的是同一个接口）。
async function pickApp(app) {
  if (!app || app.added) return;

  // ★ 拦不住的那些：先问一句，别让主人以为加上了就没事了。
  if (app.blocked) {
    const yes = window.confirm(
      `「${app.name}」这个快捷方式里没找到程序文件，加进名单**可能拦不住它**。\n\n还是要加吗？`
    );
    if (!yes) return;
  }

  // 解析不出 exe 的，进程名是空的 —— 这时只能老老实实告诉主人加不了。
  if (!app.exe) {
    toast('这个软件找不到程序文件，暂时加不进名单');
    return;
  }

  const res = await api.focusSetBlacklist({
    domains: draftDomains,
    exes: [...draftExes, app.exe],
  });
  if (!res || res.ok === false) {
    showFocusError((res && res.error) || '没能加上，稍后再试');
    return;
  }
  hideFocusError();

  // 主进程可能拒收（比如撞上保护名单）——那 exes 里就不会有它，如实说清楚
  const saved = (res.exes || []).includes(app.exe);
  focusData = Object.assign({}, focusData, { domains: res.domains, exes: res.exes });
  draftDomains = res.domains.slice();
  draftExes = res.exes.slice();
  renderFocusLists();

  if (!saved) {
    toast(`「${app.name}」没能加进去（可能撞上了保护名单）`);
    return;
  }

  // 本地面板也要同步成「已加入」，不然会让人以为没生效
  const hit = (installedApps || []).find((a) => a.exe === app.exe);
  if (hit) hit.added = true;
  renderPickerGrid();
  toast(`已挡住「${app.name}」`);
}

// 重新扫描：清掉主进程的缓存再扫一遍（装了新软件时用得上）
async function rescanApps() {
  if (appsLoading) return;
  el.pickerHint.textContent = '正在重新扫描…';
  try { await api.appsRescan(); } catch { /* 清缓存失败就还按旧的扫，别卡住 */ }
  installedApps = null;
  await loadInstalledApps();
}

// ---------- 单个日程的操作 ----------

async function onToggle(it) {
  const res = await api.toggle(it.id);
  if (res && res.error) return toast(res.error);
  await load();
  toast(res.enabled ? '已打开' : '已临时关掉');
}

// 「删」按两下才真删 —— 比弹窗轻，又不至于手滑一下就没了
function resetPendingDelete() {
  clearTimeout(pendingDelete && pendingDelete.timer);
  if (pendingDelete && pendingDelete.btn && pendingDelete.btn.isConnected) {
    pendingDelete.btn.textContent = pendingDelete.original;
  }
  pendingDelete = null;
}

async function onDelete(it, btn) {
  if (!pendingDelete || pendingDelete.id !== it.id) {
    resetPendingDelete();
    pendingDelete = {
      id: it.id,
      btn,
      original: btn.textContent,
      timer: setTimeout(resetPendingDelete, 3000),
    };
    btn.textContent = '确定删？';
    return;
  }

  resetPendingDelete();
  const ok = await api.remove(it.id);
  if (!ok) return toast('删除失败，这条日程可能已经不在了');
  await load();
  toast('已删除');
}

// ---------- 表单 ----------

function syncRepeatRows() {
  const r = el.repeat.value;
  el.rowDate.classList.toggle('hidden', r !== 'once');
  el.rowWeekdays.classList.toggle('hidden', r !== 'weekly');
}

// 选了「时段」才需要填「到几点」；「时间点」把它藏起来。
// 绑定方式和 syncRepeatRows 完全一样（都是 change 事件）。
function syncKindRows() {
  el.rowEndTime.classList.toggle('hidden', el.kind.value !== 'span');
}

function openForm(it) {
  resetPendingDelete();
  editingId = it ? it.id : null;

  el.formTitle.textContent = it ? '修改日程' : '添加日程';
  el.title.value = it ? it.title : '';
  el.time.value = it ? it.time : '09:00';
  // 新增时默认「时间点」：大多数日程就是到点提醒一下
  el.kind.value = it && it.kind ? it.kind : 'point';
  el.endTime.value = it && it.endTime ? it.endTime : '11:00';
  // 新增时默认「每天」：不用挑日期，对第一次用的人最省事
  el.repeat.value = it ? it.repeat : 'daily';
  el.date.value = it && it.date ? it.date : todayKey();

  const wd = it && Array.isArray(it.weekdays) ? it.weekdays : [];
  for (const cb of el.wdList.querySelectorAll('input')) {
    cb.checked = wd.includes(Number(cb.value));
  }

  syncRepeatRows();
  syncKindRows();
  hideFormError();
  el.form.classList.remove('hidden');
  el.title.focus();
}

function closeForm() {
  editingId = null;
  hideFormError();
  el.form.classList.add('hidden');
}

async function onSave() {
  const input = {
    title: el.title.value.trim(),
    time: el.time.value,
    kind: el.kind.value,
    repeat: el.repeat.value,
  };
  // 时间点不带「结束时间」；主进程也会把多余的 endTime 清成 null
  if (input.kind === 'span') input.endTime = el.endTime.value;
  if (input.repeat === 'once') input.date = el.date.value;
  if (input.repeat === 'weekly') {
    input.weekdays = [...el.wdList.querySelectorAll('input:checked')].map((cb) => Number(cb.value));
  }

  // 轻量提示：只挡「明显没填完」的，规则细节交给主进程
  if (!input.title) return showFormError('还没写「做什么」呢');
  if (!input.time) return showFormError('还没选「几点」');
  // ⚠ 「结束必须晚于开始」这条**不在界面判**，交给主进程 —— 免得两套规则不一致。
  if (input.kind === 'span' && !input.endTime) return showFormError('选了「时段」，得填到几点');
  if (input.repeat === 'once' && !input.date) return showFormError('选了「只提醒一次」，得挑个日期');
  if (input.repeat === 'weekly' && !input.weekdays.length) return showFormError('选了「每周」，得勾上星期几');

  const wasEditing = !!editingId;
  const res = wasEditing ? await api.update(editingId, input) : await api.add(input);
  if (res && res.error) return showFormError(res.error); // 主进程说的才算

  closeForm();
  await load();
  toast(wasEditing ? '已修改' : '已添加');
}

// ---------- 事件绑定 ----------

// 星期几的勾选框只建一次
for (const [value, label] of WEEKDAYS) {
  const box = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = String(value);
  box.append(cb, document.createTextNode('周' + label));
  el.wdList.appendChild(box);
}

el.btnAdd.addEventListener('click', () => openForm(null));
el.btnCancel.addEventListener('click', closeForm);
el.btnSave.addEventListener('click', onSave);
el.repeat.addEventListener('change', syncRepeatRows);
el.kind.addEventListener('change', syncKindRows);
el.btnWeek.addEventListener('click', toggleMode);

// ---- 专注页的事件 ----
el.btnFocus.addEventListener('click', () => setMode('focus'));
el.btnFocusBack.addEventListener('click', () => setMode('list'));
el.btnAddDomain.addEventListener('click', () => addFocusItem('domain'));
el.btnAddExe.addEventListener('click', () => addFocusItem('exe'));
el.btnCustomOk.addEventListener('click', applyCustomMinutes);
el.btnFocusStart.addEventListener('click', startFocus);

// ---- 软件选择器（v4 批次 1）----
el.btnBrowseApps.addEventListener('click', openAppPicker);
el.btnPickerClose.addEventListener('click', closeAppPicker);
el.btnPickerRescan.addEventListener('click', rescanApps);
// 点面板外面的灰底 = 关掉（和大多数弹窗一致的习惯）
el.appPicker.addEventListener('click', (e) => {
  if (e.target === el.appPicker) closeAppPicker();
});
// 搜索框：打字即过滤（数据已经在本地，不用再问主进程）
el.pickerSearch.addEventListener('input', () => {
  pickerFilter = el.pickerSearch.value;
  renderPickerGrid();
});
// Esc 关面板。⚠ 要抢在「表单的 Esc = 取消编辑」前面处理，
//   否则面板开着按 Esc 会去关那个没打开的表单（看起来像「没反应」）。
el.appPicker.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAppPicker(); }
});

// 回车 = 加一条（填网址 / 程序名时最顺手）
for (const [input, kind] of [[el.fDomainInput, 'domain'], [el.fExeInput, 'exe']]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFocusItem(kind); }
  });
}
el.fCustomMin.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyCustomMinutes(); }
});

// 长按 3 秒结束（别照抄「点一下就走」——那等于没有专注）
el.btnFocusStop.addEventListener('pointerdown', (e) => { e.preventDefault(); beginHold(); });
el.btnFocusStop.addEventListener('pointerup', () => endHold(false));
el.btnFocusStop.addEventListener('pointerleave', () => endHold(false));
el.btnFocusStop.addEventListener('pointercancel', () => endHold(false));

// 主进程换完窗口尺寸后的回执。
// 自己点按钮切的时候，这里拿到的和本地已经设好的一样 → 直接 return，避免重复渲染。
// 但如果**主进程主动**切（比如托盘菜单、或截图工具），这里得负责把内容也画出来，
// 否则会留下一个空空的周视图框。
if (api.onMode) {
  api.onMode((m) => {
    const next = (m === 'week' || m === 'focus') ? m : 'list';
    if (next === mode) return;
    mode = next;
    applyMode();
    if (mode === 'week') loadWeek();
    if (mode === 'focus') { loadFocus(); startCountdown(); } else { stopCountdown(); }
  });
}

el.btnPreview.addEventListener('click', async () => {
  const res = await api.preview();
  if (res && res.error) toast(res.error);
  else toast('提醒弹出来啦，看看桌宠旁边');
});

// 回车 = 保存，Esc = 取消（填表时最顺手的两个键）
el.form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    onSave();
  } else if (e.key === 'Escape') {
    closeForm();
  }
});

// ---------- 启动 ----------
load();
