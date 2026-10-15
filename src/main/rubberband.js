// src/main/rubberband.js
// 橡皮筋：拖出边界时的「渐进阻力」—— v4 批次 3-4
//
// 用法：rubberband(超出边界的距离, 参考尺寸, 阻力系数)
//
// ── 要解决什么 ──
//   桌宠拖到屏幕边上是**硬停**：手还在动，窗口不动了，感觉像撞墙、像程序卡了。
//   苹果的做法是「橡皮筋」：还能动，但越动越沉，松手自己弹回去。
//
// ── 公式（iOS / apple-design）──
//     offset = (1 - 1 / (d * c / dimension + 1)) * dimension
//   d = 手指拖出边界的距离；dimension = 参考尺寸（一般用窗口宽/高）；
//   c = 阻力系数（越小越难拖出去）。
//
// ── 它的性质就是自检要钉的东西 ──
//   · d = 0 → 0                     不越界就一点都不动
//   · 0 < offset < d                 **动得比手指少**，这就是「阻力」
//   · offset < dimension             无限逼近但**永远不超过**（拖不飞）
//   · offset/d 从 c 开始、随 d 单调变小   一开始最跟手，越拖越沉
//   · rubberband(-d) = -rubberband(d)     左右对称
//
// ★ 注意 offset/d 在起点等于 c（默认 0.55），**不是 1** ——
//   也就是说刚越界那一瞬间就已经「打了 55 折」。这是苹果刻意的：
//   边界反馈要立刻可感知，不然用户会以为还能拖。
//
// ── 纯函数、不 require electron ──

const DEFAULT_CONSTANT = 0.55;

// 系数必须落在 (0, 1]：
//   · ≤ 1 才有「阻力」（否则动得比手指还多，那是加速不是橡皮筋）
//   · > 0 才有意义
// 越界的一律夹回默认值，绝不把 NaN / 负数放进公式。
function normConstant(constant) {
  const c = Number(constant);
  if (!Number.isFinite(c) || c <= 0) return DEFAULT_CONSTANT;
  return Math.min(c, 1);
}

function rubberband(overflow, dimension, constant) {
  const d = Number(overflow);
  const dim = Number(dimension);
  const c = normConstant(constant);

  // 没越界 / 坏输入 → 0（不动的意思，不是 NaN）
  if (!Number.isFinite(d) || d === 0) return 0;
  if (!Number.isFinite(dim) || dim <= 0) return 0;

  const sign = d < 0 ? -1 : 1;
  const abs = Math.abs(d);
  return sign * (1 - 1 / ((abs * c) / dim + 1)) * dim;
}

module.exports = { rubberband, DEFAULT_CONSTANT };
