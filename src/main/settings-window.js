// src/main/settings-window.js
// 阶段 2-4 · 日程编辑入口
//
// 一个普通窗口，让主人在界面上加 / 改 / 删日程，不用再手动改 JSON 文件。
//
// ── 为什么单独一个文件 ──
//   主进程入口已经很长了；这块自成一体（一个窗口 + 一组 IPC）。
//   以后阶段 4 要往设置里加「专注模式黑名单」「开关」等，直接往这儿加，不动 main.js。
//
// ── ⚠ 和桌宠 / 气泡窗口最大的不同：这个窗口必须能抢焦点、能输入 ──
//   桌宠窗口是 focusable:false（不打扰主人），气泡也是（不打断打字）。
//   但主人主动打开设置就是来填表的 —— 这时候不抢焦点反而没法用。
//   所以别照抄前两个窗口的配置。
//
// ── ⚠ 校验一律走 schedules.js，界面里不再写第二套 ──
//   两套规则迟早会不一致，然后出现「界面上说没问题、存盘却被拒」这种怪事。
//   这里只做转交：把界面递上来的东西原样交给 schedules.add/update，
//   它返回 { error } 就原样递回去给界面显示。

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const schedules = require('./schedules');
const week = require('./week');
const focus = require('./focus');
const blacklist = require('./focus/blacklist');
const { placeNear } = require('./place');

const HTML = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
const PRELOAD = path.join(__dirname, 'preload-settings.js');

// 这个窗口有三种模式，每种一个尺寸。
// 周视图要放下七列 + 时间刻度，所以宽得多；
// 专注页（v3）内容不多，跟列表一样宽就行，省得窗口忽大忽小。
const SIZES = {
  list: { w: 480, h: 640 },
  week: { w: 1000, h: 680 },
  focus: { w: 480, h: 640 },
};
// WIN_W / WIN_H 是「列表模式」的别名 —— 现有自检和 placeNear 复算都在用，别删。
const WIN_W = SIZES.list.w;
const WIN_H = SIZES.list.h;

let win = null;
let inited = false;
let mode = 'list';         // 'list' | 'week' | 'focus'
let onPreview = null;      // 由 main.js 注入：点「预览提醒效果」时调 reminder.present
let getPetWindow = () => null; // 由 main.js 注入：要临时把桌宠「降一层」
let getChatWindow = () => null; // 由 main.js 注入：设置窗口打开时聊天条也要降层

// ---------- 窗口尺寸 ----------

// 模式对应的窗口尺寸。小屏笔记本上按 90% 缩，但不小于列表尺寸
// （再小就既放不下七列、也不比列表模式好用了）。
function sizeOf(m, workArea) {
  const s = SIZES[m] || SIZES.list;
  let w = s.w;
  let h = s.h;
  if (workArea) {
    if (w > workArea.width) w = Math.max(SIZES.list.w, Math.round(workArea.width * 0.9));
    if (h > workArea.height) h = Math.max(SIZES.list.h, Math.round(workArea.height * 0.9));
  }
  return { w, h };
}

// 当前窗口该在哪块屏的工作区里。桌宠不在（被隐藏 / 已销毁）就退回主屏。
function workAreaFor() {
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed()) return screen.getDisplayMatching(pet.getBounds()).workArea;
  return screen.getPrimaryDisplay().workArea;
}

// ---------- 临时把桌宠降一层 ----------
// 起因：桌宠是 alwaysOnTop('screen-saver') 层级，比普通窗口高 ——
// 设置窗口一打开就会被桌宠压住一块，主人填表时很碍事。
// 所以设置窗口开着的期间把桌宠降到普通层级，关掉再升回去。
// （只降「层级」，不隐藏桌宠 —— 它还在，只是可以被设置窗口盖住。）
function lowerPet() {
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed()) {
    try {
      pet.setAlwaysOnTop(false);
      pet.setVisibleOnAllWorkspaces(false);
      console.log('[settings] 桌宠已降到普通层级（让设置窗口能盖住它）');
    } catch (err) {
      console.error('[settings] 降桌宠层级失败：', err && err.message);
    }
  }
  // 聊天条也要降层，否则设置窗口会被聊天条压住一块
  const chat = getChatWindow();
  if (chat && !chat.isDestroyed()) {
    try {
      chat.setAlwaysOnTop(false);
    } catch (err) {
      console.error('[settings] 降聊天条层级失败：', err && err.message);
    }
  }
}

function restorePet() {
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed()) {
    try {
      pet.setAlwaysOnTop(true, 'screen-saver');
      pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      console.log('[settings] 桌宠层级已恢复（继续浮在最上层）');
    } catch (err) {
      console.error('[settings] 恢复桌宠层级失败：', err && err.message);
    }
  }
  const chat = getChatWindow();
  if (chat && !chat.isDestroyed()) {
    try {
      chat.setAlwaysOnTop(true);
    } catch (err) {
      console.error('[settings] 恢复聊天条层级失败：', err && err.message);
    }
  }
}

// ---------- 把窗口摆到桌宠旁边 ----------
// 主人反馈：以前不指定 x/y，Electron 就把窗口丢在屏幕正中 —— 离桌宠太远，
// 点完按钮还得满屏找窗口。现在改成「贴着桌宠的右上方出现」。
//
// ── ⚠ 为什么用 setBounds 而不是 setPosition（实测踩到的坑）──
//   这台机器屏幕缩放 1.5。带标题栏（frame:true）的窗口在这个缩放比下，
//   「外框尺寸」会自己飘：
//     用 width:480,height:640 建出来 → getBounds() 报 481×641
//     第一次 setPosition() 之后     → 又涨成 482×642
//     show()/focus()/moveTop() 之后 → 还可能再涨 1
//   结果是：算位置时读到的是 482，窗口真身是 484，摆出来就差 1~2 像素。
//   而 setBounds({..., width, height}) 会把尺寸一起写回去，
//   读回来就是精确的 480×640 —— 既消掉了偏差，也顺手把被撑大的尺寸掰正。
//   所以这里位置用**固定的 WIN_W/WIN_H** 算，再用 setBounds 一次写回。
//
// ── 另一个细节 ──
//   用 screen.getDisplayMatching(宠物) 挑屏幕：多显示器时窗口要跟着桌宠
//   跑到它所在的那块屏上，而不是固定放在主屏。
// 算不出位置（桌宠被隐藏/已销毁）就返回 null，让 Electron 用默认位置，不至于打不开。
function positionNearPet() {
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed() || !win || win.isDestroyed()) return null;

  try {
    const petRect = pet.getBounds();
    const workArea = workAreaFor();
    const { w, h } = sizeOf(mode, workArea);
    const { x, y, side, clamped } = placeNear(petRect, { w, h }, workArea);
    win.setBounds({ x, y, width: w, height: h });
    console.log(`[settings] 窗口摆到桌宠 ${side}${clamped ? '（被屏幕边挤过）' : ''} → ${x},${y}` +
      ` · 桌宠 ${petRect.x},${petRect.y} ${petRect.width}×${petRect.height}` +
      ` · 窗口 ${w}×${h}（${mode} 模式） · 屏工作区 ${workArea.width}×${workArea.height}`);
    return { x, y, side, clamped };
  } catch (err) {
    console.error('[settings] 算窗口位置失败，改用默认位置：', err && err.message);
    return null;
  }
}

// 切换「列表 / 周视图 / 专注」：换窗口尺寸 → 重新摆位 → 把结果告诉界面。
// 界面**不做任何尺寸计算**，只负责把内容换掉（渲染进程拿不到屏幕信息）。
function setMode(next) {
  mode = (next === 'week' || next === 'focus') ? next : 'list';

  if (!win || win.isDestroyed()) return mode;

  try {
    // ⚠ 顺序要紧：**先**把最小尺寸放开，**再**写回新尺寸。
    //   反过来的话，从周视图切回列表时会被「周视图留下的最小尺寸」卡住，窗口缩不回去。
    win.setMinimumSize(400, 420);
    const pos = positionNearPet();
    if (!pos) {
      // 桌宠不在（算不出位置）时，至少把尺寸换过去，别让界面画在错误的宽度里
      const { w, h } = sizeOf(mode, workAreaFor());
      win.setBounds({ width: w, height: h });
    }
    win.webContents.send('week:mode', mode);
    console.log(`[settings] 模式切换 → ${mode}`);
  } catch (err) {
    console.error('[settings] 切换模式失败：', err && err.message);
  }

  return mode;
}

// ---------- 周视图的数据 ----------

const DOW_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ⚠ 这份文案和界面里 settings.js 的 repeatText() 是**同一个意思**，暂时有两份。
//   改一处记得看一眼另一处（之所以不共用，是因为渲染进程不能 require 主进程的模块）。
function repeatTextOf(it) {
  if (it.repeat === 'once') return `只一次 · ${it.date}`;
  if (it.repeat === 'weekly') {
    const names = (it.weekdays || []).map((n) => (DOW_LABEL[n] || '').slice(1)).join('');
    return `每周 ${names}`;
  }
  return { daily: '每天', weekdays: '工作日' }[it.repeat] || it.repeat;
}

// 把「这一周怎么画」整个算好交给界面：七天、时间轴、每个方块的位置比例和颜色。
// 界面只拿 topRatio / heightRatio 去乘自己的像素高度，不做任何日期和数学。
function weekData() {
  const items = schedules.list();
  const now = new Date();
  const start = week.weekStartOf(now);
  const axis = week.axisOf(items);
  const todayKey = schedules.localDateKey(now);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = schedules.localDateKey(date);
    days.push({
      key,
      dow: date.getDay(),
      label: DOW_LABEL[date.getDay()],
      isToday: key === todayKey,
      blocks: week.blocksOf(items, date, axis).map((b) => ({
        // 方块要带够信息，界面点一下就能直接开表单（Task 5）
        id: b.item.id,
        title: b.item.title,
        kind: b.item.kind,
        time: b.item.time,
        endTime: b.item.endTime,
        repeatText: repeatTextOf(b.item),
        enabled: b.item.enabled,
        topRatio: b.topRatio,
        heightRatio: b.heightRatio,
        color: b.color,
      })),
    });
  }

  return {
    weekStart: schedules.localDateKey(start),
    todayKey,
    axis,
    days,
  };
}

// ---------- 窗口 ----------

// startMode：'list'（默认）| 'week' | 'focus'。
// 只有开发时的「直接开在某一页」入口会传它；正常打开一律从列表开始。
function open(startMode = 'list') {
  // 已经开着就直接拉到前面，不重复开第二个（主人点两次菜单不该出现两个窗口）
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  console.log('[settings] 打开日程管理窗口');

  // 每次打开都从「列表」开始 —— 行为可预测，也不会让窗口以周视图的大尺寸突然出现
  mode = (startMode === 'week' || startMode === 'focus') ? startMode : 'list';

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    minWidth: 400,
    minHeight: 420,
    // 普通窗口：有系统标题栏（自带关闭按钮），能缩放、能最小化。
    // 2-4 的目标是「能用」，美观留到阶段 4。
    frame: true,
    resizable: true,
    show: false,
    backgroundColor: '#f7f8fa',
    title: '日程管理 · 桌宠',
    webPreferences: {
      preload: PRELOAD,
      // 安全底线同前：渲染进程与 Node 隔离（硬性约定第 1、2 条）
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false); // 用不上菜单栏，藏掉省地方
  win.loadFile(HTML);

  // 把「打开时就在哪一页」告诉界面。
  // 正常打开是 list，界面自己初始也是 list → 这条等于空操作；
  // 只有开发入口（PET_OPEN_SETTINGS=focus）直接开在某一页时才需要它。
  win.webContents.once('did-finish-load', () => {
    if (mode !== 'list') win.webContents.send('week:mode', mode);
  });

  // 先摆一次位置（此刻窗口还藏着，主人看不到挪动过程）。
  // ready-to-show 里还会再摆一次 —— 那时外框尺寸才算彻底定下来。
  positionNearPet();

  // 开发时把界面日志转发到终端，方便排查
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const msg = first && typeof first === 'object' && 'message' in first ? first.message : args[2];
      if (msg) console.log('[settings]', msg);
    });
  }

  win.once('ready-to-show', () => {
    // 设置窗口本身是普通层级（**不置顶**）—— 主人可能想边看别的软件边改日程，
    // 一个永远浮在最上面的设置窗口只会碍事。
    // 但桌宠是 screen-saver 层级，比普通窗口高，会压住设置窗口一块 ——
    // 所以改成「设置窗口开着的时候把桌宠降下来」，见 lowerPet() 的注释。
    lowerPet();
    // 摆位置（用 setBounds，顺带把可能被系统撑大的外框尺寸掰回 WIN_W×WIN_H）。
    positionNearPet();
    win.show();
    win.focus();
    // show() + focus() 在「前面有全屏程序」等情况下不一定能把窗口抬到最前
    // （Windows 有前台锁定策略）。moveTop() 是专门干这个的：
    // 不管焦点，直接把窗口抬到同层最上面。成本极低，加着不亏。
    win.moveTop();
    // 显示之后再摆一次。show()/focus()/moveTop() 这一串动作在 1.5 倍缩放下
    // 可能又把外框撑大 1 像素，再写一次把偏差抹掉（位置没变时这步等于空操作）。
    positionNearPet();
  });

  win.on('closed', () => {
    win = null;
    restorePet();
  });

  return win;
}

function close() {
  if (win && !win.isDestroyed()) win.close();
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

// ---------- 初始化 ----------

function init(opts = {}) {
  if (typeof opts.onPreview === 'function') onPreview = opts.onPreview;
  if (typeof opts.getPetWindow === 'function') getPetWindow = opts.getPetWindow;
  if (typeof opts.getChatWindow === 'function') getChatWindow = opts.getChatWindow;
  if (inited) return;
  inited = true;

  // ---- 日程增删改查 ----
  // 全部用 handle（要返回值），失败不抛异常而是返回 { error }，
  // 界面直接把 error 显示出来就行。
  ipcMain.handle('schedules:list', () => {
    try {
      return schedules.list();
    } catch (err) {
      // 读文件失败也不能把窗口搞崩，返回空列表 + 一条说明
      console.error('[settings] 读日程失败：', err && err.message);
      return [];
    }
  });

  ipcMain.handle('schedules:add', (_e, input) => schedules.add(input || {}));
  ipcMain.handle('schedules:update', (_e, id, patch) => schedules.update(id, patch || {}));
  ipcMain.handle('schedules:remove', (_e, id) => schedules.remove(id));
  ipcMain.handle('schedules:toggle', (_e, id) => schedules.toggle(id));

  // ---- 周视图 ----
  // 返回**已经算好的**布局（七天 + 时间轴 + 方块比例），界面只负责画。
  ipcMain.handle('week:data', () => {
    try {
      return weekData();
    } catch (err) {
      console.error('[settings] 算周视图数据失败：', err && err.message);
      return null;
    }
  });
  ipcMain.handle('week:set-mode', (_e, m) => setMode(m));

  // ---- 专注模式（v3）----
  // ⚠ 校验一律走 focus/blacklist.js —— 界面不许自带第二套规则。
  //   这里只做转交：把界面递上来的东西原样交给 focus 主控。
  ipcMain.handle('focus:get', () => {
    try {
      return focus.state();
    } catch (err) {
      console.error('[settings] 读专注配置失败：', err && err.message);
      return null;
    }
  });
  // 界面「加一条」时先问一句「这条行不行」——立刻给人话原因，不用先写盘再回滚
  ipcMain.handle('focus:normalize', (_e, payload) => {
    const { kind, raw } = payload || {};
    return kind === 'exe' ? blacklist.normalizeExe(raw) : blacklist.normalizeDomain(raw);
  });
  ipcMain.handle('focus:set-blacklist', (_e, list) => focus.setBlacklist(list || {}));
  ipcMain.handle('focus:set-preset', (_e, minutes) => focus.setPreset(minutes));
  // 查「安全 DNS」：开着的话浏览器会绕过 hosts，屏蔽白做 —— 提前告诉主人
  ipcMain.handle('focus:doh', () => {
    try {
      return focus.checkDoh();
    } catch (err) {
      console.error('[settings] 检测安全 DNS 失败：', err && err.message);
      return null;
    }
  });
  // ⚠ focus:start 现在是**异步**的（要等主人点 UAC）。
  //   ipcMain.handle 会自动 await 它返回的 Promise，界面那边不用改。
  ipcMain.handle('focus:start', (_e, opts) => focus.start(opts || {}));
  // 「结束专注」要报「按下那一刻」——够没够 3 秒由 focus/requestStop 判（规则只有一处）
  ipcMain.handle('focus:stop', (_e, payload) => focus.requestStop(payload || {}));
  // 倒计时刷新用（和 focus:get 同源，单独留一个语义清晰的通道）
  ipcMain.handle('focus:state', () => focus.state());

  // ---- 预览提醒效果 ----
  ipcMain.handle('reminder:preview', async () => {
    if (!onPreview) return { error: '预览暂时不可用' };
    try {
      await onPreview();
      return { ok: true };
    } catch (err) {
      return { error: (err && err.message) || '预览失败' };
    }
  });

  console.log('[settings] 日程管理窗口已就绪（按需打开）');
}

module.exports = {
  init,
  open,
  close,
  isOpen,
  getWindow: () => (isOpen() ? win : null),
  // 自检要用：复算「窗口该待在哪」时得知道窗口的标称尺寸
  WIN_W,
  WIN_H,
  SIZES,
  sizeOf,
  setMode,
  getMode: () => mode,
  weekData,
};
