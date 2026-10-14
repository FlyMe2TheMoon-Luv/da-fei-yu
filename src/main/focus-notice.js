// src/main/focus-notice.js
// 专注模式的「拦截提示窗口」—— 一个**会抢焦点**的透明卡片。
//
// ── 为什么需要它，而不复用提醒气泡 ──
//   提醒气泡的定位是「顺口告诉你一声」：focusable:false + showInactive()，
//   30 秒没人理就自己收。它**不能**用来问事情 —— 主人正在打字时它冒出来，
//   不抢焦点，主人可能压根没看见，然后那个「选择」就默认跳过了。
//
//   这个窗口要的是相反的东西：**停下来看一眼、做个选择**。比如
//   「你的浏览器开着安全 DNS，专注可能拦不住网站，还要开始吗」。
//   这种提示被静默吞掉，比不提示更坏 —— 主人会以为屏蔽生效了。
//
// ── 所以：焦点策略和气泡**故意不一样**（别照抄）──
//   桌宠 focusable:false · 气泡 focusable:false · 设置窗口 true · **本窗口 true**
//   显示一律用 show()，**不是** showInactive()。
//   自检里有一条负对照专门钉这件事：本窗口 true、气泡 false，两个值必须不同 ——
//   防的是「有人把窗口参数照抄串了」（见 selftest-focusmode.js）。
//
// ── 和气泡共享的视觉参数 ──
//   无边框 / 透明 / 圆角靠卡片自己画 / skipTaskbar / alwaysOnTop ——
//   这些是「看起来像同一个程序弹出来的」，照抄是对的。
//   摆位置走 place.js 的 placeNear()（项目硬约定），不自己算。

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const place = require('./place');

// ---------- 参数 ----------

const NOTICE_W = 356;
const NOTICE_H = 190;
const NOTICE_GAP = 12;

// 优先放在宠物**上方**（不压住她），实在放不下再往两边退。
// 和气泡的 up-right 略不同：这个卡片更大，压住宠物的观感更差。
const NOTICE_ORDER = ['above', 'above-right', 'above-left', 'up-right', 'up-left', 'below', 'right', 'left'];

const NOTICE_HTML = path.join(__dirname, '..', 'renderer', 'notice', 'index.html');
const NOTICE_PRELOAD = path.join(__dirname, 'preload-notice.js');

// ---------- 状态 ----------

let notice = null;          // 窗口（按需创建，之后复用）
let noticeReady = null;     // Promise：等网页加载完
let current = null;         // 当前显示的内容（网页会来取）
let seq = 0;                // 提示编号，用来防「按钮和内容错位」
let onChoose = null;        // 主人点了按钮 → 回调 (which, payload)
let petMoveHandler = null;
let getPetWindow = () => null;
let inited = false;

// 自检用：每一次提示的落地情况
const history = [];

// ---------- 摆位置 ----------

function computeNoticePosition(petRect, workArea) {
  return place.placeNear(petRect, { w: NOTICE_W, h: NOTICE_H }, workArea, {
    gap: NOTICE_GAP,
    order: NOTICE_ORDER,
  });
}

function positionNotice() {
  if (!notice || notice.isDestroyed()) return null;

  const pet = getPetWindow();
  let rect = { x: 0, y: 0, width: 0, height: 0 };
  if (pet && !pet.isDestroyed()) {
    const [x, y] = pet.getPosition();
    const [width, height] = pet.getSize();
    rect = { x, y, width, height };
  }

  // 多显示器：用宠物所在的那块屏，别跑到主屏去
  const display = screen.getDisplayNearestPoint({
    x: rect.x + Math.round(rect.width / 2),
    y: rect.y + Math.round(rect.height / 2),
  });
  const pos = computeNoticePosition(rect, display.workArea);
  // 用 setBounds 把位置和尺寸一起写回去 —— 带标题栏/无边框窗口在 1.5 倍缩放下
  // 单独 setPosition 会让外框尺寸自己飘（HANDOFF 里的坑）。
  notice.setBounds({ x: pos.x, y: pos.y, width: NOTICE_W, height: NOTICE_H });
  return pos;
}

// ---------- 窗口 ----------

function ensureNotice() {
  if (notice && !notice.isDestroyed()) return notice;

  notice = new BrowserWindow({
    width: NOTICE_W,
    height: NOTICE_H,
    useContentSize: true,
    frame: false,
    transparent: true,        // 圆角靠卡片自己画
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,        // 它是「桌宠说的一句话」，不该占任务栏
    show: false,              // 等加载好再显示，避免白闪
    hasShadow: false,
    roundedCorners: false,    // Win11 会给透明窗口切圆角，会切到卡片
    // ★★ 关键差异：这个窗口**要**抢焦点。
    //    它问的是「要不要继续」这种事，被静默吞掉比不提示更坏。
    //    （气泡是 false —— 那两个值必须不一样，自检里有负对照钉着。）
    focusable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: '专注模式',
    webPreferences: {
      preload: NOTICE_PRELOAD,
      // 安全底线同桌宠：渲染进程与 Node 隔离（硬性约定第 1、2 条）
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  notice.setAlwaysOnTop(true, 'screen-saver');
  notice.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  noticeReady = new Promise((resolve) => {
    notice.webContents.once('did-finish-load', () => resolve(true));
    notice.webContents.once('did-fail-load', () => resolve(false));
  });

  notice.loadFile(NOTICE_HTML);

  notice.on('closed', () => {
    notice = null;
    noticeReady = null;
  });

  return notice;
}

function detachPetMove() {
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed() && petMoveHandler) {
    pet.removeListener('move', petMoveHandler);
  }
  petMoveHandler = null;
}

// ---------- 对外 ----------

// 弹一条提示。
//   payload = { kind, head, title, message, primaryLabel, secondaryLabel }
//     kind: 'info' | 'warn'（只影响配色，不猜别的）
//   返回 { shown, id, reason? } —— 自检据此判断，而不是靠肉眼看日志。
async function notify(payload = {}) {
  let b = ensureNotice();
  if (!b || b.isDestroyed()) return { shown: false, reason: 'no-window' };

  let loaded = await noticeReady;

  // 加载失败过一次就不能把坏窗口留着 —— 否则以后每次提示都会 await 到一个
  // 永远是 false 的 Promise，提示从此再也不弹，而且完全没有报错（纯静默失效）。
  // 和 reminder.js 里同样的处理：销毁重建，给下一次机会。
  if (!loaded) {
    console.error('[focus-notice] 提示网页加载失败，销毁后重试一次');
    try { if (notice && !notice.isDestroyed()) notice.destroy(); } catch { /* 忽略 */ }
    notice = null;
    noticeReady = null;
    b = ensureNotice();
    if (!b || b.isDestroyed()) return { shown: false, reason: 'load-failed' };
    loaded = await noticeReady;
  }
  if (!loaded || !notice || notice.isDestroyed()) return { shown: false, reason: 'load-failed' };

  seq += 1;
  const id = `n${seq}`;
  current = {
    id,
    kind: payload.kind === 'warn' ? 'warn' : 'info',
    head: payload.head || '专注模式',
    title: payload.title || '',
    message: payload.message || '',
    primaryLabel: payload.primaryLabel || '我知道了',
    secondaryLabel: payload.secondaryLabel || '',
  };

  positionNotice();
  notice.webContents.send('focus-notice:update', current);
  // ★ show() 而不是 showInactive() —— 见文件顶部「焦点策略」那段。
  notice.show();
  notice.focus();

  // 宠物挪窝时提示跟着走（不然一个在这一个在那）
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed() && !petMoveHandler) {
    petMoveHandler = () => positionNotice();
    pet.on('move', petMoveHandler);
  }

  const record = { id, title: current.title, kind: current.kind, shown: true, at: Date.now() };
  history.push(record);
  if (history.length > 20) history.shift();

  console.log(`[focus-notice] 弹出提示「${current.title}」(${current.kind})`);
  return { shown: true, id };
}

function hide(reason = '') {
  detachPetMove();
  if (notice && !notice.isDestroyed() && notice.isVisible()) {
    notice.hide();
    if (reason) console.log(`[focus-notice] 提示收起（${reason}）`);
  }
  current = null;
}

function isShowing() {
  return !!(notice && !notice.isDestroyed() && notice.isVisible());
}

// ---------- 初始化 ----------

function init(opts = {}) {
  if (typeof opts.getPetWindow === 'function') getPetWindow = opts.getPetWindow;
  if (typeof opts.onChoose === 'function') onChoose = opts.onChoose;
  if (inited) return;
  inited = true;

  ipcMain.handle('focus-notice:get-data', () => current);

  ipcMain.on('focus-notice:choose', (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const which = p.which === 'secondary' ? 'secondary' : 'primary';
    // ★ 编号对不上就不认 —— 窗口复用时，「上一条留下的按钮点击」不该
    //   作用到这一条上（否则会出现「点了知道了，却触发了上一条的动作」）。
    if (current && p.id && String(p.id) !== String(current.id)) {
      console.log('[focus-notice] 忽略了一次过期的按钮点击');
      return;
    }
    const info = current ? { ...current } : null;
    hide(`主人点了「${which === 'primary' ? (info && info.primaryLabel) || '知道了' : (info && info.secondaryLabel) || '另一个'}」`);
    if (typeof onChoose === 'function') {
      try { onChoose(which, info); } catch (err) {
        console.error('[focus-notice] 处理按钮回调出错：', err && err.message);
      }
    }
  });

  console.log('[focus-notice] 拦截提示窗口已就绪（focusable: true，按需创建）');
}

// ---------- 自检辅助 ----------
// 让自检能「问」窗口的真实状态，而不是相信我们自己的变量。

function getNoticeWindow() {
  return notice && !notice.isDestroyed() ? notice : null;
}

async function debugNotice() {
  const b = getNoticeWindow();
  if (!b) {
    return { exists: false, visible: false, focusable: null, dom: null, bounds: null };
  }
  let dom = null;
  try {
    dom = await b.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('title');
      const m = document.getElementById('msg');
      const p = document.getElementById('btn-primary');
      const s = document.getElementById('btn-secondary');
      return {
        title: t ? t.textContent : null,
        message: m ? m.textContent : null,
        primary: p ? p.textContent : null,
        secondaryShown: !!(s && !s.classList.contains('hidden')),
        secondary: s ? s.textContent : null,
        warn: document.getElementById('card').classList.contains('warn'),
      };
    })()`);
  } catch { /* 网页还没准备好 */ }

  return {
    exists: true,
    visible: b.isVisible(),
    // ★ 这个字段就是「抢不抢焦点」的真相，自检拿它和气泡对比
    focusable: b.isFocusable(),
    bounds: b.getBounds(),
    dom,
  };
}

module.exports = {
  NOTICE_W,
  NOTICE_H,
  NOTICE_ORDER,
  init,
  notify,
  hide,
  isShowing,
  // 纯函数（能脱离 Electron 单测）
  computeNoticePosition,
  // 自检用
  getNoticeWindow,
  debugNotice,
  getCurrent: () => current,
  getHistory: () => history.slice(),
  clearHistory: () => { history.length = 0; },
};
