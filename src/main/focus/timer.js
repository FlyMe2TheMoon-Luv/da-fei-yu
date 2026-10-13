// src/main/focus/timer.js
// 纯函数：专注计时的状态机（开始 / 剩余 / 到点 / 长按退出）。
//
// ── 为什么不 require('electron') ──
//   一旦 require 了，普通 Node 里就跑不起来，也就没法单测了。
//   本文件只做时间运算，当前时间由调用方传进来（见 scripts/test-focus-timer.js）。
//
// ── 核心写法：剩余时间 = 结束时刻 - 现在，而不是「每秒自减 1」 ──
//   电脑睡眠、关机再开、系统卡顿，都会让「每秒自减」的实现把时间算丢 ——
//   结果就是专注永远结束不了、或者还剩一大截。
//   用「结束时刻 - 现在」就天然免疫：睡了一小时再醒，一算就知道早该结束了。
//   （这跟项目里「日程调度用轮询、不用 setTimeout」是同一个道理。）
//
// ── 时间一律本地时间 ──
//   内部只用毫秒时间戳（Date.getTime()），不碰 UTC，绝不 toISOString()。

const DEFAULT_MINUTES = 25;
const MAX_MINUTES = 24 * 60;
const HOLD_MS = 3000; // 结束专注要长按这么久才放行

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return NaN;
}

// 开始一次专注。
// minutes 不是正数（0 / 负数 / NaN / 字符串）时回落到 25 分钟 —— 不抛异常。
function create({ minutes, now } = {}) {
  const m = (Number.isFinite(minutes) && minutes > 0)
    ? Math.min(Math.round(minutes), MAX_MINUTES)
    : DEFAULT_MINUTES;

  const startMs = toMs(now);
  const startedAt = Number.isFinite(startMs) ? startMs : Date.now();

  return {
    startedAt,
    endsAt: startedAt + m * 60 * 1000,
    minutes: m,
    state: 'running',
  };
}

// 还剩多少毫秒。过期 / 坏数据一律返回 0，绝不返回负数。
function remainingMs(session, now) {
  if (!session || !Number.isFinite(session.endsAt)) return 0;
  const t = toMs(now);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, session.endsAt - t);
}

// 到点了没有。没有 session 也当「已结束」（= 现在没在专注）。
function isDone(session, now) {
  return remainingMs(session, now) <= 0;
}

// 长按够久了没有。
// pressStartedAt 必须是「按下那一刻」的 Date 或毫秒数；没按下（null / undefined / 别的）
// 一律返回 false —— 没按就不许退出。
function canExit(pressStartedAt, now, holdMs = HOLD_MS) {
  const a = toMs(pressStartedAt);
  const b = toMs(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b - a >= holdMs;
}

// 进度比例 0..1（给界面画进度环）。超时封顶 1，时钟被往回拨也不变负。
function progressRatio(session, now) {
  if (!session || !Number.isFinite(session.startedAt) || !Number.isFinite(session.endsAt)) return 0;
  const total = session.endsAt - session.startedAt;
  if (total <= 0) return 1;
  const t = toMs(now);
  if (!Number.isFinite(t)) return 0;
  const elapsed = t - session.startedAt;
  return Math.max(0, Math.min(1, elapsed / total));
}

module.exports = {
  DEFAULT_MINUTES,
  MAX_MINUTES,
  HOLD_MS,
  create,
  remainingMs,
  isDone,
  canExit,
  progressRatio,
};
