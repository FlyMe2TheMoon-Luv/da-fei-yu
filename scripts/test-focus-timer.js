// scripts/test-focus-timer.js
// 阶段 3 · Task 2 · 专注计时状态机自检
//
// 用法：npm run test:focus-timer
//
// ── 为什么值得单独测 ──
//   计时器有两个「看起来对、其实错」的坑：
//     ① 用「每秒自减 1」实现 → 电脑睡眠 / 关机再开，时间就丢了，专注永远结束不了；
//     ② 剩余时间算成负数 / 进度超过 100% → 界面画出鬼东西。
//   这两条都是「肉眼看一眼觉得很正常」的错误，必须靠负对照钉住。
//   timer.js 是纯函数、不 require Electron，所以能穷举。
//
// ── 关键约定 ──
//   本文件里所有时间都用**本地时间**构造（new Date(年,月,日,...)），不用 toISOString()。

const timer = require('../src/main/focus/timer');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negTotal = 0;
let negPass = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function okNeg(cond, label) {
  negTotal++;
  if (cond) negPass++;
  ok(cond, label);
}
function section(t) { console.log(`\n${t}`); }

// 本地时间：2026-10-14 10:00:00
const T0 = new Date(2026, 9, 14, 10, 0, 0);
const at = (h, m, s = 0) => new Date(2026, 9, 14, h, m, s);

console.log('===== 专注计时状态机自检（timer.js）=====');

// ---------- 1. 基本：开始 / 剩余 / 到点 ----------
section('1. 基本：25 分钟的专注，剩余时间随真实时间走');
{
  const s = timer.create({ minutes: 25, now: T0 });
  ok(s.state === 'running', '开始后状态是 running');
  ok(s.minutes === 25, '时长记下来了');

  ok(timer.remainingMs(s, at(10, 0, 0)) === 25 * 60 * 1000, '刚开始时剩 25 分钟');
  ok(timer.remainingMs(s, at(10, 10, 0)) === 15 * 60 * 1000, '过了 10 分钟剩 15 分钟');
  ok(timer.remainingMs(s, at(10, 24, 59)) === 1000, '差 1 秒时剩 1000 毫秒');

  ok(timer.isDone(s, at(10, 24, 59)) === false, '差 1 秒还没结束');
  ok(timer.isDone(s, at(10, 25, 0)) === true, '到点算结束');
}

// ---------- 2. ★ 负对照：睡眠 / 关机后不能「时间丢了」 ----------
section('2. ★ 负对照：电脑睡了一觉再醒，剩余时间按真实时间算');
{
  const s = timer.create({ minutes: 25, now: T0 });

  // 中间「跳」过一大段时间 —— 如果实现是「每秒自减」，这里会算出还剩一大截
  ok(timer.isDone(s, at(11, 30, 0)) === true, '★ 睡过头了也该是「已结束」，不能卡在运行中');
  ok(timer.remainingMs(s, at(11, 30, 0)) === 0, '★ 过期后剩余一律是 0，不能是负数');
  ok(timer.remainingMs(s, new Date(2026, 9, 15, 9, 0, 0)) === 0, '★ 隔了一天也还是 0，不溢出');
}

// ---------- 3. ★ 负对照：纯函数不许「每次调用偷偷减一点」 ----------
section('3. ★ 负对照：同一个时刻连问 100 次，答案必须一模一样');
{
  const s = timer.create({ minutes: 25, now: T0 });
  const before = JSON.stringify(s);
  const first = timer.remainingMs(s, at(10, 10, 0));
  let same = true;
  for (let i = 0; i < 100; i++) {
    if (timer.remainingMs(s, at(10, 10, 0)) !== first) same = false;
  }
  okNeg(same, '★ 连问 100 次结果不变（防「每次自减 1」的假实现）');
  okNeg(JSON.stringify(s) === before, '★ 调用 remainingMs 不会改动 session 本身（纯函数）');
}

// ---------- 4. 长按 3 秒才放行 ----------
section('4. 长按退出：按满 3 秒才放行');
{
  const down = at(10, 0, 0);
  ok(timer.HOLD_MS === 3000, '长按门槛是 3000 毫秒');

  ok(timer.canExit(down, at(10, 0, 0)) === false, '刚按下（0 秒）不放行');
  ok(timer.canExit(down, at(10, 0, 1)) === false, '按 1 秒不放行');
  okNeg(timer.canExit(down, at(10, 0, 2, 900)) === false, '★ 2.9 秒还不放行（差一点点也不行）');
  ok(timer.canExit(down, at(10, 0, 3, 0)) === true, '满 3 秒放行');
  ok(timer.canExit(down, at(10, 0, 5, 0)) === true, '按更久当然放行');

  // ★ 负对照：没按下 / 时间点坏了 → 一律不许放行（防「没按也能退」）
  okNeg(timer.canExit(null, at(10, 0, 5)) === false, '★ 没按下就不许退出');
  okNeg(timer.canExit(undefined, at(10, 0, 5)) === false, '★ undefined 也不许退出');
  okNeg(timer.canExit('2026-10-14', at(10, 0, 5)) === false, '★ 乱七八糟的按下时刻不许退出');
}

// ---------- 5. 进度条比例 ----------
section('5. 进度比例：0 → 1，绝不越界');
{
  const s = timer.create({ minutes: 25, now: T0 });
  ok(timer.progressRatio(s, at(10, 0, 0)) === 0, '刚开始进度 0');
  ok(Math.abs(timer.progressRatio(s, at(10, 12, 30)) - 0.5) < 1e-9, '过半进度 0.5');
  ok(timer.progressRatio(s, at(10, 25, 0)) === 1, '到点进度 1');
  okNeg(timer.progressRatio(s, at(12, 0, 0)) === 1, '★ 超时了进度封顶在 1，不会超过');
  okNeg(timer.progressRatio(s, new Date(2026, 9, 13, 10, 0, 0)) === 0, '★ 时间倒流（时钟被调）进度也不会变负');
}

// ---------- 6. 坏输入不许崩 ----------
section('6. 坏输入：不崩、给出能用的结果');
{
  const s1 = timer.create({ minutes: 0, now: T0 });
  okNeg(s1.minutes === timer.DEFAULT_MINUTES, '★ 时长 0 → 回落默认 25 分钟');

  const s2 = timer.create({ minutes: NaN, now: T0 });
  okNeg(s2.minutes === timer.DEFAULT_MINUTES, '★ 时长 NaN → 回落默认');

  const s3 = timer.create({ minutes: -10, now: T0 });
  okNeg(s3.minutes === timer.DEFAULT_MINUTES, '★ 负时长 → 回落默认');

  const s4 = timer.create({ minutes: 45 });
  ok(s4.minutes === 45, '不传 now 也能创建（用当前时间）');

  ok(timer.remainingMs(null, T0) === 0, 'null session 不崩');
  ok(timer.remainingMs({}, T0) === 0, '空对象 session 不崩');
  ok(timer.isDone(null, T0) === true, '没有 session 就当「没在专注」= 已结束');
  ok(timer.progressRatio(null, T0) === 0, 'null session 进度 0');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
