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

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const store = require('./store');
const schedules = require('./schedules');
const scheduler = require('./scheduler');
const reminder = require('./reminder');
const settingsWindow = require('./settings-window');
const { placeNear } = require('./place');   // 自检里要复算一遍设置窗口该待的位置

const log = (m) => console.log('[main] ' + m);

// Windows 上必须设这个，否则系统通知显示不出应用名（HANDOFF 第七节「这一步的坑」）。
// 要在 app ready 之前调用。
app.setAppUserModelId('com.desktop-pet.app');

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
let dragProbe = null;  // 拖拽自检用：非 null 时逐次记录（见 runDragSelfTest）
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
    // ★ 关键：桌宠永远不抢输入焦点。
    //   主人反馈「打字的时候桌宠抢焦点」—— 桌宠是常驻置顶窗口，以前点它一下
    //   就把正在打字的软件顶到后台，输入框失焦，打得正顺的字就断了。
    //   设成 focusable:false 后，鼠标照样点得到（拖拽、点按钮都不受影响），
    //   但它拿不到键盘焦点、也不会把别的窗口挤下去。
    //   ⚠ 配套要求：显示它一律用 showInactive()，别用 show()。
    focusable: false,
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

  // showInactive 而不是 show：桌宠是 focusable:false，用 show 有可能顺手把焦点
  // 挪到它身上（不同 Windows 版本表现不一致），showInactive 明确表示「只显示、不激活」。
  win.once('ready-to-show', () => win.showInactive());

  // 开发自检：模拟鼠标移动，验证「穿透切换」整条链路通不通。
  // 只测渲染进程 → 主进程这一段的逻辑；系统层是否真的放行点击，只能靠人手试。
  // 用 PET_SELFTEST=1 启动才会跑。
  if (!app.isPackaged && process.env.PET_SELFTEST === '1') {
    setTimeout(runInputSelfTest, 4000);
  }

  // 开发自检：合成一次拖拽，量「拖动卡顿」问题（见 runDragSelfTest）。
  // 注意：桌宠是单实例程序，跑这个要另给一个 user-data-dir，否则会被已有实例顶掉。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'drag') {
    setTimeout(runDragSelfTest, 800);
  }

  // 开发自检：拖拽时「视线跟随」有没有真的关掉（见 runGazeSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'gaze') {
    setTimeout(runGazeSelfTest, 800);
  }

  // 开发自检：退出按钮（见 runExitButtonSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'exit') {
    setTimeout(runExitButtonSelfTest, 800);
  }

  // 开发自检：调度引擎端到端（见 runSchedulerSelfTest）。要等 30 秒轮询，慢一点。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'scheduler') {
    setTimeout(runSchedulerSelfTest, 1200);
  }

  // 开发自检：提醒呈现（见 runReminderSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'reminder') {
    setTimeout(runReminderSelfTest, 1200);
  }

  // 开发自检：日程管理窗口（见 runSettingsSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'settings') {
    setTimeout(runSettingsSelfTest, 1200);
  }

  // 开发自检：桌宠不抢焦点（见 runFocusSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'focus') {
    setTimeout(runFocusSelfTest, 1200);
  }

  // 位置变化就记下来
  win.on('moved', scheduleSavePosition);

  // 收到关闭请求（比如托盘菜单里点了「隐藏」）不真退出，只收进托盘。
  // 真退出走托盘菜单的「退出桌宠」——那条路会把 quitting 置为 true，这里直接放行。
  // 注：窗口现在是 focusable:false，Alt+F4 够不到它（这正是我们想要的：
  //    主人按 Alt+F4 应该关掉自己正在用的软件，而不是把桌宠关掉）。
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
  win.showInactive();   // 不抢焦点，见 createWindow 里 focusable:false 的注释
  win.setAlwaysOnTop(true, 'screen-saver');
}

function togglePet() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isVisible()) {
    savePosition();
    win.hide();
  } else {
    win.showInactive();
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
    { label: '日程管理…', click: () => settingsWindow.open() },
    { type: 'separator' },
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
  const tx = Math.round(p.x) - dragOffset.dx;
  const ty = Math.round(p.y) - dragOffset.dy;
  win.setPosition(tx, ty);
  // 自检时才记录，平时零开销
  if (dragProbe) {
    const [ax, ay] = win.getPosition();
    dragProbe.moves.push({ reqX: p.x, reqY: p.y, tx, ty, ax, ay, at: Date.now() });
  }
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

// 桌宠身上的「日程管理」按钮 → 打开设置窗口（和托盘菜单同一个入口）
ipcMain.on('pet:open-settings', () => settingsWindow.open());

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

// ---------- 日程提醒 ----------

// 调度引擎（2-2）判定「到点了」，这里负责「怎么让主人知道」（2-3）。
// 三招（桌宠表演 / 气泡 / 系统通知）都在 reminder.js 里，这里只做转交 + 记账。
//
// lastFired 是给自检看的：判断「到底响没响」，而不是靠肉眼看日志。
const lastFired = [];

function fmtClock(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function onScheduleDue(item, target) {
  lastFired.push({ id: item.id, title: item.title, at: target });
  log(`该提醒了：${item.title}（日程 ${item.time}，实际到点 ${fmtClock(target)}）`);

  // 呈现失败也绝不能把调度引擎带崩 —— 否则一条日程炸了，后面所有日程都不提醒了。
  // （scheduler 的回调外面还有一层 try/catch，这里是第二道保险。）
  try {
    await reminder.present(item, target);
  } catch (err) {
    log('提醒呈现出错：' + (err && err.message ? err.message : String(err)));
  }
}

// ---------- 开发自检：拖拽 ----------
// 量三件事（对应「拖动窗口时人物卡顿抽搐」）：
//   ① 一次拖拽让窗口搬了多少次 —— 现在是一比一，mousemove 多少次就搬多少次
//   ② 坐标链路准不准 —— 渲染进程报的 screenX 和「鼠标真实屏幕位置」差多少
//   ③ 拖拽期间掉不掉帧 —— 帧间隔中位/最大，和安静时的基线对比
//
// 做法：让渲染进程直接调拖拽接口（petAPI.dragStart / dragMove / dragEnd），
// 主进程照常搬窗口 —— 窗口是**真的在动**，所以量到的代价是真的。
// ⚠ 不用 sendInputEvent 合成鼠标事件：实测 Electron 合成的鼠标事件里
//   screenX/screenY 恒为 0（不是真实屏幕坐标），测出来的东西是假的。
//
// 用法：PET_SELFTEST=drag npm start -- --no-gpu --user-data-dir=<临时目录>
// （桌宠是单实例程序，必须另给 user-data-dir，否则会被已在运行的实例顶掉）
// 可选：DRAG_TEST_HZ=125,500,0 指定要测的「鼠标上报频率」，0 表示连续发（极端情况）

const DRAG_TEST_RATES = (process.env.DRAG_TEST_HZ || '125,500,0')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPet(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ready = await win.webContents.executeJavaScript('!!(window.__petDebug && window.__petDebug.model)');
      if (ready) return true;
    } catch { /* 还没就绪，继续等 */ }
    await sleep(300);
  }
  return false;
}

function quitAfterSelfTest() {
  log('===== 自检结束 =====');
  setTimeout(() => app.quit(), 300);
}

function statOf(arr) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: arr.length,
    med: s[Math.floor(s.length / 2)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
    over50: arr.filter((g) => g > 50).length,
  };
}

// 安静时先采一段帧间隔当基线
async function sampleBaseline(ms) {
  await win.webContents.executeJavaScript(
    '(() => { const d = window.__petDebug; d.frameGap.samples = []; d.frameGap.on = true; return true; })()'
  );
  await sleep(ms);
  return win.webContents.executeJavaScript(
    '(() => { const d = window.__petDebug; d.frameGap.on = false; return d.frameGap.samples; })()'
  );
}

async function runDragSelfTest() {
  const STEPS = 60;
  const DX = 3;
  const DY = 2;

  log('===== 拖拽自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪（模型没加载出来？）'); return quitAfterSelfTest(); }
  log(`渲染进程就绪 · 每轮 ${STEPS} 步 · 总位移 ${DX * STEPS}×${DY * STEPS}`);

  // ① 基线：窗口不动
  const base = statOf(await sampleBaseline(1500));
  if (base) {
    log(`【基线·窗口不动】帧间隔 中位 ${base.med.toFixed(1)}ms · p90 ${base.p90.toFixed(1)}ms · 最大 ${base.max.toFixed(1)}ms · 掉帧(>50ms) ${base.over50}/${base.n}`);
  }

  // ② 逐个频率测：窗口真的在动
  for (const hz of DRAG_TEST_RATES) {
    const stepMs = hz > 0 ? Math.max(1, Math.round(1000 / hz)) : 0;
    const [wx0, wy0] = win.getPosition();
    const start = { x: wx0 + 100, y: wy0 + 100 }; // 假装鼠标在窗口内 100,100 处按下

    dragProbe = { moves: [] };
    const res = await win.webContents.executeJavaScript(`(async () => {
      const api = window.petAPI, d = window.__petDebug;
      const STEPS = ${STEPS}, DX = ${DX}, DY = ${DY}, STEP_MS = ${stepMs};
      const sx = ${start.x}, sy = ${start.y};
      d.frameGap.samples = [];
      d.frameGap.on = true;
      const t0 = performance.now();
      api.dragStart({ x: sx, y: sy });
      for (let i = 1; i <= STEPS; i++) {
        api.dragMove({ x: sx + DX * i, y: sy + DY * i });
        if (STEP_MS > 0) await new Promise((r) => setTimeout(r, STEP_MS));
      }
      api.dragEnd();
      const ms = performance.now() - t0;
      d.frameGap.on = false;
      return { ms, samples: d.frameGap.samples };
    })()`);

    const probe = dragProbe;
    dragProbe = null;
    await sleep(250); // 让窗口停稳

    const [wxEnd, wyEnd] = win.getPosition();
    const st = statOf(res.samples);
    const perSec = res.ms > 0 ? (probe.moves.length / (res.ms / 1000)) : 0;

    // 跟踪误差：主进程算出来的目标位置 vs 理论值（理论值 = 起点 + 步长×步数）
    let trackMax = 0;
    let landMax = 0;
    probe.moves.forEach((m, i) => {
      const expX = wx0 + DX * (i + 1);
      const expY = wy0 + DY * (i + 1);
      trackMax = Math.max(trackMax, Math.abs(m.tx - expX), Math.abs(m.ty - expY));
      landMax = Math.max(landMax, Math.abs(m.ax - m.tx), Math.abs(m.ay - m.ty));
    });

    const label = hz > 0 ? `${hz}Hz` : '连续发（极端）';
    log(`【拖拽·${label}】收到 ${probe.moves.length} 次移动 → 搬窗口 ${probe.moves.length} 次（实测 ${perSec.toFixed(0)} 次/秒）`);
    log(`   窗口位移 ${wxEnd - wx0},${wyEnd - wy0}（期望 ${DX * STEPS},${DY * STEPS}）· 目标位置误差 ${trackMax.toFixed(0)}px · 落地误差 ${landMax.toFixed(0)}px`);
    if (st) log(`   帧间隔 中位 ${st.med.toFixed(1)}ms · p90 ${st.p90.toFixed(1)}ms · 最大 ${st.max.toFixed(1)}ms · 掉帧(>50ms) ${st.over50}/${st.n}`);
    if (base && st) {
      const r = base.med > 0 ? st.med / base.med : 0;
      log(`   → 相对基线 ${r.toFixed(2)} 倍${r > 1.25 ? ' ⚠ 明显变慢' : ''}`);
    }

    // 每轮之间把窗口挪回原处，保证起点一致
    win.setPosition(wx0, wy0);
    await sleep(300);
  }

  quitAfterSelfTest();
}

// ---------- 开发自检：拖拽时的「视线跟随」开关 ----------
// 要验的是：拖拽期间角色的头不再被鼠标位置牵着抖。
//
// 这里能用 sendInputEvent 合成 mousedown/mouseup —— 因为渲染进程的
// mousedown/mouseup 处理函数不看 screenX（只有拖拽移动才看），
// 所以虽然合成事件的 screenX 恒为 0，触发「进入拖拽状态 / 退出拖拽状态」这两件事
// 是完全可靠的。（screenX=0 会让窗口原地不动，正好，不会干扰。）
//
// 判定方式：直接问库本身 —— 拖拽中 interactionManager 还在不在。
// 光看日志「我调了关闭函数」不算证据（HANDOFF 第六节第 19 条的教训：要能证伪）。
async function runGazeSelfTest() {
  log('===== 视线跟随自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  // 问库：autoInteract 标志 + 视线监听到底挂没挂
  const state = () => win.webContents.executeJavaScript(`(() => {
    const m = window.__petDebug.model;
    return { autoInteract: m.autoInteract, attached: !!m.interactionManager };
  })()`);

  const center = await win.webContents.executeJavaScript(`(() => {
    const b = window.__petDebug.model.getBounds();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);

  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };

  const idle = await state();
  ok(idle.autoInteract === true && idle.attached === true,
    '平时：视线跟随是开着的（招牌动作）', ` → autoInteract=${idle.autoInteract} 已挂=${idle.attached}`);

  // 把鼠标压到角色身上，否则 mousedown 会被忽略
  win.webContents.sendInputEvent({ type: 'mouseMove', x: center.x, y: center.y });
  await sleep(400);

  // --- 按下：应该进入拖拽状态，视线跟随被摘掉 ---
  win.webContents.sendInputEvent({ type: 'mouseDown', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await sleep(150);
  const draggingState = await state();
  ok(draggingState.autoInteract === false, '拖拽中：autoInteract 标志已置 false', ` → ${draggingState.autoInteract}`);
  ok(draggingState.attached === false, '★ 拖拽中：视线监听确实摘掉了（头不会再跟着抖）', ` → 已挂=${draggingState.attached}`);

  // 拖拽中再动几下，确认不会被库「偷偷挂回来」
  for (let i = 1; i <= 5; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: center.x + i * 3, y: center.y + i * 2 });
    await sleep(30);
  }
  const stillOff = await state();
  ok(stillOff.attached === false, '拖拽中移动若干次后，视线监听仍然是摘掉的（没被库挂回来）', ` → 已挂=${stillOff.attached}`);

  // --- 松手：应该恢复 ---
  win.webContents.sendInputEvent({ type: 'mouseUp', x: center.x, y: center.y, button: 'left', clickCount: 1 });
  await sleep(500); // 留几帧，让 _render() 自动挂回
  const after = await state();
  ok(after.autoInteract === true, '松手后：autoInteract 标志恢复 true', ` → ${after.autoInteract}`);
  ok(after.attached === true, '★ 松手后：视线跟随自动挂回来了（招牌动作没丢）', ` → 已挂=${after.attached}`);

  log(`===== 视线跟随自检结束：${pass} 通过 / ${fail} 失败 =====`);
  log(fail === 0 ? '结论：拖拽时视线跟随能正确开关' : '结论：有失败项，拖拽时角色仍会抽动');
  quitAfterSelfTest();
}

// ---------- 开发自检：退出按钮 ----------
// 要验两件事，第一件是最容易翻车的：
//   ① 鼠标移到按钮上时，窗口必须「接住鼠标」。
//      按钮是 DOM 元素、不在 WebGL 画布上 —— 如果穿透判定只读画布像素，
//      窗口会一直保持穿透，按钮**永远点不到**（而且没有任何报错，纯静默失效）。
//   ② 按钮的点击确实能触发退出（最后真点一下，程序该自己消失）。
async function runExitButtonSelfTest() {
  log('===== 退出按钮自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };
  const hitState = () => win.webContents.executeJavaScript('window.__petDebug.hitState()');

  // 按钮在窗口里的位置，顺便问浏览器「这个点上最顶层的是谁」。
  // ⚠ 必须用 closest('[data-ui]')，和 refreshHit() 里的真实判定保持一致 ——
  //   按钮里放的是 SVG，elementFromPoint 返回的最深层元素是 <path> 而不是按钮本身。
  const btn = await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btn-exit');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const el = document.elementFromPoint(cx, cy);
    const ui = el && el.closest ? el.closest('[data-ui]') : null;
    return { cx, cy, w: Math.round(r.width), h: Math.round(r.height), topEl: ui ? (ui.id || ui.tagName) : (el ? el.tagName : null) };
  })()`);

  ok(!!btn, '页面上存在退出按钮');
  if (!btn) { log('✗ 没有按钮，后面没法测'); return finishExitTest(pass, fail); }
  ok(btn.topEl === 'btn-exit', '按钮就在它自己的位置上、没被别的东西盖住', ` → 该点最顶层是 ${btn.topEl}`);
  log(`按钮位置：${btn.cx},${btn.cy}（${btn.w}×${btn.h}）`);

  const idle = await hitState();
  ok(idle.through === true, '鼠标不在窗口上时：窗口是穿透的（不挡桌面）', ` → through=${idle.through}`);

  // ① 把鼠标移到按钮上 —— 这一步是关键
  win.webContents.sendInputEvent({ type: 'mouseMove', x: btn.cx, y: btn.cy });
  await sleep(350);
  const onBtn = await hitState();
  ok(onBtn.overUi === true, '★ 鼠标移到按钮上：判定为「压在控件上」', ` → overUi=${onBtn.overUi}`);
  ok(onBtn.through === false, '★ 压在按钮上时窗口接住了鼠标（不然按钮点不动）', ` → through=${onBtn.through}`);

  // 移开，应该恢复穿透
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 });
  await sleep(350);
  const away = await hitState();
  ok(away.overUi === false && away.through === true, '鼠标移开后：恢复穿透', ` → overUi=${away.overUi} through=${away.through}`);

  log(`--- 前半段结果：${pass} 通过 / ${fail} 失败 ---`);

  // ② 真点一下。点成功的话，这个进程会在下面这 2.5 秒内自己消失，
  //    日志就会停在上一行 —— 「日志停在这里」本身就是成功信号。
  log('最后一步：真点一下退出按钮。点了之后这个自检窗口就该消失；');
  log('           如果 2.5 秒后还看到「✗ 按钮点了没反应」，说明没生效。');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: btn.cx, y: btn.cy });
  await sleep(250);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await sleep(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await sleep(2500);

  log('✗ 按钮点了没反应，2.5 秒后程序还活着');
  finishExitTest(pass, fail + 1);
}

function finishExitTest(pass, fail, label = '退出按钮') {
  log(`===== ${label}自检结束：${pass} 通过 / ${fail} 失败 =====`);
  log(fail === 0 ? `结论：${label}可用` : `结论：${label}有失败项`);
  quitAfterSelfTest();
}

// ---------- 开发自检：桌宠不抢焦点 ----------
// 主人反馈：「打字的时候桌宠抢焦点」。桌宠是常驻置顶窗口，以前鼠标点它一下
// 就把正在打字的软件顶到后台、输入框失焦，打得正顺的字就断了。
// 修法是 focusable:false。这个自检盯住它，防止以后被无意改回去。
//
// ⚠ 诚实的边界（别把这个自检当成万能证明）：
//   这里能验的是「窗口的配置对不对」。
//   「真的不影响别的软件打字」是操作系统层的行为，自动化测不到，只能人工试。
//   所以特意加了两条负对照，防止「假通过」：
//     ③ 窗口必须真的显示出来了 —— 否则「不抢焦点」可能只是因为压根没显示
//     ④ 设置窗口必须**还能**抢焦点 —— 否则可能是把整个程序的焦点能力都关掉了
async function runFocusSelfTest() {
  log('===== 桌宠不抢焦点自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };

  // ===== ① 核心：桌宠窗口必须不可聚焦 =====
  log('① 桌宠窗口的聚焦属性');
  ok(win.isFocusable() === false, '★ 桌宠 focusable=false（点它不会抢走键盘焦点）',
    ` → focusable=${win.isFocusable()}`);
  ok(win.isFocused() === false, '★ 它当前也不是焦点窗口',
    ` → focused=${win.isFocused()}`);

  // ===== ② ★ 负对照：它得真的显示着，不然「不抢焦点」是废话 =====
  log('② ★ 负对照：确认它真的显示着（排除「因为没显示所以不抢焦点」）');
  win.showInactive();
  await sleep(400);
  ok(win.isVisible() === true, '★ 调 showInactive() 之后桌宠确实显示着',
    ` → visible=${win.isVisible()}`);
  ok(win.isFocused() === false, '★ 显示之后它也没有变成焦点窗口',
    ` → focused=${win.isFocused()}`);
  ok(win.isAlwaysOnTop() === true, '仍然浮在最上层（不抢焦点 ≠ 不置顶）',
    ` → isAlwaysOnTop=${win.isAlwaysOnTop()}`);

  // ===== ③ ★ 负对照：在它身上点一下，焦点不能被抢走 =====
  // 注：sendInputEvent 是直接灌进渲染进程的，绕过了操作系统那一层，
  //     所以这条能证明的是「配置没被改回去」，证明不了系统层的真实行为。
  log('③ ★ 负对照：在角色身上点一下');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 190 });
  await sleep(150);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 190, button: 'left', clickCount: 1 });
  await sleep(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 190, button: 'left', clickCount: 1 });
  await sleep(400);
  ok(win.isFocusable() === false, '★ 点过之后依然 focusable=false');
  ok(win.isFocused() === false, '★ 点过之后依然没抢到焦点',
    ` → focused=${win.isFocused()}`);
  ok(win.isVisible() === true, '点过之后桌宠还在（没被误关掉）');

  // ===== ④ ★ 负对照：主人主动打开的设置窗口，必须还能抢焦点 =====
  // 「不抢焦点」如果做过头（比如整个程序都关了），主人就没法在设置窗口里打字了。
  log('④ ★ 负对照：设置窗口必须还能拿焦点');
  settingsWindow.open();
  await sleep(900);
  const sw = settingsWindow.getWindow();
  if (!sw) {
    ok(false, '设置窗口没能打开');
  } else {
    await new Promise((r) => {
      if (!sw.webContents.isLoading()) return r();
      sw.webContents.once('did-finish-load', r);
    });
    await sleep(400);
    ok(sw.isFocusable() === true, '★ 设置窗口 focusable=true（主人能在里面打字）',
      ` → focusable=${sw.isFocusable()}`);
    ok(sw.isFocused() === true, '★ 设置窗口真的拿到了焦点（打开就能直接输入）',
      ` → focused=${sw.isFocused()}`);
  }

  // ===== ⑤ 关掉设置窗口 → 桌宠恢复置顶，且依然不抢焦点 =====
  log('⑤ 关掉设置窗口之后的收尾');
  settingsWindow.close();
  await sleep(700);
  ok(settingsWindow.isOpen() === false, '设置窗口已关闭');
  ok(win.isAlwaysOnTop() === true, '★ 桌宠恢复置顶（没被忘在普通层级）',
    ` → isAlwaysOnTop=${win.isAlwaysOnTop()}`);
  ok(win.isFocusable() === false, '★ 关掉之后桌宠依然不抢焦点',
    ` → focusable=${win.isFocusable()}`);

  // ===== ⑥ 提醒气泡同样不能抢焦点 =====
  log('⑥ 提醒气泡也不能抢焦点');
  await reminder.present({ title: '自检·不抢焦点' }, new Date(), { autoHideMs: 0 });
  await sleep(600);
  const bw = reminder.getBubbleWindow();
  ok(!!bw, '气泡窗口已经建出来了');
  if (bw) {
    ok(bw.isFocusable() === false, '★ 气泡窗口 focusable=false（提醒不打断打字）',
      ` → focusable=${bw.isFocusable()}`);
    ok(bw.isFocused() === false, '★ 气泡也不是焦点窗口',
      ` → focused=${bw.isFocused()}`);
    ok(bw.isVisible() === true, '气泡确实显示着（同样排除「没显示所以不抢焦点」）',
      ` → visible=${bw.isVisible()}`);
  }
  reminder.hideBubble('自检收尾');

  finishExitTest(pass, fail, '桌宠不抢焦点');
}

// ---------- 开发自检：调度引擎（端到端） ----------
// 单元测试（npm run test:scheduler）验的是「判定逻辑对不对」；
// 这里验的是「整条链路真的通了」—— 真的塞一条日程进去，等 30 秒轮询自己把它扫出来。
// 对应 HANDOFF 第七节的验收标准：「设一个 2 分钟后的日程，终端打印『该提醒了：开会』」。
async function runSchedulerSelfTest() {
  log('===== 调度引擎自检开始（端到端）=====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!scheduler.isRunning()) { log('✗ 调度引擎没启动'); return quitAfterSelfTest(); }

  // 塞一条 20 秒后的日程（时间只到分钟，所以实际落点可能比 20 秒近一些，
  // 落在过去也没关系 —— 只要没超过 5 分钟宽限窗口，照样该响）
  const at = new Date(Date.now() + 20000);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const added = schedules.add({ title: '自检·开会', time: hhmm, repeat: 'once', date: schedules.localDateKey(at) });
  if (added.error) { log('✗ 塞日程失败：' + added.error); return quitAfterSelfTest(); }

  log(`已塞入日程「${added.title}」@ ${hhmm}（id=${added.id}）`);
  log(`轮询每 ${scheduler.TICK_MS / 1000} 秒一次，最多等 75 秒…`);

  const t0 = Date.now();
  let hit = null;
  while (Date.now() - t0 < 75000) {
    hit = lastFired.find((f) => f.id === added.id) || null;
    if (hit) break;
    await sleep(500);
  }

  const waited = Math.round((Date.now() - t0) / 1000);
  if (!hit) {
    log(`✗ 等了 ${waited} 秒，调度引擎没把这条日程扫出来`);
    log('===== 调度引擎自检结束：失败 =====');
    return quitAfterSelfTest();
  }

  log(`✓ 调度引擎自己扫到了它（等了 ${waited} 秒）`);
  log(`✓ 终端打印了「该提醒了：${hit.title}」`);

  // 关键：去重。再扫一次不能重复提醒（这是「关掉重开不重复提醒」的基础）
  const reread = schedules.get(added.id);
  log(`${reread && reread.lastFiredDate ? '✓' : '✗'} lastFiredDate 已写成 ${reread && reread.lastFiredDate}（去重靠它）`);
  const again = scheduler.tick();
  const reFired = again.some((d) => d.item.id === added.id);
  log(`${reFired ? '✗ 又响了一次（去重失效）' : '✓'} 立刻再扫一遍：没有重复提醒`);

  // 清掉自检数据
  schedules.remove(added.id);
  log(`✓ 自检数据已清理`);

  const allGood = !reFired && reread && reread.lastFiredDate;
  log(`===== 调度引擎自检结束：${allGood ? '通过' : '失败'} =====`);
  quitAfterSelfTest();
}

// ---------- 开发自检：提醒呈现（阶段 2-3）----------
// 单元测试（npm run test:reminder）验的是「气泡位置算得对不对」；
// 这里验的是「整条链路真的通了」—— 提醒发下去之后，气泡**真的出现在屏幕上**、
// 内容**真的画对了**、点「知道了」**真的能收起来**、没人理**真的会自己收**。
//
// 判定原则（HANDOFF 第六节第 19 条的教训）：
//   光看到「我调了 present()、没报错」不算证据 —— 必须问气泡窗口自己的状态。
//   所以下面全部通过 reminder.debugBubble() 去问网页的 DOM 和窗口的 isVisible()。
//
// ⚠ 负对照：「桌宠收进托盘时改用系统通知」这一段会真的把桌宠藏起来、真的弹一条
//   系统通知。看到右下角冒通知是**预期行为**，不是 bug。
async function runReminderSelfTest() {
  log('===== 提醒呈现自检开始（阶段 2-3）=====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };

  reminder.clearHistory();
  await win.webContents.executeJavaScript('window.__petDebug.reminder.reset()');

  // ===== ① 正常路径：桌宠露着脸 =====
  log('① 正常路径：桌宠露着脸，到点提醒');
  const rec = await reminder.present({ title: '自检·喝水' }, new Date(), { autoHideMs: 0 });
  ok(rec.reacted === true, '桌宠收到了提醒（会切表情 + 放动作）');
  ok(rec.bubble === true, '★ 气泡窗口显示出来了');
  ok(rec.notification === false, '桌宠露脸时不发系统通知（不该重复打扰）');

  // 等网页把内容画上去
  await sleep(400);

  // ===== ② 气泡里到底画了什么（问网页本身，不问我们自己的变量）=====
  log('② 气泡内容');
  const b1 = await reminder.debugBubble();
  ok(b1.exists === true && b1.visible === true, '★ 气泡窗口真的可见（不是只创建了对象）',
    ` → exists=${b1.exists} visible=${b1.visible}`);
  ok(!!(b1.dom && b1.dom.title === '自检·喝水'), '气泡上写的标题和日程一致',
    ` → “${b1.dom && b1.dom.title}”`);
  ok(!!(b1.dom && /^\d{2}:\d{2} 到点$/.test(b1.dom.time || '')), '气泡上显示了到点时间',
    ` → “${b1.dom && b1.dom.time}”`);

  // ===== ③ 气泡位置：贴着桌宠、不越出屏幕 =====
  log('③ 气泡位置');
  const petRect = win.getBounds();
  const bb = b1.bounds;
  if (!bb) {
    ok(false, '拿不到气泡的位置');
  } else {
    // 竖直方向应该落在桌宠的高度范围内（贴着她头部）
    const nearY = bb.y >= petRect.y - 40 && bb.y <= petRect.y + petRect.height;
    ok(nearY, '气泡竖直方向贴着桌宠', ` → 气泡y=${bb.y} 桌宠 ${petRect.y}~${petRect.y + petRect.height}`);
    // 水平方向：右边缘贴桌宠，或左边缘贴桌宠
    const beside = Math.abs(bb.x - (petRect.x + petRect.width + reminder.BUBBLE_GAP)) <= 2 ||
                   Math.abs(bb.x + bb.width - (petRect.x - reminder.BUBBLE_GAP)) <= 2 ||
                   bb.x < petRect.x;
    ok(beside, '气泡水平方向在桌宠旁边（右优先，放不下翻左边）',
      ` → 气泡x=${bb.x} 桌宠x=${petRect.x} 宽=${petRect.width}`);
    const wa = screen.getDisplayNearestPoint({ x: bb.x, y: bb.y }).workArea;
    const inside = bb.x >= wa.x && bb.y >= wa.y &&
                   bb.x + bb.width <= wa.x + wa.width && bb.y + bb.height <= wa.y + wa.height;
    ok(inside, '★ 气泡完全落在屏幕工作区内（不会被裁掉）',
      ` → 气泡 ${bb.x},${bb.y} ${bb.width}×${bb.height} · 工作区 ${wa.x},${wa.y} ${wa.width}×${wa.height}`);
  }

  // ===== ④ 桌宠本体确实收到了提醒（问渲染进程的计数，别信我们自己的日志）=====
  log('④ 桌宠的反应');
  const hits = await win.webContents.executeJavaScript('window.__petDebug.reminder.hits()');
  ok(hits >= 1, '桌宠渲染进程确实收到了提醒事件', ` → 收到 ${hits} 次`);

  // ===== ⑤ 点「知道了」能收起气泡 =====
  log('⑤ 点「知道了」');
  const bw = reminder.getBubbleWindow();
  if (!bw) {
    ok(false, '拿不到气泡窗口，没法测点击');
  } else {
    const btn = await bw.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('ok');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const el = document.elementFromPoint(cx, cy);
      return { cx, cy, topEl: el ? (el.id || el.tagName) : null };
    })()`);
    ok(!!btn, '气泡上有「知道了」按钮');
    if (btn) {
      ok(btn.topEl === 'ok', '按钮就在它自己的位置上、没被别的东西盖住', ` → 该点最顶层是 ${btn.topEl}`);
      bw.webContents.sendInputEvent({ type: 'mouseMove', x: btn.cx, y: btn.cy });
      await sleep(120);
      bw.webContents.sendInputEvent({ type: 'mouseDown', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
      await sleep(60);
      bw.webContents.sendInputEvent({ type: 'mouseUp', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
      await sleep(500);
      ok(reminder.isShowing() === false, '★ 点「知道了」之后气泡收起来了',
        ` → isShowing=${reminder.isShowing()}`);
    }
  }

  // ===== ⑥ 自动收起：该收的收、不该收的不收 =====
  log('⑥ 自动收起（正例 + 负对照）');
  await reminder.present({ title: '自检·限时' }, new Date(), { autoHideMs: 900 });
  await sleep(400);
  ok(reminder.isShowing() === true, '刚弹出时气泡是显示的', ` → isShowing=${reminder.isShowing()}`);
  await sleep(1200);
  ok(reminder.isShowing() === false, '★ 倒计时走完（0.9 秒）气泡自己收了');

  await reminder.present({ title: '自检·不限时' }, new Date(), { autoHideMs: 0 });
  await sleep(1600);
  ok(reminder.isShowing() === true, '★ 负对照：autoHideMs=0 时不会误收（说明上面不是「到点就无脑收」）',
    ` → isShowing=${reminder.isShowing()}`);
  reminder.hideBubble('自检收尾');

  // ===== ⑦ 负对照：桌宠看不见时，不该冒气泡，要改用系统通知 =====
  log('⑦ 负对照：把桌宠收进托盘（看不见）再提醒一次');
  win.hide();
  await sleep(350);
  const rec2 = await reminder.present({ title: '自检·藏起来时' }, new Date(), { autoHideMs: 0 });
  ok(rec2.bubble === false, '★ 桌宠看不见时：不冒气泡（气泡会飘在空处，没意义）');
  ok(rec2.notification === Notification.isSupported(),
    '★ 桌宠看不见时：改用系统通知兜底（不该被静默吞掉）',
    ` → 系统支持通知=${Notification.isSupported()} 实际发出=${rec2.notification}`);
  win.showInactive();
  await sleep(350);

  // ===== ⑧ 收尾：别把气泡留在屏幕上 =====
  reminder.hideBubble('自检收尾');
  ok(reminder.isShowing() === false, '自检结束后气泡已收起（不留残留窗口）');

  finishExitTest(pass, fail, '提醒呈现');
}

// ---------- 开发自检：日程管理窗口（阶段 2-4）----------
// 要验的是「整条链路真的通了」，不是「我写了界面」：
//   窗口真的开出来了吗、主人填的东西真的存进文件了吗、列表真的刷新了吗、
//   填错了真的会拦下来吗、开关/删除真的生效吗。
//
// 判定原则（HANDOFF 第六节第 19 条的教训）：
//   不看界面自己的提示语，而是**两条路各问一次** ——
//   ① 问界面：DOM 里现在有几条？
//   ② 问主进程：schedules.list() 里真的有这条吗？
//   两边对上了才算数。只看一边，界面假装刷新了也能骗过测试。
//
// ⚠ 这个自检会往日程文件里写一条再删掉。跑的时候用 --isolated 更干净。
async function runSettingsSelfTest() {
  log('===== 日程管理窗口自检开始（阶段 2-4）=====');
  if (!win || win.isDestroyed()) { log('✗ 没有桌宠窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  let pass = 0;
  let fail = 0;
  let petRectBefore = null;   // 开设置窗口之前的桌宠位置，收尾时拿来对照
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };

  // 先把遗留的自检数据清掉，保证从干净状态开始
  for (const it of schedules.list()) {
    if (it.title.startsWith('自检·')) schedules.remove(it.id);
  }

  // ===== ① 从桌宠身上的按钮打开 =====
  // 顺便验第六节第 21 条那个坑：DOM 控件不在 WebGL 画布上，穿透判定看不见它，
  // 不挂 data-ui 就会「看着好好的，点上去毫无反应，而且不报错」。
  log('① 点桌宠身上的「日程管理」按钮');
  const btn = await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btn-settings');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const el = document.elementFromPoint(cx, cy);
    const ui = el && el.closest ? el.closest('[data-ui]') : null;
    return { cx, cy, topEl: ui ? (ui.id || ui.tagName) : (el ? el.tagName : null) };
  })()`);
  ok(!!btn, '桌宠界面上有「日程管理」按钮');
  if (!btn) { log('✗ 没有按钮，后面没法测'); return finishExitTest(pass, fail + 1, '日程管理窗口'); }

  ok(btn.topEl === 'btn-settings', '按钮就在它自己的位置上、没被别的东西盖住',
    ` → 该点最顶层是 ${btn.topEl}`);

  win.webContents.sendInputEvent({ type: 'mouseMove', x: btn.cx, y: btn.cy });
  await sleep(350);
  const btnHit = await win.webContents.executeJavaScript('window.__petDebug.hitState()');
  ok(btnHit.overUi === true && btnHit.through === false,
    '★ 鼠标移上去时窗口接住了鼠标（不然按钮点不动）',
    ` → overUi=${btnHit.overUi} through=${btnHit.through}`);

  // 真点一下
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await sleep(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.cx, y: btn.cy, button: 'left', clickCount: 1 });
  await sleep(900);

  const sw = settingsWindow.getWindow();
  ok(settingsWindow.isOpen() === true, '★ 按钮点下去，窗口真的开出来了');
  if (!sw) { log('✗ 窗口没开出来，后面没法测'); return finishExitTest(pass, fail + 1, '日程管理窗口'); }

  await new Promise((r) => {
    if (!sw.webContents.isLoading()) return r();
    sw.webContents.once('did-finish-load', r);
  });
  await sleep(400);

  ok(sw.isVisible() === true, '★ 窗口真的显示出来了（不是只创建了对象）',
    ` → visible=${sw.isVisible()}`);
  log(`窗口尺寸 ${sw.getBounds().width}×${sw.getBounds().height}`);

  // ===== ①b 位置：必须贴着桌宠，不能丢在屏幕正中 =====
  // 主人原话：「设置窗口的按钮离桌宠太远，我希望能点击桌宠后在靠近桌宠的右上方显示出来」。
  // 以前不传 x/y，Electron 就丢在屏幕正中。这里复算一遍「应该在哪」，和实际位置对照 ——
  // 这样万一以后有人把 positionNearPet() 那行删了，这条会立刻红。
  log('①b 窗口位置');
  {
    const petRect = win.getBounds();
    const disp = screen.getDisplayMatching(petRect);
    const b = sw.getBounds();
    const want = placeNear(petRect,
      { w: settingsWindow.WIN_W, h: settingsWindow.WIN_H }, disp.workArea);
    ok(b.x === want.x && b.y === want.y,
      `★ 窗口精确落在算好的位置上（实际 ${b.x},${b.y} / 期望 ${want.x},${want.y} · 方位 ${want.side}）`);
    // 顺带验「外框尺寸没被系统撑大」。
    // 允许 ±2 像素：屏幕缩放 1.5 时，带标题栏的窗口只要被 SetWindowPos 那类调用碰一下
    // （setPosition / setAlwaysOnTop / moveTop 都会），外框就会多出 1 像素。
    // 实测过：setBounds 写回 480×640 后，一次 setAlwaysOnTop 就变成 481×641。
    // 位置是精确的，这 1 像素对主人不可见，所以不追求像素级相等。
    const dw = Math.abs(b.width - settingsWindow.WIN_W);
    const dh = Math.abs(b.height - settingsWindow.WIN_H);
    ok(dw <= 2 && dh <= 2,
      `窗口外框尺寸和标称值相差不超过 2 像素（标称 ${settingsWindow.WIN_W}×${settingsWindow.WIN_H}）`,
      ` → 实际 ${b.width}×${b.height}`);

    const centerX = disp.workArea.x + Math.round((disp.workArea.width - b.width) / 2);
    const centerY = disp.workArea.y + Math.round((disp.workArea.height - b.height) / 2);
    ok(b.x !== centerX || b.y !== centerY,
      `★ 负对照：不再落在屏幕正中（正中是 ${centerX},${centerY}）`);

    // 「不许压住桌宠」写成了「不许**真的**盖住它」，因为允许压住一点点是有意的：
    // 宠物停在屏幕右下角时，「正上方右对齐」只差 9 像素放不下，而唯一完全不压住
    // 它的方位在屏幕左边（440px 外）。压住那 9 像素（其实还是角色外的透明边）
    // 比被甩到屏幕另一头划算，所以 place.js 里是按面积算代价的（见 place.js 注释）。
    // 这里给 5% 的上限：压住一点点可以，压住一大块不行。
    const ovW = Math.max(0, Math.min(b.x + b.width, petRect.x + petRect.width) - Math.max(b.x, petRect.x));
    const ovH = Math.max(0, Math.min(b.y + b.height, petRect.y + petRect.height) - Math.max(b.y, petRect.y));
    const ovRatio = (ovW * ovH) / (petRect.width * petRect.height);
    ok(ovRatio <= 0.05,
      `★ 没有真的把桌宠盖住（压住面积占宠物的 ${(ovRatio * 100).toFixed(1)}%，上限 5%）`);

    const gx = Math.max(petRect.x - (b.x + b.width), b.x - (petRect.x + petRect.width), 0);
    const gy = Math.max(petRect.y - (b.y + b.height), b.y - (petRect.y + petRect.height), 0);
    const gap = Math.round(Math.sqrt(gx * gx + gy * gy));
    ok(gap <= 60, `离桌宠很近（缝隙 ${gap}px）`);

    const insideArea = b.x >= disp.workArea.x && b.y >= disp.workArea.y &&
                       b.x + b.width <= disp.workArea.x + disp.workArea.width &&
                       b.y + b.height <= disp.workArea.y + disp.workArea.height;
    ok(insideArea, '完整落在屏幕工作区内（没有一半跑到屏幕外）');

    // ★ 负对照：开设置窗口会把桌宠降到普通层级（lowerPet），关掉再升回去（restorePet）。
    //   这两个动作都用 setAlwaysOnTop —— 实测它在某些缩放下会**连带挪动窗口**。
    //   桌宠位置是主人自己拖出来的，被悄悄挪走非常讨厌，所以这里盯住它。
    petRectBefore = petRect;
  }

  // 桌宠本该是 screen-saver 层级，会压住设置窗口一块 ——
  // 所以设置窗口开着的时候要把它临时降下来（关掉再升回去）。
  ok(win.isAlwaysOnTop() === false,
    '★ 设置窗口开着时，桌宠被降到普通层级（不会压住设置窗口）',
    ` → 桌宠 isAlwaysOnTop=${win.isAlwaysOnTop()}`);

  // ===== ② 这个窗口必须能抢焦点 =====
  // 气泡窗口是 focusable:false（不打断主人打字），设置窗口正好相反。
  // ⚠ 负对照放在第 ⑦ 步 —— 那里气泡窗口已经建出来了，拿它来对照才有意义。
  //   （曾经想拿桌宠窗口当对照，但实测它本身是 focusable 的，对照不出东西来。）
  log('② 能不能抢焦点（主人要在这里打字）');
  ok(sw.isFocusable() === true, '★ 设置窗口可以抢焦点',
    ` → focusable=${sw.isFocusable()}`);

  // ===== ③ 空列表该显示「还没有日程」=====
  // ⚠ 不能假设列表是空的 —— 主人本来就可能已经有日程了。
  //   所以只验「提示的显示与否，和列表空不空对得上」，不验「必须是 0 条」。
  log('③ 空状态提示');
  const emptyState = await sw.webContents.executeJavaScript(`(() => ({
    items: document.querySelectorAll('#list .item').length,
    emptyShown: !document.getElementById('empty').classList.contains('hidden'),
  }))()`);
  ok(emptyState.items === 0 ? emptyState.emptyShown === true : emptyState.emptyShown === false,
    '列表空时显示「还没有日程」、有日程时不显示（两者对得上）',
    ` → 列表 ${emptyState.items} 条 · 提示显示=${emptyState.emptyShown}`);

  // ===== ④ 负对照：标题不填就该被拦下来 =====
  log('④ ★ 负对照：标题空着保存 → 必须被拦下，且不能写进文件');
  const fileCountBefore = schedules.list().length;
  const bad = await sw.webContents.executeJavaScript(`(async () => {
    const before = document.querySelectorAll('#list .item').length;
    document.getElementById('btn-add').click();
    document.getElementById('f-title').value = '';
    document.getElementById('f-time').value = '07:15';
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 300));
    const err = document.getElementById('form-error');
    return {
      before,
      errorShown: !err.classList.contains('hidden'),
      errorText: err.textContent,
      formStillOpen: !document.getElementById('form').classList.contains('hidden'),
      items: document.querySelectorAll('#list .item').length,
    };
  })()`);
  ok(bad.errorShown === true, '界面上给出了错误提示', ` → “${bad.errorText}”`);
  ok(bad.formStillOpen === true, '表单没被关掉（主人填的东西还在，不用重填）');
  ok(bad.items === bad.before, '界面上一条都没多', ` → 还是 ${bad.before} 条`);
  ok(schedules.list().length === fileCountBefore, '★ 主进程那边也确实没写进文件',
    ` → 还是 ${fileCountBefore} 条`);

  // ===== ⑤ 正例：填好保存 → 界面和文件两边都要有 =====
  log('⑤ 添加一条日程（每天 07:15 自检·日程）');
  const added = await sw.webContents.executeJavaScript(`(async () => {
    const before = document.querySelectorAll('#list .item').length;
    const findMine = () => [...document.querySelectorAll('#list .item')]
      .find((li) => li.querySelector('.title').textContent === '自检·日程') || null;

    document.getElementById('btn-add').click();
    document.getElementById('f-title').value = '自检·日程';
    document.getElementById('f-time').value = '07:15';
    const rep = document.getElementById('f-repeat');
    rep.value = 'daily';
    rep.dispatchEvent(new Event('change'));
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 400));

    const li = findMine();
    return {
      before,
      count: document.querySelectorAll('#list .item').length,
      time: li ? li.querySelector('.time').textContent : null,
      title: li ? li.querySelector('.title').textContent : null,
      repeat: li ? li.querySelector('.repeat').textContent : null,
      formClosed: document.getElementById('form').classList.contains('hidden'),
      emptyHidden: document.getElementById('empty').classList.contains('hidden'),
    };
  })()`);

  const inFile = schedules.list().filter((x) => x.title === '自检·日程');
  ok(added.count === added.before + 1, '★ 界面上多了一条（不是「等于 1 条」—— 主人可能本来就有日程）',
    ` → ${added.before} 条 → ${added.count} 条`);
  ok(inFile.length === 1, '★ 主进程那边确实存进了文件（两边对上了才算数）',
    ` → 文件里 ${inFile.length} 条`);
  ok(added.time === '07:15' && added.title === '自检·日程', '列表上显示的时间 / 标题和填的一致',
    ` → “${added.time} ${added.title}”`);
  ok(added.repeat === '每天', '重复规则显示成人话「每天」', ` → “${added.repeat}”`);
  ok(added.formClosed === true, '保存后表单自动收起');
  ok(added.emptyHidden === true, '有日程之后，「还没有日程」的提示自动藏起来');
  const testId = inFile.length ? inFile[0].id : null;

  // ===== ⑥ 开关：临时关掉 / 打开 =====
  log('⑥ 开关（临时关掉，不删除）');
  if (testId) {
    // ⚠ 一定要按标题找到「我们自己那一行」再操作 ——
    //   直接 querySelector('#list .item .switch') 会拿到第一条，而第一条未必是我们的。
    const toggled = await sw.webContents.executeJavaScript(`(async () => {
      const findMine = () => [...document.querySelectorAll('#list .item')]
        .find((li) => li.querySelector('.title').textContent === '自检·日程') || null;

      const row = findMine();
      if (!row) return { error: '列表里找不到「自检·日程」那一行' };
      const sw2 = row.querySelector('.switch');
      const before = sw2.getAttribute('aria-pressed');
      sw2.click();
      await new Promise((r) => setTimeout(r, 400));

      const row2 = findMine();
      return {
        before,
        after: row2.querySelector('.switch').getAttribute('aria-pressed'),
        off: row2.classList.contains('off'),
      };
    })()`);
    const item = schedules.get(testId);
    ok(!toggled.error, toggled.error || '找到「自检·日程」那一行并点了开关', toggled.error ? '' : ` → ${toggled.before} → ${toggled.after}`);
    ok(toggled.before === 'true' && toggled.after === 'false', '点开关后界面状态翻转了');
    ok(item && item.enabled === false, '★ 主进程那边 enabled 也真的变成 false 了');
    ok(toggled.off === true, '关掉的日程在列表上变淡了（一眼能看出它是关着的）');

    // 打开回来，顺便验一下「关掉不等于删除」
    await sw.webContents.executeJavaScript(`(async () => {
      const row = [...document.querySelectorAll('#list .item')]
        .find((li) => li.querySelector('.title').textContent === '自检·日程');
      if (row) row.querySelector('.switch').click();
      await new Promise((r) => setTimeout(r, 400));
    })()`);
    const back = schedules.get(testId);
    ok(back && back.enabled === true, '再点一下能打开回来（关掉 ≠ 删除）');
  } else {
    ok(false, '拿不到刚加的那条日程的 id，后面没法测');
  }

  // ===== ⑦ 预览提醒：气泡真的弹出来 =====
  log('⑦ 预览提醒效果');
  const before7 = reminder.isShowing();
  await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-preview').click();
    await new Promise((r) => setTimeout(r, 700));
  })()`);
  const after7 = reminder.isShowing();
  ok(before7 === false, '点之前气泡是收着的（不然下面看不出变化）');
  ok(after7 === true, '★ 点「预览提醒效果」后气泡真的弹出来了');
  const previewDom = await reminder.debugBubble();
  ok(!!(previewDom.dom && /预览/.test(previewDom.dom.title || '')), '气泡上显示的是预览文案',
    ` → “${previewDom.dom && previewDom.dom.title}”`);

  // ★ 负对照：气泡窗口必须**不能**抢焦点，否则每次提醒都会打断主人正在打的字。
  //   有它作对照，第 ② 步「设置窗口能抢焦点」才是有意义的断言
  //   —— 否则两个窗口都返回 true，那条第 ② 步等于什么都没验。
  const bw2 = reminder.getBubbleWindow();
  ok(!!bw2 && bw2.isFocusable() === false,
    '★ 负对照：气泡窗口不能抢焦点（不打断主人打字）',
    ` → ${bw2 ? 'focusable=' + bw2.isFocusable() : '气泡窗口不在'}`);

  reminder.hideBubble('自检收尾');

  // ===== ⑧ 删除要按两下（防手滑）=====
  log('⑧ 删除：按一下是「确定删？」，按两下才真删');
  if (testId) {
    const del = await sw.webContents.executeJavaScript(`(async () => {
      const before = document.querySelectorAll('#list .item').length;
      const row = [...document.querySelectorAll('#list .item')]
        .find((li) => li.querySelector('.title').textContent === '自检·日程');
      if (!row) return { error: '列表里找不到「自检·日程」那一行' };
      const b = row.querySelector('.actions .danger');
      b.click();                                  // 第一下：变成确认
      await new Promise((r) => setTimeout(r, 150));
      const label = b.textContent;
      const stillThere = [...document.querySelectorAll('#list .item')]
        .some((li) => li.querySelector('.title').textContent === '自检·日程');
      return { before, label, stillThere };
    })()`);
    ok(del.label === '确定删？', '第一下只是变成「确定删？」', ` → “${del.label}”`);
    ok(del.stillThere === true && !!schedules.get(testId), '★ 第一下没有真的删掉（防手滑生效）');

    const after = await sw.webContents.executeJavaScript(`(async () => {
      const row = [...document.querySelectorAll('#list .item')]
        .find((li) => li.querySelector('.title').textContent === '自检·日程');
      if (row) row.querySelector('.actions .danger').click();
      await new Promise((r) => setTimeout(r, 400));
      const items = document.querySelectorAll('#list .item').length;
      return {
        items,
        mineGone: ![...document.querySelectorAll('#list .item')]
          .some((li) => li.querySelector('.title').textContent === '自检·日程'),
        emptyShown: !document.getElementById('empty').classList.contains('hidden'),
      };
    })()`);
    ok(after.mineGone === true, '第二下真的删掉了（界面上找不到它了）');
    ok(after.items === del.before - 1, '★ 列表条数正好少 1 条（没有误删别人的日程）',
      ` → ${del.before} 条 → ${after.items} 条`);
    ok(schedules.get(testId) === null, '★ 主进程那边也确实没了');
    ok(after.items === 0 ? after.emptyShown === true : after.emptyShown === false,
      '删完之后「还没有日程」提示的显示与否，和列表空不空对得上',
      ` → 剩 ${after.items} 条 · 提示显示=${after.emptyShown}`);
  }

  // ===== ⑨ 收尾 =====
  log('⑨ 收尾');
  for (const it of schedules.list()) {
    if (it.title.startsWith('自检·')) schedules.remove(it.id);
  }
  ok(schedules.list().filter((x) => x.title.startsWith('自检·')).length === 0, '自检数据已清理');

  // 重复打开不该出现第二个窗口
  const again = settingsWindow.open();
  ok(again === sw, '重复打开拿到的是同一个窗口（不会开出第二个）');

  settingsWindow.close();
  await sleep(300);
  ok(settingsWindow.isOpen() === false, '关闭后窗口对象被回收（不会漏）');
  ok(win.isAlwaysOnTop() === true,
    '★ 设置窗口关掉后，桌宠层级已恢复（继续浮在最上层）',
    ` → 桌宠 isAlwaysOnTop=${win.isAlwaysOnTop()}`);

  // ★ 负对照：整个开→关的过程里，桌宠的位置不能被挪动。
  //   原因见上面 petRectBefore 的注释：lowerPet/restorePet 用的 setAlwaysOnTop
  //   在某些缩放下会连带挪窗口。位置是主人自己拖出来的，不该被程序悄悄改掉。
  const petAfter = win.getBounds();
  if (petRectBefore) {
    ok(petAfter.x === petRectBefore.x && petAfter.y === petRectBefore.y,
      '★ 开关设置窗口的全过程中，桌宠位置没有被挪动',
      ` → ${petRectBefore.x},${petRectBefore.y} → ${petAfter.x},${petAfter.y}`);
  }

  finishExitTest(pass, fail, '日程管理窗口');
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

    // 阶段 2-3：提醒呈现。气泡窗口 + 桌宠表演 + 系统通知兜底都在这里面，
    // 这里只把「桌宠窗口在哪」告诉它（它自己拿不到）。
    reminder.init({ getPetWindow: () => win });

    // 阶段 2-4：日程管理窗口（按需打开，不占内存）。
    // 「预览提醒效果」按钮直接复用提醒呈现那套，看到的和真到点时一模一样。
    settingsWindow.init({
      onPreview: () => reminder.present({ title: '开会（预览效果）' }, new Date()),
      // 设置窗口打开期间要临时把桌宠降到普通层级，否则桌宠会压住设置窗口
      getPetWindow: () => win,
    });

    // 开发便利：启动时直接把日程管理窗口开出来，方便做视觉验收 / 截图。
    //   PET_OPEN_SETTINGS=1 npm start -- --no-gpu
    if (!app.isPackaged && process.env.PET_OPEN_SETTINGS === '1') {
      setTimeout(() => settingsWindow.open(), 2500);
    }

    // 阶段 2-2：日程调度引擎。每 30 秒扫一遍，到点回调（启动时也会立刻扫一次，
    // 把「开机前 5 分钟内刚错过」的那条补上）。
    scheduler.start(onScheduleDue);

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
  log('收到退出指令，正在退出');
  scheduler.stop();
  reminder.hideBubble('程序退出');
  savePosition();
});

// 诊断：子进程（GPU / 网络 / 渲染）意外退出时报一条。
// 起因：无 GPU 沙箱里桌宠跑几分钟会突然整个消失，只有这一行线索能查。
app.on('child-process-gone', (_e, details) => {
  console.error(`[main] ⚠ 子进程退出：${details.type} · 原因 ${details.reason} · 退出码 ${details.exitCode}`);
});
