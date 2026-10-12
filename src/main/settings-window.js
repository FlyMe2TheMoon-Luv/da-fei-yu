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
const { placeNear } = require('./place');

const HTML = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
const PRELOAD = path.join(__dirname, 'preload-settings.js');

const WIN_W = 480;
const WIN_H = 640;

let win = null;
let inited = false;
let onPreview = null;      // 由 main.js 注入：点「预览提醒效果」时调 reminder.present
let getPetWindow = () => null; // 由 main.js 注入：要临时把桌宠「降一层」

// ---------- 临时把桌宠降一层 ----------
// 起因：桌宠是 alwaysOnTop('screen-saver') 层级，比普通窗口高 ——
// 设置窗口一打开就会被桌宠压住一块，主人填表时很碍事。
// 所以设置窗口开着的期间把桌宠降到普通层级，关掉再升回去。
// （只降「层级」，不隐藏桌宠 —— 它还在，只是可以被设置窗口盖住。）
function lowerPet() {
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed()) return;
  try {
    pet.setAlwaysOnTop(false);
    pet.setVisibleOnAllWorkspaces(false);
    console.log('[settings] 桌宠已降到普通层级（让设置窗口能盖住它）');
  } catch (err) {
    console.error('[settings] 降桌宠层级失败：', err && err.message);
  }
}

function restorePet() {
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed()) return;
  try {
    pet.setAlwaysOnTop(true, 'screen-saver');
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    console.log('[settings] 桌宠层级已恢复（继续浮在最上层）');
  } catch (err) {
    console.error('[settings] 恢复桌宠层级失败：', err && err.message);
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
    const display = screen.getDisplayMatching(petRect);
    const { x, y, side, clamped } = placeNear(
      petRect,
      { w: WIN_W, h: WIN_H },
      display.workArea,
    );
    win.setBounds({ x, y, width: WIN_W, height: WIN_H });
    console.log(`[settings] 窗口摆到桌宠 ${side}${clamped ? '（被屏幕边挤过）' : ''} → ${x},${y}` +
      ` · 桌宠 ${petRect.x},${petRect.y} ${petRect.width}×${petRect.height}` +
      ` · 窗口 ${WIN_W}×${WIN_H} · 屏工作区 ${display.workArea.width}×${display.workArea.height}`);
    return { x, y, side, clamped };
  } catch (err) {
    console.error('[settings] 算窗口位置失败，改用默认位置：', err && err.message);
    return null;
  }
}

// ---------- 窗口 ----------

function open() {
  // 已经开着就直接拉到前面，不重复开第二个（主人点两次菜单不该出现两个窗口）
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  console.log('[settings] 打开日程管理窗口');

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
};
