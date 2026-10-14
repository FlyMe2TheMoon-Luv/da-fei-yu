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
const hosts = require('./hosts');
const doh = require('./doh');
const intercept = require('./intercept');
const { sanitizeBlacklist } = require('./blacklist');

// ⚠ 拿到的是**模块**，要 createElevator() 才是能用的实例 ——
//   require('./elevate') 本身只有工厂和纯函数，没有 startHelper / notifyStop。
const elevator = require('./elevate').createElevator();

// 每 5 秒查一次「到点了没有」。
// ⚠ 不用 setTimeout(到点时间) —— 电脑睡一觉 / 关机再开，setTimeout 会把事件丢掉，
//   专注就永远结束不了。这跟项目里「日程调度用轮询」是同一条硬约定。
const TICK_MS = 5000;

// 沙箱模式下用的假 hosts 初始内容（只写进 userData，绝不碰系统文件）
// 沙箱模式下用的假 hosts 初始内容（只写进 userData，绝不碰系统文件）
// ⚠ 必须是**纯 ASCII**：它会被按 latin1 落盘，中文会被截断成任意字节，
//   撞上 0x0D 就凭空多出一个换行（踩过 —— 端到端自检抓到的）。
const SANDBOX_HOSTS = '# selftest fake hosts - never touches the real system file\r\n127.0.0.1 localhost\r\n';

// 运行选项。默认就是「动真格」的：真实 hosts + 真提权。
// 自检时由 main.js 传 elevate:false + 一个假 hosts 路径 ——
// ★ 自检绝不能弹 UAC、绝不能碰主人的真实 hosts，否则自检就变成危险操作了。
let options = {
  elevate: true,
  hostsPath: elevator.HOSTS_PATH,
};

let onChange = null;   // 会话状态变了就喊一声（由 main.js 注入）
let onTick = null;     // 专注进行中每次轮询也喊一声（桌宠据此校正剩余时间）
let tickHandle = null;
let inited = false;

// 最近一次「安全 DNS」检测结果（给界面看）
let lastDoh = null;

// 计划文件用的路径（沙箱时 hostsPath 指向假文件）
function planPaths() {
  const p = elevator.paths();
  p.hostsPath = options.hostsPath;
  return p;
}

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
    // 最近一次的「安全 DNS」检测结果（界面据此提醒主人：这会让屏蔽失效）
    doh: lastDoh,
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

// 开始专注。
// ⚠ 从 Task 7 起这是**异步**的 —— 要等主人点 UAC 的「是」。
//   同步等会把桌宠整个卡死（UAC 弹窗可能停好几秒）。
async function start({ minutes } = {}) {
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

  // ① 先查「安全 DNS」。
  //    它开着的话，hosts 屏蔽会被浏览器整个绕过 —— 我们全对、功能全废。
  //    ★ 不拦着开始（主人可能就是想先专注），但必须把话带回去让界面显示出来。
  const dohInfo = checkDoh();

  // ② 读真实 hosts。读不到就**不许开始** ——
  //    硬着头皮写下去，可能拿一份不完整的内容覆盖掉主人的 DNS 配置。
  const original = intercept.readHostsText(options.hostsPath);
  if (original === null) {
    return {
      ok: false,
      doh: dohInfo,
      error: '读不到 hosts 文件，没法开始专注。可能是被杀毒软件挡住了，或者权限不够。',
    };
  }

  const m = (Number.isFinite(minutes) && minutes > 0) ? Math.round(minutes) : cfg.lastMinutes;
  const session = timer.create({ minutes: m, now: Date.now() });

  // 会话号（Task 6）：提权助手靠它认领「这趟专注的收工信号」。
  session.sid = elevator.newSid();

  // ③ 算好「要写进去的全文」和「还原用的全文」—— 全在纯函数里做，助手只负责照抄。
  const plan = intercept.buildPlan({
    session,
    originalText: original,
    domains: cfg.domains,
    exes: cfg.exes,
    paths: planPaths(),
    now: Date.now(),
  });

  // ④ 清信号文件（控制文件标成「不许停」、心跳标成「还没听到」）
  elevator.resetSignals(session.sid);

  // ⑤ 起提权助手 —— 整段专注**只在这里弹一次 UAC**
  if (options.elevate) {
    const r = await elevator.startHelper(plan);
    if (!r.ok) {
      // ★ 主人点了「否」/ 提权失败 → 专注**不能开始**。
      //   假装开始了会让主人以为在挡，其实什么都没挡，比直接失败更坏。
      return { ok: false, error: r.error, doh: dohInfo };
    }
  } else {
    // 沙箱（自检）：不走提权，直接改假文件 —— 走的是**同一套文本逻辑**，
    // 只是省掉了 UAC 那一步。这样自检能验完整条链，又不会弹窗、不会碰真文件。
    try {
      intercept.writeHostsText(options.hostsPath, plan.hostsText);
    } catch (err) {
      return { ok: false, error: `写 hosts 失败：${err && err.message}`, doh: dohInfo };
    }
  }

  cfg.session = session;
  cfg.lastMinutes = session.minutes;
  persist(cfg);

  lastDoh = dohInfo;
  startTick();
  console.log(`[focus] 专注开始：${session.minutes} 分钟（挡 ${cfg.domains.length} 个网站 / 关 ${cfg.exes.length} 个软件）`);
  emit();
  return { ok: true, session, doh: dohInfo };
}

function stop(reason = 'manual') {
  const cfg = config();
  if (!cfg.session) return { ok: true, alreadyStopped: true };

  const sid = cfg.session.sid || null;

  if (options.elevate) {
    // 先看助手还在不在 —— 关机重启过、或者主人手动杀了它，它就不在了。
    // 不在了的话，控制文件写了也没人读，得自己补一次清理。
    const alive = safeAlive(sid);

    // 请助手收工（写控制文件）。
    // ★ 绝不杀助手进程 —— 强杀它就没有还原 hosts 的机会了。
    try {
      elevator.notifyStop(sid);
    } catch (err) {
      console.error('[focus] 通知助手收工失败：', err && err.message);
    }

    if (!alive) {
      // 助手已经不在了 → 自己补一次一次性清理（不阻塞结束流程）。
      // 失败也不拦着结束：下次启动的 recoverIfDirty 还会再兜一次。
      cleanupResidue('helper-gone').catch(() => { });
    }
  } else {
    // 沙箱（自检）：真实路径下这一步是助手做的，这里自己把假 hosts 还原
    try {
      const cur = intercept.readHostsText(options.hostsPath);
      if (cur !== null) intercept.writeHostsText(options.hostsPath, hosts.removeBlock(cur));
    } catch (err) {
      console.error('[focus] 沙箱还原 hosts 失败：', err && err.message);
    }
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

// ---------- 安全 DNS（DoH）----------

// 查一遍浏览器的「安全 DNS」。开着的话 hosts 屏蔽会被绕过。
// 永远返回一个对象，绝不抛异常（查不到就说「不知道」，不瞎猜）。
function checkDoh() {
  try {
    lastDoh = doh.detectDoh();
  } catch (err) {
    console.error('[focus] 检测安全 DNS 失败：', err && err.message);
    lastDoh = { level: 'unknown', browsers: [], policy: 'unknown', advice: doh.adviceFor('unknown', []) };
  }
  return lastDoh;
}

// ---------- hosts 残留（上次没清干净）----------

function safeAlive(sid) {
  try { return elevator.isHelperAlive(sid); } catch { return false; }
}

// 看一眼 hosts 里有没有我们留下的标记块。
//   dirty       = 有块
//   interrupted = 有块 **且** 还有一个「进行中」的会话
//                 （那不是残留，是「正在用」—— 关机重启后块还在，专注其实还有效）
function residue() {
  let text = null;
  try { text = intercept.readHostsText(options.hostsPath); } catch { text = null; }
  if (text === null) {
    return { dirty: false, domains: [], interrupted: false, restoreText: null, readFailed: true };
  }
  return intercept.residueOf(text, isRunning());
}

// 一次性清掉残留（走 restore 模式，不备份、不循环、不杀进程）
async function cleanupResidue(why) {
  const r = residue();
  if (!r.dirty || !r.restoreText) return { ok: true, cleaned: false };

  if (!options.elevate) {
    try {
      intercept.writeHostsText(options.hostsPath, r.restoreText);
      return { ok: true, cleaned: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  }

  console.log(`[focus] 清理 hosts 残留（${why}）：${r.domains.join(', ')}`);
  const plan = intercept.buildRestorePlan({
    restoreText: r.restoreText,
    paths: planPaths(),
    now: Date.now(),
  });
  return elevator.startHelper(plan);
}

// 启动时兜一次底。
// 场景：上次专注中途崩了 / 关机了，hosts 里还留着指向 0.0.0.0 的块，
//       主人的网站打不开，而且没有任何人会来收拾。
// ⚠ 绝不抛异常 —— 这是启动流程里的一步，它失败不能让桌宠起不来。
async function recoverIfDirty() {
  let r;
  try { r = residue(); } catch { return { ok: true, dirty: false }; }

  if (r.readFailed) return { ok: true, dirty: false, readFailed: true };
  if (!r.dirty) return { ok: true, dirty: false };

  // 还有进行中的会话 → 块是「正在生效」的，不是垃圾。
  // 保留不动（关机重启后 hosts 还在挡，专注其实仍然有效），
  // 等这段专注结束时 stop() 会处理。
  if (r.interrupted) {
    console.log(`[focus] hosts 里有正在生效的屏蔽块（${r.domains.join(', ')}），保留`);
    return { ok: true, dirty: true, interrupted: true, domains: r.domains };
  }

  console.log(`[focus] 检测到上次专注没正常结束，正在帮你恢复 hosts（原来挡着 ${r.domains.join(', ')}）`);
  try {
    const res = await cleanupResidue('startup');
    if (!res.ok) {
      console.error('[focus] 自动恢复 hosts 没成功（不影响桌宠启动）：', res.error);
      return { ok: false, dirty: true, domains: r.domains, error: res.error };
    }
    return { ok: true, dirty: true, cleaned: true, domains: r.domains };
  } catch (err) {
    console.error('[focus] 自动恢复 hosts 抛异常（不影响桌宠启动）：', err && err.message);
    return { ok: false, dirty: true, domains: r.domains, error: err && err.message };
  }
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

function init(o = {}) {
  if (typeof o.onChange === 'function') onChange = o.onChange;
  if (typeof o.onTick === 'function') onTick = o.onTick;
  if (typeof o.elevate === 'boolean') options.elevate = o.elevate;
  if (typeof o.hostsPath === 'string' && o.hostsPath) options.hostsPath = o.hostsPath;
  if (inited) return;
  inited = true;

  // 沙箱（自检）时，假 hosts 文件可能还不存在。
  // ★ 必须先造一份像样的初始内容 —— 否则 start() 会读到 null 然后一直拒绝开始，
  //   自检就会表现成「专注按钮点了没反应」，很难查。
  if (!options.elevate) {
    try {
      if (!require('fs').existsSync(options.hostsPath)) {
        require('fs').writeFileSync(options.hostsPath, Buffer.from(SANDBOX_HOSTS, 'latin1'));
      }
      console.log(`[focus] 沙箱模式：hosts 指向 ${options.hostsPath}（不会碰系统真实文件）`);
    } catch (err) {
      console.error('[focus] 沙箱 hosts 初始化失败：', err && err.message);
    }
  }

  // 启动时若文件里还留着「进行中的专注」（上次没结束就关了程序），接着计时；
  // 已经过期的会在第一次 tick 里被自动清掉。
  const cfg = config();
  if (cfg.session) {
    const left = Math.round(timer.remainingMs(cfg.session, Date.now()) / 1000);
    const alive = safeAlive(cfg.session.sid);
    console.log(`[focus] 检测到上次没结束的专注（还剩 ${left} 秒），接着计时；提权助手${alive ? '还在' : '已经不在了'}`);
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
  // Task 6 起：提权助手这一层
  elevator,
  paths: planPaths,
  isHelperAlive: () => safeAlive(config().session ? config().session.sid : null),
  // Task 7 起：安全 DNS 检测 + hosts 残留
  checkDoh,
  residue,
  cleanupResidue,
  recoverIfDirty,
  hostsPath: () => options.hostsPath,
};
