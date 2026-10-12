// src/renderer/pet/renderer.js
// 桌宠界面（浏览器世界，碰不到系统；要操作系统一律走 window.petAPI → 主进程）。
//
// 这一版干四件事：
//   1. 用 PIXI 6 + pixi-live2d-display 把 Live2D 模型画在透明画布上
//   2. 量出角色的真实范围，自动缩放贴合窗口
//   3. 动态鼠标穿透：鼠标压在角色身上才接住，否则放鼠标穿过去点桌面
//   4. 拖拽移动（手动实现，不用 -webkit-app-region，因为要保留点击检测）
//
// 关于第 2 条为什么麻烦：
//   Live2D 模型自带的是 4068×4068 的正方形画布，角色只占其中一小块（实测约 36% 是空的）。
//   照着这个方框摆窗口，窗口会比角色大一大圈，鼠标穿透的判定范围也跟着虚胖。
//   所以必须实测角色边界。但只量「启动那一瞬间」也不行 ——
//   待机动作会让她甩尾巴、抬头，实测能超出首帧边界 20 多像素。
//   做法：采样一整个待机循环（4 秒）取并集，量完把结果缓存到磁盘，下次启动直接用。

// ---------- 配置 ----------

const MODEL_URL = './model/c_0120.model3.json';
const MODEL_KEY = 'c_0120'; // 缓存用的键；换模型要改

const FPS_CAP = 30;         // 桌宠不需要 60 帧，砍一半省电
const MAX_DPR = 1.5;        // 高分屏渲染倍率上限，再高是白烧性能
const FIT_MARGIN = 0.03;    // 校准完成后角色四周留白（校准准了就不用留太多）
const SAFE_MARGIN = 0.12;   // 校准完成前先用的保守留白，防止首帧就被切
const BOTTOM_PAD = 0.02;    // 底部额外留白（别贴着窗口底边）
const CALIBRATE_MS = 4300;  // 采样时长，要盖过一个完整的待机循环（idle 动作是 4 秒）

// 判定「鼠标压在角色身上」的 alpha 阈值（0-255）。
// 用两个阈值做迟滞，不是矫情：角色一直在动（呼吸、甩尾巴），
// 鼠标停在她轮廓边不动时，边缘会反复扫过鼠标，单阈值会导致穿透疯狂开关。
const ALPHA_ENTER = 28;  // 想「接住鼠标」要够实
const ALPHA_LEAVE = 8;   // 想「放行鼠标」要够空
const HIT_THROTTLE_MS = 25;

// 量角色边界 / 查边缘用的阈值：只要不是全透明就算「有内容」
const ALPHA_MASK = 12;

// 点一下换一个表情
const EXPRESSIONS = ['爱心眼', '星星眼', '脸红', '吐舌', '调皮', '晕晕', '开心兴奋', '流汗', '墨镜', '猫猫贴纸', '鲸鱼'];

// ---------- 小工具 ----------

const hint = document.getElementById('hint');
const log = (m) => console.log('[pet] ' + m);

function setHint(text, isError = false) {
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('error', isError);
}
function hideHint() {
  if (hint) hint.classList.add('gone');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 拖拽性能探针 ----------
// 起因：「拖动窗口时人物卡顿抽搐」。
// 这种毛病肉眼说不清，得量。用 requestAnimationFrame 记录帧间隔 ——
// 拖拽期间如果帧间隔明显变大，说明主进程搬窗口搬得太频繁，把渲染挤掉了；
// 如果帧间隔正常，那卡顿就不是掉帧，得往别处查（比如角色视线跟着窗口抖）。
// 只统计「拖拽期间」的样本，平时不占开销。
const frameGap = { on: false, last: performance.now(), samples: [] };

(function frameGapTick() {
  const now = performance.now();
  const gap = now - frameGap.last;
  frameGap.last = now;
  if (frameGap.on) frameGap.samples.push(gap);
  requestAnimationFrame(frameGapTick);
})();

function frameGapStats(samples = frameGap.samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    med: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    // 30fps 的基准间隔是 33.3ms，超过 50ms 就算肉眼可见的掉帧
    over50: samples.filter((g) => g > 50).length,
  };
}

// ---------- 退出按钮 ----------
// 走的是和托盘菜单「退出桌宠」同一条通道（pet:quit），主进程收到后真退出。
// 渲染进程不碰系统，只负责把「用户点了退出」这件事报上去（硬性约定第 1 条）。
function setupExitButton() {
  const btn = document.getElementById('btn-exit');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    log('点了退出按钮');
    if (window.petAPI && window.petAPI.quit) window.petAPI.quit();
  });
}

// ---------- 日程提醒：角色的「表演」 ----------
// 日程到点时主进程会推一个事件过来，让角色动一下。
//
// 为什么光有气泡不够：气泡是安静的，主人正埋头干活时很容易错过；
// 角色突然换个表情、放个有明显动作的姿势，眼角余光就能扫到 —— 这是桌宠提醒的天然优势。
//
// 两个细节：
//   ① 表演期间把视线跟随摘掉。不然放动作时头还在追鼠标，看着很精神分裂。
//      和拖拽用的是同一招（见 setupInteractions 里的 setGazeFollowing 注释）。
//   ② 表演完必须恢复，否则「招牌动作」就永久丢了。
const REMINDER_EXPRESSION = '星星眼';
const REMINDER_MOTION = 'splash'; // 有大幅度肢体动作的，比 idle 里的小动作显眼
const REMINDER_HOLD_MS = 4000;    // 表情保持 4 秒再收回

let reminderHits = 0;             // 自检用：到底收到几次提醒（不是「我发了」，是「它收到了」）
let reminderRestoreTimer = null;

function playReminderReaction(model) {
  reminderHits++;

  try {
    model.autoInteract = false;
    model.unregisterInteraction();
  } catch { /* 库内部结构变了也不能让提醒崩掉 */ }

  try { model.expression(REMINDER_EXPRESSION).catch(() => {}); } catch { /* 忽略 */ }
  try { model.motion(REMINDER_MOTION).catch(() => {}); } catch { /* 动作组不存在就只留表情 */ }

  log(`日程提醒 → 表演「${REMINDER_EXPRESSION}」+ 动作「${REMINDER_MOTION}」`);

  clearTimeout(reminderRestoreTimer);
  reminderRestoreTimer = setTimeout(() => {
    // 恢复视线跟随：把 autoInteract 设回 true，下一帧库会自己把监听挂回去
    try { model.autoInteract = true; } catch { /* 忽略 */ }
    try {
      const em = model.internalModel.motionManager.expressionManager;
      if (em && typeof em.resetExpression === 'function') em.resetExpression();
    } catch { /* 忽略 */ }
    log('提醒表演结束，恢复常态');
  }, REMINDER_HOLD_MS);
}

// 接主进程推来的提醒事件
function setupReminder(model) {
  if (!window.petAPI || !window.petAPI.onReminder) return;
  window.petAPI.onReminder((payload) => {
    log(`收到提醒：${payload && payload.title}（${payload && payload.time}）`);
    playReminderReaction(model);
  });
}

// ---------- 主流程 ----------

(async () => {
  try {
    // ===== 1. 运行时自检 =====
    if (!window.PIXI) throw new Error('PIXI 没加载起来');
    if (typeof Live2DCubismCore === 'undefined') throw new Error('Live2D Cubism Core 没加载起来');
    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) throw new Error('pixi-live2d-display 没挂到 PIXI.live2d 上');
    log(`PIXI ${PIXI.VERSION} · Cubism Core 已就绪 · pixi-live2d-display 已就绪`);

    const { Live2DModel } = PIXI.live2d;
    Live2DModel.registerTicker(PIXI.Ticker);

    // ===== 2. 建 PIXI 应用（透明背景） =====
    const stageEl = document.getElementById('stage');
    const app = new PIXI.Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,           // 关键：背景完全透明
      antialias: true,
      autoDensity: true,
      preserveDrawingBuffer: true,  // 关键：读像素做命中判定和裁切校准要用
      resolution: Math.min(window.devicePixelRatio || 1, MAX_DPR),
      powerPreference: 'low-power',
    });
    app.ticker.maxFPS = FPS_CAP;
    stageEl.appendChild(app.view);
    log(`画布 ${app.view.width}×${app.view.height}（CSS ${window.innerWidth}×${window.innerHeight}，倍率 ${app.renderer.resolution}）`);

    // ===== 3. 加载模型 =====
    const t0 = performance.now();
    const model = await Live2DModel.from(MODEL_URL, {
      autoInteract: true,   // 眼睛跟着鼠标转，桌宠的招牌动作
      autoUpdate: true,
      idleMotionGroup: 'idle',
    });
    log(`模型加载完成，耗时 ${Math.round(performance.now() - t0)}ms`);
    app.stage.addChild(model);

    // ===== 4. 量角色真实范围并贴合窗口 =====
    await setupFit(app, model);

    // ===== 5. 交互 =====
    const interactions = setupInteractions(app, model);
    setupExitButton();
    setupReminder(model);

    // ===== 6. 启动后盯一会儿边缘，确认动作没把角色顶出窗口 =====
    watchEdges(app);

    hideHint();

    // 给开发自检用的出口（主进程用 executeJavaScript 跑检查时会用到）。
    // 只是把本地对象挂出来，不增加任何权限。
    window.__petDebug = {
      app, model, measureLocalBounds, edgeHits, EXPRESSIONS, frameGap, frameGapStats,
      hitState: interactions.getHitState, // 自检用：看穿透判定和鼠标压在哪
      // 自检用：某个坐标上的画布 alpha（判断「这里是不是角色本体」）
      hitTestPoint: (x, y) => {
        const a = interactions.alphaAt(x, y);
        return { alpha: a, overPet: a > ALPHA_ENTER };
      },
      // 自检用：提醒到底收到几次（收到 ≠ 发出，见 HANDOFF 第六节第 19 条）
      reminder: {
        hits: () => reminderHits,
        reset: () => { reminderHits = 0; },
      },
    };

    log('就绪');
  } catch (err) {
    log('✗ 启动失败: ' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) console.log('[pet] stack: ' + err.stack);
    setHint('桌宠启动失败：' + (err && err.message ? err.message : err), true);
  }
})();

// ---------- 裁切与贴合 ----------

async function setupFit(app, model) {
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const internal = model.internalModel;
  const baseBox = Math.max(internal.originalWidth, internal.originalHeight);

  // 探测倍率：缩得足够小，保证角色整个落在画布内。
  // 否则量到的是「被画布裁过的边界」，会越量越小。
  const probeScale = (Math.min(viewW, viewH) * 0.55) / baseBox;
  model.scale.set(probeScale);
  model.x = (viewW - internal.originalWidth * probeScale) / 2;
  model.y = (viewH - internal.originalHeight * probeScale) / 2;
  app.renderer.render(app.stage);

  const first = measureLocalBounds(app, model);
  if (!first) throw new Error('画布上一个不透明像素都没有，模型可能没画出来');
  log(`首帧角色本地尺寸 ${fmt(first)}`);

  // 4a. 有缓存就直接用 —— 这是常态路径，启动是即时的
  const cached = await getCachedBounds();
  if (cached) {
    applyFit(app, model, cached, FIT_MARGIN);
    log(`用缓存校准结果贴合（${fmt(cached)}）`);
    return;
  }

  // 4b. 没缓存：先用保守留白把角色显示出来，别让用户干等
  applyFit(app, model, first, SAFE_MARGIN);
  setHint('首次运行：正在校准角色尺寸…');
  log(`首次运行，开始采样 ${(CALIBRATE_MS / 1000).toFixed(1)} 秒（覆盖一个完整待机循环）`);

  // 4c. 采样一整个待机循环取并集
  const union = await sampleUnion(app, model, first, CALIBRATE_MS);
  log(`校准完成，角色本地尺寸 ${fmt(union)}（比首帧宽 ${Math.round((union.x1 - union.x0) / (first.x1 - first.x0) * 100 - 100)}%，高 ${Math.round((union.y1 - union.y0) / (first.y1 - first.y0) * 100 - 100)}%）`);

  // 4d. 按校准结果重新贴合（平滑过渡，别硬跳）
  animateFit(app, model, union, FIT_MARGIN, 500);
  saveCachedBounds(union);
  log('校准结果已缓存，下次启动就是即时贴合');
}

// 把模型本地坐标范围贴合到窗口里
function computeFit(model, viewW, viewH, b, margin) {
  const cw = b.x1 - b.x0;
  const ch = b.y1 - b.y0;
  const scale = Math.min((viewW * (1 - margin * 2)) / cw, (viewH * (1 - margin * 2)) / ch);
  return {
    scale,
    x: (viewW - cw * scale) / 2 - b.x0 * scale,
    y: viewH - ch * scale - b.y0 * scale - viewH * BOTTOM_PAD,
  };
}

function applyFit(app, model, b, margin) {
  const t = computeFit(model, window.innerWidth, window.innerHeight, b, margin);
  model.scale.set(t.scale);
  model.x = t.x;
  model.y = t.y;
  app.renderer.render(app.stage);
  log(`贴合：缩放 ${t.scale.toFixed(4)} → 角色显示 ${Math.round((b.x1 - b.x0) * t.scale)}×${Math.round((b.y1 - b.y0) * t.scale)}（窗口 ${window.innerWidth}×${window.innerHeight}）`);
}

// 平滑地从当前姿态过渡到目标姿态
function animateFit(app, model, b, margin, ms) {
  const target = computeFit(model, window.innerWidth, window.innerHeight, b, margin);
  const from = { scale: model.scale.x, x: model.x, y: model.y };
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
    model.scale.set(from.scale + (target.scale - from.scale) * e);
    model.x = from.x + (target.x - from.x) * e;
    model.y = from.y + (target.y - from.y) * e;
    if (k >= 1) app.ticker.remove(tick);
  };
  app.ticker.add(tick);
}

// 采样一段时间，取角色范围的并集（返回模型本地坐标）
async function sampleUnion(app, model, seed, durationMs) {
  let u = { ...seed };
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < durationMs) {
    await sleep(110);
    const b = measureLocalBounds(app, model);
    if (!b) continue;
    n++;
    u = {
      x0: Math.min(u.x0, b.x0),
      x1: Math.max(u.x1, b.x1),
      y0: Math.min(u.y0, b.y0),
      y1: Math.max(u.y1, b.y1),
    };
  }
  log(`采样了 ${n} 帧`);
  return u;
}

// 读画布 alpha 通道，量出角色范围并换算成模型本地坐标
function measureLocalBounds(app, model) {
  const gl = app.renderer.gl;
  const res = app.renderer.resolution;
  const W = app.view.width;   // 绘图缓冲尺寸（已含倍率）
  const H = app.view.height;

  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  let x0 = W, x1 = -1, glBottom = H, glTop = -1;
  const step = 2; // 隔点采样，够精确
  for (let gy = 0; gy < H; gy += step) {
    const row = gy * W * 4;
    for (let x = 0; x < W; x += step) {
      if (buf[row + x * 4 + 3] > ALPHA_MASK) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (gy < glBottom) glBottom = gy;
        if (gy > glTop) glTop = gy;
      }
    }
  }
  if (x1 < 0) return null;

  // WebGL 的 y 轴朝上，先转成屏幕坐标（y 朝下），再换算回模型本地坐标
  const s = model.scale.x;
  return {
    x0: (x0 / res - model.x) / s,
    x1: ((x1 + 1) / res - model.x) / s,
    y0: ((H - 1 - glTop) / res - model.y) / s,
    y1: ((H - glBottom) / res - model.y) / s,
  };
}

const fmt = (b) => `${Math.round(b.x1 - b.x0)}×${Math.round(b.y1 - b.y0)}`;

// ---------- 校准缓存的读写 ----------

async function getCachedBounds() {
  try {
    if (!window.petAPI || !window.petAPI.getBounds) return null;
    const b = await window.petAPI.getBounds(MODEL_KEY);
    if (b && [b.x0, b.x1, b.y0, b.y1].every(Number.isFinite)) return b;
    return null;
  } catch {
    return null;
  }
}

function saveCachedBounds(b) {
  try {
    if (window.petAPI && window.petAPI.saveBounds) window.petAPI.saveBounds(MODEL_KEY, b);
  } catch { /* 存不上也无所谓，下次再量一遍 */ }
}

// ---------- 边缘检测 ----------
// 读画布最外圈那一圈像素，如果有不透明的，说明角色被窗口切了。
// 这是「自动裁切准不准」唯一的客观证据，留着当回归哨兵。

function edgeHits(app) {
  const gl = app.renderer.gl;
  const W = app.view.width;
  const H = app.view.height;
  const row = new Uint8Array(W * 4);
  const col = new Uint8Array(H * 4);
  const anyOpaque = (buf) => {
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > ALPHA_MASK) return true;
    return false;
  };

  const hits = [];
  gl.readPixels(0, H - 1, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, row); // 顶边（GL 的 y 朝上）
  if (anyOpaque(row)) hits.push('顶');
  gl.readPixels(0, 0, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, row); // 底边
  if (anyOpaque(row)) hits.push('底');
  gl.readPixels(0, 0, 1, H, gl.RGBA, gl.UNSIGNED_BYTE, col); // 左边
  if (anyOpaque(col)) hits.push('左');
  gl.readPixels(W - 1, 0, 1, H, gl.RGBA, gl.UNSIGNED_BYTE, col); // 右边
  if (anyOpaque(col)) hits.push('右');
  return hits;
}

function watchEdges(app) {
  const started = performance.now();
  const seen = new Set();
  const timer = setInterval(() => {
    for (const h of edgeHits(app)) {
      if (seen.has(h)) continue;
      seen.add(h);
      log(`⚠ 角色贴到窗口「${h}」边缘了 —— 校准留白不够，动作会被切`);
    }
    if (performance.now() - started > 15000) clearInterval(timer);
  }, 400);
}

// ---------- 鼠标交互：穿透 / 拖拽 / 点击 ----------

function setupInteractions(app, model) {
  let overPet = false;   // 鼠标当前是否压在角色身上
  let overUi = false;    // 鼠标当前是否压在界面控件上（退出按钮等）
  let dragging = false;
  let lastSent = null;   // 上一次下发的穿透状态，避免重复 IPC
  let lastHitAt = 0;
  let lastCell = '';     // 鼠标所在的粗网格，没换格子就不重复读像素
  let dragMoves = 0;     // 本次拖拽收到的 mousemove 次数（探针用）
  let dragStartAt = 0;

  // 读画布上某个 CSS 坐标处的 alpha 值
  function alphaAt(cssX, cssY) {
    const gl = app.renderer.gl;
    const res = app.renderer.resolution;
    const W = app.view.width;
    const H = app.view.height;
    const px = Math.round(cssX * res);
    const py = Math.round(H - 1 - cssY * res);
    if (px < 0 || py < 0 || px >= W || py >= H) return 0;
    const buf = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf[3];
  }

  function setThrough(through) {
    if (lastSent === through) return;
    lastSent = through;
    if (window.petAPI) window.petAPI.setClickThrough(through);
  }

  function refreshHit(e) {
    if (dragging) return; // 拖拽期间强制不穿透，否则窗口跟着鼠标跑、判定会抖

    const now = performance.now();
    if (now - lastHitAt < HIT_THROTTLE_MS) return;

    // 鼠标没换格子就不重复判定（读像素会强制 GPU 同步，能省则省）
    const cell = `${Math.floor(e.clientX / 8)},${Math.floor(e.clientY / 8)}`;
    if (cell === lastCell) return;
    lastCell = cell;
    lastHitAt = now;

    // ★ 先看鼠标是不是压在界面控件上（退出按钮等）。
    // 控件是 DOM 元素、不在 WebGL 画布上 —— 下面那个读像素的判定对它们永远是「空白」。
    // 不先判这一条，窗口会继续保持穿透，按钮就永远点不到（这是最容易漏的坑）。
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const ui = !!(el && el.closest('[data-ui]'));

    let hit = overPet;
    if (ui) {
      hit = true; // 压在控件上：无条件接住鼠标
    } else {
      const a = alphaAt(e.clientX, e.clientY);
      // 迟滞：进要够实，出要够空，中间地带维持原状
      if (!overPet && a > ALPHA_ENTER) hit = true;
      else if (overPet && a < ALPHA_LEAVE) hit = false;
    }

    if (hit === overPet && ui === overUi) return;
    overPet = hit;
    overUi = ui;
    document.body.style.cursor = ui ? 'pointer' : (hit ? 'grab' : 'default');
    setThrough(!hit);
  }

  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      dragMoves++;
      if (window.petAPI) window.petAPI.dragMove({ x: e.screenX, y: e.screenY });
      return;
    }
    refreshHit(e);
  });

  // 拖拽期间关掉「视线跟随」。
  //
  // 为什么必须关：pixi-live2d-display 的 onPointerMove 会把「鼠标在画布里的位置」
  // 直接喂给 model.focus()，角色的头/眼睛就跟着转（平时这是招牌动作）。
  // 但拖拽时是灾难 —— 鼠标在屏幕上几乎不动，窗口却在追着鼠标跑，
  // 于是鼠标在画布里的相对位置一直在抖，focus 目标跟着抖，**角色的头就一抽一抽的**。
  // 拖拽时用户的意图是「把宠物挪个地方」，不是「指着宠物看」，所以这里直接停掉。
  //
  // ⚠ 坑：不能只写 model.autoInteract = false。
  //   库里那个 setter 只管 pointertap（点击）监听，视线跟随是挂在
  //   _render() 里每帧调用的 registerInteraction() 上的（index.es.js:1305）。
  //   所以必须「先设标志、再手动 unregisterInteraction()」——
  //   顺序反了的话，下一帧 _render 又会把监听挂回来，等于白做。
  //   恢复时只要把 autoInteract 设回 true，下一帧 _render 会自动挂回去。
  function setGazeFollowing(on) {
    if (!model) return;
    try {
      model.autoInteract = on;
      if (!on) model.unregisterInteraction();
    } catch { /* 库内部结构变了，也不能让拖拽崩掉 */ }
  }

  // 拖拽结束后打一行统计 —— 这是「拖动卡顿」的客观证据。
  // 「mousemove 次数」很关键：现在每收到一次就请主进程搬一次窗口，
  // 所以这个数字 ≈ 这次拖拽让窗口动了多少次。数字越大越费。
  function reportDragStats(moved) {
    const ms = performance.now() - dragStartAt;
    const st = frameGapStats();
    const perSec = ms > 0 ? Math.round((dragMoves / ms) * 1000) : 0;
    if (!st) return log(`拖拽结束：位移 ${moved}px · 没采到帧数据`);
    log(
      `拖拽统计：mousemove ${dragMoves} 次 / ${Math.round(ms)}ms（≈${perSec} 次/秒，每次都会搬一次窗口）· ` +
      `帧间隔 中位 ${st.med.toFixed(1)}ms 最大 ${st.max.toFixed(1)}ms · 掉帧(>50ms) ${st.over50}/${st.n} · 位移 ${moved}px`
    );
  }

  let downAt = null;

  window.addEventListener('mousedown', (e) => {
    // 压在界面控件上（退出按钮等）不进入拖拽 —— 否则点按钮会变成拖窗口
    if (e.button !== 0 || !overPet || overUi) return;
    dragging = true;
    downAt = { x: e.screenX, y: e.screenY };
    lastCell = '';
    // 开始采集帧间隔
    dragMoves = 0;
    dragStartAt = performance.now();
    frameGap.samples = [];
    frameGap.on = true;
    // 拖拽期间别让角色的头跟着鼠标抖
    setGazeFollowing(false);
    document.body.style.cursor = 'grabbing';
    setThrough(false);
    if (window.petAPI) window.petAPI.dragStart({ x: e.screenX, y: e.screenY });
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    frameGap.on = false;
    // 松手，视线跟随恢复（下一帧库会自动挂回去）
    setGazeFollowing(true);
    document.body.style.cursor = overPet ? 'grab' : 'default';
    if (window.petAPI) window.petAPI.dragEnd();

    // 位移很小 = 点击（换表情），位移大 = 拖拽
    const moved = downAt ? Math.abs(e.screenX - downAt.x) + Math.abs(e.screenY - downAt.y) : 999;
    downAt = null;
    if (moved <= 6) reactToClick(model);

    reportDragStats(moved);

    // 松手后重新判一次，决定要不要恢复穿透
    lastCell = '';
    lastHitAt = 0;
    refreshHit(e);
  });

  // 右键：弹出和托盘一样的菜单
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!overPet || overUi || !window.petAPI) return;
    window.petAPI.showMenu();
  });

  // 初始状态：先设成穿透，免得程序刚起来就挡住桌面
  setThrough(true);

  // 自检：确认命中判定的坐标换算没写错。
  // 这里最容易错的是 WebGL 的 y 轴是反的，错了就会出现
  // 「鼠标在她头上时判定为不在她身上」这种诡异现象。
  setTimeout(() => {
    const b = model.getBounds(); // 舞台坐标下的角色范围
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const atCenter = alphaAt(cx, cy);
    const atCorner = alphaAt(3, 3);
    const atTopOfHead = alphaAt(cx, b.y + b.height * 0.15);
    log(`命中自检：角色中心 alpha=${atCenter}（应>0）· 头顶 alpha=${atTopOfHead}（应>0）· 左上角 alpha=${atCorner}（应为 0）`);
    if (atCenter <= ALPHA_MASK) log('⚠ 角色中心读不到像素，命中判定的坐标换算可能错了');
    if (atCorner > ALPHA_MASK) log('⚠ 左上角不该有像素，命中判定范围可能偏大');
  }, 800);

  log('交互已就绪（穿透 / 拖拽 / 点击换表情 / 右键菜单）');

  // 给自检用：看当前穿透判定状态（through = true 表示鼠标穿过去点桌面了）
  return {
    getHitState: () => ({ overPet, overUi, through: lastSent }),
    alphaAt, // 自检用：查某个坐标上的画布 alpha
  };
}

function reactToClick(model) {
  const name = EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)];
  try {
    model.expression(name).catch(() => { /* 个别表情不存在就忽略 */ });
    log(`点击 → 表情「${name}」`);
  } catch { /* 忽略 */ }
}
