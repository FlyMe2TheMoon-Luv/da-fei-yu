// src/main/main.js
// 主进程入口：创建桌宠窗口、托盘、生命周期。
//
// 阶段 1 要做的事（见 HANDOFF.md 第九节）：
//   1. 窗口透明 / 无边框 / 置顶 / 不进任务栏
//   2. 拖拽移动（由渲染进程发起，见下方 pet:drag-* 通道）
//   3. 动态鼠标穿透（渲染进程判定鼠标是否在角色身上，这里只负责执行）
//   4. 托盘图标 + 右键菜单
//   5. 位置记忆 + 换显示器越界保护
//
// 分工原则（CLAUDE.md 硬性约定第 1 条）：主进程碰系统，渲染进程碰界面。
// 渲染进程自己判断不了「鼠标是不是压在角色身上」（那是像素级的事），
// 所以判定在渲染进程做，setIgnoreMouseEvents 的执行在主进程做。

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const store = require('./store');

const log = (m) => console.log('[main] ' + m);

// ---------- 常量 ----------

// 桌宠窗口尺寸。角色本体是「宽 > 高」的坐姿，所以不用正方形。
// 渲染进程会自动把角色缩放到贴合这个窗口，改这里不用改渲染进程。
const WIN_W = 400;
const WIN_H = 380;

const STATE_FILE = 'window-state.json';

let win = null;
let tray = null;
let quitting = false; // 真退出 vs 收进托盘，靠它区分
let dragOffset = null; // 拖拽时鼠标相对窗口左上角的偏移
let saveTimer = null;

// ---------- 位置记忆 ----------

// 判断这个位置还落在某块屏幕上吗（拔掉外接显示器后，原来的坐标会跑到屏幕外）
// 规则：窗口至少有 1/4 面积在某块屏幕的工作区内，就算合法。
function isPositionUsable(x, y) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ox = Math.max(0, Math.min(x + WIN_W, a.x + a.width) - Math.max(x, a.x));
    const oy = Math.max(0, Math.min(y + WIN_H, a.y + a.height) - Math.max(y, a.y));
    return ox * oy >= (WIN_W * WIN_H) / 4;
  });
}

// 默认位置：主屏右下角，留一点边距
function defaultPosition() {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - WIN_W - 48, y: a.y + a.height - WIN_H - 48 };
}

function loadPosition() {
  const saved = store.read(STATE_FILE, null);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && isPositionUsable(saved.x, saved.y)) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  return defaultPosition();
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  store.write(STATE_FILE, { x, y });
}

// 拖拽时 setPosition 会疯狂触发 moved，节流一下再落盘
function scheduleSavePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 400);
}

// ---------- 窗口 ----------

function createWindow() {
  const { x, y } = loadPosition();

  const d = screen.getPrimaryDisplay();
  log(`屏幕 ${d.size.width}×${d.size.height} · 缩放 ${d.scaleFactor} · 工作区 ${d.workArea.width}×${d.workArea.height} · 窗口放 ${x},${y}`);

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    // 让 width/height 指的是「网页可视区域」而不是「含隐形边框的窗口」。
    // 不加这条的话，Windows 上 innerWidth 会比 400 多出几个像素，
    // 渲染进程按 innerWidth 画的画布就会被窗口裁掉一条边。
    useContentSize: true,
    frame: false, // 无边框
    transparent: true, // 背景透明（配合渲染进程的 WebGL 透明画布）
    resizable: false,
    hasShadow: false, // 有阴影的话透明边缘会显出一圈灰
    skipTaskbar: true, // 不占任务栏，桌宠该待在托盘
    show: false, // 等渲染好再显示，避免白闪一下
    backgroundColor: '#00000000',
    roundedCorners: false, // Windows 11 默认会给窗口切圆角，会切到角色
    title: '桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全底线：渲染进程与 Node 隔离，只能通过 preload 暴露的接口通信
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：透明窗口 + WebGL 常驻，窗口失焦时不能被降频，
      // 否则切到别的软件后桌宠会像卡死一样不动
      backgroundThrottling: false,
    },
  });

  // screen-saver 层级：比普通置顶更高，能压在任务栏之上
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'index.html'));

  // 开发时把渲染进程的日志转发到终端，方便看加载进度和报错
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const msg = first && typeof first === 'object' && 'message' in first ? first.message : args[2];
      if (msg) console.log('[renderer]', msg);
    });
  }

  win.once('ready-to-show', () => win.show());

  // 开发自检：模拟鼠标移动，验证「穿透切换」整条链路通不通。
  // 只测渲染进程 → 主进程这一段的逻辑；系统层是否真的放行点击，只能靠人手试。
  // 用 PET_SELFTEST=1 启动才会跑。
  if (!app.isPackaged && process.env.PET_SELFTEST === '1') {
    setTimeout(runInputSelfTest, 4000);
  }

  // 位置变化就记下来
  win.on('moved', scheduleSavePosition);

  // 关闭按钮 / Alt+F4 不真退出，收进托盘（真退出走托盘菜单）
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    savePosition();
    win.hide();
  });

  win.on('closed', () => { win = null; });
}

function showPet() {
  if (!win) return createWindow();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function togglePet() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isVisible()) {
    savePosition();
    win.hide();
  } else {
    win.show();
  }
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = defaultPosition();
  win.setPosition(x, y);
  savePosition();
}

// ---------- 托盘 ----------

// 菜单内容只写一份，托盘右键和桌宠身上右键共用
function menuTemplate() {
  return [
    { label: '显示 / 隐藏', click: togglePet },
    { label: '重置位置', click: resetPosition },
    { type: 'separator' },
    {
      label: '退出桌宠',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
}

function createTray() {
  // 优先用专门生成的方形托盘图标；没有就退回桌宠图标（会被压扁，但不至于没图标）
  const trayIcon = path.join(__dirname, '..', 'assets', 'tray.png');
  const fallback = path.join(__dirname, '..', 'assets', 'pet', 'icon.png');
  let img = nativeImage.createFromPath(trayIcon);
  if (img.isEmpty()) img = nativeImage.createFromPath(fallback);

  tray = new Tray(img);
  tray.setToolTip('桌宠 · 女仆鲸鱼娘');
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));

  // 左键单击也切换显示，符合大多数托盘软件的习惯
  tray.on('click', togglePet);
}

// ---------- 渲染进程发来的指令 ----------

// 拖拽：渲染进程给的是鼠标在屏幕上的坐标，这里换算成窗口左上角坐标
ipcMain.on('pet:drag-start', (_e, p) => {
  if (!win || win.isDestroyed()) return;
  const [wx, wy] = win.getPosition();
  dragOffset = { dx: Math.round(p.x) - wx, dy: Math.round(p.y) - wy };
});

ipcMain.on('pet:drag-move', (_e, p) => {
  if (!win || win.isDestroyed() || !dragOffset) return;
  win.setPosition(Math.round(p.x) - dragOffset.dx, Math.round(p.y) - dragOffset.dy);
});

ipcMain.on('pet:drag-end', () => {
  dragOffset = null;
  savePosition();
});

// 动态鼠标穿透：true = 鼠标穿过去（点在桌面上），false = 桌宠接住鼠标
let lastThrough = null;
ipcMain.on('pet:set-click-through', (_e, through) => {
  if (!win || win.isDestroyed()) return;
  if (through === lastThrough) return;
  lastThrough = through;
  log(`鼠标穿透 → ${through ? '开（放行到桌面）' : '关（接住鼠标）'}`);
  // forward: true 很关键 —— 穿透的同时仍把 mousemove 转给渲染进程，
  // 否则渲染进程再也收不到鼠标位置，就永远判定不出该不该恢复穿透了
  win.setIgnoreMouseEvents(Boolean(through), { forward: true });
});

ipcMain.on('pet:hide', () => {
  if (win && !win.isDestroyed()) {
    savePosition();
    win.hide();
  }
});

// 在桌宠身上点右键 → 弹出同一份菜单
ipcMain.on('pet:show-menu', () => {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});

// 模型裁切校准的缓存：key 是模型文件路径，value 是角色在模型本地坐标系里的范围
const BOUNDS_FILE = 'model-bounds.json';

ipcMain.handle('pet:get-bounds', (_e, key) => {
  const all = store.read(BOUNDS_FILE, {});
  return all && all[key] ? all[key] : null;
});

ipcMain.on('pet:save-bounds', (_e, key, bounds) => {
  if (!key || !bounds) return;
  const all = store.read(BOUNDS_FILE, {}) || {};
  all[key] = bounds;
  store.write(BOUNDS_FILE, all);
});

ipcMain.on('pet:quit', () => {
  quitting = true;
  app.quit();
});

// ---------- 开发自检 ----------

function runInputSelfTest() {
  if (!win || win.isDestroyed()) return;
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  log('自检开始：把鼠标「移」到角色身上 → 应该取消穿透；再移到窗口角落 → 应该恢复穿透');

  // 角色大致在窗口中间偏下
  move(200, 230);
  setTimeout(() => {
    move(4, 4); // 左上角一定是空的
    setTimeout(() => {
      log('自检结束。上面应该看到「穿透 → 关」再「穿透 → 开」两条日志');
      checkExpressions();
    }, 700);
  }, 700);
}

// 查表情到底能不能用。
// 背景：这个模型的 model3.json 原本漏了 Expressions 字段，导致 pixi-live2d-display
// 一个表情都加载不到，而 model.expression() 不报错、静默什么也不做 —— 特别坑。
// 已用 scripts/patch-model-expressions.js 补上。这里做回归哨兵。
async function checkExpressions() {
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const d = window.__petDebug;
      if (!d) return { error: '渲染进程没暴露 __petDebug' };
      const em = d.model.internalModel.motionManager.expressionManager;
      const defs = em ? em.definitions : null;
      // 注意：库内部读的是 Name（大写），getExpressionIndex 里写死了 e.Name === t
      const names = defs ? defs.map((x) => x.Name) : [];
      const out = {
        managerExists: !!em,
        count: defs ? defs.length : -1,
        firstNames: names.slice(0, 5),
        good: await d.model.expression('爱心眼'),      // 存在的表情
        bogus: await d.model.expression('这个名字不存在'), // 负对照：必须返回 false
      };
      return out;
    })()`);

    if (r.error) return log('表情自检失败：' + r.error);
    log(`表情自检：manager ${r.managerExists ? '存在' : '不存在'} · 表情数 ${r.count}`);
    if (r.firstNames && r.firstNames.length) log(`  前几个: ${r.firstNames.join('、')}`);
    log(`  调用「爱心眼」→ ${r.good}（应为 true）· 调用不存在的名字 → ${r.bogus}（应为 false）`);
    if (r.count === 0) log('  ⚠ 一个表情都没加载 —— 跑 node scripts/patch-model-expressions.js 补上');
    else if (r.good !== true) log('  ⚠ 表情加载了但切不动，要查 getExpressionIndex 的字段名');
    else if (r.bogus !== false) log('  ⚠ 不存在的表情也返回 true，说明这个自检本身不可靠');
    else log('  ✓ 表情功能正常（正例通、反例被拒，检测可信）');
  } catch (err) {
    log('表情自检失败：' + err.message);
  }
}

// ---------- 生命周期 ----------

// 托盘软件的标准做法：只允许开一个实例，重复启动就把已有窗口唤出来
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showPet);

  app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showPet();
    });
  });
}

// 桌宠是托盘常驻程序，窗口全关了也不退出
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 什么都不做：交给托盘菜单的「退出」
});

app.on('before-quit', () => {
  quitting = true;
  savePosition();
});
