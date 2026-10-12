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
  repeat: document.getElementById('f-repeat'),
  date: document.getElementById('f-date'),
  rowDate: document.getElementById('row-date'),
  rowWeekdays: document.getElementById('row-weekdays'),
  wdList: document.getElementById('wd-list'),
  formError: document.getElementById('form-error'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  btnAdd: document.getElementById('btn-add'),
  btnPreview: document.getElementById('btn-preview'),
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
  time.textContent = it.time;
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

function openForm(it) {
  resetPendingDelete();
  editingId = it ? it.id : null;

  el.formTitle.textContent = it ? '修改日程' : '添加日程';
  el.title.value = it ? it.title : '';
  el.time.value = it ? it.time : '09:00';
  // 新增时默认「每天」：不用挑日期，对第一次用的人最省事
  el.repeat.value = it ? it.repeat : 'daily';
  el.date.value = it && it.date ? it.date : todayKey();

  const wd = it && Array.isArray(it.weekdays) ? it.weekdays : [];
  for (const cb of el.wdList.querySelectorAll('input')) {
    cb.checked = wd.includes(Number(cb.value));
  }

  syncRepeatRows();
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
    repeat: el.repeat.value,
  };
  if (input.repeat === 'once') input.date = el.date.value;
  if (input.repeat === 'weekly') {
    input.weekdays = [...el.wdList.querySelectorAll('input:checked')].map((cb) => Number(cb.value));
  }

  // 轻量提示：只挡「明显没填完」的，规则细节交给主进程
  if (!input.title) return showFormError('还没写「做什么」呢');
  if (!input.time) return showFormError('还没选「几点」');
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
