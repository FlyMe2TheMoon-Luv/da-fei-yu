// scripts/test-scheduler.js
// 阶段 2-2 · 调度引擎自检（纯逻辑，不起窗口）
//
// 用法：npm run test:scheduler
//
// 为什么单独写脚本：桌宠是单实例程序，托盘里跑着时再启动会被顶掉，自检根本不会执行。
// 这个脚本把 userData 指到临时目录，不碰主人真实的日程数据。
//
// 测试原则（HANDOFF 第六节第 19 条）：每类规则都要配**反例** ——
// 「到点会响」通过了不算数，还得证明「没到点不响」「过了宽限期不响」「今天响过不响」，
// 否则一个「永远返回 true」的实现也能全绿。

const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------- 把 electron 换成假的，让 store.js 能跑在普通 Node 里 ----------
const FAKE_USER_DATA = path.join(os.tmpdir(), 'desktop-pet-selftest-scheduler', String(process.pid));
fs.rmSync(FAKE_USER_DATA, { recursive: true, force: true });

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => FAKE_USER_DATA, isPackaged: false } };
  }
  return origLoad.apply(this, arguments);
};

const schedules = require('../src/main/schedules');
const scheduler = require('../src/main/scheduler');
const FILE_PATH = path.join(FAKE_USER_DATA, schedules.FILE);

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function section(t) { console.log(`\n${t}`); }

// 2026-10-12 是星期一（周一=1）
const MON = (h, m, s = 0) => new Date(2026, 9, 12, h, m, s, 0);
const TUE = (h, m, s = 0) => new Date(2026, 9, 13, h, m, s, 0);
const WED = (h, m, s = 0) => new Date(2026, 9, 14, h, m, s, 0);
const SAT = (h, m, s = 0) => new Date(2026, 9, 17, h, m, s, 0);
const SUN = (h, m, s = 0) => new Date(2026, 9, 18, h, m, s, 0);

// 造一条合法日程（不走存盘，直接给 dueItems 用）
function mk(over = {}) {
  return {
    id: 's_test',
    title: '开会',
    time: '09:30',
    repeat: 'daily',
    date: null,
    weekdays: [],
    enabled: true,
    lastFiredDate: null,
    createdAt: 1,
    ...over,
  };
}
const dueIds = (items, now) => scheduler.dueItems(items, now).map((d) => d.item.id);

console.log('===== 调度引擎自检（阶段 2-2）=====');
console.log(`临时数据目录：${FAKE_USER_DATA}`);

// ---------- 1. 到点判定 ----------
section('1. 到点判定（daily 09:30）');
const daily = [mk()];
ok(dueIds(daily, MON(9, 29, 59)).length === 0, '09:29:59 → 还没到点，不响');
ok(dueIds(daily, MON(9, 30, 0)).length === 1, '09:30:00 → 正好到点，响');
ok(dueIds(daily, MON(9, 30, 1)).length === 1, '09:30:01 → 响（轮询会晚一点扫到）');

// ---------- 2. 宽限窗口（5 分钟，主人拍板）----------
section('2. 宽限窗口 = 5 分钟');
ok(dueIds(daily, MON(9, 34, 59)).length === 1, '09:34:59 → 还在 5 分钟内，补提醒');
ok(dueIds(daily, MON(9, 35, 0)).length === 0, '09:35:00 → 刚好满 5 分钟，不补（边界必须掐准）');
ok(dueIds(daily, MON(9, 35, 1)).length === 0, '09:35:01 → 超了，不补');
ok(dueIds(daily, MON(11, 0, 0)).length === 0, '11:00 → 早就过了，绝不补（不然开机会炸一堆）');
ok(dueIds(daily, MON(9, 0, 0)).length === 0, '09:00 → 还没到点，当然不响');

// ---------- 3. 去重 ----------
section('3. 去重（关掉重开不重复提醒的基础）');
ok(dueIds([mk({ lastFiredDate: '2026-10-12' })], MON(9, 30, 30)).length === 0, '今天已响过 → 不再响');
ok(dueIds([mk({ lastFiredDate: '2026-10-11' })], MON(9, 30, 30)).length === 1, '★ 反例：昨天响过 → 今天照响（去重不能过头）');
ok(dueIds([mk({ lastFiredDate: null })], MON(9, 30, 30)).length === 1, '★ 反例：从没响过 → 响');

// ---------- 4. 开关 ----------
section('4. 开关（enabled = false 只是静音，不删）');
ok(dueIds([mk({ enabled: false })], MON(9, 30, 30)).length === 0, '关掉的日程不响');
ok(dueIds([mk({ enabled: true })], MON(9, 30, 30)).length === 1, '★ 反例：打开的日程照响');

// ---------- 5. 一次性 ----------
section('5. repeat = once（看具体日期）');
const once = mk({ repeat: 'once', date: '2026-10-12' });
ok(dueIds([once], MON(9, 30, 30)).length === 1, '日期就是今天 → 响');
ok(dueIds([once], TUE(9, 30, 30)).length === 0, '★ 反例：到了第二天 → 不响（MVP 不补跨天）');
const onceTomorrow = mk({ repeat: 'once', date: '2026-10-13' });
ok(dueIds([onceTomorrow], MON(9, 30, 30)).length === 0, '★ 反例：日期是明天 → 今天不响');

// ---------- 6. 工作日 ----------
section('6. repeat = weekdays（周一~周五）');
const wk = mk({ repeat: 'weekdays' });
ok(dueIds([wk], MON(9, 30, 30)).length === 1, '周一 → 响');
ok(dueIds([wk], TUE(9, 30, 30)).length === 1, '周二 → 响');
ok(dueIds([wk], SAT(9, 30, 30)).length === 0, '★ 反例：周六 → 不响');
ok(dueIds([wk], SUN(9, 30, 30)).length === 0, '★ 反例：周日 → 不响');

// ---------- 7. 每周指定星期 ----------
section('7. repeat = weekly（选了周一/三/五）');
const weekly = mk({ repeat: 'weekly', weekdays: [1, 3, 5] });
ok(dueIds([weekly], MON(9, 30, 30)).length === 1, '周一（选了）→ 响');
ok(dueIds([weekly], WED(9, 30, 30)).length === 1, '周三（选了）→ 响');
ok(dueIds([weekly], TUE(9, 30, 30)).length === 0, '★ 反例：周二（没选）→ 不响');
ok(dueIds([weekly], SAT(9, 30, 30)).length === 0, '★ 反例：周六（没选）→ 不响');
ok(dueIds([mk({ repeat: 'weekly', weekdays: [0] })], SUN(9, 30, 30)).length === 1, '只选周日（0）→ 周日响');
ok(dueIds([mk({ repeat: 'weekly', weekdays: [0] })], MON(9, 30, 30)).length === 0, '★ 反例：只选周日 → 周一不响');

// ---------- 8. tick 真的派发 + 写去重标记 ----------
section('8. tick：派发 + 写 lastFiredDate');
fs.rmSync(FILE_PATH, { force: true });
// 注意：start() 里的 tick 用的是**真实时钟**，所以这里必须塞「当前时间」的日程，
// 写死 09:30 的话，下午跑这个测试就永远不响（踩过）。
const NOW = new Date();
const HHMM = `${String(NOW.getHours()).padStart(2, '0')}:${String(NOW.getMinutes()).padStart(2, '0')}`;
const seeded = schedules.add({ title: '自检·开会', time: HHMM, repeat: 'daily' });
ok(!!seeded.id, `塞入一条日程（${HHMM}，就是当前时刻）`);

const fired = [];
scheduler.start((item) => fired.push(item.id)); // start 会立刻扫一次
ok(fired.length === 1 && fired[0] === seeded.id, 'tick 派发了这条日程（回调收到）');
ok(schedules.get(seeded.id).lastFiredDate === schedules.localDateKey(new Date()), 'lastFiredDate 被写成今天');
scheduler.stop();

// ---------- 9. 去重：再扫不重复 ----------
section('9. 去重：同一轮周期内不重复派发');
scheduler.start((item) => fired.push(item.id)); // 再启动一次，立刻又扫一遍
ok(fired.length === 1, '★ 再扫一遍没有重复提醒（还是只响过 1 次）');
scheduler.stop();

// ---------- 10. 回调抛异常不能导致重放 ----------
section('10. 回调抛异常：不能变成每 30 秒重放一次');
fs.rmSync(FILE_PATH, { force: true });
const seeded2 = schedules.add({ title: '自检·会炸的', time: HHMM, repeat: 'daily' });
let boomCount = 0;
scheduler.start(() => { boomCount++; throw new Error('故意的'); });
ok(boomCount === 1, '回调确实被调用了一次（并且抛了异常）');
ok(schedules.get(seeded2.id).lastFiredDate === schedules.localDateKey(new Date()),
  '★ 回调抛异常了，lastFiredDate 仍然写下去了（先标记再回调，顺序很关键）');
scheduler.stop();
scheduler.start(() => { boomCount++; throw new Error('故意的'); });
ok(boomCount === 1, '★ 再扫一遍没有重放（没有变成「每轮都炸」）');
scheduler.stop();

// ---------- 11. 坏文件不能带崩引擎 ----------
section('11. 坏文件兜底');
fs.writeFileSync(FILE_PATH, '这不是 JSON {{{', 'utf8');
let crashed = false;
let result = null;
try { result = scheduler.tick(new Date()); } catch { crashed = true; }
ok(!crashed, '日程文件全是乱码时，tick 不抛异常');
ok(Array.isArray(result) && result.length === 0, '乱码文件 → 这一轮什么也不派发');

// ---------- 12. 引擎开关 ----------
section('12. start / stop');
scheduler.stop();
ok(scheduler.isRunning() === false, 'stop 之后不再运行');
scheduler.start(() => {});
ok(scheduler.isRunning() === true, 'start 之后正在运行');
scheduler.stop();
ok(scheduler.isRunning() === false, '再 stop 又停下（可以反复开关）');

// ---------- 收尾 ----------
section('收尾');
fs.rmSync(FAKE_USER_DATA, { recursive: true, force: true });
ok(!fs.existsSync(FAKE_USER_DATA), '临时数据目录已清理');

console.log(`\n===== 结束：${pass} 通过 / ${fail} 失败 =====`);
console.log(fail === 0
  ? '结论：调度引擎 OK，可以进 2-3 提醒呈现。'
  : '结论：有失败项，先修好再往下走。');
process.exit(fail === 0 ? 0 : 1);
