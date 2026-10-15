// src/main/pet-drag.js
// 桌宠拖拽的「手感」逻辑（纯函数）—— v4 批次 3-b
//
// 三件事，全在这里、全能用纯 Node 单测（不 require electron）：
//   ① rubberbandAxis —— 拖出屏幕边界时的渐进阻力
//   ② releasePlan    —— 松手那一刻：该往哪去、用不弹还是轻弹
//   ③ createGlide / stepGlide —— 松手之后的动画状态机（喂 dt 就往前走）
//
// ── 为什么松手之后还要动 ──
//   手指甩出去、松手，东西却「啪」地停住 —— 这是最典型的「廉价感」。
//   苹果的做法是**把手指速度交给动画**：先按这个速度继续走，再平滑减速。
//   这里的做法是把速度投影成一个落点（`v × 投影时长`），然后让弹簧走到那儿。
//   ★ 弹簧的初速就是手指速度 —— 所以接缝处既不断速度也不断位置。
//
// ── 什么时候用「不弹」、什么时候用「轻弹」──
//   · 拖出边界了 → 弹回边界内：**不弹**（damping 1.0）。已经拖飞了还弹，像失控。
//   · 在界内松手 → 惯性滑行：**轻弹**（damping 0.8）。
//     只有手势本身带惯性时才给弹 —— 苹果的原则，凭空弹是廉价不是活泼。
//   · 系统开了「减少动态效果」→ 直接落位，一步都不动。
//
// ── 纯函数，所以「手感」也能被量 ──
//   「松手后走了多远」「有没有滑出屏幕」「停不停得下来」全是数字，
//   见 scripts/test-pet-drag.js。

const { rubberband } = require('./rubberband');
const { stepSpring, isSettled } = require('./spring');

// ── 手感参数（主人 2026-10-15 反馈「滑太远，希望更跟鼠标」后收紧过一次）──
//
// 怎么调（这三个数就是全部）：
//   · PROJECT_SECONDS 越小 → 松手后滑得越近。想要「松手基本就停」就调到 0.02 以下。
//   · FLICK_RESPONSE  越小 → 停得越快（但也越「硬」）。
//   · FLICK_DAMPING   1.0 = 一点都不弹（最跟手）；< 1 会轻轻弹一下。
//   · RUBBER_CONSTANT 越大 → 拖到屏幕边上越跟手（1.0 = 完全跟手、毫无阻力）。
const BACK_RESPONSE = 0.3;    // 弹回边界：快一点，别拖泥带水
const FLICK_RESPONSE = 0.26;  // 惯性滑行：0.4 → 0.26（更快停住，更跟手）
const FLICK_DAMPING = 1.0;    // 不再给「弹」—— 主人要的是跟手，不是活泼
const PROJECT_SECONDS = 0.05; // 0.15 → 0.05（松手后滑的距离缩到约 1/3）
const MAX_SPEED = 2000;       // px/s —— 3000 → 2000，免得一甩就飞很远
const MAX_GLIDE_SECONDS = 3;  // 兜底：再怎么算也不许动超过 3 秒
const RUBBER_CONSTANT = 0.9;  // 0.55 → 0.9：边界阻力调轻，拖拽更跟鼠标

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function clamp(v, lo, hi) {
  if (!isNum(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

// 拖拽中：想要的位置超出边界时，给出「有阻力」的位移。
// lo/hi 是**窗口左上角的合法范围**（保证整个窗口在屏幕里）；
// size 是参考尺寸（一般用窗口宽/高）—— 越界最多也就挪出不到一个窗口。
// constant 越大越跟手（1.0 = 完全 1:1，等于没有阻力）。
function rubberbandAxis(desired, lo, hi, size, constant = RUBBER_CONSTANT) {
  if (!isNum(desired)) return lo;
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (desired < min) return min - rubberband(min - desired, size, constant);
  if (desired > max) return max + rubberband(desired - max, size, constant);
  return desired;
}

// 松手那一刻的决策。bounds = { minX, maxX, minY, maxY }（窗口左上角合法范围）
function releasePlan({ x, y, vx, vy, bounds, reducedMotion = false }) {
  const b = bounds || {};
  const X = isNum(x) ? x : (isNum(b.minX) ? b.minX : 0);
  const Y = isNum(y) ? y : (isNum(b.minY) ? b.minY : 0);
  const VX = isNum(vx) ? clamp(vx, -MAX_SPEED, MAX_SPEED) : 0;
  const VY = isNum(vy) ? clamp(vy, -MAX_SPEED, MAX_SPEED) : 0;

  const minX = isNum(b.minX) ? b.minX : X;
  const maxX = isNum(b.maxX) ? Math.max(b.maxX, minX) : X;
  const minY = isNum(b.minY) ? b.minY : Y;
  const maxY = isNum(b.maxY) ? Math.max(b.maxY, minY) : Y;

  const cx = clamp(X, minX, maxX);
  const cy = clamp(Y, minY, maxY);
  const outside = cx !== X || cy !== Y;

  // 系统要求减少动态效果 → 直接落位（不是「没有反馈」，是换成不动的等价物）
  if (reducedMotion) {
    return {
      x: cx, y: cy, vx: 0, vy: 0, targetX: cx, targetY: cy,
      damping: 1.0, response: BACK_RESPONSE, instant: true, reason: 'reduced-motion',
    };
  }

  // 拖出界了 → 弹回边界内。速度保留（会先顺着惯性再被拉回来，比硬拽自然）
  if (outside) {
    return {
      x: X, y: Y, vx: VX, vy: VY, targetX: cx, targetY: cy,
      damping: 1.0, response: BACK_RESPONSE, instant: false, reason: 'rubberback',
    };
  }

  // 界内松手 → 惯性滑行。落点 = 当前位置 + 速度 × 投影时长（夹在界内）
  return {
    x: X, y: Y, vx: VX, vy: VY,
    targetX: clamp(X + VX * PROJECT_SECONDS, minX, maxX),
    targetY: clamp(Y + VY * PROJECT_SECONDS, minY, maxY),
    damping: FLICK_DAMPING, response: FLICK_RESPONSE, instant: false, reason: 'flick',
  };
}
// 把 plan 变成可以逐帧推进的状态机。
// ★ 已经在目标上、速度也几乎是 0 时直接 done —— 不然「点一下没拖动」也会起一次动画。
// ⚠ 这里容易写错：弹簧的状态字段是 `x`（位置）和 `v`（速度），**不分横竖**。
//   竖直那一路要写成 `{ x: plan.y, v: plan.vy }` —— 别去读 `spring.y`，那个字段不存在
//   （读不存在的属性不报错，只会静默变成 undefined，然后整条曲线全变 NaN）。
function createGlide(plan) {
  if (!plan) return { done: true };
  const done = isSettled({ x: plan.x, v: plan.vx }, plan.targetX)
    && isSettled({ x: plan.y, v: plan.vy }, plan.targetY);
  return { ...plan, elapsed: 0, done };
}

// 推进 dt 秒，返回**新**状态（不改传进来的那个）
function stepGlide(g, dt) {
  if (!g || g.done) return g;
  if (!isNum(dt) || dt <= 0) return g;

  const opts = { damping: g.damping, response: g.response };
  const sx = stepSpring({ x: g.x, v: g.vx }, g.targetX, dt, opts);
  const sy = stepSpring({ x: g.y, v: g.vy }, g.targetY, dt, opts);  // ← 竖直也走 x/v 这两个字段
  const elapsed = g.elapsed + dt;
  // 兜底：万一参数被改坏了，也不许无限动下去
  const done = (isSettled(sx, g.targetX) && isSettled(sy, g.targetY)) || elapsed >= MAX_GLIDE_SECONDS;
  return { ...g, x: sx.x, y: sy.x, vx: sx.v, vy: sy.v, elapsed, done };
}

module.exports = {
  rubberbandAxis,
  releasePlan,
  createGlide,
  stepGlide,
  clamp,
  BACK_RESPONSE,
  FLICK_RESPONSE,
  FLICK_DAMPING,
  PROJECT_SECONDS,
  MAX_SPEED,
  MAX_GLIDE_SECONDS,
  RUBBER_CONSTANT,
};
