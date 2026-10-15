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
  // v4 批次 3-c：侧边栏导航 + 内容区标题
  btnList: document.getElementById('btn-list'),
  pageTitle: document.getElementById('page-title'),
  pageSub: document.getElementById('page-sub'),
  btnCancel: document.getElementById('btn-cancel'),
  btnSave: document.getElementById('btn-save'),
  // 专注页（v3）
  btnFocus: document.getElementById('btn-focus'),
  focusPage: document.getElementById('focus-page'),
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
  pickerLock: document.getElementById('picker-lock'),
  btnPickerRescan: document.getElementById('btn-picker-rescan'),
  btnPickerSave: document.getElementById('btn-picker-save'),
  focusError: document.getElementById('focus-error'),
  focusDoh: document.getElementById('focus-doh'),
  focusPresets: document.getElementById('focus-presets'),
  focusCustomRow: document.getElementById('focus-custom-row'),
  fCustomMin: document.getElementById('f-custom-min'),
  btnCustomOk: document.getElementById('btn-custom-ok'),
  focusIdle: document.getElementById('focus-idle'),
  focusIdleHint: document.getElementById('focus-idle-hint'),
  focusRunning: document.getElementById('focus-running'),
  btnFocusStart: document.getElementById('btn-focus-start'),
  btnFocusStop: document.getElementById('btn-focus-stop'),
  focusCountdown: document.getElementById('focus-countdown'),
  focusRingFg: document.getElementById('focus-ring-fg'),
  focusStopHint: document.getElementById('focus-stop-hint'),
  focusStopLabel: document.getElementById('focus-stop-label'),
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
let holdStart = null;      // 「长按结束」按下那一刻（进度条也按它算进度）

// ---- 软件选择器（v4 批次 1；批次 2.5 改「先勾后存」）----
let installedApps = null;  // 最近一次从主进程拿到的「已安装软件」列表（null = 还没扫）
let appsLoading = false;
let appsLoadPromise = null; // 关掉又打开时仍等待同一趟扫描，不返回半成品。
let pickerFilter = '';     // 搜索框里的关键词
let pickerPicked = new Set();   // 本次**新勾上**的 exe（还没保存）
let pickerUnpicked = new Set(); // 本次**取消勾选**的 exe（原来挡着的，还没保存）
let pickerLocked = false;
let pickerSaving = false;
let pickerOpening = false;
let pickerEpoch = 0; // 关闭后，旧的异步响应不能抢回焦点。
let pickerReturnFocus = null;
let pickerInert = new Map();

// 每小时的像素高度。方块的位置和高度都由这个值乘出来 ——
// 比例是主进程算的（week.js），像素才是界面的事。
const HOUR_H = 40;

// ---------- 小工具 ----------

// 原生 :active 本来就在按下时生效；pressing 只补统一的指针取消/失焦清理。
// 视觉反馈在按下时发生，业务动作仍由 click 提交。

// 给一个容器里所有（含以后动态加进来的）按钮都挂上按下反馈。
// 用事件委托：`pointerdown` 会冒泡，所以一次性挂在 document 上最省事，
// 而且**动态生成的按钮也自动生效**（列表项、软件格子都是 JS 建出来的）。
function installPressFeedback(root) {
  const target = root || document;
  const pick = (e) => {
    const b = e.target && e.target.closest
      ? e.target.closest('button, .app-cell, #wd-list label')
      : null;
    return b;
  };
  target.addEventListener('pointerdown', (e) => {
    const b = pick(e);
    if (b && !b.disabled) b.classList.add('pressing');
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) {
    target.addEventListener(ev, () => {
      document.querySelectorAll('.pressing').forEach((b) => b.classList.remove('pressing'));
    }, true);
  }
  target.addEventListener('pointerleave', (e) => {
    const b = pick(e);
    if (b) b.classList.remove('pressing');
  }, true);
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 底部飘一条提示，2.4 秒后自己消失（比 alert 温和，也不打断操作）
let toastTimer = null;
function toast(msg) {
  // The picker is a modal with a scrim; a document-level toast would float over its footer.
  // Route picker toasts into the panel's own status line instead.
  if (el.appPicker && !el.appPicker.classList.contains('hidden') && el.pickerLock) {
    pickerMessage(msg);
    return;
  }
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
  edit.addEventListener('click', () => openForm(it, edit));
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

// 只负责「哪块显示、导航高亮谁、标题写什么」——窗口尺寸是主进程的事
//
// v4 批次 3-c：原来是「点周视图按钮 → 按钮自己的字变成『列表』」，
// 用户看不出现在在哪一页。改成侧边栏之后，**高亮**负责说「你在哪」、
// 内容区标题负责说「这是什么页」，按钮的字不再变。
const PAGE_TEXT = {
  list: { title: '日程', sub: '到点时，桌宠会冒泡提醒你。错过 5 分钟以内的，开机后还会补上。' },
  week: { title: '周视图', sub: '周一到周日，一眼看见这一周怎么排。点方块可以改。' },
  // ★ 这句话要跟专注页那张卡里的说明**错开**：卡里讲的是「机制」（网站打不开、软件被关掉），
  //   这里讲的是「这一页要你做什么」。两句话一样的话，读起来像复制粘贴。
  focus: { title: '专注', sub: '挑好要挡住的网站和软件，再选一段时长。' },
};

function applyMode() {
  const isWeek = mode === 'week';
  const isFocus = mode === 'focus';
  el.week.classList.toggle('hidden', !isWeek);
  el.listWrap.classList.toggle('hidden', isWeek || isFocus);
  el.focusPage.classList.toggle('hidden', !isFocus);
  // 专注页把「日程那一套」（工具栏 / 表单 / 列表 / 周视图）整体藏起来，
  // 用一个 body 上的类来切，比逐个元素 toggle 更不容易漏。
  // ★ 侧边栏不在里面 —— 藏了就出不去了。
  document.body.classList.toggle('focus-mode', isFocus);

  // 导航高亮：三个都过一遍（不是「找第一个就 return」——
  // 那样别人加一个同选择器的项就会悄悄失效，见 CLAUDE.md 第 63 条）
  for (const [name, btn] of [['list', el.btnList], ['week', el.btnWeek], ['focus', el.btnFocus]]) {
    if (!btn) continue;
    if (name === mode) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  const t = PAGE_TEXT[mode] || PAGE_TEXT.list;
  el.pageTitle.textContent = t.title;
  el.pageSub.textContent = t.sub;
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

// v4 批次 3-c：`toggleMode` 删掉了 —— 侧边栏里「日程」和「周视图」各是一个独立入口，
// 不再需要「同一个按钮点一下切过去、再点一下切回来」（那种做法用户看不出自己在哪）。

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
// ★ 传进来不是有限数字时一律当 0 —— 界面上宁可显示 00:00，也**绝不能出现 NaN:NaN**。
//   那不是「小瑕疵」：一眼看去像坏掉了，主人会以为专注模式整个坏了。
//   （自检夹具少给一个字段就复现过这个画面。）
function fmtClock(ms) {
  const raw = Number(ms);
  const total = Math.max(0, Math.ceil(Number.isFinite(raw) ? raw / 1000 : 0));
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
  // 秒数只从主进程来（默认 3），不在界面里写死 —— 写死了以后改规则就是在骗人。
  const secs = holdSeconds();
  // 「还没开始」那一句也要跟着走（它同样写着秒数）
  if (el.focusIdleHint) {
    el.focusIdleHint.textContent = `开始后，大肥鱼会陪着你，中途想提前结束得长按 ${secs} 秒。`;
  }
  if (running) {
    refreshCountdownFrom(focusData);
    const label = `长按 ${secs} 秒结束`;
    el.btnFocusStop.dataset.idleLabel = label;
    el.focusStopLabel.textContent = label;
    el.btnFocusStop.title = `按住不放 ${secs} 秒才会结束（防止手滑）`;
  }
}

// 主进程给的「长按多久才算数」，换算成秒（默认 3 秒）。
// ★ 只此一处换算：按钮标签、还没开始时的说明、松手太早的提示都用它，
//   免得三处各写一个数、改一个忘两处。
function holdSeconds() {
  return Math.round(((focusData && focusData.holdMs) || 3000) / 1000);
}

// 用一份状态刷新倒计时数字 + 进度环
function refreshCountdownFrom(data) {
  if (!data || !data.session) return;
  el.focusCountdown.textContent = fmtClock(data.remainingMs);

  // 进度环：圆周长按半径算，dashoffset 越大环越空
  const r = 52;
  const C = 2 * Math.PI * r;
  el.focusRingFg.style.strokeDasharray = String(C);
  const ratio = Math.max(0, Math.min(1, Number(data.progressRatio) || 0));
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
  if (!el.appPicker.classList.contains('hidden') && !pickerOpening && !pickerSaving) {
    syncPickerBaseline(data);
  }
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
  toast('已加入名单'); // 面板开着时会被路由到面板内，不会压住底栏
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
    // 主进程拒绝了（例如启动那一刻手滑、或会话已经结束）。
    // ★ 这时进度条已经缩回 0 了，但**不要**留一句「按住别松手…」——
    //   那是在描述一个已经结束的动作，会让人以为还得继续按。
    el.focusStopHint.textContent = '';
    showFocusError((res && res.error) || '还结束不了');
    return;
  }
  hideFocusError();
  stopCountdown();
  await loadFocus();
  toast('已结束专注，休息一下～');
}

// ---------- 退出专注：长按进度条（v4 批次 3）----------
//
// 之前只有一句「按住别松手… 还差 X 秒」的文字。现在按钮**自己变成进度条**：
// 按住时红色填充从左往右涨满，松手立刻缩回去。
//
// ★ 三条刻意守住的规矩：
//   ① **难度一点没变**：仍然是「按住 holdMs（主进程给的，默认 3 秒）才放行」。
//      进度条只是把「按到哪了」画出来，没有让退出变容易 —— 它是自律工具。
//   ② **进度 ≠ 剩余时间**：上面的圆环是「专注还剩多久」，这条是「退出动作按到哪」。
//      两件事各管各的，合并了会让人误以为专注只剩 3 秒。
//   ③ **可打断**（apple-design 第 3 节）：松手就回退、可以立刻重按，回退要快（160ms），
//      涨上去要跟手（线性、时长＝holdMs），不额外加 easing 拖着。
//
// ⚠ 是不是「够 3 秒了」**仍然由主进程说了算**（`api.focusStop({pressedAt})`）。
//   界面这里只负责画进度；就算有人改坏这段，主进程照样会拒绝。

let holdRaf = null;

// 把进度写进 CSS 变量（0→1）。用 rAF 而不是 setInterval：
// 进度是动画，跟着屏幕刷新走最跟手，也不会在后台标签里白烧 CPU。
function setHoldProgress(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  el.btnFocusStop.style.setProperty('--hold', String(r));
  return r;
}

// ★ 只读的自检窗口：自检要能问「现在进度是多少、在不在按住」，
//   而不是靠等固定毫秒数去猜（猜的断言会在慢机器上假失败）。
//   刻意只暴露**读**，不暴露写 —— 免得自检能伪造进度、把假象验成真的。
window.__focusHoldDebug = {
  progress: () => parseFloat(el.btnFocusStop.style.getPropertyValue('--hold')) || 0,
  holding: () => holdStart !== null,
  // 「按到哪了」换算成毫秒，方便断言「还没够 holdMs 就绝对不许放行」
  elapsedMs: () => (holdStart === null ? 0 : Date.now() - holdStart),
  needMs: () => (focusData && focusData.holdMs) || 3000,
};

// 松手/移开/取消都走这里。completed = true 表示「按够了」，由主进程最终裁定。
function beginHold() {
  if (holdStart) return;
  if (focusData && focusData.running === false) return;
  // 主进程给的时长（默认 3000），界面不写死
  const need = (focusData && focusData.holdMs) || 3000;

  holdStart = Date.now();
  el.btnFocusStop.classList.add('holding');
  el.focusStopHint.textContent = '按住别松手…';
  el.focusStopLabel.textContent = '松开就取消';

  const tick = () => {
    if (!holdStart) return; // 已经松手了
    const elapsed = Date.now() - holdStart;
    const ratio = setHoldProgress(elapsed / need);
    if (ratio >= 1) {
      finishStop();
      return;
    }
    holdRaf = requestAnimationFrame(tick);
  };
  setHoldProgress(0);
  holdRaf = requestAnimationFrame(tick);
}

// 松手（completed = true 表示「按够了、放行」）
function endHold(completed) {
  if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = null; }
  const wasHolding = holdStart !== null;
  holdStart = null;
  el.btnFocusStop.classList.remove('holding');
  // 回退到 0（CSS 里有 160ms 过渡，看起来就是「缩回去了」）
  setHoldProgress(0);
  el.focusStopLabel.textContent = el.btnFocusStop.dataset.idleLabel || '长按 3 秒结束';
  // 提示语里的秒数也走同一个来源（见 holdSeconds）
  if (!completed && wasHolding) el.focusStopHint.textContent = `松手太早啦，得按住 ${holdSeconds()} 秒才行`;
  if (completed) el.focusStopHint.textContent = '';
}

// ---------- 已安装软件选择器（v4 批次 1 / 批次 2.5 改「先勾后存」）----------
//
// 主人不用再记 `steam.exe` 怎么拼了 —— 打开面板，点图标就能加。
//
// ⚠ 这个面板**自己能做的事很少**：
//   「你电脑上装了哪些软件」「哪些已经加过」「哪些拦不住」——
//   全部是主进程扫出来、算好之后送过来的。这里只负责画 + 把勾选递上去。
//   一旦这里自己判「哪些软件该出现」，就会和主进程的过滤规则长歪。
//
// ★ 批次 2.5 把交互模型换成了「**先勾选、再保存**」（主人要求）：
//   · 点一下图标 = 只改**本地草稿** `pickerPicked`，**一个 IPC 都不发**
//   · 再点一下 = 取消勾选
//   · 底部「保存」才真正写进主进程（一次提交，不是点一下存一次）
//
//   为什么非要改成这样（不是审美，是隐患）：
//     ① 专注**进行中**不许改黑名单。原来是「点一个存一个」，
//        主人在专注中点一圈会**挨个弹错**，一路踩坑；现在能一进来就禁用保存并说明原因。
//     ② 原来是「点一下就生效」，**没有撤销**。苹果设计原则里 Agency 明确要求
//        「给容易的挽回」，勾选模型天然自带撤销（再点一下就行）。
//     ③ 勾选语义天然就是 checkbox —— 顺手把无障碍也做对了（见 buildAppCell）。
//
//   ⚠ `pickerPicked` 里存的是**exe 名**（不是下标/名字）：
//     因为搜索过滤会让网格重画，用索引会串位；exe 名是稳定的身份。

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
//
// ★ 用 `role="checkbox"` + `aria-checked`：
//   「勾选/取消」在语义上**就是**一个复选框。用 button 的话屏幕阅读器只会念
//   「按钮」，念不出「已选中」这个**状态** —— 状态恰恰是这里最重要的信息。
//   保留 `<button>` 元素本身（键盘行为天然正确），只加 ARIA 语义。
function buildAppCell(app) {
  const cell = document.createElement('button');
  cell.type = 'button';
  const picked = pickedHas(app);
  cell.className = 'app-cell' + (picked ? ' picked' : '') + (app.added ? ' added' : '')
    + (app.added && !picked ? ' will-remove' : '');
  cell.setAttribute('aria-disabled', String(!app.exe || !!app.blocked || pickerLocked || pickerSaving));
  cell.dataset.exe = app.exe || '';
  cell.dataset.name = app.name || '';
  cell.setAttribute('role', 'checkbox');
  cell.setAttribute('aria-checked', picked ? 'true' : 'false');
  cell.setAttribute('aria-label', app.name || '(无名)');
  if (app.added) cell.title = '已经在名单里了；点一下可以取消';

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

  // 勾选徽标：由 CSS 画（`::after`），这里只负责给一个「容器」语义。
  //   ⚠ 不用文字打勾：那会和 `.app-name` 的 `✓` 撞车，而且旋转/缩放做不圆滑。

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

  // ★ 点一下 = 切换勾选（不是直接写主进程）。
  //   ⚠ 已挡的（`added`）**也绑**，因为「再点一下撤销」对着已挡的软件最常发生 ——
  //     以前是 `if (!app.added)`，等于已挡的根本点不动，主人想取消也取消不了。
  cell.addEventListener('click', () => togglePick(app));
  return cell;
}

// ---------- 勾选状态（本地草稿，不发 IPC）----------

function pickedHas(app) {
  if (!app || !app.exe) return false;
  // ★ 已挡的软件**默认就是勾上的** —— 主人看到的是「当前生效的状态」，
  //   而不是「这次又新加了多少」。这样「取消勾选 → 保存 = 从名单移除」也才成立。
  if (app.added) return !pickerUnpicked.has(app.exe);
  return !!pickerPicked.has(app.exe);
}

function togglePick(app) {
  if (!app || pickerLocked || pickerSaving || pickerOpening || appsLoading) return;
  if (!app.exe || app.blocked) {
    // 解析不出 exe 的：勾了也没意义 —— 不打断，只飘一句
    toast('这个软件找不到程序文件，勾了也拦不住');
    return;
  }
  if (app.added) {
    // 已挡的：在「取消」和「恢复」之间来回切
    if (pickerUnpicked.has(app.exe)) pickerUnpicked.delete(app.exe);
    else pickerUnpicked.add(app.exe);
  } else {
    if (pickerPicked.has(app.exe)) pickerPicked.delete(app.exe);
    else pickerPicked.add(app.exe);
  }
  // ★ 只重画这**一格**，不重画整个网格 ——
  //   重画会毁掉 hover / 焦点状态，鼠标底下那一格会「闪」一下，很廉价。
  syncCellState(app);
  renderPickerCount();
}

// 把某一格的外观同步成当前勾选状态（不重建 DOM，保住 hover 和焦点）
function syncCellState(app) {
  const cell = findCell(app);
  if (!cell) return;
  const picked = pickedHas(app);
  cell.classList.toggle('picked', picked);
  cell.classList.toggle('added', !!app.added);
  cell.title = app.added ? '已在屏蔽名单；再次点击取消，保存后生效' : '点击选中，再次点击取消';
  cell.setAttribute('aria-disabled', String(!app.exe || !!app.blocked || pickerLocked || pickerSaving));
  cell.setAttribute('aria-checked', picked ? 'true' : 'false');
  // 「已挡但被取消勾选」要能看出来 —— 不然主人以为它还在挡着
  cell.classList.toggle('will-remove', !!app.added && !picked);
}

// 按 exe 找格子。⚠ 不能用变量存着的旧引用：搜索一变网格就重画了。
function findCell(app) {
  if (!app || !app.exe) return null;
  return [...el.pickerGrid.querySelectorAll('.app-cell')]
    .find((c) => c.dataset.exe === app.exe) || null;
}

// 底栏计数：区分「已经挡着的」和「这次勾的」，别让人以为勾了没生效
function renderPickerCount() {
  const list = Array.isArray(installedApps) ? installedApps : [];
  const addN = pickerPicked.size;
  const delN = pickerUnpicked.size;
  const selected = list.filter(pickedHas).length;
  const changed = addN + delN;
  const text = `${list.length} 个软件 · 已选 ${selected} 个` + (changed ? ' · 未保存' : '');
  el.pickerCount.textContent = text;
  el.pickerCount.classList.toggle('dirty', changed > 0);

  // 保存按钮：只有「有改动」时才亮起来
  const save = el.btnPickerSave;
  if ((pickerSaving || pickerOpening || appsLoading) &&
      [save, el.btnPickerRescan].includes(document.activeElement)) el.pickerSearch.focus();
  if (save) {
    save.disabled = changed === 0 || pickerLocked || pickerSaving || pickerOpening || appsLoading;
    save.textContent = pickerSaving ? '保存中…' : '保存';
  }
  el.btnPickerRescan.disabled = pickerSaving || pickerOpening || appsLoading;
  el.pickerGrid.setAttribute('aria-busy', String(pickerSaving || pickerOpening || appsLoading));
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

  renderPickerCount();
}

function pickerMessage(text = '', error = false) {
  el.pickerLock.textContent = text;
  el.pickerLock.classList.toggle('hidden', !text);
  el.pickerLock.classList.toggle('error', error);
}

// 只缓存软件/图标。名单每次从主进程刷新，不能把缓存的 added 当成事实。
function syncPickerBaseline(data) {
  const valid = data && Array.isArray(data.exes) && Array.isArray(data.domains);
  pickerLocked = !valid || !!data.running;
  if (valid) {
    focusData = data;
    draftDomains = data.domains.slice();
    draftExes = data.exes.slice();
    const saved = new Set(draftExes);
    for (const app of installedApps || []) app.added = saved.has(app.exe);
    for (const exe of pickerPicked) if (saved.has(exe)) pickerPicked.delete(exe);
    for (const exe of pickerUnpicked) if (!saved.has(exe)) pickerUnpicked.delete(exe);
  }
  pickerMessage(!valid ? '暂时读不到专注状态，请关闭后重新打开。'
    : pickerLocked ? '专注进行中，只能查看；结束后再修改名单。' : '', !valid);
  for (const app of installedApps || []) syncCellState(app);
  renderPickerCount();
}

// ---------- v4 批次 3-c-2：空间一致 ----------
//
// 面板要「从触发它的那个东西长出来」，而不是从自己的正中间往外鼓。
// 做法：把面板的 transform-origin 打到**触发点的相对位置**上。
//
// ⚠ 必须**先让面板可见**才量得到它的矩形 —— 所以调用顺序是
//   「去掉 hidden → aimPanelAt(...) → 下一帧再加 .is-open 起动画」。
//   动画挂在 .is-open 上（不是直接挂面板），就是为了给这一步留出时间。
//
// 取不到触发点（程序化打开、元素已消失）→ 清掉 origin 回到居中，
// **绝不把 NaN 写进样式**（CLAUDE.md 第 65 条的同一条道理）。
function aimPanelAt(panel, triggerEl) {
  if (!panel || !panel.getBoundingClientRect) return;
  const p = panel.getBoundingClientRect();
  if (!p.width || !p.height) return;
  const rect = triggerEl && triggerEl.getBoundingClientRect ? triggerEl.getBoundingClientRect() : null;
  if (!rect || (!rect.width && !rect.height)) {
    panel.style.transformOrigin = '';
    return;
  }
  const pct = (n) => (Number.isFinite(n) ? Math.max(-20, Math.min(120, n)) : 50);
  const ox = ((rect.left + rect.width / 2 - p.left) / p.width) * 100;
  const oy = ((rect.top + rect.height / 2 - p.top) / p.height) * 100;
  panel.style.transformOrigin = `${pct(ox).toFixed(1)}% ${pct(oy).toFixed(1)}%`;
}

// 下一帧再加类，保证 origin 已经生效、动画从正确的点扩开
function popIn(panel, openClass) {
  if (!panel) return;
  panel.classList.remove(openClass);
  requestAnimationFrame(() => panel.classList.add(openClass));
}

async function openAppPicker() {
  if (!el.appPicker.classList.contains('hidden')) return;
  const epoch = ++pickerEpoch;
  pickerReturnFocus = document.activeElement;
  pickerInert = new Map([...document.body.children]
    .filter((node) => node !== el.appPicker).map((node) => [node, node.inert]));
  for (const node of pickerInert.keys()) node.inert = true;
  el.appPicker.classList.remove('hidden');
  // 面板从「🔍 浏览已安装软件」那颗按钮长出来
  aimPanelAt(el.appPicker.querySelector('.picker-panel'), el.btnBrowseApps);
  popIn(el.appPicker, 'is-open');
  el.pickerSearch.value = '';
  pickerFilter = '';
  pickerPicked.clear();
  pickerUnpicked.clear();
  pickerOpening = true;
  pickerLocked = true;
  pickerMessage();
  el.pickerHint.textContent = '点一下选中，再点一下取消。保存后用于下一次专注。';
  renderPickerGrid();
  el.pickerSearch.focus();
  try {
    // A rescan may be replacing cached objects; await it before binding cells to them.
    if (!installedApps || appsLoadPromise) await loadInstalledApps();
    const data = await api.focusGet();
    if (epoch !== pickerEpoch) return;
    syncPickerBaseline(data);
    renderPickerGrid();
  } catch (err) {
    if (epoch === pickerEpoch) {
      pickerLocked = true;
      pickerMessage('读取失败，请点「重新扫描」重试。', true);
      console.error('[picker] open:', err);
    }
  } finally {
    if (epoch === pickerEpoch) { pickerOpening = false; renderPickerCount(); }
  }
}

function loadInstalledApps(refresh = false) {
  if (appsLoadPromise) return appsLoadPromise;
  appsLoading = true;
  renderPickerCount();
  appsLoadPromise = (async () => {
    try {
      // Share the entire refresh, including cache invalidation, with any reopening.
      if (refresh) {
        const result = await api.appsRescan();
        if (!result || !result.ok) throw new Error('刷新失败');
      }
      const res = await api.appsList();
      if (!res || res.ok === false || !Array.isArray(res.apps)) {
        throw new Error((res && res.error) || '软件列表读取失败');
      }
      installedApps = res.apps;
    } finally {
      appsLoading = false;
      appsLoadPromise = null;
      renderPickerCount();
    }
  })();
  return appsLoadPromise;
}

function closeAppPicker() {
  if (pickerSaving) return; // 防止保存尚未返回却显示「已取消」。
  if (pickerPicked.size + pickerUnpicked.size) toast('未保存的选择已取消，名单没有改变');
  ++pickerEpoch;
  pickerOpening = false;
  pickerPicked.clear();
  pickerUnpicked.clear();
  el.appPicker.classList.add('hidden');
  el.appPicker.classList.remove('is-open'); // 收起时把动画类摘掉，下次打开才能重放
  for (const [node, wasInert] of pickerInert) node.inert = wasInert;
  pickerInert.clear();
  if (pickerReturnFocus && pickerReturnFocus.isConnected) pickerReturnFocus.focus();
}

// 保存只发一次写请求。基于最新名单合并增删，保留搜索隐藏项、手输软件和网站。
async function savePicks() {
  if (pickerLocked || pickerSaving || pickerOpening || appsLoading) return;
  if (!(pickerPicked.size + pickerUnpicked.size)) return;
  pickerSaving = true;
  pickerMessage();
  for (const app of installedApps || []) syncCellState(app);
  renderPickerCount();
  try {
    const current = await api.focusGet();
    if (!current || !Array.isArray(current.exes) || !Array.isArray(current.domains)) {
      throw new Error('暂时读不到当前名单，请重试');
    }
    if (current.running) {
      syncPickerBaseline(current);
      return;
    }
    const want = new Set(current.exes);
    for (const exe of pickerPicked) want.add(exe);
    for (const exe of pickerUnpicked) want.delete(exe);
    const res = await api.focusSetBlacklist({ domains: current.domains, exes: [...want] });
    if (!res || res.ok === false || !Array.isArray(res.exes) || !Array.isArray(res.domains)) {
      throw new Error((res && res.error) || '没能保存，请重试');
    }
    const got = new Set(res.exes);
    if ([...want].some((exe) => !got.has(exe)) || [...pickerUnpicked].some((exe) => got.has(exe))) {
      throw new Error('部分修改未生效，请核对名单后重试');
    }
    pickerPicked.clear();
    pickerUnpicked.clear();
    syncPickerBaseline({ ...current, ...res });
    renderFocusLists();
    // 不重建网格，保存后也保留悬停、滚动和键盘焦点。
    pickerMessage('已保存，将用于下一次专注。');
  } catch (err) {
    // 错误必须在浮层里面，不能藏在遮罩后；失败保留草稿，可直接重试。
    pickerMessage(`${err.message || '保存失败'}。选择已保留。`, true);
  } finally {
    pickerSaving = false;
    for (const app of installedApps || []) syncCellState(app);
    renderPickerCount();
  }
}

async function rescanApps() {
  if (appsLoading || pickerOpening || pickerSaving) return;
  const epoch = pickerEpoch;
  pickerOpening = true;
  renderPickerCount();
  pickerMessage('正在重新扫描，未保存的选择会保留…');
  try {
    // The shared promise owns the refresh, so reopening during a rescan waits for it.
    await loadInstalledApps(true);
    const current = await api.focusGet();
    if (epoch !== pickerEpoch) return;
    syncPickerBaseline(current);
    renderPickerGrid();
  } catch (err) {
    if (epoch === pickerEpoch) pickerMessage('重新扫描失败，选择已保留，请重试。', true);
  } finally {
    if (epoch === pickerEpoch) { pickerOpening = false; renderPickerCount(); }
  }
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

// triggerEl：谁把表单叫出来的（「＋ 添加日程」那颗按钮 / 列表里的「改」/ 周视图的方块）。
// 传进来的话表单就从那个点展开；传不到就居中（见 aimPanelAt）。
function openForm(it, triggerEl) {
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
  aimPanelAt(el.form, triggerEl);   // 先量位置定 origin，再起动画（顺序不能反）
  popIn(el.form, 'is-open');
  el.title.focus();
}

function closeForm() {
  editingId = null;
  hideFormError();
  el.form.classList.add('hidden');
  el.form.classList.remove('is-open'); // 摘掉动画类，下次打开才能重放
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

el.btnAdd.addEventListener('click', () => openForm(null, el.btnAdd));
el.btnCancel.addEventListener('click', closeForm);
el.btnSave.addEventListener('click', onSave);
el.repeat.addEventListener('change', syncRepeatRows);
el.kind.addEventListener('change', syncKindRows);
el.btnWeek.addEventListener('click', () => setMode('week'));
el.btnList.addEventListener('click', () => setMode('list'));

// ---- 专注页的事件 ----
el.btnFocus.addEventListener('click', () => setMode('focus'));
// v4 批次 3-c：原来这里绑的是「← 返回日程」（#btn-focus-back）。
// 侧边栏已经承担了「从专注页回日程」这件事，那个按钮连同它的处理一起删了。
el.btnAddDomain.addEventListener('click', () => addFocusItem('domain'));
el.btnAddExe.addEventListener('click', () => addFocusItem('exe'));
el.btnCustomOk.addEventListener('click', applyCustomMinutes);
el.btnFocusStart.addEventListener('click', startFocus);

// ---- 软件选择器（v4 批次 1；批次 2.5 改「先勾后存」）----
el.btnBrowseApps.addEventListener('click', openAppPicker);
el.btnPickerClose.addEventListener('click', closeAppPicker);
el.btnPickerRescan.addEventListener('click', rescanApps);
el.btnPickerSave.addEventListener('click', savePicks);
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
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAppPicker(); return; }
  // button 原生支持空格和回车，不再手动 click，以免一次按键触发两次。
  if (e.key === 'Tab') {
    const nodes = [...el.appPicker.querySelectorAll('button:not(:disabled), input')];
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
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

// 长按 3 秒结束（别照抄「点一下就走」——那等于没有专注）。
// ★ 鼠标按住 / 触屏按住 / 键盘按住空格或回车，三种都要能退：
//   键盘长按会**连发 keydown**，所以用一个标志保证只从第一次开始计时（否则进度会被反复重置）。
//
// ★ 为什么按住时要 setPointerCapture（而不是靠 pointerleave 取消）：
//   按钮上写着「松开就取消」，那么「手抖滑出去一点」必须**不算松开** ——
//   否则主人好不容易按到 2.9 秒、手指偏一个像素，进度就归零了，非常气人。
//   捕获之后指针事件一直送到这个元素，`pointerleave` 根本不会触发；
//   真正的松手只有 pointerup / pointercancel（系统手势打断）两种。
//   ★ 这也解释了下面那条：**不要**在 pointerleave 里 endHold —— 那是「以为在帮人、其实在坑人」。
let holdKeyDown = false;
let holdPointerId = null;

el.btnFocusStop.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // 捕获指针，让「按住」不怕手滑（松开才算松）
  try {
    el.btnFocusStop.setPointerCapture(e.pointerId);
    holdPointerId = e.pointerId;
  } catch { holdPointerId = null; }
  beginHold();
});
el.btnFocusStop.addEventListener('pointerup', () => {
  if (holdPointerId !== null) { try { el.btnFocusStop.releasePointerCapture(holdPointerId); } catch { /* 已经回收 */ } holdPointerId = null; }
  endHold(false);
});
// 系统手势（比如触屏从底部上划）会发 pointercancel —— 那是真的被打断了，必须回退
el.btnFocusStop.addEventListener('pointercancel', () => {
  holdPointerId = null;
  endHold(false);
});
el.btnFocusStop.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
  e.preventDefault(); // 空格默认会「滚动/点一下」，这里要的是「按住」
  if (holdKeyDown) return;
  holdKeyDown = true;
  beginHold();
});
el.btnFocusStop.addEventListener('keyup', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
  holdKeyDown = false;
  endHold(false);
});
// 焦点被抢走 = 键盘长按断了（不然会一直涨下去）。
// ⚠ 只在「键盘那一路」上取消：鼠标按住期间如果窗口失去焦点，
//   指针捕获和 pointerup 还是会来，不该在这里提前回退。
el.btnFocusStop.addEventListener('blur', () => {
  if (!holdKeyDown) return;
  holdKeyDown = false;
  endHold(false);
});

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
installPressFeedback(document);
load();
