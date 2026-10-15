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

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, Notification, dialog } = require('electron');
const path = require('path');
const store = require('./store');
const schedules = require('./schedules');
const scheduler = require('./scheduler');
const reminder = require('./reminder');
const settingsWindow = require('./settings-window');
const chatWindow = require('./chat-window');
const focus = require('./focus');           // v3 专注模式主控（Task 4 起：只计时，不碰系统）
const focusNotice = require('./focus-notice'); // v3 专注模式·拦截提示窗口（Task 9，focusable 窗口）
const week = require('./week');             // 周视图自检要拿它做交叉验证
const { placeNear } = require('./place');   // 自检里要复算一遍设置窗口该待的位置
const brain = require('./brain');
const aiConfig = require('./ai-config');
const petDrag = require('./pet-drag');            // v4 批次 3-b：拖拽手感（纯函数）
const { estimateVelocity } = require('./spring'); // v4 批次 3-b：松手时把手指速度算出来
const reducedMotionCheck = require('./selftest-reduced-motion'); // v4 批次 3-c-2：减少动效检查

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
let petSize = null; // 桌宠窗口的标称外框尺寸，移动时必须连它一起写回（见 movePet）
let tray = null;
let quitting = false; // 真退出 vs 收进托盘，靠它区分
let dragOffset = null; // 拖拽时鼠标相对窗口左上角的偏移
let dragProbe = null;  // 拖拽自检用：非 null 时逐次记录（见 runDragSelfTest）
let saveTimer = null;
// v4 批次 3-b：松手之后的「惯性滑行 / 弹回边界」
let glideTimer = null;   // 动画循环的定时器
let glide = null;        // 当前滑行状态（null = 没在滑）
let dragSamples = [];    // 本次拖拽最近若干个位置，松手时用来估速度
let dragBounds = null;   // 本次拖拽的边界（按下时算一次，别每次 mousemove 都问系统）

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

  // 记下这一刻的外框尺寸当「标称值」，之后每次移动都用它把尺寸掰回去。
  // ⚠ 必须在 setAlwaysOnTop / setVisibleOnAllWorkspaces **之后**取：
  //   这两个调用本身也会动窗口尺寸，先取会取到一个随后就变的数。
  // 顺便注意：这里的 404×384 比 WIN_W×WIN_H（400×380）大 4 像素 ——
  //   useContentSize 只管构造那一下，Windows 会给窗口补一圈看不见的边框。
  //   所以移动时要用这个实测值，不能拿 WIN_W/WIN_H 去写。
  petSize = win.getSize();
  log(`桌宠窗口标称外框 ${petSize[0]}×${petSize[1]}（内容区标称 ${WIN_W}×${WIN_H}）`);

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

  // 开发自检：松手惯性 + 橡皮筋边界（见 runGlideSelfTest，v4 批次 3-b）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'glide') {
    setTimeout(runGlideSelfTest, 800);
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

  // 开发自检：周视图端到端（见 selftest-week.js）。
  // 这个自检自成一体（窗口 + 数据 + DOM 三方对照），所以单独放一个文件，不往 main.js 里塞。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'week') {
    setTimeout(() => require('./selftest-week').run({
      win,
      log,
      sleep,
      finish: finishExitTest,
      settingsWindow,
      week,
      schedules,
    }), 1500);
  }

  // 开发自检：聊天端到端（见 selftest-chat.js）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'chat') {
    setTimeout(() => require('./selftest-chat').run({
      win,
      log,
      sleep,
      finish: finishExitTest,
      settingsWindow,
      schedules,
    }), 1500);
  }

  // 开发自检：专注模式端到端（见 selftest-focusmode.js）。
  // ⚠ 名字必须是 focusmode，不能叫 focus —— `--selftest=focus` 已经被
  //   「桌宠不抢焦点」那个自检占了（见 PLAN-V3 的「命名冲突」一节）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'focusmode') {
    setTimeout(() => require('./selftest-focusmode').run({
      win,
      log,
      sleep,
      finish: finishExitTest,
      settingsWindow,
      focus,
      // Task 9：拦截提示窗口 + 提醒气泡 —— 自检要拿两者的 focusable 做对照
      focusNotice,
      reminder,
      // v4 批次 3-c-2：减少动态效果的检查（提示卡也要验一遍）
      reducedMotionCheck,
    }), 1500);
  }

  // 开发自检：桌宠不抢焦点（见 runFocusSelfTest）。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'focus') {
    setTimeout(runFocusSelfTest, 1200);
  }

  // 开发自检：按钮和桌宠的同步（见 runSyncSelfTest）。
  // 盯「拖拽时窗口偷偷长大、按钮被顶右」这个回归。
  if (!app.isPackaged && process.env.PET_SELFTEST === 'sync') {
    setTimeout(runSyncSelfTest, 1200);
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

// 移动桌宠窗口。
//
// ⚠ 必须用 setBounds 把尺寸**一起**写回去，不能只调 setPosition。
//   起因（HANDOFF 第六节第 32 条）：主人报「拖拽时右上角的设置按钮会自动右移，
//   跟角色对不上」。实测发现是窗口自己在长大 —— 这台机器是 1.5 倍缩放，
//   setPosition() 每调一次，窗口外框就悄悄涨一点：
//
//     静止 404×384  →  拖拽中 422×403  →  拖完 443×424
//
//   而渲染进程的画布是启动时按当时的 innerWidth（404）定死的、之后不会跟着变，
//   角色就钉在画布原来的位置不动；两个按钮是 `position:absolute; right:…`
//   贴着窗口右边定位的 —— 窗口一宽，按钮就往右跑。
//   于是「按钮越拖越往右、跟桌宠越离越远」。
//
//   尺寸用启动时记下的标称值（petSize），不用 getSize() 现读 ——
//   现读会读到已经被撑大的值，越修越大。
//   ★ v4 批次 3-b 起：movePet 默认会**打断正在进行的惯性滑行** ——
//     托盘「重置位置」、自检复位这些「有人主动搬它」的场合，不该被动画抢回去。
//     滑行自己每帧调用时必须传 { keepGlide: true }，否则会把自己停掉。
function movePet(x, y, opts = {}) {
  if (!win || win.isDestroyed()) return;
  if (!opts.keepGlide) stopGlide();
  const px = Math.round(x);
  const py = Math.round(y);
  if (petSize) {
    win.setBounds({ x: px, y: py, width: petSize[0], height: petSize[1] });
  } else {
    // 还没记下标称尺寸（理论上不会发生）时退回旧行为，至少位置是对的
    win.setPosition(px, py);
  }
}

// ---------- v4 批次 3-b：松手之后的惯性滑行 / 弹回边界 ----------
//
// 手感逻辑（越界阻力、松手往哪去、弹不弹）全在 ./pet-drag.js 里，是纯函数、可单测。
// 这里只负责「按帧推进 + 真的搬窗口」。

// 窗口左上角的合法范围：整个窗口都要在工作区内。
// 多显示器用「离窗口最近的那块屏」的工作区，所以拖到副屏也是按副屏算。
function petDragBounds() {
  if (!win || win.isDestroyed()) return null;
  const [w, h] = petSize || win.getSize();
  const [cx, cy] = win.getPosition();
  const wa = screen.getDisplayNearestPoint({
    x: cx + Math.round(w / 2),
    y: cy + Math.round(h / 2),
  }).workArea;
  const minX = wa.x;
  const minY = wa.y;
  // 窗口比工作区还大时（极端分辨率）min 和 max 会打架，这里保证 max >= min
  return {
    minX, minY,
    maxX: Math.max(minX, wa.x + wa.width - w),
    maxY: Math.max(minY, wa.y + wa.height - h),
    size: [w, h],
  };
}

function stopGlide() {
  if (glideTimer) { clearTimeout(glideTimer); glideTimer = null; }
  glide = null;
}

function startGlide(plan) {
  stopGlide();
  if (!plan || !win || win.isDestroyed()) return;

  // 「减少动态效果」或本来就已经在落点上 → 一步到位，不起动画
  if (plan.instant) {
    movePet(plan.targetX, plan.targetY, { keepGlide: true });
    savePosition();
    return;
  }
  glide = petDrag.createGlide(plan);
  if (glide.done) { savePosition(); return; }

  let last = Date.now();
  const tick = () => {
    glideTimer = null;
    if (!glide || !win || win.isDestroyed()) { glide = null; return; }
    const now = Date.now();
    // 上限 0.1 秒：窗口被系统挂起再唤醒时，这个 dt 可能大得离谱
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
    last = now;
    glide = petDrag.stepGlide(glide, dt);
    if (glide.done) {
      // ★ 结束时**对齐到落点**：弹簧的「到位」判定留了 0.5px 余量，
      //   不对齐的话窗口可能停在边界外零点几像素。
      movePet(glide.targetX, glide.targetY, { keepGlide: true });
      glide = null;
      savePosition();
      return;
    }
    movePet(glide.x, glide.y, { keepGlide: true });
    glideTimer = setTimeout(tick, 16);
  };
  glideTimer = setTimeout(tick, 16);
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
  movePet(x, y);
  savePosition();
}

// ---------- 托盘 ----------

// CC BY-NC-SA 要求「给出适当署名」—— 这是**应用内**的署名入口。
// 完整署名链在随包分发的 CREDITS.md 里；这里给一份一眼能看完的摘要，
// 让拿到安装包的人不用翻仓库也能看到权利人是谁、改了什么。
function showAbout() {
  const detail = [
    '形象素材：社区二次创作「女仆鲸鱼娘」（并非 DeepSeek 官方形象）',
    '权利人：上善无形 / ZipZipPipe / 氵六青',
    '协议：CC BY-NC-SA 4.0（署名—非商业性使用—相同方式共享）',
    '修改说明：本项目补登记了 model3.json 里的 44 个表情；',
    '　　　　　美术文件（.moc3 / 贴图 / 表情本身）一个字节都没动。',
    '',
    '代码协议：MIT（详见随包的 LICENSE）',
    '本项目为非商业项目，与 DeepSeek 官方无任何关联。',
    '',
    '完整署名链与协议原文：见随包分发的 CREDITS.md / LICENSE-ASSETS.md。',
  ].join('\n');
  dialog.showMessageBox({
    type: 'info',
    title: '关于 · 署名',
    message: '大肥鱼 · 桌面宠物',
    detail,
    buttons: ['好'],
    noLink: true,
  });
}

// 菜单内容只写一份，托盘右键和桌宠身上右键共用
function menuTemplate() {
  return [
    { label: '显示 / 隐藏', click: togglePet },
    { label: '日程管理…', click: () => settingsWindow.open() },
    { label: '和大肥鱼聊天', click: () => chatWindow.toggle() },
    { type: 'separator' },
    { label: '重置位置', click: resetPosition },
    { label: '关于 · 署名', click: showAbout },
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
  // ★ 抓住正在滑行的桌宠 = 立刻接管（可打断性）。
  //   不这么做的话，手指刚碰到它、它还在按上一段惯性跑，手感是「抓不住」。
  stopGlide();
  dragSamples = [];
  // ★ 边界在这里算**一次**就够了。
  //   原来每次 mousemove 都调 screen.getDisplayNearestPoint()（要问系统），
  //   拖拽时一秒上百次 —— 纯粹是白花的时间，拖起来会觉得「跟不上手」。
  dragBounds = petDragBounds();
  const [wx, wy] = win.getPosition();
  dragOffset = { dx: Math.round(p.x) - wx, dy: Math.round(p.y) - wy };
});

ipcMain.on('pet:drag-move', (_e, p) => {
  if (!win || win.isDestroyed() || !dragOffset) return;
  const wantX = Math.round(p.x) - dragOffset.dx;
  const wantY = Math.round(p.y) - dragOffset.dy;

  // v4 批次 3-b：拖出屏幕边界时给「渐进阻力」（不是硬停）。
  // 界内时 rubberbandAxis 原样返回，所以正常拖动一点变化都没有。
  if (!dragBounds) dragBounds = petDragBounds();
  // 拖到别的显示器上了（离缓存的屏太远）→ 重新问一次系统。
  // 这是纯算术，不调系统，所以不会拖慢拖拽。
  else {
    const sx = dragBounds.size[0] * 2;
    const sy = dragBounds.size[1] * 2;
    if (wantX < dragBounds.minX - sx || wantX > dragBounds.maxX + sx
      || wantY < dragBounds.minY - sy || wantY > dragBounds.maxY + sy) {
      dragBounds = petDragBounds();
    }
  }

  let tx = wantX, ty = wantY;
  if (dragBounds) {
    tx = petDrag.rubberbandAxis(wantX, dragBounds.minX, dragBounds.maxX, dragBounds.size[0]);
    ty = petDrag.rubberbandAxis(wantY, dragBounds.minY, dragBounds.maxY, dragBounds.size[1]);
  }

  movePet(tx, ty);   // 注意：这里不能用 setPosition，会把窗口撑大（见 movePet）

  // 记样本用于松手时估速度。记的是**手指想去的位置**（wantX/wantY），
  // 因为要的是手指速度，不是被橡皮筋压过之后的速度。
  dragSamples.push({ x: wantX, y: wantY, t: Date.now() });
  if (dragSamples.length > 16) dragSamples.shift();

  // 自检时才记录，平时零开销
  if (dragProbe) {
    const [ax, ay] = win.getPosition();
    const [aw, ah] = win.getSize();
    dragProbe.moves.push({ reqX: p.x, reqY: p.y, tx, ty, ax, ay, aw, ah, at: Date.now() });
  }
});

ipcMain.on('pet:drag-end', (_e, p = {}) => {
  dragOffset = null;

  const bounds = dragBounds || petDragBounds();
  dragBounds = null;
  if (!win || win.isDestroyed() || !bounds) {
    dragSamples = [];
    savePosition();
    return;
  }

  // 松手速度：只取最近 100ms（手停了速度就该是 0，不能拿半秒前的移动当「还在飞」）。
  // ★ 必须带上 now：鼠标不动就不发 mousemove，最后一笔样本可能已经过去很久了。
  const now = Date.now();
  const vx = estimateVelocity(dragSamples.map((s) => ({ x: s.x, t: s.t })), { maxAbs: petDrag.MAX_SPEED, now });
  const vy = estimateVelocity(dragSamples.map((s) => ({ x: s.y, t: s.t })), { maxAbs: petDrag.MAX_SPEED, now });
  dragSamples = [];

  const [x, y] = win.getPosition();
  const plan = petDrag.releasePlan({
    x, y, vx, vy, bounds,
    reducedMotion: Boolean(p && p.reducedMotion),
  });
  startGlide(plan);
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

// 桌宠身上的「聊天」按钮 → 打开/关闭聊天条
ipcMain.on('pet:open-chat', () => chatWindow.toggle());

// ---------- 专注模式：把状态推给桌宠（v3 · Task 5）----------
//
// 桌宠要「陪着专注」：开始时换姿态说话、专注中显示剩余时间角标、结束说句鼓励。
// 这里负责把 focus 主控的状态翻译成桌宠听得懂的 payload 推过去。
//
// ⚠ 只在「开始 / 结束」两个瞬间推（phase 由上一个状态算出来），
//   改黑名单之类的中间变化不打扰桌宠 —— 否则她会被无关事件反复打断。
let petFocusRunning = false;

function notifyPetFocus(phase) {
  if (!win || win.isDestroyed()) return;
  let st;
  try {
    st = focus.state();
  } catch (err) {
    console.error('[main] 读专注状态失败：', err && err.message);
    return;
  }
  const payload = {
    phase,                                              // 'start' | 'tick' | 'end'
    running: st.running,
    endsAt: st.session ? st.session.endsAt : null,
    minutes: st.session ? st.session.minutes : null,
    remainingMs: st.remainingMs,
  };
  try {
    win.webContents.send('focus:notify', payload);
  } catch (err) {
    console.error('[main] 通知桌宠专注状态失败：', err && err.message);
  }
}

// 专注期间「拦下了东西」（关掉一个分心软件）→ 让桌宠说一句人话（Task 9）。
//   ★ 和 notifyPetFocus 分开：那个是状态心跳（每几秒一次），这个只在**真有动作**时推，
//     所以渲染进程收到就该说话，不需要自己去重。
function notifyPetBlocked(info) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('focus:blocked', info || {});
  } catch (err) {
    console.error('[main] 通知桌宠「拦下东西」失败：', err && err.message);
  }
}

// 桌宠启动时会问一句「现在在专注吗」——桌宠重开时若还在专注，要接着陪。
ipcMain.handle('pet:focus-state', () => {
  try {
    return focus.state();
  } catch {
    return { running: false, session: null };
  }
});

// ---------- 聊天记录 ----------
const CHAT_FILE = 'chat.json';
const CHAT_MAX = 200;

function loadChatHistory() {
  const raw = store.read(CHAT_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function pushChat(role, text, scheduleId = null) {
  const list = loadChatHistory();
  list.push({ role, text, at: Date.now(), scheduleId });
  while (list.length > CHAT_MAX) list.shift();
  store.write(CHAT_FILE, list);
}

function clearChatHistory() {
  store.write(CHAT_FILE, []);
}

// ---------- 聊天 IPC ----------

ipcMain.handle('chat:send', async (_e, text) => {
  const now = new Date();
  pushChat('me', text);

  brain.init({
    getItems: () => schedules.list(),
    getConfig: () => aiConfig.read(),
  });

  const result = await brain.respond(text, now);

  let created = null;
  if (result.draft) {
    const addResult = schedules.add(result.draft);
    if (addResult.error) {
      result.reply += '（这条我没记住，你再说一次？）';
      result.draft = null;
    } else {
      created = { id: addResult.id, title: addResult.title, time: addResult.time, endTime: addResult.endTime };
    }
  }

  pushChat('fish', result.reply, created && created.id ? created.id : null);
  return { ...result, created };
});

ipcMain.handle('chat:history', () => loadChatHistory());

ipcMain.handle('chat:clear', () => {
  clearChatHistory();
  return true;
});

ipcMain.handle('chat:undo', (_e, scheduleId) => {
  if (scheduleId) schedules.remove(scheduleId);
  return true;
});

ipcMain.handle('chat:config-get', () => {
  const cfg = aiConfig.read();
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    enabled: cfg.enabled,
    keyMask: aiConfig.maskKey(cfg.apiKey),
    hasKey: Boolean(cfg.apiKey),
  };
});

ipcMain.handle('chat:config-set', (_e, cfg) => {
  const old = aiConfig.read();
  const next = {
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : old.baseUrl,
    model: typeof cfg.model === 'string' ? cfg.model : old.model,
    // apiKey 空串表示「不改」
    apiKey: typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : old.apiKey,
    enabled: Boolean(cfg.enabled),
  };
  aiConfig.write(next);
  // 让 cloud 模块立刻拿到新配置
  const cloud = require('./brain/cloud');
  cloud.configure({ baseUrl: next.baseUrl, apiKey: next.apiKey, model: next.model });
  return true;
});

ipcMain.handle('chat:config-test', async () => {
  const cfg = aiConfig.read();
  const cloud = require('./brain/cloud');
  cloud.configure({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 8000 });
  const res = await cloud.respond('你好', { now: new Date(), items: [] });
  if (res.error) return { ok: false, error: res.error };
  return { ok: true };
});

ipcMain.on('chat:close', () => chatWindow.close());

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
    // ★ v4 批次 3-b：先挪到屏幕左上角附近再开始。
    //   默认位置在右下角（贴着屏幕底边），往下拖 120px 会撞到工作区边界，
    //   而边界外是有「橡皮筋阻力」的 —— 那样量到的目标位置误差就不再是
    //   「搬窗口准不准」，而是「被橡皮筋压了多少」，两件事混在一起就看不出来了。
    const wa = screen.getPrimaryDisplay().workArea;
    movePet(wa.x + 80, wa.y + 80);
    await sleep(200);
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

    // ★ v4 批次 3-b：松手之后桌宠还会惯性滑一段，所以 250ms 后量到的位置
    //   已经不等于「松手那一刻」的位置了。这个自检测的是**拖拽期间的搬窗口保真度**，
    //   所以位移取「最后一次 dragMove 之后窗口的实际位置」，
    //   滑到哪去了另外单独报一行，不混进这个数。
    const lastMove = probe.moves[probe.moves.length - 1];
    const dragDx = lastMove ? lastMove.ax - wx0 : 0;
    const dragDy = lastMove ? lastMove.ay - wy0 : 0;

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
    log(`   拖拽位移 ${dragDx},${dragDy}（期望 ${DX * STEPS},${DY * STEPS}）· 目标位置误差 ${trackMax.toFixed(0)}px · 落地误差 ${landMax.toFixed(0)}px`);
    log(`   松手后惯性滑到 ${wxEnd - wx0},${wyEnd - wy0}（比松手时多走了 ${(wxEnd - wx0) - dragDx},${(wyEnd - wy0) - dragDy}px）`);
    if (st) log(`   帧间隔 中位 ${st.med.toFixed(1)}ms · p90 ${st.p90.toFixed(1)}ms · 最大 ${st.max.toFixed(1)}ms · 掉帧(>50ms) ${st.over50}/${st.n}`);
    if (base && st) {
      const r = base.med > 0 ? st.med / base.med : 0;
      log(`   → 相对基线 ${r.toFixed(2)} 倍${r > 1.25 ? ' ⚠ 明显变慢' : ''}`);
    }

    // 每轮之间把窗口挪回原处，保证起点一致
    movePet(wx0, wy0);
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

// ---------- 开发自检：松手惯性 + 橡皮筋边界（v4 批次 3-b）----------
//
// ── 为什么必须端到端 ──
//   手感逻辑本身是纯函数，已经有单测（`npm run test:pet-drag`）。
//   但「主进程有没有真的把它接上」纯函数测不到 —— 这正是项目那条老坑：
//   改了「谁 require 谁 / 谁调谁」这类接线，纯函数自检永远是绿的。
//
// ── 为什么还是用 petAPI 而不是真鼠标 ──
//   和别的拖拽自检一样：Electron 合成鼠标事件的 screenX/screenY 恒为 0，
//   拿它拖拽测出来的是假的。所以直接调 petAPI 把拖拽喂进去，
//   松手之后的动画是**主进程真的在跑**，这部分是真实行为。
//
// ── 这一套能抓到什么（都是单测抓不到的）──
//   ① 松手后到底有没有继续走、走多远
//   ② 手停了再松手，会不会莫名其妙窜出去（估速度的 staleness）
//   ③ 橡皮筋有没有真的接上（拖出边界时窗口能不能越过去）
//   ④ 「减少动态效果」这条开关有没有真的生效
//   ⑤ 抓住正在滑行的桌宠，滑行会不会立刻停（可打断性）
async function runGlideSelfTest() {
  let pass = 0, fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}  ← 失败${extra}`); }
  };

  log('===== 松手惯性 / 橡皮筋 自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  const wa = screen.getPrimaryDisplay().workArea;
  const [W, H] = petSize || win.getSize();
  const BOUNDS = { minX: wa.x, maxX: wa.x + wa.width - W, minY: wa.y, maxY: wa.y + wa.height - H };

  // 挪到「四周都有余量」的位置再测，免得默认的右下角一上来就贴着边界
  const home = async () => {
    movePet(Math.round(wa.x + (wa.width - W) / 2), Math.round(wa.y + (wa.height - H) / 2));
    await sleep(220);
    return win.getPosition();
  };
  const posX = () => win.getPosition()[0];
  const posY = () => win.getPosition()[1];
  const inside = (x, y) => x >= BOUNDS.minX && x <= BOUNDS.maxX && y >= BOUNDS.minY && y <= BOUNDS.maxY;

  // 合成一次拖拽：dx/dy 是「每步手指走多少像素」，stepMs 决定速度
  const drag = async ({ steps, dx, dy, stepMs, pauseBeforeRelease = 0, reducedMotion = false }) => {
    const [wx, wy] = win.getPosition();
    const sx = wx + 100;
    const sy = wy + 100;
    await win.webContents.executeJavaScript(`(async () => {
      const api = window.petAPI;
      const sx = ${sx}, sy = ${sy};
      api.dragStart({ x: sx, y: sy });
      for (let i = 1; i <= ${steps}; i++) {
        api.dragMove({ x: sx + ${dx} * i, y: sy + ${dy} * i });
        await new Promise((r) => setTimeout(r, ${stepMs}));
      }
      ${pauseBeforeRelease > 0 ? `await new Promise((r) => setTimeout(r, ${pauseBeforeRelease}));` : ''}
      api.dragEnd({ reducedMotion: ${reducedMotion} });
      return true;
    })()`);
    return { x: posX(), y: posY() };
  };

  // ===== ① 松手后还会滑一点，但**不许滑太远** =====
  log('');
  log('① 快速往右甩一下再松手');
  {
    await home();
    // 6px / 10ms = 600px/s
    const at = await drag({ steps: 20, dx: 6, dy: 0, stepMs: 10 });
    await sleep(750);
    const after = posX();
    await sleep(450);
    const settled = posX();
    const glide = after - at.x;
    log(`   松手时 x=${at.x} → 750ms 后 x=${after}（滑了 ${glide}px）→ 再等 450ms x=${settled}`);
    // ★ 主人 2026-10-15 的反馈就是「滑太远」，所以这里**上下都要卡**：
    //   下界保证「不是硬停」（还有一点点惯性，手感不突兀），
    //   上界保证「没有滑出去」（滑太远就是主人抱怨的那个问题）。
    ok(glide > 8, '★ 松手后还会滑一点点（不是硬邦邦地停住）', `滑了 ${glide}px`);
    ok(glide < 60, '★ 但滑得很少（主人要求「别滑太远」）', `滑了 ${glide}px < 60px`);
    ok(Math.abs(settled - after) < 4, '★ 会自己停稳（不再漂）', `450ms 内只动了 ${Math.abs(settled - after)}px`);
    ok(inside(settled, posY()), '停稳后整个窗口在屏幕内', `x=${settled} ∈ [${BOUNDS.minX},${BOUNDS.maxX}]`);
  }

  // ===== ② 负对照：手停住了再松手，不许窜出去 =====
  log('');
  log('② ★ 负对照：快速甩完之后「按住不动」300ms 再松手');
  {
    await home();
    const at = await drag({ steps: 20, dx: 6, dy: 0, stepMs: 10, pauseBeforeRelease: 300 });
    await sleep(750);
    const after = posX();
    log(`   松手时 x=${at.x} → 750ms 后 x=${after}`);
    ok(Math.abs(after - at.x) < 8,
      '★ 手已经停了 → 松手后基本不动（不许拿 300ms 前的速度当成「还在飞」）',
      `只走了 ${Math.abs(after - at.x)}px`);
  }

  // ===== ③ 橡皮筋：拖出右边界 =====
  log('');
  log('③ 一直往右拖，拖出屏幕右边界');
  {
    await home();
    const at = await drag({ steps: 60, dx: 12, dy: 0, stepMs: 10 });
    const over = at.x - BOUNDS.maxX;
    log(`   松手时 x=${at.x}（边界 ${BOUNDS.maxX}）· 超出 ${over}px · 手指一共拖了 ${60 * 12}px`);
    ok(over > 5, '★ 越界时窗口还能往外挪一点（不是硬停在边界上）', `超出 ${over}px`);
    ok(over < W, '★ 但超出得远小于一个窗口宽（拖不飞）', `${over}px < ${W}px`);
    ok(over < 60 * 12 - (BOUNDS.maxX - (Math.round(wa.x + (wa.width - W) / 2))),
      '★ 超出量比手指的超出量小（有阻力）',
      `窗口超出 ${over}px vs 手指超出 ${60 * 12 - (BOUNDS.maxX - Math.round(wa.x + (wa.width - W) / 2))}px`);

    await sleep(900);
    const settled = { x: posX(), y: posY() };
    log(`   停稳后 x=${settled.x},y=${settled.y}`);
    ok(inside(settled.x, settled.y), '★ 松手后自己弹回屏幕内（不会停在边界外）',
      `x=${settled.x} ≤ ${BOUNDS.maxX}`);
  }

  // ===== ④ 减少动态效果 =====
  log('');
  log('④ 系统开了「减少动态效果」时松手');
  {
    await home();
    const at = await drag({ steps: 20, dx: 6, dy: 0, stepMs: 10, reducedMotion: true });
    await sleep(700);
    const after = posX();
    log(`   松手时 x=${at.x} → 700ms 后 x=${after}`);
    ok(Math.abs(after - at.x) < 4, '★ 直接落位、一点都不滑', `只动了 ${Math.abs(after - at.x)}px`);
    ok(inside(after, posY()), '落位后仍在屏幕内');
  }

  // ===== ⑤ 可打断：抓住正在滑行的桌宠 =====
  log('');
  log('⑤ 滑行途中再按下去（可打断性）');
  {
    await home();
    await drag({ steps: 20, dx: 6, dy: 0, stepMs: 10 });
    await sleep(50); // 让它滑起来
    const moving = posX();
    await sleep(100);
    const stillMoving = posX();
    // 立刻抓住
    await win.webContents.executeJavaScript(`(() => { window.petAPI.dragStart({ x: 0, y: 0 }); return true; })()`);
    await sleep(60);
    const grabbed1 = posX();
    await sleep(400);
    const grabbed2 = posX();
    log(`   滑行中 ${moving} → ${stillMoving}（在动=${stillMoving !== moving}）· 抓住后 ${grabbed1} → ${grabbed2}`);
    ok(stillMoving !== moving, '前提：抓住之前它确实在滑', `${moving} → ${stillMoving}`);
    ok(Math.abs(grabbed2 - grabbed1) < 4, '★ 抓住之后立刻停下（不会跟手指抢）',
      `抓住后 400ms 只动了 ${Math.abs(grabbed2 - grabbed1)}px`);
  }

  log('');
  log(`===== 松手惯性 / 橡皮筋 自检结束：${pass} 通过 / ${fail} 失败 =====`);
  log(fail === 0 ? '结论：松手惯性、橡皮筋边界、减少动效、可打断 都已接上' : '结论：有失败项，拖拽手感没接对');
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

  // 聊天按钮也在它自己的位置上
  const chatBtn = await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btn-chat');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const el = document.elementFromPoint(cx, cy);
    const ui = el && el.closest ? el.closest('[data-ui]') : null;
    return { cx, cy, topEl: ui ? (ui.id || ui.tagName) : null };
  })()`);
  ok(!!chatBtn, '★ 桌宠界面上存在聊天按钮');
  ok(chatBtn && chatBtn.topEl === 'btn-chat', '★ 聊天按钮没被盖住');
  // ★ 光「存在」不够 —— 必须真的落在右上角按钮堆里。
  //   踩过：给 #btn-chat 写了 right:46px 却漏把它加进共享样式选择器，
  //   于是它没有 position:absolute，静态布局掉到窗口左上角 (3,3)，
  //   把角色左上角那块挡住了、也压掉了「鼠标移开恢复穿透」。
  //   「存在」和「在对的地方」是两回事。
  if (chatBtn) {
    const winW = await win.webContents.executeJavaScript('window.innerWidth');
    ok(chatBtn.cx > winW * 0.6, '★ 聊天按钮真的在右上角（不是掉到左边）',
      ` → 按钮中心 x=${chatBtn.cx}，窗口宽 ${winW}`);
  }

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

  // ===== ③b ★ 右键菜单还收不收得到事件 =====
  // 改成 focusable:false 之后鼠标事件还通不通？左键那条链路刚才已经间接验过，
  // 右键（弹原生菜单）单独再验一次 —— 这个功能坏了主人会直接发现。
  log('③b ★ 负对照：右键菜单事件');
  await win.webContents.executeJavaScript(
    'window.__petDebug.menu.reset(); window.__petDebug.menu.suppress(true)');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 190 });
  await sleep(300);
  const onPetPt = await win.webContents.executeJavaScript('window.__petDebug.hitTestPoint(200, 190)');
  ok(onPetPt.overPet === true, `右键前先把鼠标压在角色身上（alpha=${onPetPt.alpha}）`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 200, y: 190, button: 'right', clickCount: 1 });
  await sleep(80);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 200, y: 190, button: 'right', clickCount: 1 });
  await sleep(350);
  const hitsOnPet = await win.webContents.executeJavaScript('window.__petDebug.menu.hits()');
  ok(hitsOnPet >= 1, '★ 在角色身上右键：菜单事件确实送到了渲染进程（没被 focusable:false 掐断）',
    ` → 收到 ${hitsOnPet} 次`);

  // ★ 负对照：在空白处右键不该触发 —— 说明上面不是「无脑计数」
  await win.webContents.executeJavaScript('window.__petDebug.menu.reset()');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 3, y: 3 });
  await sleep(350);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 3, y: 3, button: 'right', clickCount: 1 });
  await sleep(80);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 3, y: 3, button: 'right', clickCount: 1 });
  await sleep(350);
  const hitsEmpty = await win.webContents.executeJavaScript('window.__petDebug.menu.hits()');
  ok(hitsEmpty === 0, '★ 负对照：在空白处右键不会弹菜单', ` → 收到 ${hitsEmpty} 次`);
  await win.webContents.executeJavaScript('window.__petDebug.menu.suppress(false)');

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

// ---------- 开发自检：按钮与桌宠的同步 ----------
// 主人反馈：「按住桌宠拖动时（或者按住不动时），右上角的设置按钮会自动右移，
// 跟角色对不上。」
//
// 根因（HANDOFF 第六节第 32 条）：拖拽时每收到一次 mousemove 就调一次
// win.setPosition()。这台机器是 1.5 倍缩放，setPosition 会让窗口外框**每次**
// 悄悄长大一点 —— 实测拖 40 步从 404×384 长到 443×424，还在继续长。
// 渲染进程的画布是启动时按当时的 innerWidth（404）定死的、之后不会跟着变，
// 角色就钉在原处；两个按钮是 `position:absolute; right:…` 贴着窗口右边定位的，
// 窗口一宽按钮就往右跑 —— 越拖越远。
// 改成 movePet()（用 setBounds 把尺寸一起写回去）之后不再长大。
//
// ⚠ 用「按钮中心」而不是 left/right 来量：
//   按钮有 hover 和「呼吸」动画的 scale 变换，缩放绕中心做，
//   只有中心点在变换下是不变的。拿 right 去比会被动画干扰成偶发失败。
async function runSyncSelfTest() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}  ← 失败${extra}`); }
  };

  log('===== 按钮与桌宠同步自检开始 =====');
  if (!win || win.isDestroyed()) { log('✗ 没有窗口'); return quitAfterSelfTest(); }
  if (!(await waitForPet())) { log('✗ 等不到渲染进程就绪'); return quitAfterSelfTest(); }

  // 读渲染进程里「窗口可视区 / 画布 / 两个按钮」的状态
  const readState = () => win.webContents.executeJavaScript(`(() => {
    const center = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        cx: Math.round((b.x + b.width / 2) * 100) / 100,
        w: Math.round(b.width * 100) / 100,
      };
    };
    const d = window.__petDebug;
    const cv = d.app.view;
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasCssW: Math.round(cv.getBoundingClientRect().width * 100) / 100,
      canvasPx: cv.width + 'x' + cv.height,
      settings: center('btn-settings'),
      exit: center('btn-exit'),
    };
  })()`);

  // ⚠ 关键：量「按钮中心在屏幕坐标系里的 x」，**不能**量「离窗口右边界的距离」。
  //   按钮是 `right: 46px` 定位的，所以「窗口宽 - 按钮中心 x」恒等于一个常数，
  //   窗口再怎么长大它都不会变 —— 拿它当断言就是一条永远绿的假测试
  //   （这条是写负对照时被抓出来的，见第 ④ 节）。
  //   主人看到的是「按钮相对角色右移」，而角色钉在画布上（画布左上角锚定、
  //   尺寸启动时就定死），所以只有**绝对坐标**能反映问题。
  const btnCx = (s) => s.settings.cx;

  // 合成一次拖拽（和拖拽自检同一套路：直接调 petAPI，绕开合成鼠标事件）
  // ★ v4 批次 3-b：每轮开始先摆回同一个起点。
  //   松手之后桌宠还会惯性滑一段，滑到哪儿跟「松手时的位置」有关；
  //   不固定起点的话，三轮会越滑越远、最后贴到屏幕边上，
  //   量出来的窗口尺寸就会带上「位置不同导致的 DPI 取整差异」（实测差 1px），
  //   于是「三轮尺寸一致」这条断言变成了测位置、不是测尺寸。
  const dragOnce = async (steps) => {
    const home = loadPosition();
    movePet(home.x, home.y);
    await sleep(220);
    const [wx0, wy0] = win.getPosition();
    const sx = wx0 + 100;
    const sy = wy0 + 100;
    await win.webContents.executeJavaScript(`(async () => {
      const api = window.petAPI;
      const sx = ${sx}, sy = ${sy};
      api.dragStart({ x: sx, y: sy });
      for (let i = 1; i <= ${steps}; i++) {
        api.dragMove({ x: sx + 3 * i, y: sy + 2 * i });
        await new Promise((r) => setTimeout(r, 6));
      }
      api.dragEnd();
      return true;
    })()`);
    await sleep(250);
  };

  // ===== ① 静止基准 =====
  log('① 静止时的基准');
  const base = await readState();
  log(`   窗口可视区 ${base.innerW}×${base.innerH} · 画布 CSS 宽 ${base.canvasCssW} · 画布像素 ${base.canvasPx}`);
  log(`   btn-settings 中心 x=${base.settings.cx} · btn-exit 中心 x=${base.exit.cx}`);
  ok(Math.abs(base.canvasCssW - base.innerW) <= 1,
    '★ 画布宽度和窗口可视区宽度一致（角色和按钮用同一套坐标）',
    ` → 画布 ${base.canvasCssW} / 窗口 ${base.innerW}`);

  // ===== ② 拖拽过程中窗口不能变大、按钮不能飘 =====
  log('');
  log('② 拖拽过程中');
  {
    // 边拖边采：不 await 这个 promise，让它跑着，我们从主进程去看
    const running = (async () => {
      const [wx0, wy0] = win.getPosition();
      const sx = wx0 + 100;
      const sy = wy0 + 100;
      return win.webContents.executeJavaScript(`(async () => {
        const api = window.petAPI;
        const sx = ${sx}, sy = ${sy};
        api.dragStart({ x: sx, y: sy });
        for (let i = 1; i <= 40; i++) {
          api.dragMove({ x: sx + 3 * i, y: sy + 2 * i });
          await new Promise((r) => setTimeout(r, 10));
        }
        api.dragEnd();
        return true;
      })()`);
    })();

    await sleep(220);
    const during = await readState();
    await running;
    await sleep(300);
    const after = await readState();

    log(`   拖拽中：窗口可视区 ${during.innerW} · 按钮中心 x=${during.settings.cx}`);
    log(`   拖拽后：窗口可视区 ${after.innerW} · 按钮中心 x=${after.settings.cx}`);

    ok(during.innerW === base.innerW && after.innerW === base.innerW,
      '★ 整个拖拽过程中窗口可视区宽度没有变（旧代码这里会从 404 涨到 443）',
      ` → ${base.innerW} → ${during.innerW} → ${after.innerW}`);
    ok(Math.abs(btnCx(during) - btnCx(base)) <= 0.75,
      '★ 拖拽中按钮没有右移（在屏幕坐标里的位置不变）',
      ` → ${btnCx(base)} → ${btnCx(during)}`);
    ok(Math.abs(btnCx(after) - btnCx(base)) <= 0.75,
      '★ 拖拽结束后按钮回到了原来的位置',
      ` → ${btnCx(base)} → ${btnCx(after)}`);
  }

  // ===== ③ 反复拖拽不能累积 =====
  log('');
  log('③ 反复拖拽 3 轮（防「每拖一次涨一点」）');
  const sizeAfterFirst = win.getSize();
  await dragOnce(40);
  const size1 = win.getSize();
  await dragOnce(40);
  await dragOnce(40);
  const size3 = win.getSize();
  const s3 = await readState();
  log(`   第 1 轮后 ${size1.join('×')} · 第 3 轮后 ${size3.join('×')}（拖之前 ${sizeAfterFirst.join('×')}）`);
  // ⚠ 这里不能用「完全相等」：窗口外框尺寸**跟绝对位置有关**
  //   （1.5 倍缩放按 DPI 取整，见 CLAUDE.md 第 32 条，实测 404×384 / 404×382 / 405×385 都出现过）。
  //   而 v4 批次 3-b 之后每次松手都会滑一小段，落点会差几个像素 → 尺寸跟着抖 ±1px。
  //   所以要卡的是「**没有累积变大**」这件事：旧代码每拖一次长 ~19px，
  //   3 轮下来会从 404 涨到 443（见下面负对照①的实测 404 → 444）。
  //   容差 2px 足够把那个 bug 抓死，又不会被 DPI 取整的 ±1px 晃成假失败。
  const growX = Math.abs(size3[0] - sizeAfterFirst[0]);
  const growY = Math.abs(size3[1] - sizeAfterFirst[1]);
  ok(growX <= 2 && growY <= 2,
    '★ 反复拖 3 轮，窗口尺寸基本没变（旧代码每拖一次长 ~19px，3 轮会到 443）',
    ` → 拖之前 ${sizeAfterFirst.join('×')} · 第 3 轮 ${size3.join('×')}（差 ${growX}×${growY}）`);
  ok(Math.abs(btnCx(s3) - btnCx(base)) <= 0.75,
    '★ 拖完 3 轮，按钮还在原处',
    ` → ${btnCx(base)} → ${btnCx(s3)}`);

  // ===== ④ 负对照：证明这个自检真的能抓到问题 =====
  // 不然后面全是 ✓ 也可能是「断言写松了」或者「窗口压根没动过」。
  // 这里做两件事，缺一不可：
  //   ㈠ 把控件层临时改回「贴窗口」的写法（模拟改造前），再用旧的 setPosition
  //      搬 40 次窗口 —— 按钮必须真的右移。这一步同时证明：
  //        · 自检抓得住「按钮右移」这个现象（不是一条永远绿的假测试）
  //        · 「贴画布」这一层确实在起作用（拿掉它问题就复现）
  //   ㈡ 换回正常写法后，movePet + syncUiBox 能把窗口和按钮都恢复原样。
  log('');
  log('④ ★ 负对照：把控件层改回「贴窗口」，再用旧的 setPosition 搬 40 次');
  {
    // ★ v4 批次 3-b：先摆回确定的起点再演示旧写法。
    //   「setPosition 会把窗口撑大」这件事跟**绝对位置**有关（1.5 倍缩放下按 DPI 取整），
    //   不固定起点的话，这条负对照会随「前面几次拖拽把桌宠留在哪儿」而时灵时不灵 ——
    //   而负对照一旦不红，整个自检就不算数了。
    const home = loadPosition();
    movePet(home.x, home.y);
    await sleep(220);

    const before = await readState();
    const [px, py] = win.getPosition();

    // ㈠ 模拟改造前的写法：控件层跟窗口一样大（于是按钮跟着窗口一起变）
    await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('ui');
      box.style.width = '100%';
      box.style.height = '100%';
      return true;
    })()`);
    await sleep(120);
    for (let i = 1; i <= 40; i++) {
      win.setPosition(px + i, py + i);   // 旧写法：只改位置，不管尺寸
    }
    await sleep(250);
    const broke = await readState();
    log(`   旧写法 + 贴窗口：窗口可视区 ${before.innerW} → ${broke.innerW} · 按钮中心 x ${btnCx(before)} → ${btnCx(broke)}`);
    ok(broke.innerW > before.innerW + 5,
      '★ 负对照①：旧写法确实会把窗口撑大（说明自检抓得住「窗口变大」）',
      ` → ${before.innerW} → ${broke.innerW}`);
    ok(btnCx(broke) - btnCx(before) > 5,
      '★ 负对照①：贴窗口时按钮确实会右移（正是主人看到的现象）',
      ` → ${btnCx(before)} → ${btnCx(broke)}`);

    // ㈡ 换回正常写法，两样都要能恢复
    movePet(px, py);
    await win.webContents.executeJavaScript('window.__petDebug.syncUiBox()');
    await sleep(250);
    const fixed = await readState();
    log(`   恢复之后：窗口可视区 ${fixed.innerW} · 按钮中心 x ${btnCx(fixed)}`);
    ok(Math.abs(fixed.innerW - before.innerW) <= 1,
      '★ 负对照②：movePet 能把被撑大的窗口掰回标称尺寸',
      ` → ${fixed.innerW}（期望 ${before.innerW}）`);
    ok(Math.abs(btnCx(fixed) - btnCx(before)) <= 0.75,
      '★ 负对照②：syncUiBox 能把按钮重新贴回角色身上',
      ` → ${btnCx(fixed)}（期望 ${btnCx(before)}）`);
  }

  finishExitTest(pass, fail, '按钮与桌宠同步');
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

  // ===== ②b 减少动态效果（v4 批次 3-c-2）=====
  // 系统开了「减少动态效果」时，气泡**不许再弹进来**（位移 + 缩放），
  // 但**必须还看得见**（保留淡入）—— 直接不显示等于把提醒也一起删了。
  // 真模拟系统设置（CDP Emulation.setEmulatedMedia），不是查 CSS 规则在不在。
  log('②b 减少动态效果：气泡不弹、但还在');
  {
    const bubbleWin = reminder.getBubbleWindow();
    if (!bubbleWin || bubbleWin.isDestroyed()) {
      ok(false, '拿不到气泡窗口，这条没法验');
    } else {
      const rm = await reducedMotionCheck.read(bubbleWin.webContents);
      log(`   正常：animation=${rm.normal.name} 帧=${rm.normal.frames} 有位移/缩放=${rm.normal.hasTransform}`);
      log(`   reduce：animation=${rm.reduced.name} 帧=${rm.reduced.frames} 有位移/缩放=${rm.reduced.hasTransform} 有淡入=${rm.reduced.hasOpacity}`);
      ok(rm.reduced.hasTransform === false,
        '★ 开了「减少动态效果」→ 关键帧里没有位移/缩放（不再弹进来）');
      ok(rm.reduced.hasOpacity === true,
        '★ 但仍然保留淡入（不是「干脆不出现」—— 那等于把提醒删了）');
      // ★ 负对照：不开的时候必须**有**位移/缩放。不然上面那条「没有」可能是读错了。
      ok(rm.normal.hasTransform === true,
        '★ 负对照：系统没开这个设置时，关键帧里**有**位移/缩放（说明这套读法真的分得清）',
        ` → normal.animation=${rm.normal.name}`);
    }
  }

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
  // ⚠ 必须在**开设置窗口之前**就记下桌宠位置。
  //   曾经记在窗口开出来之后 —— 那样如果 lowerPet()（setAlwaysOnTop）把桌宠挪了，
  //   两次读数都是「挪过之后」的，断言会假通过。见第六节第 28 条：
  //   setAlwaysOnTop 在某些缩放下确实会顺带挪窗口。
  const petRect0 = win.getBounds();
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
    ok(petRect.x === petRect0.x && petRect.y === petRect0.y,
      '★ 开设置窗口（lowerPet 降层级）这一步没有挪动桌宠',
      ` → ${petRect0.x},${petRect0.y} → ${petRect.x},${petRect.y}`);
  }

  // ===== ①c 侧边栏（v4 批次 3-c）=====
  // 以前「周视图 / 专注」是工具栏上的按钮，而且「周视图」按钮点完还会改自己的字变成
  // 「列表」—— 用户看不出现在在哪一页。侧边栏要同时做到三件事：
  //   ① 三个页面各有独立入口（不再共用一个会变字的按钮）
  //   ② **高亮**说清「你在哪一页」
  //   ③ 专注页上侧边栏**仍然在**（不然就没有出口了 —— 原来靠「← 返回日程」按钮）
  log('①c 侧边栏');
  {
    const nav = await sw.webContents.executeJavaScript(`(() => {
      const sb = document.querySelector('.sidebar');
      const ids = ['btn-list', 'btn-week', 'btn-focus'];
      const items = ids.map((id) => {
        const el = document.getElementById(id);
        return el ? { id, inSidebar: !!sb && sb.contains(el), current: el.getAttribute('aria-current') } : { id, missing: true };
      });
      const content = document.querySelector('.content');
      return {
        hasSidebar: !!sb,
        sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : null,
        contentW: content ? Math.round(content.getBoundingClientRect().width) : null,
        innerW: window.innerWidth,
        items,
        // ★ 负对照：这两个不该再留在工具栏里（它们已经搬进侧边栏了）
        weekInToolbar: !!document.querySelector('.toolbar #btn-week'),
        focusInToolbar: !!document.querySelector('.toolbar #btn-focus'),
        title: document.getElementById('page-title').textContent,
      };
    })()`);

    ok(nav.hasSidebar === true, '★ 侧边栏存在');
    ok(nav.items.every((x) => !x.missing && x.inSidebar),
      '★ 三个导航项（日程 / 周视图 / 专注）都在侧边栏里',
      ` → ${nav.items.map((x) => `${x.id}:${x.missing ? '缺' : (x.inSidebar ? '在' : '不在侧边栏')}`).join(' ')}`);
    ok(nav.weekInToolbar === false && nav.focusInToolbar === false,
      '★ 负对照：周视图 / 专注 已经**不在**工具栏里了（搬进侧边栏，不是两边各留一份）',
      ` → toolbar 里有周视图=${nav.weekInToolbar} 有专注=${nav.focusInToolbar}`);

    // 高亮：只有当前页那一项带 aria-current，**全部收齐再判**（不是找第一个就 return）
    const currentIds = nav.items.filter((x) => x.current === 'page').map((x) => x.id);
    ok(currentIds.length === 1 && currentIds[0] === 'btn-list',
      '★ 刚打开时高亮正好在「日程」一项上（且只有一项高亮）',
      ` → 高亮的项：${currentIds.join(',') || '(无)'}`);

    // 侧边栏是真的占了一列（而不是叠在内容上）：内容区宽度 ≈ 窗口宽 - 侧边栏宽
    const expectedContent = nav.innerW - nav.sidebarW;
    ok(Math.abs(nav.contentW - expectedContent) <= 2,
      '★ 侧边栏占掉了一整列，内容区是剩下的宽度（不是浮在上面盖住内容）',
      ` → 窗口 ${nav.innerW} - 侧边栏 ${nav.sidebarW} = ${expectedContent}，内容区实际 ${nav.contentW}`);
    ok(nav.title === '日程', '内容区标题跟着当前页走（现在是「日程」）', ` → “${nav.title}」`);
  }

  // ===== ①d 空间一致：面板「从触发它的那个东西长出来」（v4 批次 3-c-2）=====
  // 要验的是 transform-origin 真的对准了触发点，而不是默认的「正中间」。
  // ★ 量法：拿面板自己的矩形当坐标系，算触发点中心的百分比，跟 computedStyle 里
  //   的 origin 比。**不能只断言「不是 50% 50%」** —— 那只能证明「有改过」。
  log('①d 空间一致：表单从「＋ 添加日程」长出来');
  {
    const aim = await sw.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById('btn-add');
      const form = document.getElementById('form');
      btn.click();
      await new Promise((r) => setTimeout(r, 350));
      const p = form.getBoundingClientRect();
      const t = btn.getBoundingClientRect();
      const wantX = ((t.left + t.width / 2 - p.left) / p.width) * 100;
      const wantY = ((t.top + t.height / 2 - p.top) / p.height) * 100;
      const origin = getComputedStyle(form).transformOrigin;   // 形如 "123.4px 56.7px" 或 "%"
      return {
        open: !form.classList.contains('hidden'),
        hasClass: form.classList.contains('is-open'),
        wantX, wantY, origin,
        panelW: Math.round(p.width), panelH: Math.round(p.height),
      };
    })()`);

    ok(aim.open === true && aim.hasClass === true, '★ 表单开着，而且挂上了动画类 .is-open');
    // computedStyle 会把百分比换算成 px（相对面板左上角），所以拿 px 比更直接
    const m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(aim.origin);
    ok(!!m, 'transform-origin 能读出来', ` → ${aim.origin}`);
    if (m) {
      const gotX = parseFloat(m[1]);
      const gotY = parseFloat(m[2]);
      const wantX = (aim.wantX / 100) * aim.panelW;
      const wantY = (aim.wantY / 100) * aim.panelH;
      ok(Math.abs(gotX - wantX) <= 2 && Math.abs(gotY - wantY) <= 2,
        '★ origin 精确落在触发按钮的中心上（不是面板正中间）',
        ` → 实际 ${gotX.toFixed(1)},${gotY.toFixed(1)}px / 期望 ${wantX.toFixed(1)},${wantY.toFixed(1)}px`);
      // ★ 负对照：这一条证明上面那条「真的在挑位置」——
      //   如果 origin 恰好就是面板中心，那上面那条等于在测默认值，白测。
      const cx = aim.panelW / 2;
      const cy = aim.panelH / 2;
      ok(Math.abs(wantX - cx) > 5 || Math.abs(wantY - cy) > 5,
        '★ 负对照：触发点确实不在面板中心（不然「对准触发点」和「用默认值」分不出来）',
        ` → 触发点 ${wantX.toFixed(1)},${wantY.toFixed(1)}px vs 中心 ${cx},${cy}px`);
    }
    // 收尾：关掉表单，别影响后面的步骤
    await sw.webContents.executeJavaScript(`(async () => {
      document.getElementById('btn-cancel').click();
      await new Promise((r) => setTimeout(r, 150));
      return true;
    })()`);
    const closed = await sw.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('form');
      return { hidden: form.classList.contains('hidden'), hasClass: form.classList.contains('is-open') };
    })()`);
    ok(closed.hidden === true && closed.hasClass === false,
      '关掉表单后动画类也摘掉了（下次打开才会重新播）');
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

  // ===== ⑤b 时段日程：界面上填得出、存得进、列表显示成「开始–结束」=====
  // 「时段」是 v2 的新东西：一条日程占一段时间，不是到点响一下就走。
  log('⑤b 时段日程（14:00–16:30）');
  const spanAdd = await sw.webContents.executeJavaScript(`(async () => {
    const kindSel = document.getElementById('f-kind');
    if (!kindSel) return { missingKind: true };

    document.getElementById('btn-add').click();
    document.getElementById('f-title').value = '自检·时段';
    kindSel.value = 'span';
    kindSel.dispatchEvent(new Event('change'));
    const endVisible = !document.getElementById('row-endtime').classList.contains('hidden');
    document.getElementById('f-time').value = '14:00';
    document.getElementById('f-endtime').value = '16:30';
    const rep = document.getElementById('f-repeat');
    rep.value = 'daily';
    rep.dispatchEvent(new Event('change'));
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 400));

    const li = [...document.querySelectorAll('#list .item')]
      .find((x) => x.querySelector('.title').textContent === '自检·时段') || null;
    return {
      endVisible,
      time: li ? li.querySelector('.time').textContent : null,
      formClosed: document.getElementById('form').classList.contains('hidden'),
    };
  })()`);

  if (spanAdd.missingKind) {
    ok(false, '★ 表单里没有「类型」这一栏（#f-kind）—— 时段根本填不出来');
  } else {
    ok(spanAdd.endVisible === true, '选了「时段」，「到几点」那一行冒出来了');
    ok(spanAdd.time === '14:00–16:30', '★ 列表上显示成「开始–结束」', ` → “${spanAdd.time}”`);
    ok(spanAdd.formClosed === true, '保存后表单自动收起');
  }
  const spanInFile = schedules.list().filter((x) => x.title === '自检·时段');
  ok(spanInFile.length === 1, '★ 主进程那边确实存进了文件', ` → 文件里 ${spanInFile.length} 条`);
  // ★ 只看界面不算数 —— 界面假装显示对了也能骗过测试，所以必须问主进程
  ok(!!(spanInFile[0] && spanInFile[0].kind === 'span'), '★ 主进程读到 kind = span（不是只有界面显示对）',
    ` → kind=${spanInFile[0] && spanInFile[0].kind}`);
  ok(!!(spanInFile[0] && spanInFile[0].endTime === '16:30'), '★ 主进程读到 endTime = 16:30',
    ` → endTime=${spanInFile[0] && spanInFile[0].endTime}`);

  // ★ 负对照：类型切回「时间点」，「到几点」必须藏起来，存出来的 endTime 必须是 null。
  //   ⚠ 故意另建一条「自检·试类型」来验，**不动**上面那条「自检·时段」——
  //     后面 ⑤d（周视图）还要拿它当「时段比时间点高」的证据。
  log('⑤b′ ★ 负对照：类型切回「时间点」→ 结束时间那一行消失、endTime 存成 null');
  const pointSwitch = await sw.webContents.executeJavaScript(`(async () => {
    const kindSel = document.getElementById('f-kind');
    if (!kindSel) return { missingKind: true };

    document.getElementById('btn-add').click();
    document.getElementById('f-title').value = '自检·试类型';
    kindSel.value = 'span';
    kindSel.dispatchEvent(new Event('change'));
    document.getElementById('f-time').value = '10:00';
    document.getElementById('f-endtime').value = '11:00';
    const rep = document.getElementById('f-repeat');
    rep.value = 'daily';
    rep.dispatchEvent(new Event('change'));
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 400));

    // 再打开它，把类型切回「时间点」
    const li = [...document.querySelectorAll('#list .item')]
      .find((x) => x.querySelector('.title').textContent === '自检·试类型');
    if (!li) return { missingRow: true };
    li.querySelector('.actions .ghost').click();
    await new Promise((r) => setTimeout(r, 150));
    const endVisibleBefore = !document.getElementById('row-endtime').classList.contains('hidden');
    kindSel.value = 'point';
    kindSel.dispatchEvent(new Event('change'));
    const endVisibleAfter = !document.getElementById('row-endtime').classList.contains('hidden');
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 400));
    return { endVisibleBefore, endVisibleAfter };
  })()`);

  if (pointSwitch.missingKind || pointSwitch.missingRow) {
    ok(false, '★ 负对照没法做（找不到「类型」栏或那一行）');
  } else {
    ok(pointSwitch.endVisibleBefore === true, '改一条时段日程时，「到几点」一开始是显示着的');
    ok(pointSwitch.endVisibleAfter === false, '★ 负对照：类型切成「时间点」后，「到几点」藏起来了');
  }
  const switchedToPoint = schedules.list().filter((x) => x.title === '自检·试类型');
  ok(!!(switchedToPoint[0] && switchedToPoint[0].kind === 'point' && switchedToPoint[0].endTime === null),
    '★ 负对照：切回时间点后存出来的 endTime 是 null（没留脏数据）',
    ` → kind=${switchedToPoint[0] && switchedToPoint[0].kind} endTime=${switchedToPoint[0] && switchedToPoint[0].endTime}`);

  // ===== ⑤c ★ 负对照：结束时间早于开始 → 必须被拦下，且不能写进文件 =====
  log('⑤c ★ 负对照：结束时间早于开始时间（15:00→14:00）→ 拦下');
  const countBeforeC = schedules.list().length;
  const backwards = await sw.webContents.executeJavaScript(`(async () => {
    const kindSel = document.getElementById('f-kind');
    if (!kindSel) return { missingKind: true };

    document.getElementById('btn-add').click();
    document.getElementById('f-title').value = '自检·倒流';
    kindSel.value = 'span';
    kindSel.dispatchEvent(new Event('change'));
    document.getElementById('f-time').value = '15:00';
    document.getElementById('f-endtime').value = '14:00';
    const rep = document.getElementById('f-repeat');
    rep.value = 'daily';
    rep.dispatchEvent(new Event('change'));
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 400));
    const err = document.getElementById('form-error');
    const out = {
      formStillOpen: !document.getElementById('form').classList.contains('hidden'),
      errorShown: !err.classList.contains('hidden'),
      errorText: err.textContent,
    };
    document.getElementById('btn-cancel').click();   // 收尾：别让表单一直开着影响后面几步
    return out;
  })()`);

  if (backwards.missingKind) {
    ok(false, '★ 负对照没法做（找不到「类型」栏）');
  } else {
    ok(backwards.errorShown === true, '界面上给出了错误提示', ` → “${backwards.errorText}”`);
    ok(backwards.formStillOpen === true, '表单没被关掉（主人填的东西还在，不用重填）');
  }
  ok(schedules.list().length === countBeforeC, '★ 主进程那边一条都没多',
    ` → 还是 ${countBeforeC} 条`);
  ok(schedules.list().every((x) => x.title !== '自检·倒流'), '★ 「自检·倒流」确实没被写进文件');

  // ===== ⑤d 周视图：七列 + 时间刻度 + 彩色方块 =====
  // 「周视图」是 v2 的主体需求：一眼看见一周的安排，不同颜色的方块代表不同的事。
  log('⑤d 周视图（点「周视图」按钮 → 七列方块）');
  // 主进程还没实现 SIZES 时用计划里的标称值兜底，这样这条断言会「红」而不是把自检搞崩
  const WEEK_SIZE = (settingsWindow.SIZES && settingsWindow.SIZES.week) || { w: 1000, h: 680 };
  const weekOpen = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('btn-week');
    if (!btn) return { missingBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 900));

    const heads = [...document.querySelectorAll('#week-head .day-head')].map((h) => h.textContent);
    const blks = [...document.querySelectorAll('#week-grid .blk')];
    const heightOf = (title) => {
      const b = blks.find((x) => {
        const t = x.querySelector('.blk-title');
        return t && t.textContent === title;
      });
      return b ? Math.round(b.getBoundingClientRect().height) : null;
    };
    return {
      weekShown: !document.getElementById('week').classList.contains('hidden'),
      listHidden: document.querySelector('.list-wrap').classList.contains('hidden'),
      heads,
      blockCount: blks.length,
      spanH: heightOf('自检·时段'),
      pointH: heightOf('自检·日程'),
    };
  })()`);

  if (weekOpen.missingBtn) {
    ok(false, '★ 工具栏上没有「周视图」按钮（#btn-week）—— 周视图根本打不开');
  } else {
    ok(weekOpen.weekShown === true && weekOpen.listHidden === true,
      '★ 周视图容器出现了、列表容器藏起来了');
    // ★ 拿 DOM 里真实的列头文本比，不要比我们自己生成的那个数组 —— 那样等于自己验自己
    ok(weekOpen.heads.join() === '周一,周二,周三,周四,周五,周六,周日',
      '★ 正好七列，从左到右是周一到周日', ` → ${weekOpen.heads.join(' / ')}`);
  }

  {
    const b = sw.getBounds();
    const dw = Math.abs(b.width - WEEK_SIZE.w);
    const dh = Math.abs(b.height - WEEK_SIZE.h);
    ok(dw <= 2 && dh <= 2, `★ 窗口跟着变成周视图的尺寸（标称 ${WEEK_SIZE.w}×${WEEK_SIZE.h}，允许 ±2 像素）`,
      ` → 实际 ${b.width}×${b.height}`);
  }

  // ★ 这条是「时段用高的长方体、时间点用扁的」这条需求的**唯一证据**：
  //   同一天里，时段那一块必须比时间点那一块高。
  // ⚠ 必须用 typeof 判「量到了没有」，不能写 `!== null`：
  //   注入的脚本走 early-return 时字段是 undefined，而 `undefined !== null` 是 true，
  //   断言会**假通过** —— 这正是「验证方式本身也可能是假的」那种坑。
  const gotHeights = typeof weekOpen.spanH === 'number' && typeof weekOpen.pointH === 'number';
  ok(gotHeights,
    '周视图上找得到「自检·时段」和「自检·日程」两块',
    ` → 时段高 ${weekOpen.spanH}px · 时间点高 ${weekOpen.pointH}px`);
  ok(gotHeights && weekOpen.spanH > weekOpen.pointH,
    '★ 时段的方块比时间点的方块高（时段是长方体、时间点是扁条）',
    ` → ${weekOpen.spanH}px vs ${weekOpen.pointH}px`);

  // ★ 负对照：切回列表 —— 周视图要藏起来、列表要回来、窗口尺寸也要缩回去
  //   v4 批次 3-c：切回去走**侧边栏的「日程」**。
  //   原来是「再点一下同一个按钮」（那个按钮点完还会把字改成「列表」），
  //   侧边栏里两个页面各有独立入口，所以负对照改成点另一个入口 ——
  //   这同样能证明「切页面是真的切了」，而且比原来更贴近用户的真实动作。
  log('⑤d′ ★ 负对照：点侧边栏「日程」切回列表');
  const weekBack = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('btn-list');
    if (!btn) return { missingBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      weekHidden: document.getElementById('week').classList.contains('hidden'),
      listShown: !document.querySelector('.list-wrap').classList.contains('hidden'),
      weekNav: document.getElementById('btn-week').getAttribute('aria-current'),
      listNav: btn.getAttribute('aria-current'),
      weekLabel: document.getElementById('btn-week').textContent.trim(),
    };
  })()`);
  if (weekBack.missingBtn) {
    ok(false, '★ 负对照没法做（侧边栏没有「日程」入口）');
  } else {
    ok(weekBack.weekHidden === true && weekBack.listShown === true,
      '★ 负对照：切回列表后周视图藏起来、列表回来了');
    ok(weekBack.listNav === 'page' && weekBack.weekNav === null,
      '★ 高亮跟着切回「日程」（周视图不再高亮）',
      ` → 日程=${weekBack.listNav} 周视图=${weekBack.weekNav}`);
    // 侧边栏的标签**不再变字**（旧做法是按钮自己变成「列表」，看不出在哪一页）
    ok(weekBack.weekLabel === '周视图', '★ 侧边栏的「周视图」标签保持原样（不再变字）',
      ` → “${weekBack.weekLabel}”`);
  }
  {
    const b = sw.getBounds();
    const dw = Math.abs(b.width - settingsWindow.WIN_W);
    const dh = Math.abs(b.height - settingsWindow.WIN_H);
    ok(dw <= 2 && dh <= 2, `★ 负对照：窗口尺寸缩回列表的 ${settingsWindow.WIN_W}×${settingsWindow.WIN_H}`,
      ` → 实际 ${b.width}×${b.height}`);
  }

  // ===== ⑤e 在周视图上改：点方块 → 跳回列表并弹出填好的表单 =====
  log('⑤e 周视图上点方块 → 弹出填好的表单');
  const clickBlk = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('btn-week');
    if (!btn) return { missingBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 900));

    const blk = [...document.querySelectorAll('#week-grid .blk')].find((x) => {
      const t = x.querySelector('.blk-title');
      return t && t.textContent === '自检·时段';
    });
    if (!blk) return { missingBlk: true };

    blk.click(); // 真点一下（不是直接调函数）
    await new Promise((r) => setTimeout(r, 600));

    const kindSel = document.getElementById('f-kind');
    return {
      formOpen: !document.getElementById('form').classList.contains('hidden'),
      title: document.getElementById('f-title').value,
      kind: kindSel ? kindSel.value : null,
      endTime: document.getElementById('f-endtime') ? document.getElementById('f-endtime').value : null,
      weekHidden: document.getElementById('week').classList.contains('hidden'),
      listShown: !document.querySelector('.list-wrap').classList.contains('hidden'),
      btnText: btn.textContent.trim(),
    };
  })()`);

  if (clickBlk.missingBtn || clickBlk.missingBlk) {
    ok(false, '★ 点方块没法测（找不到「周视图」按钮或那一块）');
  } else {
    ok(clickBlk.formOpen === true, '★ 点一下方块，表单真的弹出来了');
    ok(clickBlk.title === '自检·时段', '★ 表单里填的是**这一条**的标题（不是空的、也不是别人的）',
      ` → “${clickBlk.title}”`);
    ok(clickBlk.kind === 'span' && clickBlk.endTime === '16:30',
      '★ 类型和结束时间也都带进来了', ` → kind=${clickBlk.kind} endTime=${clickBlk.endTime}`);
    ok(clickBlk.weekHidden === true && clickBlk.listShown === true,
      '★ 同时切回了列表（不然表单会被周视图的网格盖住）');
    ok(clickBlk.btnText === '周视图', '★ 侧边栏「周视图」标签保持原样（不再变字）', ` → “${clickBlk.btnText}”`);
  }

  // ★ 负对照：在表单里改完保存，主进程那边必须**真的变了** ——
  //   只验「表单里填对了」不够，那只能证明我们把值读出来了，证明不了写回去。
  log('⑤e′ ★ 负对照：在表单里改名 + 改结束时间 → 主进程那边真的变了');
  const editFromWeek = await sw.webContents.executeJavaScript(`(async () => {
    if (document.getElementById('form').classList.contains('hidden')) return { formWasClosed: true };
    document.getElementById('f-title').value = '自检·时段改';
    document.getElementById('f-endtime').value = '17:00';
    document.getElementById('btn-save').click();
    await new Promise((r) => setTimeout(r, 500));
    return { formClosed: document.getElementById('form').classList.contains('hidden') };
  })()`);
  const editedItems = schedules.list().filter((x) => x.title === '自检·时段改');
  ok(editFromWeek.formClosed === true, '保存后表单收起来了');
  ok(editedItems.length === 1, '★ 负对照：主进程那边的标题真的变成「自检·时段改」了',
    ` → 找到 ${editedItems.length} 条`);
  ok(!!(editedItems[0] && editedItems[0].endTime === '17:00'), '★ 负对照：结束时间也真的改成 17:00 了',
    ` → endTime=${editedItems[0] && editedItems[0].endTime}`);
  ok(schedules.list().every((x) => x.title !== '自检·时段'),
    '★ 负对照：老标题已经不存在（说明是「改了这一条」，不是「又加了一条」）');

  // ★ 负对照：点空白格新建 → 表单必须是**空的**，不能把上次点过的日程带进来
  log('⑤e″ ★ 负对照：点周视图的空白格 → 弹出空白表单，时间预填那一格');
  {
    // 本周三的日期键（周一算第一天，所以 +2）
    const nowD = new Date();
    const backD = (nowD.getDay() + 6) % 7;
    const monD = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - backD);
    const wedKey = schedules.localDateKey(
      new Date(monD.getFullYear(), monD.getMonth(), monD.getDate() + 2)
    );

    const clickSlot = await sw.webContents.executeJavaScript(`(async () => {
      const btn = document.getElementById('btn-week');
      if (!btn) return { missingBtn: true };
      btn.click();
      await new Promise((r) => setTimeout(r, 900));

      const cols = [...document.querySelectorAll('#week-grid .day-col')];
      const wed = cols[2]; // 周一、周二、周三 —— 第 3 列就是周三
      const slot = wed ? wed.querySelector('.slot[data-hour="13"]') : null;
      if (!slot) return { missingSlot: true };

      slot.click();
      await new Promise((r) => setTimeout(r, 600));

      const kindSel = document.getElementById('f-kind');
      return {
        formOpen: !document.getElementById('form').classList.contains('hidden'),
        title: document.getElementById('f-title').value,
        time: document.getElementById('f-time').value,
        repeat: document.getElementById('f-repeat').value,
        date: document.getElementById('f-date').value,
        kind: kindSel ? kindSel.value : null,
        weekHidden: document.getElementById('week').classList.contains('hidden'),
      };
    })()`);

    if (clickSlot.missingBtn || clickSlot.missingSlot) {
      ok(false, '★ 点空白格没法测（找不到「周视图」按钮或那一格）');
    } else {
      ok(clickSlot.formOpen === true, '点空白格也能弹出表单');
      ok(clickSlot.title === '', '★ 负对照：标题是**空的**（没把上次点过的日程带进来）',
        ` → “${clickSlot.title}”`);
      ok(clickSlot.time === '13:00', '时间预填成点的那一格 13:00', ` → “${clickSlot.time}”`);
      ok(clickSlot.repeat === 'once' && clickSlot.date === wedKey,
        '★ 重复默认「只提醒一次」，日期预填成点的那一天（周三）',
        ` → ${clickSlot.repeat} · ${clickSlot.date}（期望 ${wedKey}）`);
      ok(clickSlot.kind === 'point', '类型默认「时间点」', ` → ${clickSlot.kind}`);
      ok(clickSlot.weekHidden === true, '★ 也切回了列表（表单才不会被盖住）');
      // 收尾：把这张空白表单取消掉，别影响后面几步
      await sw.webContents.executeJavaScript(`document.getElementById('btn-cancel').click()`);
      await sleep(200);
    }
  }

  // 收尾：把 ⑤e 造出来的那条删掉。
  // （⑨ 也会清掉所有「自检·」开头的记录，这里顺手清一次，让中间几步看到的列表更干净）
  for (const it of schedules.list()) {
    if (it.title === '自检·时段改') schedules.remove(it.id);
  }
  // 让界面上的列表跟着刷新（load 是 settings.js 里的全局函数；万一拿不到就跳过，⑨ 还会兜底）
  await sw.webContents.executeJavaScript(`(async () => {
    if (typeof load === 'function') await load();
  })()`);
  await sleep(200);

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

  // ===== ⑧b 专注页（阶段 3 · Task 4）=====
  // 这一段只验「计时 + 配置」的地基，**不碰系统**（改 hosts / 关软件在 Task 6-8）。
  // 从干净状态开始：先确保没在专注，再清空名单（专注中不允许清）。
  focus.stop('selftest-reset');
  focus.setBlacklist({ domains: [], exes: [] });

  log('⑧b 专注页：切过去、加名单、选时长、开始、倒计时');
  const focusOpen = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('btn-focus');
    if (!btn) return { missingBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      pageShown: !document.getElementById('focus-page').classList.contains('hidden'),
      listHidden: document.querySelector('.list-wrap').classList.contains('hidden'),
      hasStart: !!document.getElementById('btn-focus-start'),
      hasStop: !!document.getElementById('btn-focus-stop'),
    };
  })()`);

  if (focusOpen.missingBtn) {
    ok(false, '★ 侧边栏上没有「专注」入口（#btn-focus）—— 专注页根本打不开');
  } else {
    ok(focusOpen.pageShown === true && focusOpen.listHidden === true,
      '★ 点「专注」后专注页出现了、日程列表藏起来了');
    ok(focusOpen.hasStart === true && focusOpen.hasStop === true,
      '专注页上有「开始专注」和「结束专注」两个按钮');
  }

  // ★ v4 批次 3-c：专注页上侧边栏必须**还在**。
  //   这是这一批最容易出人命的地方：以前专注页的出口是页内那个「← 返回日程」按钮，
  //   现在那个按钮删了、出口只剩侧边栏 —— 万一侧边栏被 body.focus-mode 一起藏了，
  //   用户就**出不来了**（而且窗口也没了关闭按钮的替代路径）。
  {
    const nav = await sw.webContents.executeJavaScript(`(() => {
      const sb = document.querySelector('.sidebar');
      const list = document.getElementById('btn-list');
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        sidebarVisible: vis(sb),
        listVisible: vis(list),
        listCurrent: list ? list.getAttribute('aria-current') : null,
        focusCurrent: document.getElementById('btn-focus').getAttribute('aria-current'),
        title: document.getElementById('page-title').textContent,
      };
    })()`);
    ok(nav.sidebarVisible === true, '★ 专注页上侧边栏仍然可见（不然就没有出口了）');
    ok(nav.listVisible === true, '★ 侧边栏上的「日程」仍然点得到（这就是专注页的出口）');
    ok(nav.focusCurrent === 'page' && nav.listCurrent === null,
      '★ 高亮切到了「专注」，「日程」不再高亮',
      ` → 专注=${nav.focusCurrent} 日程=${nav.listCurrent}`);
    ok(nav.title === '专注', '内容区标题跟着变成「专注」', ` → “${nav.title}」`);
  }

  // 顺带验「专注页真的排开了版」——不是掉到左上角、也不是高度为 0 的隐形页。
  // （项目里踩过「漏加共享样式 → 控件掉到左上角」的坑，见 HANDOFF 第六节第 21 条。）
  {
    const layout = await sw.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('focus-page').getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        presets: document.querySelectorAll('#focus-presets button').length,
      };
    })()`);
    ok(layout.w > 300 && layout.h > 300,
      '★ 专注页真的铺开了（有实际宽高，不是隐形页）', ` → ${layout.w}×${layout.h}`);
    ok(layout.presets >= 4, '预设按钮是 3 个固定时长 + 1 个「自定义」',
      ` → ${layout.presets} 个`);
  }

  // ===== ⑧b⁰ 安全 DNS（DoH）提醒条（阶段 3 · Task 7）=====
  // 为什么要单独验：这是「我们全对、功能全废」的那个坑 ——
  // 浏览器开了安全 DNS，hosts 改得一点没错，网站照样打得开。
  // 所以「开始专注前必须让主人看见」这件事，得钉死在自检里，不能只是代码里写了。
  log('⑧b⁰ 安全 DNS 提醒条：查到了没、显示出来了没、颜色对不对');
  {
    const info = focus.checkDoh();
    const three = ['off', 'on', 'unknown'];
    ok(info && three.includes(info.level),
      '★ 主进程给出了「安全 DNS」三态结论（不是随便一个值）',
      ` → ${info && info.level}`);
    ok(info && typeof info.advice === 'string' && info.advice.length > 8,
      '★ 并且带了一句给主人看的人话',
      ` → “${info && info.advice}”`);

    // 提醒条真渲染出来了没：颜色类 + 文本都得和主进程报的三态对得上
    const dom = await sw.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('focus-doh');
      if (!b) return { missing: true };
      return {
        hidden: b.classList.contains('hidden'),
        cls: [...b.classList].join(' '),
        text: b.textContent.trim(),
      };
    })()`);

    if (dom.missing) {
      ok(false, '★ 专注页上没有 #focus-doh 提醒条 —— 主人永远看不到这条警告');
    } else {
      ok(dom.hidden === false, '★ 提醒条显示出来了（没被藏起来）');
      ok(dom.text.includes(info.advice),
        '★ 界面上显示的就是主进程给的那句人话（没被改写/截断）',
        ` → “${dom.text.slice(0, 40)}…”`);
      const wantCls = info.level === 'on' ? 'warn' : info.level === 'off' ? 'ok' : 'unknown';
      ok(dom.cls.includes(wantCls),
        '★ 提醒条的配色和「三态」对得上（开着=警示、关着=放心、查不到=中性）',
        ` → ${dom.cls} / 期望含 ${wantCls}`);
    }

    // ★ 负对照：把三种状态分别喂给渲染函数，**必须画出三种不一样的东西**。
    //   防的是「无论什么状态都画同一句话/同一个颜色」的假实现 ——
    //   那种实现下，主人开着安全 DNS 也只会看到一句「放心」，比不显示还坏。
    const trio = await sw.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('focus-doh');
      const snap = (lv) => {
        renderDoh({ level: lv, advice: 'ADVICE-' + lv });
        return { cls: [...box.classList].join(' '), text: box.textContent.trim() };
      };
      const on = snap('on'), off = snap('off'), unk = snap('unknown');
      return { on, off, unk };
    })()`);
    ok(trio.on.cls !== trio.off.cls && trio.on.cls !== trio.unk.cls && trio.off.cls !== trio.unk.cls,
      '★ 负对照：三种状态画出三种不同配色（防「永远同一个颜色」的假实现）',
      ` → on=${trio.on.cls} / off=${trio.off.cls} / unknown=${trio.unk.cls}`);
    ok(trio.on.text !== trio.off.text && trio.off.text !== trio.unk.text && trio.on.text !== trio.unk.text,
      '★ 负对照：三种状态画出三句不同的话（防「永远同一句话」的假实现）');
    ok(trio.on.cls.includes('warn') && trio.off.cls.includes('ok'),
      '★ 「开着」必须是警示色、「关着」必须是放心色（别把最该提醒的那个画得最不起眼）');

    // 把界面恢复成真实状态，别把自检的假数据留在屏幕上
    await sw.webContents.executeJavaScript('refreshDoh()');
  }

  // ★ 负对照：黑名单空着点「开始专注」→ 必须被拒（不能「专注了个寂寞」）
  log('⑧b′ ★ 负对照：黑名单空着点「开始专注」→ 被拒');
  const emptyStart = await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-focus-start').click();
    await new Promise((r) => setTimeout(r, 500));
    const err = document.getElementById('focus-error');
    return {
      errorShown: !err.classList.contains('hidden'),
      errorText: err.textContent,
      stillIdle: !document.getElementById('focus-idle').classList.contains('hidden'),
    };
  })()`);
  ok(emptyStart.errorShown === true, '界面上给出了「先加一个要挡住的东西」的提示',
    ` → “${emptyStart.errorText}”`);
  ok(emptyStart.stillIdle === true, '界面还停在「开始」那一步（没切到倒计时）');
  ok(focus.state().session === null, '★ 主进程那边 session 还是 null（确实没开始）');

  // ★ 正例：粘的是完整网址，列表里必须出现**洗干净**的域名
  log('⑧b″ 加一条网站（粘完整网址，要洗成域名）');
  const addDomain = await sw.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('f-domain-input');
    input.value = 'https://www.bilibili.com/video/BV1xx?t=1';
    document.getElementById('btn-add-domain').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      shown: [...document.querySelectorAll('#focus-domains .focus-val')].map((x) => x.textContent),
      inputCleared: input.value === '',
    };
  })()`);
  ok(addDomain.shown.includes('www.bilibili.com'),
    '★ 列表里出现的是洗干净的「www.bilibili.com」（不是原样粘进去的整串）',
    ` → ${JSON.stringify(addDomain.shown)}`);
  ok(addDomain.inputCleared === true, '加完之后输入框清空了');
  ok(focus.state().domains.includes('www.bilibili.com'), '★ 主进程那边也真的存进去了');

  // ★ 负对照：把桌宠自己的进程名加进「软件」→ 必须被拒
  log('⑧b‴ ★ 负对照：把 electron.exe 加进「软件」→ 被拒（不许把自己杀了）');
  const addBadExe = await sw.webContents.executeJavaScript(`(async () => {
    const err = document.getElementById('focus-error');
    err.classList.add('hidden');   // 先清掉上一步的提示，才看得出这一步有没有新提示
    const input = document.getElementById('f-exe-input');
    input.value = 'electron.exe';
    document.getElementById('btn-add-exe').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      shown: [...document.querySelectorAll('#focus-exes .focus-val')].map((x) => x.textContent),
      errorShown: !err.classList.contains('hidden'),
      errorText: err.textContent,
    };
  })()`);
  ok(!addBadExe.shown.includes('electron.exe'), '★ 列表里没有 electron.exe');
  ok(addBadExe.errorShown === true, '界面上给出了错误提示（告诉主人为什么不行）',
    ` → “${addBadExe.errorText}”`);
  ok(focus.state().exes.length === 0, '★ 主进程那边也没存进去');

  log('⑧b⁴ᐩ 软件选择器（v4 批次 2.5）：点一下勾选 → 再点取消 → 保存才生效');
  {
    // 面板的数据来自主进程扫开始菜单。这条链子在自检环境里跑的是**真开始菜单**
    // （沙箱只隔离了 userData，没有隔离开始菜单），所以断言要写得稳一点：
    // 不写死「必须有 41 个」，而是「面板能打开、能列出东西、勾选/取消/保存都对」。
    const opened = await sw.webContents.executeJavaScript(`(async () => {
      const panel = document.getElementById('app-picker');
      const btn = document.getElementById('btn-browse-apps');
      const r = { hasBtn: !!btn, hasPanel: !!panel };
      if (!btn || !panel) return r;
      r.hiddenBefore = panel.classList.contains('hidden');
      btn.click();
      await new Promise((res) => setTimeout(res, 4000)); // 等扫描（真机 100+ 个 .lnk，实测约 1.2 秒；留足余量）
      r.hiddenAfter = panel.classList.contains('hidden');
      r.cells = document.querySelectorAll('#picker-grid .app-cell').length;
      r.countText = document.getElementById('picker-count').textContent.trim();
      r.firstExe = document.querySelector('#picker-grid .app-cell')?.dataset.exe || '';
      r.firstName = document.querySelector('#picker-grid .app-cell')?.dataset.name || '';
      r.addedCells = document.querySelectorAll('#picker-grid .app-cell.added').length;
      // 无障碍语义：每格必须是 checkbox 且带 aria-checked
      const c0 = document.querySelector('#picker-grid .app-cell');
      r.role = c0 ? c0.getAttribute('role') : '';
      r.aria = c0 ? c0.getAttribute('aria-checked') : '';
      r.saveText = (document.getElementById('btn-picker-save') || {}).textContent || '';
      r.saveDisabled = !!(document.getElementById('btn-picker-save') || {}).disabled;
      // v4 批次 3-c-2：面板要从那颗按钮「长出来」—— origin 必须对准它
      const p = panel.querySelector('.picker-panel');
      if (p) {
        const pr = p.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        r.wantX = ((br.left + br.width / 2 - pr.left) / pr.width) * 100;
        r.wantY = ((br.top + br.height / 2 - pr.top) / pr.height) * 100;
        r.origin = getComputedStyle(p).transformOrigin;
        r.panelW = Math.round(pr.width);
        r.panelH = Math.round(pr.height);
        r.isOpenClass = panel.classList.contains('is-open');
      }
      return r;
    })()`);

    ok(opened.hasBtn === true, '专注页上有「浏览已安装软件」按钮');
    ok(opened.hiddenBefore === true, '一开始面板是关着的');
    ok(opened.hiddenAfter === false, '★ 点按钮后面板打开了');
    ok(opened.cells > 0, '★ 面板里列出了软件（真开始菜单扫出来的）',
      ` → ${opened.cells} 个 · ${opened.countText}`);
    // ★ 批次 2.5：语义必须是「复选框」而不是「按钮」——
    //   否则屏幕阅读器念不出「已选中/未选中」这个状态
    ok(opened.role === 'checkbox', '★ 每格是 role=checkbox（不是普通按钮）', ` → role=${opened.role}`);
    ok(opened.aria === 'false' || opened.aria === 'true', '★ 每格带 aria-checked 状态',
      ` → aria-checked=${opened.aria}`);
    // ★ 负对照：刚打开、什么都没勾，保存按钮必须是**禁用的**
    //   （这正是「先勾后存」的核心 —— 没有改动就不该能点保存）
    ok(opened.saveDisabled === true, '★ 负对照：刚打开时「保存」是禁用的（没有改动）',
      ` → 文字「${opened.saveText}」disabled=${opened.saveDisabled}`);

    // ★ v4 批次 3-c-2 空间一致：面板必须从「浏览已安装软件」那颗按钮长出来
    {
      const m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(opened.origin || '');
      ok(opened.isOpenClass === true, '★ 面板挂上了动画类 .is-open');
      ok(!!m, '面板的 transform-origin 能读出来', ` → ${opened.origin}`);
      if (m) {
        const gotX = parseFloat(m[1]);
        const gotY = parseFloat(m[2]);
        const wantX = (opened.wantX / 100) * opened.panelW;
        const wantY = (opened.wantY / 100) * opened.panelH;
        ok(Math.abs(gotX - wantX) <= 2 && Math.abs(gotY - wantY) <= 2,
          '★ origin 精确落在那颗按钮的中心上（面板从它长出来）',
          ` → 实际 ${gotX.toFixed(1)},${gotY.toFixed(1)}px / 期望 ${wantX.toFixed(1)},${wantY.toFixed(1)}px`);
      }
    }

    if (opened.cells > 0) {
      // 搜索过滤：打个不存在的词，网格应该清空（这条同时验「搜索是本地过滤」）
      const searched = await sw.webContents.executeJavaScript(`(async () => {
        const box = document.getElementById('picker-search');
        box.value = 'zzz不存在的软件zzz';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const none = document.querySelectorAll('#picker-grid .app-cell').length;
        const emptyShown = !document.getElementById('picker-empty').classList.contains('hidden');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        return { none, emptyShown, restored: document.querySelectorAll('#picker-grid .app-cell').length };
      })()`);
      ok(searched.none === 0, '★ 搜索不存在的词 → 网格清空');
      ok(searched.emptyShown === true, '★ 并且给出了「没找到」的提示（不是一片空白）');
      ok(searched.restored === opened.cells, '★ 清空搜索框 → 列表恢复（过滤是可逆的）');

      // ===== 核心：勾选 → 不保存 → 再点取消 → 保存 =====
      const before = focus.state().exes.slice();
      const picked = await sw.webContents.executeJavaScript(`(async () => {
        const cell = [...document.querySelectorAll('#picker-grid .app-cell')]
          .find((c) => !c.classList.contains('added') && c.dataset.exe);
        if (!cell) return { none: true };
        const name = cell.dataset.name, exe = cell.dataset.exe;

        // ① 点一下 = 只勾选（本地草稿），不发 IPC
        cell.click();
        await new Promise((r) => setTimeout(r, 120));
        const afterFirst = {
          mainExes: (await window.settingsAPI.focusGet()).exes,
          sameNode: cell === [...document.querySelectorAll('.app-cell')].find((c) => c.dataset.exe === exe),
          picked: cell.classList.contains('picked'),
          aria: cell.getAttribute('aria-checked'),
          count: document.getElementById('picker-count').textContent.trim(),
          saveDisabled: !!document.getElementById('btn-picker-save').disabled,
        };

        // ② 再点一下 = 取消勾选
        cell.click();
        await new Promise((r) => setTimeout(r, 120));
        const afterSecond = {
          picked: cell.classList.contains('picked'),
          aria: cell.getAttribute('aria-checked'),
          saveDisabled: !!document.getElementById('btn-picker-save').disabled,
        };

        // ③ 再勾回来，然后保存
        cell.click();
        await new Promise((r) => setTimeout(r, 120));
        document.getElementById('btn-picker-save').click();
        await new Promise((r) => setTimeout(r, 600));

        // ⚠ 保存后网格会重画 → 旧节点失效，必须按 exe 重新查
        const fresh = [...document.querySelectorAll('#picker-grid .app-cell')]
          .find((c) => c.dataset.exe === exe);
        return {
          name, exe, afterFirst, afterSecond,
          listVals: [...document.querySelectorAll('#focus-exes .focus-val')].map((x) => x.textContent),
          cellAdded: !!(fresh && fresh.classList.contains('added')),
          cellPicked: !!(fresh && fresh.classList.contains('picked')),
          saveDisabledAfter: !!document.getElementById('btn-picker-save').disabled,
        };
      })()`);

      if (picked.none) {
        ok(false, '★ 面板里一个「还没加过」的软件都没有，没法验证勾选');
      } else if (picked.exe) {
        // ★★ 最重要的负对照：点了但**没保存**之前，主进程名单一个字节都不能变
        ok(JSON.stringify(picked.afterFirst.mainExes) === JSON.stringify(before),
          '负对照：在保存之前取主进程快照，勾选不写名单',
          ` → ${JSON.stringify(before)} vs ${JSON.stringify(picked.afterFirst.mainExes)}`);
        ok(picked.afterFirst.sameNode, '勾选不重建格子，保留焦点和悬停');

        ok(picked.afterFirst.picked === true, '★ 点一下 → 那一格变成「已选中」',
          ` → 计数「${picked.afterFirst.count}」`);
        ok(picked.afterFirst.aria === 'true', '★ 无障碍状态也跟着变（aria-checked=true）');
        ok(picked.afterFirst.saveDisabled === false, '★ 有改动后「保存」才可点');
        ok(picked.afterSecond.picked === false, '★★ 再点一下 → 取消选中（主人要的「再点一下撤销」）');
        ok(picked.afterSecond.aria === 'false', '★ 取消后 aria-checked 回到 false');
        ok(picked.afterSecond.saveDisabled === true, '★ 取消回原状后「保存」又变回禁用');

        ok(picked.listVals.includes(picked.exe), '★ 点「保存」后，它出现在黑名单列表里',
          ` → 勾了「${picked.name}」→ ${picked.exe}`);
        ok(focus.state().exes.includes(picked.exe), '★ 主进程那边真的存进去了（保存才生效）');
        ok(picked.cellAdded === true, '★ 保存后那一格变成「已在名单里」');
        ok(picked.cellPicked === true, '★ 而且它默认是勾上的（看到的 = 当前生效的）');
        ok(picked.saveDisabledAfter === true, '★ 保存完「保存」回到禁用（改动已清零）');

        // ===== 已挡的软件：点一下能取消勾选 → 保存 → 真的从名单移除 =====
        const removed = await sw.webContents.executeJavaScript(`(async () => {
          const cell = [...document.querySelectorAll('#picker-grid .app-cell')]
            .find((c) => c.dataset.exe === ${JSON.stringify(picked.exe)});
          if (!cell) return { missing: true };
          cell.click();   // 取消勾选
          await new Promise((r) => setTimeout(r, 120));
          const willRemove = cell.classList.contains('will-remove');
          const count = document.getElementById('picker-count').textContent.trim();
          document.getElementById('btn-picker-save').click();
          await new Promise((r) => setTimeout(r, 600));
          const fresh = [...document.querySelectorAll('#picker-grid .app-cell')]
            .find((c) => c.dataset.exe === ${JSON.stringify(picked.exe)});
          return {
            willRemove, count,
            addedAfter: !!(fresh && fresh.classList.contains('added')),
            listVals: [...document.querySelectorAll('#focus-exes .focus-val')].map((x) => x.textContent),
          };
        })()`);
        ok(removed.missing !== true, '（已挡的软件还能在网格里找到）');
        ok(removed.willRemove === true, '★ 对已挡的软件点一下 → 标成「保存后会放开」', ` → 计数「${removed.count}」`);
        ok(!removed.listVals.includes(picked.exe), '★★ 保存后它从黑名单里**真的移除了**（撤销是有效的）');
        ok(focus.state().exes.includes(picked.exe) === false, '★ 主进程那边也移除了');
        ok(removed.addedAfter === false, '★ 那一格不再是「已在名单里」');
      }
    }

    // ★ 负对照：面板里的软件一个都不许撞保护名单
    const badInList = await sw.webContents.executeJavaScript(`(() => {
      const exes = [...document.querySelectorAll('#picker-grid .app-cell')]
        .map((c) => c.dataset.exe).filter(Boolean);
      return exes;
    })()`);
    const prot = badInList.filter((x) => {
      try { return require('./focus/blacklist').isProtectedExe(x); } catch { return false; }
    });
    ok(prot.length === 0, '★ 负对照：面板里没有任何保护进程（explorer/electron…）',
      prot.length ? ` → 混进了 ${JSON.stringify(prot)}` : '');

    // 关掉面板，别挡住后面的步骤
    await sw.webContents.executeJavaScript(`(() => {
      document.getElementById('btn-picker-close').click();
      return document.getElementById('app-picker').classList.contains('hidden');
    })()`);
    const closed = await sw.webContents.executeJavaScript(
      `document.getElementById('app-picker').classList.contains('hidden')`
    );
    ok(closed === true, '★ 点 × 能关掉面板');
  }

  // ===== ⑧b⁵ 批次 2：视觉层（token / 材质 / 按压反馈）=====
  // 为什么这节必须存在：UI 是主观的，全靠肉眼说「像苹果了」是没法回归的。
  // 但「token 有没有真的接到控件上」「按压反馈是不是 pointerdown 触发」
  // 这类事是客观的，可以钉死。肉眼看的部分交给截图。
  log('⑧b⁴ᐨ 视觉层（v4 批次 2）：设计 token 是否真的接到控件上');
  const vis = await sw.webContents.executeJavaScript(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const tok = (n) => cs.getPropertyValue(n).trim();
    const btn = document.getElementById('btn-save') || document.querySelector('button');
    const bcs = btn ? getComputedStyle(btn) : null;
    const hdr = document.querySelector('header');
    const hcs = hdr ? getComputedStyle(hdr) : null;
    return {
      // token 层必须真的定义了东西（不是空壳）
      n3: tok('--n-3'),
      accent: tok('--a-500'),
      shadow: tok('--sh-1'),
      rSm: tok('--r-sm'),
      rMd: tok('--r-md'),
      ease: tok('--ease-out'),
      // 关键：token 要「接到」控件上，光定义没人用等于白写
      btnRadius: bcs ? bcs.borderTopLeftRadius : '',
      btnTransition: bcs ? bcs.transitionProperty : '',
      hdrBackdrop: hcs ? (hcs.backdropFilter || hcs.webkitBackdropFilter || '') : '',
      hdrBg: hcs ? hcs.backgroundColor : '',
      // 字号分级：标题和正文必须不一样（否则分级是假的）
      fsTitle: tok('--fs-title'),
      fsBody: tok('--fs-body'),
      fontFamily: getComputedStyle(document.body).fontFamily,
    };
  })()`);

  ok(!!vis.n3 && !!vis.accent, '★ 中性色 / 强调色 token 有值', ` → --n-3:${vis.n3} --a-500:${vis.accent}`);
  ok(!!vis.shadow && !!vis.rSm, '★ 阴影 / 圆角 token 有值', ` → --sh-1:${vis.shadow} --r-sm:${vis.rSm}`);
  // 负对照：token 定义了却没人用，就是装饰。
  //   基准用 --r-sm（button 自己用的就是它）。
  //   ⚠ 这里量的是**绝对像素**，不是「差不多就行」 —— 手写测试最容易糊弄自己的地方
  //   就是写成「不为空即通过」，那样把 border-radius 删了照样绿。
  ok(vis.btnRadius === vis.rSm && vis.btnRadius !== '', '★ 负对照：按钮圆角真的来自 --r-sm（不是硬编码）',
    ` → 按钮 ${vis.btnRadius} vs --r-sm ${vis.rSm}`);
  // 再钉一条：两个圆角 token 值必须不同，否则「分级」是假的
  ok(vis.rSm !== vis.rMd, '★ 负对照：--r-sm 和 --r-md 是不同值（圆角分级不是摆设）',
    ` → sm ${vis.rSm} / md ${vis.rMd}`);
  ok(/transform|box-shadow/.test(vis.btnTransition), '★ 负对照：按钮的 transition 真写了 transform/阴影',
    ` → ${vis.btnTransition}`);
  ok(vis.fsTitle !== vis.fsBody, '★ 负对照：标题和正文字号真的不一样（否则分级是假的）',
    ` → 标题 ${vis.fsTitle} / 正文 ${vis.fsBody}`);
  // 材质：header 必须是毛玻璃。注意 --no-gpu / 软件渲染下 blur 可能被降级，
  // 所以这里只要求「写了 backdrop-filter」，并同时打印实际值供人工判断。
  ok(/blur/.test(vis.hdrBackdrop), '★ header 用了毛玻璃（backdrop-filter: blur）',
    ` → ${vis.hdrBackdrop || '(空)'}；底色 ${vis.hdrBg}`);

  // ★ 深浅色一致性：CSS 的 prefers-color-scheme 和主进程 nativeTheme 必须**指向同一个主题**。
  //   踩过的坑：窗口 backgroundColor 写死浅色，而界面因为系统是深色而渲染成深色 →
  //   「开窗先闪一下白再变黑」。这条断言就是钉这个不一致。
  const themeProbe = await sw.webContents.executeJavaScript(
    `window.matchMedia('(prefers-color-scheme: dark)').matches`
  ).catch(() => null);
  const sysDark = require('electron').nativeTheme.shouldUseDarkColors;
  ok(themeProbe === sysDark, '★ 负对照：界面认的深色状态 == 主进程认的深色状态（否则开窗会闪白）',
    ` → 界面 ${themeProbe} / 主进程 ${sysDark}`);
  // 深色下必须真的是深底浅字（顺便钉住 token 真的换了值）
  if (themeProbe === true) {
    const lum = await sw.webContents.executeJavaScript(`(() => {
      const c = getComputedStyle(document.body).backgroundColor;
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
      return m ? (+m[1] + +m[2] + +m[3]) / 3 : NaN;
    })()`);
    ok(!Number.isNaN(lum) && lum < 110, '★ 深色模式下 body 底色确实是深色（不是闪回白）',
      ` → 平均亮度 ${lum}`);
  }

  log('⑧b⁴ᐩᐩ 按压反馈：是 pointerdown 触发，不是等 click');
  // ⚠ 这里必须**等过渡走完**再量 transform。
  //   第一版是「发完 pointerdown 立刻量」，量到的是 matrix(1,0,0,1,0,0)（= scale 1，没变），
  //   因为 transform 有 110ms 过渡，那一刻动画才刚开始。断言写的是 `!== 'none'`，
  //   于是「什么都没变」也能通过 —— 又是一条装饰性断言，自己抓出来。
  //   现在要求：量到的 scale **严格小于 1**。
  const press = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.querySelector('#focus-presets button') || document.querySelector('button');
    if (!btn) return { missing: true };
    const has = () => btn.classList.contains('pressing');
    const before = has();
    // 只发 pointerdown，不发 pointerup —— 模拟「手指刚按下去」
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    const downNow = has();
    const tfImmediate = getComputedStyle(btn).transform;
    // 等过渡真正落地（--t-fast 是 110ms，留足余量）
    await new Promise((r) => setTimeout(r, 260));
    const tfSettled = getComputedStyle(btn).transform;
    const scaleOf = (t) => {
      const m = /matrix\\(([-\\d.e]+),[^)]*\\)/.exec(t || '');
      return m ? parseFloat(m[1]) : NaN;
    };
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    return { before, downNow, tfImmediate, tfSettled, scale: scaleOf(tfSettled), afterUp: has() };
  })()`);
  if (press.missing) {
    ok(false, '★ 找不到任何按钮，没法验证按压反馈');
  } else {
    ok(press.before === false, '★ 负对照：没按之前不带 pressing 类');
    ok(press.downNow === true, '★ 按下的一瞬间（pointerdown）就带上了 pressing 类');
    ok(press.afterUp === false, '★ 松手后 pressing 类被摘掉（不会一直按着）');
    // 真正的负对照：缩放必须真的变小，量的是绝对数值，不是「不为 none」
    ok(press.scale < 1, '★ 按下时真的缩小了（scale < 1，量到的是绝对数值）',
      ` → 立刻 ${press.tfImmediate} → 稳定后 ${press.tfSettled}（scale=${press.scale}）`);
  }

  // 负对照：无障碍「减少动态效果」时，按压位移必须被取消
  //   —— 本机默认不开，所以这条只能验「样式表里确实写了这段兜底」
  //
  // ⚠ 必须把所有 prefers-reduced-motion 块**合起来**看，不能只看第一个。
  //   第一版是 `return`（遇到第一个就收工），后来 v4 批次 3 给进度条加了第二个
  //   reduced-motion 块（只管 transition），排在前面 —— 于是这条断言当场假失败。
  //   ★ 教训：**「找第一条就返回」的检查，在别人往同一个选择器上加规则时会烂掉。**
  //     凡是要断言「样式表里有某条规则」，都该把命中的块拼起来再判。
  const a11y = await sw.webContents.executeJavaScript(`(() => {
    const blocks = [];
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion/.test(r.conditionText || '')) {
          blocks.push(r.cssText || '');
        }
      }
    }
    const all = blocks.join('\\n');
    return {
      found: blocks.length > 0,
      count: blocks.length,
      killsTransform: /transform:\\s*none/.test(all),
      hasFade: /picker-fade|opacity/.test(all),
      mentionsPressing: /pressing/.test(all),
    };
  })()`);
  ok(a11y.found === true, '★ 样式表里有 prefers-reduced-motion 兜底块',
    ` → 找到 ${a11y.count} 块（要合起来看，不能只看第一块）`);
  if (a11y.found) {
    ok(a11y.killsTransform === true, '★ 负对照：「减少动态效果」时位移被取消（transform:none）',
      ` → 命中 ${a11y.count} 块`);
    ok(a11y.hasFade === true, '★ 但保留了透明度变化（反馈不能消失，只是变温和）');
    ok(a11y.mentionsPressing === true, '★ 负对照：JS 加的 .pressing 也在取消名单里（否则那条路会漏）');
  }

  log('⑧b⁗ 选「25 分钟」');
  const preset = await sw.webContents.executeJavaScript(`(async () => {
    const b = [...document.querySelectorAll('#focus-presets button')]
      .find((x) => x.dataset.minutes === '25');
    if (!b) return { missing: true };
    b.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      on: [...document.querySelectorAll('#focus-presets button.on')].map((x) => x.dataset.minutes),
    };
  })()`);
  if (preset.missing) {
    ok(false, '★ 预设按钮里没有「25 分钟」');
  } else {
    ok(preset.on.includes('25'), '★ 点「25 分钟」后它高亮选中了', ` → 选中 ${JSON.stringify(preset.on)}`);
    ok(focus.state().lastMinutes === 25, '★ 主进程那边 lastMinutes === 25', ` → ${focus.state().lastMinutes}`);
  }

  log('⑧b⁵ 开始专注（25 分钟）');
  const started = await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-focus-start').click();
    await new Promise((r) => setTimeout(r, 600));
    return {
      runningShown: !document.getElementById('focus-running').classList.contains('hidden'),
      idleHidden: document.getElementById('focus-idle').classList.contains('hidden'),
      countdown: document.getElementById('focus-countdown').textContent.trim(),
    };
  })()`);
  const st1 = focus.state();
  ok(!!st1.session && st1.session.state === 'running', '★ 主进程那边真的开始了一个会话',
    ` → ${st1.session ? st1.session.state : 'null'}`);
  {
    const wantEnd = Date.now() + 25 * 60 * 1000;
    const diff = st1.session ? Math.abs(st1.session.endsAt - wantEnd) : Infinity;
    ok(diff < 5000, '★ 结束时刻约等于「现在 + 25 分钟」',
      ` → 差 ${Number.isFinite(diff) ? Math.round(diff / 1000) : '?'} 秒`);
  }
  ok(started.runningShown === true && started.idleHidden === true, '界面上切到了倒计时的样子');
  ok(/^2[45]:\d{2}$/.test(started.countdown), '倒计时数字显示出来了（25:00 上下）',
    ` → “${started.countdown}”`);
  {
    const ring = await sw.webContents.executeJavaScript(`(() => {
      const fg = document.getElementById('focus-ring-fg');
      return { dash: fg.style.strokeDasharray, offset: fg.style.strokeDashoffset };
    })()`);
    ok(!!ring.dash && !!ring.offset, '★ 进度环也画出来了（dasharray / offset 都设上了）',
      ` → dash=${ring.dash} offset=${ring.offset}`);
  }

  // ★ 负对照：专注进行中改黑名单 → 必须被拒（防止「开着专注偷偷把自己放出来」）
  log('⑧b⁶ ★ 负对照：专注进行中改黑名单 → 被拒');
  const lockedChange = await sw.webContents.executeJavaScript(`(async () => {
    const err = document.getElementById('focus-error');
    err.classList.add('hidden');
    const input = document.getElementById('f-domain-input');
    input.value = 'zhihu.com';
    document.getElementById('btn-add-domain').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      errorShown: !err.classList.contains('hidden'),
      errorText: err.textContent,
    };
  })()`);
  ok(lockedChange.errorShown === true, '界面提示了「专注中不能改」', ` → “${lockedChange.errorText}”`);
  ok(!focus.state().domains.includes('zhihu.com'), '★ 主进程那边的名单没变（专注期间锁住了）',
    ` → ${JSON.stringify(focus.state().domains)}`);
  // ★ 负对照：专注中再点一次「开始专注」→ 不许重置计时（endsAt 不能变）
  log('⑧b⁷ ★ 负对照：专注中再点一次「开始专注」→ 不重置计时');
  const endsBefore = focus.state().session.endsAt;
  await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-focus-start').click();
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  ok(focus.state().session && focus.state().session.endsAt === endsBefore,
    '★ 结束时刻没被重置（没有「再点一次就重新计时」）',
    ` → ${endsBefore} → ${focus.state().session && focus.state().session.endsAt}`);

  log('⑧b⁸ 收尾：结束专注、清空名单、回到日程列表');
  focus.stop('selftest-cleanup');
  focus.setBlacklist({ domains: [], exes: [] });
  // v4 批次 3-c：回列表改走**侧边栏**（原来那一页上的「← 返回日程」已经删了）
  const backToList = await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-list').click();
    await new Promise((r) => setTimeout(r, 600));
    return {
      focusHidden: document.getElementById('focus-page').classList.contains('hidden'),
      listShown: !document.querySelector('.list-wrap').classList.contains('hidden'),
      listNavCurrent: document.getElementById('btn-list').getAttribute('aria-current'),
    };
  })()`);
  ok(backToList.focusHidden === true && backToList.listShown === true,
    '点侧边栏「日程」回到了列表');
  ok(backToList.listNavCurrent === 'page', '★ 侧边栏高亮也跟着回到「日程」',
    ` → aria-current=${backToList.listNavCurrent}`);
  ok(focus.state().session === null && focus.state().domains.length === 0,
    '★ 收尾后没有残留的专注会话 / 黑名单');

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
  //   原因见上面 petRect0 的注释：lowerPet/restorePet 用的 setAlwaysOnTop
  //   在某些缩放下会连带挪窗口。位置是主人自己拖出来的，不该被程序悄悄改掉。
  const petAfter = win.getBounds();
  ok(petAfter.x === petRect0.x && petAfter.y === petRect0.y,
    '★ 开关设置窗口的全过程中，桌宠位置都没有被挪动（回到最初的位置）',
    ` → ${petRect0.x},${petRect0.y} → ${petAfter.x},${petAfter.y}`);

  finishExitTest(pass, fail, '日程管理窗口');
}

// ---------- 生命周期 ----------

// 桌面上的「停止桌宠」快捷方式就是再启动一次自己、带上这个参数：
// 已经开着的那个实例会在 second-instance 里收到它，然后优雅退出。
//
// 为什么不直接在快捷方式里写 taskkill：
//   1. taskkill /IM electron.exe 会把机器上**所有** electron 程序一起杀掉
//      （以后装了别的基于 Electron 的软件就会误伤）；
//   2. 强杀不给程序收尾的机会（HANDOFF 硬性约定：专注模式改过 hosts 要能还原）；
//   3. 走「第二实例通知第一实例」这条路，退出流程和点托盘菜单里的「退出」完全一样。
//
// 参数名特意起得跟 Chromium 自带开关不冲突，免得被浏览器层吃掉。
const QUIT_FLAG = '--pet-quit';

// 托盘软件的标准做法：只允许开一个实例，重复启动就把已有窗口唤出来
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已经有实例在跑。我们要么是「再点了一次启动」（对方会把它唤出来），
  // 要么是「点了停止桌宠」（对方会退出）——不管哪种，自己都不该继续待着。
  app.quit();
} else if (process.argv.includes(QUIT_FLAG)) {
  // 拿到了锁说明本来就没在跑，而主人点的是「停止桌宠」——没东西可停，安静退出。
  // 注意要在 createWindow() 之前判断，否则会先闪一下窗口再消失。
  log('收到「停止桌宠」，但桌宠本来就没在运行，直接退出');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(QUIT_FLAG)) {
      log('收到「停止桌宠」指令，优雅退出');
      app.quit();
      return;
    }
    // 普通重复启动：把已有窗口唤出来
    showPet();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // 阶段 2-3：提醒呈现。气泡窗口 + 桌宠表演 + 系统通知兜底都在这里面，
    // 这里只把「桌宠窗口在哪」告诉它（它自己拿不到）。
    reminder.init({ getPetWindow: () => win });

    // 阶段 3·Task 9：拦截提示窗口 —— 贴着桌宠弹一张小卡片，让主人**看见并做选择**
    //   （安全 DNS 开着时提醒「专注可能没用」；拦下东西时也可以在这里露个面）。
    //   ★ 它和气泡窗口正好相反：气泡 focusable:false + showInactive()（不打断打字），
    //     这个窗口 focusable:true + show()+focus()（就是要主人看见并点）。
    //   ★ onChoose：选「先去关掉」= 这趟专注没意义（hosts 屏蔽被安全 DNS 绕过），停掉并还原。
    focusNotice.init({
      getPetWindow: () => win,
      onChoose: (which) => {
        if (which === 'secondary') {
          try { focus.stop('doh-dismiss'); } catch (err) { console.error('[main] 关掉专注失败：', err && err.message); }
        }
        // primary（仍要开始）：什么都不做，专注继续。
      },
    });

    // 阶段 2-4：日程管理窗口（按需打开，不占内存）。
    // 「预览提醒效果」按钮直接复用提醒呈现那套，看到的和真到点时一模一样。
    settingsWindow.init({
      onPreview: () => reminder.present({ title: '开会（预览效果）' }, new Date()),
      // 设置窗口打开期间要临时把桌宠降到普通层级，否则桌宠会压住设置窗口
      getPetWindow: () => win,
      // 聊天条也要跟着降层，否则设置窗口会被聊天条压住一块
      getChatWindow: () => chatWindow.getWindow(),
    });

    // Task 11：聊天条窗口
    chatWindow.init({ getPetWindow: () => win });

    // 阶段 3：专注模式主控。
    //   Task 4-5：计时 + 配置 + 宠物陪伴（不碰系统）
    //   Task 6-7：提权助手 + 真的改 hosts 挡网站
    // 会话状态一变就广播一声 —— Task 5 的宠物陪伴会接在这里换姿态、说话。
    //
    // ⚠ 自检（--selftest）时切到「沙箱」：hosts 指向 userData 里的假文件、且不提权。
    //   自检绝不能弹 UAC、绝不能碰主人的真实 hosts —— 否则自检本身就变成危险操作了。
    const focusSandbox = !!process.env.PET_SELFTEST;
    focus.init({
      elevate: !focusSandbox,
      hostsPath: focusSandbox ? path.join(app.getPath('userData'), 'selftest-hosts') : undefined,
      // 开始 / 结束：换姿态、说话
      onChange: (st) => {
        const wasRunning = petFocusRunning;
        petFocusRunning = st.running;
        console.log(`[main] 专注状态变化：${st.running ? `进行中（还剩 ${Math.round(st.remainingMs / 1000)} 秒）` : '未专注'}`);
        if (st.running && !wasRunning) notifyPetFocus('start');
        else if (!st.running && wasRunning) notifyPetFocus('end');
      },
      // 每 5 秒一次的心跳：让桌宠把剩余时间角标校正过来
      onTick: () => notifyPetFocus('tick'),
      // Task 9：刚拦下一个分心软件 → 让桌宠说一句（只在数量变多时才触发）
      onBlocked: (info) => notifyPetBlocked(info),
    });

    // 启动兜底：上次专注没正常结束的话，hosts 里可能还留着指向 0.0.0.0 的块，
    // 主人的网站会一直打不开，而且没有任何人会来收拾。
    //
    // ⚠ 这一步**可能弹一次 UAC**（只在真检测到残留时才会），所以延后几秒 ——
    //   等桌宠窗口先显示出来，别让主人开机就看到一个莫名其妙的提权弹窗。
    //   失败也不影响启动（recoverIfDirty 内部已经全包了 try/catch）。
    setTimeout(() => {
      focus.recoverIfDirty().catch(() => { });
    }, 4000);

    // 开发便利：启动时直接把日程管理窗口开出来，方便做视觉验收 / 截图。
    //   PET_OPEN_SETTINGS=1     → 开在「列表」
    //   PET_OPEN_SETTINGS=focus → 直接开在「专注」页
    //   PET_OPEN_SETTINGS=week  → 直接开在「周视图」
    if (!app.isPackaged && process.env.PET_OPEN_SETTINGS) {
      const m = process.env.PET_OPEN_SETTINGS === '1' ? 'list' : process.env.PET_OPEN_SETTINGS;
      setTimeout(() => settingsWindow.open(m), 2500);
    }
    // 开发便利：启动时直接打开聊天条
    //   PET_OPEN_CHAT=1 npm start -- --no-gpu
    if (!app.isPackaged && process.env.PET_OPEN_CHAT === '1') {
      setTimeout(() => chatWindow.open(), 2800);
    }
    // 开发便利：启动时直接弹一张「拦截提示」卡片，方便视觉验收 / 截图。
    //   PET_OPEN_NOTICE=1 npm start -- --no-gpu
    if (!app.isPackaged && process.env.PET_OPEN_NOTICE === '1') {
      setTimeout(() => {
        focusNotice.notify({
          kind: 'warn',
          head: '专注可能没用',
          title: '检测到「安全 DNS」是开着的',
          message: 'Chrome / Edge 开着安全 DNS 时会绕过 hosts 屏蔽，网站可能照样能打开。\n先去浏览器设置里把它关掉，专注才真的挡得住。',
          primaryLabel: '仍要开始',
          secondaryLabel: '先去关掉',
        }).catch(() => { });
      }, 3000);
    }

    // 开发便利：启动时直接打开「已安装软件选择器」，方便视觉验收 / 截图。
    //   PET_OPEN_PICKER=1 npm start -- --no-gpu
    // ⚠ 只给开发用（打包后无效），且只是「帮主人点两下按钮」，不改任何数据。
    if (!app.isPackaged && process.env.PET_OPEN_PICKER === '1') {
      setTimeout(async () => {
        try {
          const win = settingsWindow.open('focus');
          if (!win) return;
          win.webContents.once('did-finish-load', () => {
            win.webContents.executeJavaScript(`(async () => {
              document.getElementById('btn-browse-apps').click();      // 打开选择器
            })()`).catch(() => { });
            // 顺便把窗口自己截一张存下来（比抓整个桌面可靠：不会被前台锁定挡住）
            setTimeout(async () => {
              try {
                const img = await win.webContents.capturePage();
                const fs = require('fs');
                const path = require('path');
                const out = path.join(__dirname, '..', '..', 'tmp', 'v4-picker.png');
                fs.writeFileSync(out, img.toPNG());
                console.log('[main] 选择器截图已存：', out);
              } catch (e) {
                console.error('[main] 截图失败：', e && e.message);
              }
            }, 6000);
          });
        } catch (err) {
          console.error('[main] 自动打开软件选择器失败：', err && err.message);
        }
      }, 3000);
    }

    // 开发便利：把设置窗口的三个页面各截一张（v4 批次 2 视觉验收用）。
    //   PET_SHOT_PAGES=1 npm start -- --no-gpu
    // ⚠ 纯截图，不改任何数据；文件名带 pages- 前缀，和单张的选择器截图区分开。
    //
    // ⚠⚠ 踩过的坑：一开始连着调三次 `settingsWindow.open(mode)` 就截，
    //    结果三张图**字节数完全一样**（23130）—— 因为 `open()` 在窗口已存在时
    //    直接 `return win`，**根本不看 startMode**，所以三张都是「列表」页。
    //    「三张图一样大」就是最好的报警信号；现在改成：切模式 → 轮询确认界面真的换了 → 再截。
    if (!app.isPackaged && process.env.PET_SHOT_PAGES === '1') {
      setTimeout(async () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', '..', 'tmp');
        const win = settingsWindow.open('list');
        if (!win) return;
        // 先等第一页渲染完
        await new Promise((r) => {
          if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r);
          else r();
        });
        const sizes = [];
        const shoot = async (mode, name) => {
          try {
            // 走真正的切换通道（和用户点按钮同一条路），不要靠 open() 的 startMode
            settingsWindow.setMode(mode);
            // 轮询等界面切过去（比死等一个固定毫秒数可靠）
            const deadline = Date.now() + 5000;
            let switched = false;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 200));
              const cur = await win.webContents.executeJavaScript(`(() => {
                const vis = (id) => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden'); };
                return { week: vis('week'), focus: vis('focus-page') };
              })()`).catch(() => null);
              if (!cur) continue;
              const want = mode === 'week' ? cur.week : mode === 'focus' ? cur.focus : (!cur.week && !cur.focus);
              if (want) { switched = true; break; }
            }
            await new Promise((r) => setTimeout(r, 500)); // 让过渡走完
            const img = await win.webContents.capturePage();
            const buf = img.toPNG();
            sizes.push(buf.length);
            fs.writeFileSync(path.join(dir, name), buf);
            console.log(`[main] 截图已存：${name}（${buf.length} 字节${switched ? '' : ' ⚠ 界面可能没切过去'}）`);
          } catch (e) {
            console.error(`[main] 截 ${mode} 失败：`, e && e.message);
          }
        };
        await shoot('list', 'v4-pages-list.png');
        await shoot('week', 'v4-pages-week.png');
        await shoot('focus', 'v4-pages-focus.png');
        // 三张一样大 = 没切成功，明确喊出来，别让主人对着一张假图验收
        const uniq = new Set(sizes);
        if (sizes.length === 3 && uniq.size < 3) {
          console.error(`[main] ⚠⚠ 三页截图有重复（字节数 ${sizes.join('/')}），说明模式没切过去！`);
        }
        console.log('[main] 三页截图完成');
      }, 3000);
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
