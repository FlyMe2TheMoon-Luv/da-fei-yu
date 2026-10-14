// src/main/reminder.js
// 阶段 2-3 · 提醒呈现
//
// 职责：日程到点了，让主人「真的察觉到」。
// 一共三招，从强到弱，按情况挑：
//   ① 桌宠本体做反应 —— 切表情 + 放个有明显动作的姿势（主人在看屏幕时最抓眼）
//   ② 旁边冒一个气泡   —— 写清「什么事 / 几点到点」，点「知道了」收起来，30 秒没人理也自己收
//   ③ 系统通知         —— 桌宠被收进托盘、看不见时的兜底，别让提醒被静默吞掉
//
// 为什么不写在 main.js 里：主进程入口已经 700 多行了，提醒这块能独立验证
// （气泡真的出现了吗 / 内容对不对 / 会自己收吗），单独一个文件更好维护，
// 也符合「模块解耦」的项目约定（A 桌宠外壳 / B 日程提醒 / C 专注 / D 设置）。
//
// ── 一个容易踩的坑 ──
//   气泡窗口必须 focusable: false + showInactive()。
//   否则每次提醒都会把主人正在打字的窗口顶掉、输入法被打断 —— 那是「帮忙」变「添乱」。
//   代价是：窗口不抢焦点，就不能靠 focus 事件判断它还在不在，得自己管状态。

const { BrowserWindow, ipcMain, screen, Notification } = require('electron');
const path = require('path');

// ---------- 参数 ----------

const BUBBLE_W = 268;
const BUBBLE_H = 112;
const BUBBLE_GAP = 10;            // 气泡和宠物之间留的缝
const BUBBLE_EDGE = 4;            // 气泡离屏幕工作区边缘至少留这么多，别贴死
const BUBBLE_ANCHOR = 0.22;       // 竖直方向对齐到宠物高度的这个比例（≈头部位置）
const BUBBLE_AUTO_HIDE_MS = 30000; // 30 秒没人理就自己收

const BUBBLE_HTML = path.join(__dirname, '..', 'renderer', 'bubble', 'index.html');
const BUBBLE_PRELOAD = path.join(__dirname, 'preload-bubble.js');

// ---------- 状态 ----------

let bubble = null;        // 气泡窗口（按需创建，之后一直复用，避免每次重开都闪一下）
let bubbleReady = null;   // Promise：等网页加载完，加载完才能往里推内容
let bubbleTimer = null;   // 自动收起定时器
let current = null;       // 气泡当前显示的内容（气泡窗口自己来取）
let petMoveHandler = null; // 宠物挪窝时让气泡跟着走

let getPetWindow = () => null; // 由 main.js 注入：问「桌宠窗口在哪、露不露脸」
let inited = false;
const history = [];       // 自检用：每次提醒的落地情况（气泡？通知？）

// ---------- 小工具 ----------

function clockOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 气泡位置（纯函数，能脱离 Electron 单测）----------
//
// 规则：优先放宠物右边；右边顶到屏幕边了就翻到左边；左右都放不下就贴着右边缘。
// 竖直方向对齐到宠物头部，像它在说话。全程夹在工作区内，保证不会被屏幕裁掉。
function computeBubblePosition(petRect, workArea) {
  const px = petRect.x;
  const py = petRect.y;
  const pw = petRect.width;
  const ph = petRect.height;

  // 竖直：对齐宠物头部，再夹进工作区
  let y = py + Math.round(ph * BUBBLE_ANCHOR);
  const minY = workArea.y + BUBBLE_EDGE;
  const maxY = workArea.y + workArea.height - BUBBLE_H - BUBBLE_EDGE;
  y = Math.max(minY, Math.min(y, maxY));

  // 水平：先试右边
  let x = px + pw + BUBBLE_GAP;
  if (x + BUBBLE_W > workArea.x + workArea.width - BUBBLE_EDGE) {
    x = px - BUBBLE_W - BUBBLE_GAP; // 右边放不下 → 左边
  }
  if (x < workArea.x + BUBBLE_EDGE) {
    x = workArea.x + workArea.width - BUBBLE_W - BUBBLE_EDGE; // 左右都放不下 → 贴右边缘
  }
  const minX = workArea.x + BUBBLE_EDGE;
  const maxX = workArea.x + workArea.width - BUBBLE_W - BUBBLE_EDGE;
  x = Math.max(minX, Math.min(x, maxX));

  return { x: Math.round(x), y: Math.round(y) };
}

function positionBubble() {
  if (!bubble || bubble.isDestroyed()) return null;

  const pet = getPetWindow();
  let rect = { x: 0, y: 0, width: 0, height: 0 };
  if (pet && !pet.isDestroyed()) {
    const [x, y] = pet.getPosition();
    const [width, height] = pet.getSize();
    rect = { x, y, width, height };
  }

  // 多显示器时用宠物所在的那块屏，别跑到主屏去
  const display = screen.getDisplayNearestPoint({
    x: rect.x + Math.round(rect.width / 2),
    y: rect.y + Math.round(rect.height / 2),
  });
  const pos = computeBubblePosition(rect, display.workArea);
  bubble.setPosition(pos.x, pos.y);
  return pos;
}

// ---------- 气泡窗口 ----------

function ensureBubble() {
  if (bubble && !bubble.isDestroyed()) return bubble;

  bubble = new BrowserWindow({
    width: BUBBLE_W,
    height: BUBBLE_H,
    frame: false,
    transparent: true,        // 圆角靠卡片自己画
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,        // 提醒不是「一个程序」，不该占任务栏
    show: false,              // 等加载好再显示，避免白闪
    hasShadow: false,
    roundedCorners: false,    // Win11 会给透明窗口切圆角，会切到卡片
    focusable: false,         // ★ 关键：不抢主人正在打字的焦点
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: '日程提醒',
    webPreferences: {
      preload: BUBBLE_PRELOAD,
      // 安全底线同桌宠：渲染进程与 Node 隔离（硬性约定第 1、2 条）
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 透明窗口失焦时不能被降频，否则倒计时条会卡住
    },
  });

  bubble.setAlwaysOnTop(true, 'screen-saver');
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 等网页真的加载完，否则 send 过去的内容会丢（窗口还在，但没人听）
  bubbleReady = new Promise((resolve) => {
    bubble.webContents.once('did-finish-load', () => resolve(true));
    bubble.webContents.once('did-fail-load', () => resolve(false));
  });

  bubble.loadFile(BUBBLE_HTML);

  bubble.on('closed', () => {
    bubble = null;
    bubbleReady = null;
  });

  return bubble;
}

function armAutoHide(ms) {
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  if (!ms || ms <= 0) return;
  bubbleTimer = setTimeout(() => hideBubble('没人理，自动收起'), ms);
}

async function showBubble(payload) {
  let b = ensureBubble();
  if (!b || b.isDestroyed()) return false;

  let loaded = await bubbleReady;

  // 加载失败过一次就不能把坏窗口留着 —— 否则以后每次提醒都会 await 到一个
  // 永远是 false 的 Promise，气泡从此再也不弹（而且完全没有报错，纯静默失效）。
  // 所以销毁重建，给下一次机会。
  if (!loaded) {
    console.error('[reminder] 气泡网页加载失败，销毁后重试一次');
    try { if (bubble && !bubble.isDestroyed()) bubble.destroy(); } catch { /* 忽略 */ }
    bubble = null;
    bubbleReady = null;
    b = ensureBubble();
    if (!b || b.isDestroyed()) return false;
    loaded = await bubbleReady;
  }

  if (!loaded || !bubble || bubble.isDestroyed()) return false;

  positionBubble();
  bubble.webContents.send('bubble:update', payload);
  bubble.showInactive(); // ★ 显示但不激活窗口，不抢焦点

  // 宠物挪窝时气泡跟着走（拖拽时也贴着她，不会一个在这一个在那）
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed() && !petMoveHandler) {
    petMoveHandler = () => positionBubble();
    pet.on('move', petMoveHandler);
  }

  armAutoHide(payload.autoHideMs);
  return true;
}

function hideBubble(reason = '') {
  clearTimeout(bubbleTimer);
  bubbleTimer = null;

  const pet = getPetWindow();
  if (pet && !pet.isDestroyed() && petMoveHandler) {
    pet.removeListener('move', petMoveHandler);
  }
  petMoveHandler = null;

  if (bubble && !bubble.isDestroyed() && bubble.isVisible()) {
    bubble.hide();
    if (reason) console.log(`[reminder] 气泡收起（${reason}）`);
  }
}

function isShowing() {
  return !!(bubble && !bubble.isDestroyed() && bubble.isVisible());
}

// ---------- 主入口 ----------

// 到点了 → 把这条日程呈现给主人。
// 返回一条记录（哪个渠道真的生效了），方便自检判断，而不是靠肉眼看日志。
async function present(item, target, opts = {}) {
  const when = target instanceof Date ? target : new Date();
  const autoHideMs = opts.autoHideMs === undefined ? BUBBLE_AUTO_HIDE_MS : opts.autoHideMs;

  const payload = {
    title: (item && item.title) || '（无标题）',
    time: `${clockOf(when)} 到点`,
    autoHideMs,
  };
  current = payload;

  const pet = getPetWindow();
  const petAlive = !!(pet && !pet.isDestroyed());
  const petVisible = petAlive && pet.isVisible();

  // ① 桌宠本体做反应（切表情 + 放动作）
  let reacted = false;
  if (petAlive) {
    try {
      pet.webContents.send('reminder:notify', payload);
      reacted = true;
    } catch (err) {
      console.error('[reminder] 通知桌宠失败：', err && err.message);
    }
  }

  // ② 冒气泡 —— 只在桌宠露脸时才有意义（气泡就贴在它旁边）
  let bubbleShown = false;
  if (petVisible) {
    try {
      bubbleShown = await showBubble(payload);
    } catch (err) {
      // 气泡建不出来绝不能影响别的日程（scheduler 的回调会兜住，但这里也别抛）
      console.error('[reminder] 气泡显示失败：', err && err.message);
    }
  }

  // ③ 兜底：桌宠收进托盘看不见 → 用系统通知，别让提醒被静默吞掉
  let notified = false;
  if (!bubbleShown && Notification.isSupported()) {
    try {
      new Notification({
        title: '日程提醒',
        body: `${payload.title} · ${payload.time}`,
      }).show();
      notified = true;
    } catch (err) {
      console.error('[reminder] 系统通知失败：', err && err.message);
    }
  }

  const record = {
    title: payload.title,
    time: payload.time,
    reacted,
    bubble: bubbleShown,
    notification: notified,
    at: Date.now(),
  };
  history.push(record);
  if (history.length > 20) history.shift();

  console.log(
    `[reminder] 提醒「${payload.title}」→ 桌宠${reacted ? '已通知' : '未通知'} · ` +
    `气泡${bubbleShown ? '已显示' : '未显示'} · 系统通知${notified ? '已发' : '未发'}`
  );
  return record;
}

// ---------- 初始化 ----------

function init(opts = {}) {
  if (typeof opts.getPetWindow === 'function') getPetWindow = opts.getPetWindow;
  if (inited) return;
  inited = true;

  // 气泡窗口来取内容
  ipcMain.handle('bubble:get-data', () => current);
  // 主人点了「知道了」
  ipcMain.on('bubble:dismiss', () => hideBubble('主人点了知道了'));

  console.log('[reminder] 提醒呈现已就绪（气泡窗口按需创建）');
}

// ---------- 自检辅助 ----------
// 让自检能「问」气泡窗口的真实状态，而不是相信我们自己的变量。

function getBubbleWindow() {
  return bubble && !bubble.isDestroyed() ? bubble : null;
}

async function debugBubble() {
  const b = getBubbleWindow();
  if (!b) return { exists: false, visible: false, dom: null, bounds: null };

  let dom = null;
  try {
    dom = await b.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('title');
      const m = document.getElementById('time');
      return { title: t ? t.textContent : null, time: m ? m.textContent : null };
    })()`);
  } catch { /* 网页还没准备好 */ }

  // focusable 是 Task 9 加的：拦截提示窗口必须是 true、气泡必须是 false，
  // 两个值必须**不一样**（自检里就是这么对照的，别把气泡也改成 focusable:true）。
  return { exists: true, visible: b.isVisible(), focusable: b.isFocusable(), dom, bounds: b.getBounds() };
}

module.exports = {
  // 常量
  BUBBLE_W,
  BUBBLE_H,
  BUBBLE_GAP,
  BUBBLE_AUTO_HIDE_MS,
  // 主流程
  init,
  present,
  hideBubble,
  positionBubble,
  isShowing,
  // 纯函数（单测用）
  computeBubblePosition,
  // 自检用
  getBubbleWindow,
  debugBubble,
  getCurrent: () => current,
  getHistory: () => history.slice(),
  clearHistory: () => { history.length = 0; },
};
