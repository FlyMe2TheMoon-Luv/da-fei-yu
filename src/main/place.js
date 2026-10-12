// src/main/place.js
// 纯函数：把一个小窗口摆在桌宠旁边（优先「右上方」）。
//
// ── 为什么单独抽出来 ──
//   设置窗口要「贴着桌宠出现」，而不是屏幕正中。
//   这类「摆位置」的代码最容易写错（屏幕边、多显示器、上下放不下），
//   又最不容易被肉眼发现（差几十像素谁看得出来）。
//   抽成纯函数就能穷举测试（见 scripts/test-place.js）。
//
// ── 为什么不 require('electron') ──
//   一旦 require 了，普通 Node 里就跑不起来，也就没法单测了。
//   这个文件只做数字运算，屏幕信息由调用方传进来。
//
// ── 方位说明 ──
//   按 order 里的顺序依次尝试：
//
//      up-right     窗口在宠物右上方（窗口左下角挨着宠物右上角）★ 首选
//      above-right  窗口在宠物正上方、右边缘和宠物右边缘对齐
//      above        窗口在宠物正上方、水平居中
//      up-left      窗口在宠物左上方
//      right        窗口在宠物右侧（顶端对齐）
//      left         窗口在宠物左侧（顶端对齐）
//      below        窗口在宠物正下方
//
// ── 两段式策略（这是这个文件的全部难点）──
//
//   第一段：按 order 找第一个「不用挪就能完整放进工作区」的方位，直接用。
//          有地方的时候行为完全可预期，就是右上方。
//
//   第二段：一个都放不下（宠物贴着屏幕边，边上剩的地方不够放窗口）时，
//          不能「随便挑一个」—— 那样会出现窗口跑到屏幕另一头、离宠物十万八千里。
//          正确做法是把首选方位的理想落点**夹进工作区**，用它当靶心，挑离靶心最近的。
//          （注意：靶心本身就是「夹过的 up-right」，所以 up-right 的距离恒为 0 ——
//            也就是说这一段的默认答案就是「尽量靠右上方，靠不到就贴着屏幕边」。）
//
//          但只按距离挑有个坑：宠物贴在屏幕**右上角**时，「夹过的 up-right」会正好
//          落在角色身上，窗口一打开就把桌宠盖住了。所以这里多一条偏好 ——
//          **优先挑不压住宠物的**，实在全都会压住（屏幕比窗口还小）才认了。
//          「窗口盖住角色」比「离得稍微远一点」难受得多。
//
//   举例（主人这台机器，屏 1707×1067，宠物 400×380 在 1340,650，窗口 480×640）：
//     宠物的右上方其实放不下（窗口 640 高，宠物顶上只剩 650px，差一点；
//     右边更是一点地方都没有）。
//     只按「超出最少」挑的老做法 → 选中 up-left → 窗口跑到 x=850，离宠物 490px，很怪。
//     现在 → 靶心 = 夹过的 up-right = (1219,8) → 窗口贴在宠物**正上方、顶到最右**，
//     只比宠物右边缘偏左 41px，而且不压住它。这才是「靠近宠物右上方」。

const DEFAULTS = {
  gap: 10,   // 和宠物之间留的缝
  edge: 8,   // 离屏幕工作区边缘至少留这么多
  order: ['up-right', 'above-right', 'above', 'up-left', 'right', 'left', 'below'],
};

// 每个方位算出的「理想坐标」（还没考虑屏幕边界）
function candidate(side, petRect, size, gap) {
  const px = petRect.x;
  const py = petRect.y;
  const pw = petRect.width;
  const ph = petRect.height;

  switch (side) {
    case 'up-right':    return { x: px + pw + gap, y: py - size.h - gap };
    case 'above-right': return { x: px + pw - size.w, y: py - size.h - gap };
    case 'above':       return { x: px + Math.round((pw - size.w) / 2), y: py - size.h - gap };
    case 'up-left':     return { x: px - size.w - gap, y: py - size.h - gap };
    case 'right':       return { x: px + pw + gap, y: py };
    case 'left':        return { x: px - size.w - gap, y: py };
    case 'below':       return { x: px + Math.round((pw - size.w) / 2), y: py + ph + gap };
    default:            return null;
  }
}

// 工作区里「窗口左上角允许出现的范围」。
// 屏幕比窗口还小时 max < min，这里统一抬成 min —— 保证夹取结果确定、不来回跳。
function limits(size, workArea, edge) {
  const minX = workArea.x + edge;
  const minY = workArea.y + edge;
  const maxX = Math.max(minX, workArea.x + workArea.width - size.w - edge);
  const maxY = Math.max(minY, workArea.y + workArea.height - size.h - edge);
  return { minX, minY, maxX, maxY };
}

function clampPoint(p, lim) {
  return {
    x: Math.max(lim.minX, Math.min(p.x, lim.maxX)),
    y: Math.max(lim.minY, Math.min(p.y, lim.maxY)),
  };
}

// 两个矩形是否相交。p 是窗口左上角坐标。
function overlaps(p, size, petRect) {
  return p.x < petRect.x + petRect.width && p.x + size.w > petRect.x &&
         p.y < petRect.y + petRect.height && p.y + size.h > petRect.y;
}

// petRect : { x, y, width, height }  宠物窗口在屏幕上的位置（逻辑像素）
// size    : { w, h }                 要摆的窗口的真实外框尺寸
// workArea: { x, y, width, height }  目标屏幕的工作区
// opts    : { gap, edge, order }
//
// 返回 { x, y, side, clamped } —— side 是最终选了哪个方位、clamped 表示有没有被屏幕边挤过。
// 这两个字段是给日志和测试断言用的，别删。
function placeNear(petRect, size, workArea, opts = {}) {
  const gap = opts.gap === undefined ? DEFAULTS.gap : opts.gap;
  const edge = opts.edge === undefined ? DEFAULTS.edge : opts.edge;
  const order = opts.order || DEFAULTS.order;

  const lim = limits(size, workArea, edge);

  // ---- 第一段：有没有哪个方位不用挪就能完整放下 ----
  for (const side of order) {
    const c = candidate(side, petRect, size, gap);
    if (!c) continue;
    const p = clampPoint(c, lim);
    if (p.x === c.x && p.y === c.y) {
      return { x: Math.round(p.x), y: Math.round(p.y), side, clamped: false };
    }
  }

  // ---- 第二段：全都要挪。以「夹过的 up-right」为靶心，挑最近的；优先不压住宠物 ----
  const anchor = clampPoint(candidate(order[0], petRect, size, gap), lim);

  let bestFree = null;   // 不压住宠物的候选里最好的
  let bestAny = null;    // 实在没得选时的兜底
  for (const side of order) {
    const c = candidate(side, petRect, size, gap);
    if (!c) continue;
    const p = clampPoint(c, lim);
    // 曼哈顿距离：横向偏 + 纵向偏，越小越「贴着靶心」
    const d = Math.abs(p.x - anchor.x) + Math.abs(p.y - anchor.y);
    const rec = { x: p.x, y: p.y, side, d };
    if (!bestAny || d < bestAny.d) bestAny = rec;
    if (!overlaps(p, size, petRect) && (!bestFree || d < bestFree.d)) bestFree = rec;
  }

  const best = bestFree || bestAny;
  return { x: Math.round(best.x), y: Math.round(best.y), side: best.side, clamped: true };
}

module.exports = { placeNear, candidate, DEFAULTS };
