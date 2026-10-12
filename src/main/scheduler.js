// src/main/scheduler.js
// 阶段 2-2 · 日程调度引擎
//
// 职责很窄：**每 30 秒扫一遍日程，命中的回调出去**。
//   · 不碰界面 —— 提醒怎么呈现（气泡 / 表情 / 系统通知）是 2-3 的事
//   · 不管存盘细节 —— 那是 schedules.js 的事
//   · 不碰系统 —— 那是 main.js 的事
// 这样拆开，引擎可以脱离 Electron 单独测（见 scripts/test-scheduler.js）。
//
// ── 为什么用轮询，不用 setTimeout（硬性约定第 3 条）──
//   电脑睡眠 / 关机再开机，setTimeout 会把事件直接丢掉，醒来后静默不响，
//   而且你根本不知道它丢了。轮询 + lastFiredDate 去重，重启后依然可靠。
//
// ── 宽限窗口为什么是 5 分钟（主人 2026-10-12 拍板）──
//   轮询是 30 秒一次，09:30:00 的日程可能到 09:30:12 才被扫到 —— 窗口太小会漏。
//   但窗口太大，晚开机时会一次炸出一堆过期提醒。5 分钟是折中：
//   09:30 的提醒，09:34 开机还能看到；11:00 才开机就算了（**不补**）。
//
// ── 跨天不补（PLAN.md 明确的 MVP 边界）──
//   昨天没开机，今天不补昨天的。判定只看「今天」这一天的目标时刻。

const schedules = require('./schedules');

const TICK_MS = 30 * 1000; // 轮询间隔
const GRACE_MS = 5 * 60 * 1000; // 宽限窗口

let timer = null;
let onDue = null; // 命中时的回调：(item, 目标时刻Date) => void

// ---------- 判定（纯函数，好测）----------

// 这条日程「今天」该在几点响？不该响就返回 null。
// 只看日期规则，不管有没有已经响过（那是 dueItems 的事）。
function todayTarget(item, now) {
  if (!item || !item.enabled) return null;

  const dow = now.getDay(); // 0 = 周日

  if (item.repeat === 'once') {
    // 一次性日程：日期必须就是今天
    if (item.date !== schedules.localDateKey(now)) return null;
  } else if (item.repeat === 'weekdays') {
    if (dow === 0 || dow === 6) return null; // 周末不响
  } else if (item.repeat === 'weekly') {
    if (!Array.isArray(item.weekdays) || !item.weekdays.includes(dow)) return null;
  }
  // daily 不用额外判定：每天都响

  const [h, m] = item.time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
}

// 扫一遍，返回「现在该提醒」的日程。
// 命中条件三件套：① 今天有目标时刻 ② 目标时刻 <= 现在 < 目标 + 宽限 ③ 今天还没响过
function dueItems(items, now = new Date()) {
  const todayKey = schedules.localDateKey(now);
  const out = [];

  for (const item of items || []) {
    // ③ 去重：今天已经响过就跳过（这条是「关掉重开不重复提醒」的关键）
    if (item.lastFiredDate === todayKey) continue;

    const target = todayTarget(item, now);
    if (!target) continue;

    // ② 还没到点 → 等下次；超过宽限窗口 → 放过（不补）
    const late = now.getTime() - target.getTime();
    if (late < 0 || late >= GRACE_MS) continue;

    out.push({ item, target });
  }

  return out;
}

// ---------- 引擎 ----------

// 扫一次并把命中的派发出去。返回这次派发了哪些（方便自检和日志）。
function tick(now = new Date()) {
  let items;
  try {
    items = schedules.list();
  } catch (err) {
    // 读日程失败绝不能把主进程带崩（HANDOFF 第七节「这一步的坑」）
    console.error('[scheduler] 读日程失败，跳过这一轮：', err && err.message);
    return [];
  }

  const due = dueItems(items, now);
  const todayKey = schedules.localDateKey(now);

  for (const { item, target } of due) {
    // ★ 先写「今天已响过」，再回调。
    //   顺序反了的话，回调里一旦抛异常，这条日程会在下一轮又被扫出来，变成每 30 秒重放一次。
    try {
      schedules.markFired(item.id, todayKey);
    } catch (err) {
      console.error('[scheduler] 标记已触发失败：', err && err.message);
    }

    try {
      if (onDue) onDue(item, target);
    } catch (err) {
      // 回调出错（比如气泡窗口建不出来）不能影响其它日程
      console.error('[scheduler] 提醒回调出错：', err && err.message);
    }
  }

  return due;
}

function start(handler) {
  onDue = handler || null;
  stop();

  // 启动时立刻扫一次：把「开机前 5 分钟内刚错过」的那条补上
  tick();

  timer = setInterval(() => tick(), TICK_MS);
  console.log(`[scheduler] 已启动（每 ${TICK_MS / 1000} 秒扫一次，宽限窗口 ${GRACE_MS / 60000} 分钟）`);
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function isRunning() {
  return timer !== null;
}

module.exports = {
  TICK_MS,
  GRACE_MS,
  start,
  stop,
  isRunning,
  tick,
  // 纯函数，给测试和 2-3 复用
  todayTarget,
  dueItems,
};
