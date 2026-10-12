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
};

// 星期几的显示顺序按中文习惯：周一在前、周日在最后。
// 但存进文件的数字是 JS 的 getDay() 规则（0 = 周日），所以这里要把两件事分开。
const WEEKDAYS = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
const REPEAT_LABEL = { once: '只一次', daily: '每天', weekdays: '工作日', weekly: '每周' };

let items = [];
let editingId = null;    // null = 正在新增；否则是正在改的那条 id
let pendingDelete = null; // 「删」要按两下才真删，这里记着第一下的状态
let mode = 'list';        // 'list' | 'week'
let weekData = null;      // 最近一次从主进程拿到的周视图布局

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
  el.week.classList.toggle('hidden', !isWeek);
  el.listWrap.classList.toggle('hidden', isWeek);
  el.btnWeek.textContent = isWeek ? '列表' : '周视图';
}

async function setMode(next) {
  mode = next === 'week' ? 'week' : 'list';
  applyMode();
  await api.setMode(mode); // 主进程换窗口尺寸并重新摆位
  if (mode === 'week') await loadWeek();
}

async function toggleMode() {
  await setMode(mode === 'week' ? 'list' : 'week');
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

// 主进程换完窗口尺寸后的回执 —— 以它为准（万一以后有别的入口也能切模式）
if (api.onMode) {
  api.onMode((m) => {
    mode = m === 'week' ? 'week' : 'list';
    applyMode();
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
