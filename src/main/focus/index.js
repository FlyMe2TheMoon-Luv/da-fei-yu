// src/main/focus/index.js
// 专注模式主控 —— 把「配置」和「当前会话」收在一处，给界面和桌宠一个唯一真相来源。
//
// ── 它负责什么 ──
//   1. 读写配置（黑名单 / 时长预设），落 userData/focus.json
//   2. 管理当前专注会话（开始 / 结束 / 到点自动结束）
//   3. 会话状态变了，广播一声（Task 5 的宠物陪伴就靠它换姿态、说话）
//
// ── 为什么不让界面直接读写 focus.json ──
//   1. 「专注进行中不许改配置」这条规则必须**只有一处**执行 ——
//      否则界面能改、别的入口也能改，就锁不住了（Review Focus 第 4 条）。
//   2. 到点自动结束要靠一个**轮询**（界面可能关着、桌宠可能被最小化）。
//   3. 会话变化要通知桌宠，得有个统一的地方广播。
//
// ── 纯逻辑在哪 ──
//   黑名单规范化在 blacklist.js、计时在 timer.js、hosts 文本在 hosts.js ——
//   那三个刻意不 require('electron')，能脱离 Electron 单测。
//   本文件只做「编排 + 落盘」，require 了 ./store（它 require('electron')），
//   所以**别拿它写单测**。
//
// ── 第一段（Task 4-5）只做计时 + 配置，完全不碰系统 ──
// ── Task 6 起接上「提权助手」这一层（见 ./elevate.js）──
//   本文件现在负责：开始专注时发一个会话号 + 清信号文件；结束专注时写控制文件
//   请助手收工。**真正的拦截动作**（改 hosts、关软件）在 Task 7-8 接进来。
//   ⚠ 本文件只写「控制文件」，从不杀助手进程 —— 强杀它就没机会还原 hosts 了。

const store = require('./store');
const timer = require('./timer');
const { sanitizeBlacklist } = require('./blacklist');

// ⚠ 拿到的是**模块**，要 createElevator() 才是能用的实例 ——
//   require('./elevate') 本身只有工厂和纯函数，没有 startHelper / notifyStop。
const elevator = require('./elevate').createElevator();

// 每 5 秒查一次「到点了没有」。
// ⚠ 不用 setTimeout(到点时间) —— 电脑睡一觉 / 关机再开，setTimeout 会把事件丢掉，
//   专注就永远结束不了。这跟项目里「日程调度用轮询」是同一条硬约定。
const TICK_MS = 5000;

let onChange = null;   // 会话状态变了就喊一声（由 main.js 注入）
let onTick = null;     // 专注进行中每次轮询也喊一声（桌宠据此校正剩余时间）
let tickHandle = null;
let inited = false;

// ---------- 小工具 ----------

// 读一份干净的配置：store.read() 已过 withDefaults（补默认值 + 挡危险项），
// 永远返回一个对象，绝不返回 null。
function config() {
  return store.read();
}

function persist(cfg) {
  return store.write(cfg);
}

function emit() {
  if (typeof onChange !== 'function') return;
  try {
    onChange(state());
  } catch (err) {
    console.error('[focus] 通知会话变化失败：', err && err.message);
  }
}

// 专注进行中的「心跳」：每轮轮询喊一次，让桌宠把剩余时间角标校正过来。
// 和 emit() 分开，是因为它「开始 / 结束」才响一次，而这个是每 5 秒响一次。
function emitTick() {
  if (typeof onTick !== 'function') return;
  try {
    onTick(state());
  } catch (err) {
    console.error('[focus] 通知专注心跳失败：', err && err.message);
  }
}

// ---------- 对外：状态 ----------

// 给界面 / 桌宠看的全部信息（一次拿全，界面不用自己拼）
function state() {
  const cfg = config();
  const now = Date.now();
  const s = cfg.session;
  return {
    domains: cfg.domains,
    exes: cfg.exes,
    presets: cfg.presets,
    lastMinutes: cfg.lastMinutes,
    running: !!s,
    session: s,                                   // null 表示当前没在专注
    remainingMs: s ? timer.remainingMs(s, now) : 0,
    progressRatio: s ? timer.progressRatio(s, now) : 0,
    // 界面拿它画「按住别松手…还差几秒」，避免界面自己写死一个时长
    holdMs: timer.HOLD_MS,
  };
}

function isRunning() {
  return !!config().session;
}

// ---------- 对外：配置 ----------

// 保存整份黑名单。专注进行中一律拒绝（防止「开着专注偷偷把自己放出来」）。
function setBlacklist(raw) {
  if (isRunning()) return { ok: false, error: '专注中不能改，忍一下～' };

  const clean = sanitizeBlacklist(raw || {});
  if (!clean.ok) {
    const first = clean.rejected[0];
    return { ok: false, error: first ? first.error : '有些条目不合格' };
  }

  const cfg = config();
  cfg.domains = clean.domains;
  cfg.exes = clean.exes;
  persist(cfg);
  emit();
  return { ok: true, domains: clean.domains, exes: clean.exes };
}

// 记住「上次选了多久」。专注进行中同样拒绝。
function setPreset(minutes) {
  if (isRunning()) return { ok: false, error: '专注中不能改，忍一下～' };

  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > timer.MAX_MINUTES) {
    return { ok: false, error: `时长得是 1 到 ${timer.MAX_MINUTES} 之间的整数分钟` };
  }

  const cfg = config();
  cfg.lastMinutes = minutes;
  persist(cfg);
  return { ok: true, lastMinutes: minutes };
}

// ---------- 对外：会话 ----------

function start({ minutes } = {}) {
  const cfg = config();

  // 已经在专注 → 直接返回当前会话，**不重置计时**。
  // （「再点一次开始就重新计时」等于给了主人一个偷偷延长的口子，也把
  //   已经专注过的时间抹掉了。Task 5 的负对照④专门盯这个。）
  if (cfg.session) {
    return { ok: true, session: cfg.session, alreadyRunning: true };
  }

  // ★ 黑名单空着不许开始 —— 不能「专注了个寂寞」。
  //   一个都没挡，专注就没有任何意义，这时候拦住比放行更负责。
  if (!cfg.domains.length && !cfg.exes.length) {
    return { ok: false, error: '黑名单还是空的，先加一个要挡住的东西吧' };
  }

  const m = (Number.isFinite(minutes) && minutes > 0) ? Math.round(minutes) : cfg.lastMinutes;
  const session = timer.create({ minutes: m, now: Date.now() });

  // 会话号（Task 6）：提权助手靠它认领「这趟专注的收工信号」。
  // 顺手把两个信号文件清一遍 —— 控制文件标成「不许停」，心跳标成「还没听到」。
  session.sid = elevator.newSid();
  elevator.resetSignals(session.sid);

  cfg.session = session;
  cfg.lastMinutes = session.minutes;
  persist(cfg);

  startTick();
  console.log(`[focus] 专注开始：${session.minutes} 分钟（${cfg.domains.length} 个网站 / ${cfg.exes.length} 个软件）`);
  emit();
  return { ok: true, session };
}

function stop(reason = 'manual') {
  const cfg = config();
  if (!cfg.session) return { ok: true, alreadyStopped: true };

  const sid = cfg.session.sid || null;

  // 先请助手收工（写控制文件），再清会话。
  // ★ 绝不杀助手进程 —— 强杀它就没有还原 hosts 的机会了。
  //   写文件失败也不拦着结束：助手还有「到点自愈」这条兜底。
  try {
    elevator.notifyStop(sid);
  } catch (err) {
    console.error('[focus] 通知助手收工失败：', err && err.message);
  }

  cfg.session = null;
  persist(cfg);
  stopTick();

  console.log(`[focus] 专注结束（${reason}）`);
  emit();
  return { ok: true, reason };
}

// 主人按了「结束专注」—— pressedAt 是他**按下那一刻**的时间戳。
// 没按够 HOLD_MS 一律拒绝：这是「能随时一键退出的工具等于没用」那条调研结论的落点。
// ⚠ 判定放在这里而不是界面里 —— 规则只有一处，界面报「按下时刻」就够了。
function requestStop({ pressedAt } = {}) {
  if (!config().session) return { ok: true, alreadyStopped: true };

  if (!timer.canExit(pressedAt, Date.now())) {
    return { ok: false, error: `得按住 ${Math.round(timer.HOLD_MS / 1000)} 秒才能结束哦` };
  }
  return stop('manual');
}

// ---------- 轮询：到点自动结束 ----------

function tick() {
  const cfg = config();
  if (!cfg.session) { stopTick(); return; }
  if (timer.isDone(cfg.session, Date.now())) {
    stop('done');   // 到点自动结束（界面关着也照样结束）
    return;
  }
  emitTick();       // 还在专注：报个心跳，让桌宠校正角标
}

function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(tick, TICK_MS);
  // 别让这个定时器拖住进程退出（托盘程序退出要干净）
  if (tickHandle.unref) tickHandle.unref();
}

function stopTick() {
  if (!tickHandle) return;
  clearInterval(tickHandle);
  tickHandle = null;
}

// ---------- 初始化 ----------

function init(opts = {}) {
  if (typeof opts.onChange === 'function') onChange = opts.onChange;
  if (typeof opts.onTick === 'function') onTick = opts.onTick;
  if (inited) return;
  inited = true;

  // 启动时若文件里还留着「进行中的专注」（上次没结束就关了程序），接着计时；
  // 已经过期的会在第一次 tick 里被自动清掉。
  const cfg = config();
  if (cfg.session) {
    const left = Math.round(timer.remainingMs(cfg.session, Date.now()) / 1000);
    console.log(`[focus] 检测到上次没结束的专注（还剩 ${left} 秒），接着计时`);
    startTick();
  } else {
    console.log('[focus] 专注模式已就绪（当前没有进行中的专注）');
  }
}

module.exports = {
  init,
  state,
  isRunning,
  setBlacklist,
  setPreset,
  start,
  stop,
  requestStop,
  TICK_MS,
  // Task 6 起：提权助手这一层。Task 7/8 会用它把 hosts 和 exe 列表送下去。
  elevator,
  paths: () => elevator.paths(),
  isHelperAlive: () => elevator.isHelperAlive(config().session ? config().session.sid : null),
};
