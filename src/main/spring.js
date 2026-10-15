// src/main/spring.js
// 手写弹簧（不引依赖）—— v4 批次 3-1
//
// 用法：
//   const { createSpring, stepSpring, isSettled, estimateVelocity } = require('./spring');
//   let s = createSpring(0, 0);
//   s = stepSpring(s, target, dt, { damping: 1.0, response: 0.35 });
//
// ── 为什么参数是「阻尼比 + 响应时间」，不是 mass/stiffness/damping ──
//   apple-design 给的语义参数就是这两个，而且**人能直接调**：
//     · response（秒）：动画「大概多久走完」。界面上舒服的区间是 0.3–0.4。
//     · damping（阻尼比）：1.0 = 不弹（临界阻尼，最稳）；< 1 会弹一下再停；
//       > 1 会「泡在糖浆里」（过阻尼，又慢又钝）。
//   而 mass/stiffness/damping 三个数要凑很久才能凑出想要的手感。
//   ★ 默认 damping = 1.0（不弹）。**只在手势本身带惯性时**才给 ~0.8 的弹 ——
//     界面元素凭空弹一下，在苹果的语言里是「廉价」，不是「活泼」。
//
// ── 为什么必须能「中途打断」 ──
//   苹果设计原则里「可打断性」排第一：手伸出去、动画走到一半又往回拉，
//   必须立刻从**当前的位置 + 当前的速度**接着走，不能跳一下、也不能先停住。
//   所以这里的 state 就只有 {x, v} 两个数 —— 打断时把当下这两个数喂进去即可，
//   位置和速度天然都连续（见 test-spring 第 6 节）。
//
// ── 为什么内部固定子步长 ──
//   显式欧拉在 dt 大时会发散（数值爆炸）。渲染掉帧时 dt 可能到 1/20 秒，
//   直接用就会看到窗口「嗖」地飞出去。所以外面给多少 dt 都行，
//   内部一律拆成不超过 1/240 秒的小步走 —— 既稳，结果也**和帧率无关**。
//
// ── 纯函数、不 require electron ──
//   所以能脱离 Electron 用纯 Node 单测（见 scripts/test-spring.js）。

const DEFAULT_DAMPING = 1.0;   // 不弹
const DEFAULT_RESPONSE = 0.35; // 秒

const SUBSTEP = 1 / 240;       // 固定子步长（秒）
const MAX_SECONDS = 10;        // 单次推进的 dt 上限：防外面传个离谱的 dt 把 CPU 转死

const SETTLE_POS = 0.5;        // px —— 小于半个像素就看不出来了
const SETTLE_VEL = 1;          // px/s

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// 把「语义参数」翻成「物理参数」（质量固定为 1）。
// 坏参数一律退回默认值 —— 绝不把 NaN 放进去（否则整条曲线都是 NaN）。
function paramsOf(opts = {}) {
  const damping = isNum(opts.damping) && opts.damping >= 0 ? opts.damping : DEFAULT_DAMPING;
  const response = isNum(opts.response) && opts.response > 0 ? opts.response : DEFAULT_RESPONSE;
  const w0 = (2 * Math.PI) / response;   // 固有角频率
  return { damping, response, w0, k: w0 * w0, c: 2 * damping * w0 };
}

// 建一个弹簧状态。位置单位 px，速度单位 px/s。
function createSpring(x = 0, v = 0) {
  return { x: isNum(x) ? x : 0, v: isNum(v) ? v : 0 };
}

// 推进 dt 秒，目标 target。返回**新** state（不改传进来的那个）。
// ★ 松手那一帧把「手指速度」放进 state.v，就是「速度衔接」——
//   弹簧会带着这个初速走，接缝处不会顿一下。
function stepSpring(state, target, dt, opts) {
  const s = createSpring(state && state.x, state && state.v);
  if (!isNum(target)) return s;      // 目标不是数 → 原地不动（不许变成 NaN）
  if (!isNum(dt) || dt <= 0) return s;

  const { k, c } = paramsOf(opts);
  const span = Math.min(dt, MAX_SECONDS);
  // 拆成 n 个不超过 SUBSTEP 的小步，每步 h = span/n（这样最后一步不剩零头）
  const n = Math.max(1, Math.ceil(span / SUBSTEP));
  const h = span / n;

  let { x, v } = s;
  for (let i = 0; i < n; i++) {
    const a = -k * (x - target) - c * v;
    v += a * h;   // 先更新速度（半隐式欧拉：比显式欧拉稳得多）
    x += v * h;   // 再用**新**速度更新位置
  }
  return { x, v };
}

// 到位了吗？位置和速度**都**要小才算 —— 只看位置会在「路过目标」的瞬间误判成到了。
function isSettled(state, target, eps) {
  if (!state || !isNum(target)) return false;
  const pos = eps && isNum(eps.pos) ? eps.pos : SETTLE_POS;
  const vel = eps && isNum(eps.vel) ? eps.vel : SETTLE_VEL;
  return Math.abs(state.x - target) <= pos && Math.abs(state.v) <= vel;
}

// 从指针采样里估速度（px/s）—— 这就是「速度衔接」的输入。
// samples: [{ x, t }]，t 是毫秒时间戳，按时间升序。
// 只取**最近 windowMs 毫秒内**的样本：松手前如果手已经停了，速度就该是 0，
// 不能拿半秒前的移动当成「还在飞」。
function estimateVelocity(samples, opts = {}) {
  const win = isNum(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 100;
  const arr = Array.isArray(samples)
    ? samples.filter((s) => s && isNum(s.x) && isNum(s.t))
    : [];
  if (arr.length < 2) return 0;

  const last = arr[arr.length - 1];
  let first = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (last.t - arr[i].t > win) break;
    first = arr[i];
  }
  // 窗口内只剩一笔 → 退回「最后两笔」，否则没法算
  if (!first || first === last) first = arr[arr.length - 2];

  const dtMs = last.t - first.t;
  // ★ 时间没走（两笔同一时刻）→ 速度就是 0。
  //   这里如果不挡住，会算出 Infinity 或 NaN，然后整条曲线全废。
  if (!(dtMs > 0)) return 0;

  const v = ((last.x - first.x) / dtMs) * 1000;
  const max = isNum(opts.maxAbs) ? Math.abs(opts.maxAbs) : Infinity;
  return Math.max(-max, Math.min(max, v));
}

module.exports = {
  createSpring,
  stepSpring,
  isSettled,
  estimateVelocity,
  paramsOf,
  DEFAULT_DAMPING,
  DEFAULT_RESPONSE,
  SUBSTEP,
};
