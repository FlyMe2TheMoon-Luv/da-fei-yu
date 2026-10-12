// src/main/week.js
// v2 · 周视图的「布局数学」（纯函数）
//
// ★ 本文件刻意不 require('electron')，这样能脱离 Electron 直接单测（照 place.js 的做法）。
//   它只复用 schedules.js 里的两个纯函数（localDateKey / minutesOfDay）。
//   所有导出都是同步、无副作用的：同样的输入永远得到同样的输出。
//
// ── 为什么这些数学要放主进程 ──
//   渲染进程不能 require（硬性约定第 1 条），而「一周怎么展开、方块画在哪」这类
//   算错了肉眼几乎看不出来的东西，必须能被测试覆盖。所以全部在主进程算好、测好，
//   只把 0~1 的**比例**交给界面去乘自己的像素高度（见 PLAN-V2 的架构约定）。

const schedules = require('./schedules');

// 8 色调色板。键名固定，界面用 data-color 属性挑样式。
const PALETTE = ['blue', 'teal', 'amber', 'pink', 'purple', 'green', 'coral', 'gray'];

// 时间轴的默认范围：最少覆盖 08:00–20:00（只有一条 10:00 的日程时，
// 不该画一整天的空网格 —— 见 PLAN-V2 决定表）。
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 20;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---------- 小工具 ----------

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// 坏时间（比如手改坏了文件）直接跳过，别让时间轴被撑成 0~24
function safeMinutes(hhmm) {
  if (typeof hhmm !== 'string' || !TIME_RE.test(hhmm)) return null;
  return schedules.minutesOfDay(hhmm);
}

// ---------- 周展开 ----------

// 本周一 00:00:00.000（本地时间）。
// 周一是一周之始 —— 周日属于「本周的第 7 天」，**不是**下一周的第 1 天。
function weekStartOf(date = new Date()) {
  const dow = date.getDay(); // 0 = 周日
  const back = (dow + 6) % 7; // 周一 → 0，周二 → 1，…… 周日 → 6
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back, 0, 0, 0, 0);
}

// 这一天该显示哪些条目。
//
// ⚠ 星期判定必须和 scheduler.js 的 todayTarget() 用**同一套规则**（getDay()，0 = 周日）。
//   改了一边一定要改另一边，否则会出现「周视图上明明画了，到点却不响」这种极难查的 bug。
//
// enabled:false 的**也返回** —— 界面自己把它画淡一点，
// 主人才能看出「它还在，只是关着」（和列表现有行为一致）。
function itemsOfDay(items, date) {
  const key = schedules.localDateKey(date);
  const dow = date.getDay();

  return (items || []).filter((it) => {
    if (!it) return false;
    switch (it.repeat) {
      case 'daily':
        return true;
      case 'weekdays':
        return dow !== 0 && dow !== 6; // 周六周日不显示
      case 'weekly':
        return Array.isArray(it.weekdays) && it.weekdays.includes(dow);
      case 'once':
        return it.date === key; // 一次性日程只在它那一天出现
      default:
        return false; // 不认识的重复规则：不画，总比画错好
    }
  });
}

// 时间轴范围（整点）。最少覆盖 08:00–20:00；有更早 / 更晚的日程就往外扩。
// 返回 { startHour, endHour }，例如 { startHour: 8, endHour: 20 }。
function axisOf(items) {
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;

  for (const it of items || []) {
    if (!it) continue;

    const start = safeMinutes(it.time);
    if (start === null) continue;
    startHour = Math.min(startHour, Math.floor(start / 60));

    // 结束边界：时段用 endTime，时间点用 time 本身。
    // 有零头分钟就往上凑一个整点 —— 否则 22:30 的日程会贴着网格底边，
    // 看着像被切掉一半。
    const endRaw = it.kind === 'span' ? it.endTime : it.time;
    const end = safeMinutes(endRaw) ?? start;
    endHour = Math.max(endHour, Math.ceil(end / 60));
  }

  startHour = Math.max(0, Math.min(23, startHour));
  endHour = Math.max(startHour + 1, Math.min(24, endHour));
  return { startHour, endHour };
}

// 某一天的方块列表。topRatio / heightRatio 都是 0..1 的比例，
// 相对 [axis.startHour, axis.endHour] 这一段，界面负责乘像素。
// 返回 [{ item, topRatio, heightRatio, color }]。
function blocksOf(items, date, axis) {
  const ax = axis || axisOf(items);
  const totalMin = Math.max(1, (ax.endHour - ax.startHour) * 60);

  const blocks = itemsOfDay(items, date).map((item) => {
    const start = safeMinutes(item.time);
    const topRatio = start === null ? 0 : clamp01((start - ax.startHour * 60) / totalMin);

    // 只有时段有高度；时间点的 heightRatio 恒为 0，界面用固定像素高画一根扁条
    let heightRatio = 0;
    if (item.kind === 'span') {
      const end = safeMinutes(item.endTime);
      if (end !== null && start !== null) heightRatio = clamp01((end - start) / totalMin);
    }

    return { item, topRatio, heightRatio, color: colorOf(item.title) };
  });

  // 同一个开始时刻的方块：**时段排前、时间点排后**。
  // 界面按数组顺序画（后画的压在上面），这样扁扁的时间点不会被长长的时段盖住。
  return blocks.sort((a, b) => {
    if (a.topRatio !== b.topRatio) return a.topRatio - b.topRatio;
    const rank = (b) => (b.item.kind === 'span' ? 0 : 1);
    return rank(a) - rank(b);
  });
}

// 同一个标题永远同一个颜色；空标题归到 gray。
//
// 用「标题字符码滚动哈希」，**不要**用 item.id —— id 会变（删了重建就是新 id），
// 颜色跟着 id 跳会显得很吵。更不要随机数（那样每次刷新都在变色）。
// gray 留给「没有标题」这种兜底情况，所以哈希只在前面 7 个彩色里转。
function colorOf(title) {
  if (typeof title !== 'string') return 'gray';
  const t = title.trim();
  if (!t) return 'gray';

  let h = 0;
  for (let i = 0; i < t.length; i++) {
    h = (h * 31 + t.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % (PALETTE.length - 1)];
}

module.exports = {
  PALETTE,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  weekStartOf,
  itemsOfDay,
  axisOf,
  blocksOf,
  colorOf,
};
