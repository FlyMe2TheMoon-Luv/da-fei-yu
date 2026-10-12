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

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const schedules = require('./schedules');

const HTML = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
const PRELOAD = path.join(__dirname, 'preload-settings.js');

const WIN_W = 480;
const WIN_H = 640;

let win = null;
let inited = false;
let onPreview = null; // 由 main.js 注入：点「预览提醒效果」时调 reminder.present

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

  // 开发时把界面日志转发到终端，方便排查
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const msg = first && typeof first === 'object' && 'message' in first ? first.message : args[2];
      if (msg) console.log('[settings]', msg);
    });
  }

  win.once('ready-to-show', () => {
    // 注意：新窗口默认是普通层级（不置顶）。
    // 桌宠是 screen-saver 层级，会浮在设置窗口上面 —— 但桌宠只有 400×380，
    // 挡住的位置主人拖一下桌宠就避开了，所以不给设置窗口加置顶。
    win.show();
    win.focus();
    // show() + focus() 在「前面有全屏程序」等情况下不一定能把窗口抬到最前
    // （Windows 有前台锁定策略）。moveTop() 是专门干这个的：
    // 不管焦点，直接把窗口抬到同层最上面。成本极低，加着不亏。
    win.moveTop();
  });

  win.on('closed', () => { win = null; });

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

module.exports = { init, open, close, isOpen, getWindow: () => (isOpen() ? win : null) };
