// scripts/test-schedules.js
// 阶段 2-1 · 日程数据层自检
//
// 用法：npm run test:schedules
//
// 为什么单独写一个脚本，而不是塞进 main.js 的自检：
//   1. 桌宠是「单实例」程序（main.js 里有 requestSingleInstanceLock）。
//      如果桌宠已经在托盘里跑着，再启动一次会立刻退出，自检根本不会执行 —— 很容易误判成「通过」。
//   2. 这个脚本不建窗口、不抢锁，随时能跑，几秒出结果。
//   3. 它把 userData 指到一个临时目录，**不会碰主人真实的日程数据**。
//
// 测试原则（HANDOFF 第六节第 19 条的教训）：
//   只测「正例通过」不算数，必须配**负对照** —— 坏数据如果也能通过校验，
//   说明这个校验是假的。所以每一类校验都配了一条「必须被拒」的反例。

const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------- 把 electron 换成假的，让 store.js 能跑在普通 Node 里 ----------
const FAKE_USER_DATA = path.join(os.tmpdir(), 'desktop-pet-selftest', String(process.pid));
fs.rmSync(FAKE_USER_DATA, { recursive: true, force: true });

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => FAKE_USER_DATA, isPackaged: false } };
  }
  return origLoad.apply(this, arguments);
};

const schedules = require('../src/main/schedules');
const FILE_PATH = path.join(FAKE_USER_DATA, schedules.FILE);

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function section(t) { console.log(`\n${t}`); }

console.log('===== 日程数据层自检（阶段 2-1）=====');
console.log(`临时数据目录：${FAKE_USER_DATA}`);

// ---------- 1. 空文件起步 ----------
section('1. 空文件起步（文件还不存在）');
ok(schedules.list().length === 0, '文件不存在时返回空列表，不报错');
ok(schedules.get('s_随便') === null, '查不存在的 id 返回 null');

// ---------- 2. 新增 ----------
section('2. 新增');
const once = schedules.add({ title: '开会', time: '09:30', repeat: 'once', date: '2026-10-13' });
ok(once && typeof once.id === 'string' && once.id.startsWith('s_'), '拿到时间戳生成的 id');
ok(once && once.enabled === true, '默认 enabled = true');
ok(once && once.lastFiredDate === null, '默认没触发过（lastFiredDate = null）');
ok(once && Number.isFinite(once.createdAt), '自动补上 createdAt');

const daily = schedules.add({ title: '喝水', time: '15:00', repeat: 'daily' });
const weekly = schedules.add({ title: '周会', time: '10:00', repeat: 'weekly', weekdays: [1, 3, 5] });
const weekdaysOnly = schedules.add({ title: '打卡', time: '08:50', repeat: 'weekdays' });
ok(schedules.list().length === 4, '一共加进去 4 条');

// ---------- 3. 真的落盘了吗 ----------
section('3. 落盘（直接读磁盘上的文件核对）');
ok(fs.existsSync(FILE_PATH), `${schedules.FILE} 文件确实生成了`);
const onDisk = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
ok(onDisk.version === schedules.VERSION, `文件里有 version = ${schedules.VERSION}`);
ok(Array.isArray(onDisk.items) && onDisk.items.length === 4, '磁盘上就是 4 条（不是只存在内存里）');

// ---------- 4. 排序 ----------
section('4. 列表排序（按时间从早到晚）');
const times = schedules.list().map((it) => it.time);
ok(times.join() === '08:50,09:30,10:00,15:00', `按时间排好了：${times.join(' , ')}`);

// ---------- 5. 改 ----------
section('5. 修改');
const renamed = schedules.update(once.id, { title: '开会（改过）' });
ok(renamed && renamed.title === '开会（改过）', '改标题生效');
ok(renamed && renamed.time === '09:30' && renamed.date === '2026-10-13', '没改的字段原样保留');

const switched = schedules.update(once.id, { repeat: 'weekly', weekdays: [2, 4] });
ok(switched && switched.repeat === 'weekly', '重复规则改成每周');
ok(switched && switched.date === null, '改规则后，原来的「一次性日期」被清掉（避免残留脏字段）');
ok(switched && switched.weekdays.join() === '2,4', '新的星期被保存');

const back = schedules.update(once.id, { repeat: 'once', date: '2026-10-20' });
ok(back && back.date === '2026-10-20' && back.weekdays.length === 0, '再改回一次性，星期被清空');

// ---------- 6. 开关 ----------
section('6. 开关（不删除，只静音）');
const off = schedules.toggle(once.id);
ok(off && off.enabled === false, 'toggle 一次 → 关掉');
const on = schedules.toggle(once.id);
ok(on && on.enabled === true, 'toggle 两次 → 打开');

// ---------- 7. 标记已触发 ----------
section('7. 标记「今天已响过」（2-2 调度引擎要用）');
ok(schedules.markFired(once.id, '2026-10-12') === true, 'markFired 写入成功');
ok(schedules.get(once.id).lastFiredDate === '2026-10-12', 'lastFiredDate 确实写进去了');
ok(schedules.markFired('s_不存在') === false, '对不存在的日程 markFired 返回 false');

// ---------- 8. ★ 负对照：这些都必须被拒 ----------
section('8. 负对照（坏数据必须被拒，否则校验是假的）');
const rejects = [
  ['空标题', { title: '', time: '09:30', repeat: 'once', date: '2026-10-13' }],
  ['标题只有空格', { title: '   ', time: '09:30', repeat: 'once', date: '2026-10-13' }],
  ['非法时间 25:00', { title: 'x', time: '25:00', repeat: 'once', date: '2026-10-13' }],
  ['非法时间 09:60', { title: 'x', time: '09:60', repeat: 'once', date: '2026-10-13' }],
  ['不规范时间 9:30', { title: 'x', time: '9:30', repeat: 'once', date: '2026-10-13' }],
  ['时间不是字符串', { title: 'x', time: 930, repeat: 'once', date: '2026-10-13' }],
  ['不存在的日期 2026-02-30', { title: 'x', time: '09:30', repeat: 'once', date: '2026-02-30' }],
  ['日期格式错 2026/10/13', { title: 'x', time: '09:30', repeat: 'once', date: '2026/10/13' }],
  ['一次性日程缺日期', { title: 'x', time: '09:30', repeat: 'once' }],
  ['每周重复没选星期', { title: 'x', time: '09:30', repeat: 'weekly' }],
  ['每周重复星期为空数组', { title: 'x', time: '09:30', repeat: 'weekly', weekdays: [] }],
  ['未知重复规则「每三天」', { title: 'x', time: '09:30', repeat: '每三天' }],
  ['不是对象', null],
  ['是字符串', '开会'],
];
for (const [label, input] of rejects) {
  const r = schedules.add(input);
  ok(r && typeof r.error === 'string', `${label} → 被拒（${r && r.error}）`);
}
ok(schedules.update('s_不存在的id', { title: 'y' }).error, '改不存在的日程 → 被拒');
ok(schedules.remove('s_不存在的id') === false, '删不存在的日程 → 返回 false');
ok(schedules.toggle('s_不存在的id').error, '开关不存在的日程 → 被拒');

// ---------- 9. 坏文件兜底 ----------
section('9. 坏文件兜底（读坏了也不能把主进程带崩）');
fs.writeFileSync(FILE_PATH, '这不是 JSON {{{', 'utf8');
let crashed = false;
let afterCorrupt = [];
try { afterCorrupt = schedules.list(); } catch { crashed = true; }
ok(!crashed, '文件内容全是乱码时，list() 不抛异常');
ok(afterCorrupt.length === 0, '乱码文件被当成空列表');

fs.writeFileSync(FILE_PATH, JSON.stringify({
  version: 1,
  items: [
    { id: 's_1', title: '好的一条', time: '09:00', repeat: 'daily' },
    { id: 's_2', title: '', time: '09:00', repeat: 'daily' },          // 坏：空标题
    { id: 's_3', title: '坏时间', time: '99:99', repeat: 'daily' },     // 坏：时间非法
    { id: 's_1', title: '重复 id', time: '11:00', repeat: 'daily' },    // 坏：id 撞车
    '我是一条字符串不是对象',                                            // 坏：类型不对
  ],
}), 'utf8');
let mixed = [];
try { mixed = schedules.list(); } catch { crashed = true; }
ok(!crashed, '部分条目坏掉时，list() 不抛异常');
ok(mixed.length === 2, `坏的被丢掉、好的留下（留下 ${mixed.length} 条，期望 2）`);
ok(mixed.every((it) => it.id && it.title), '留下的每条都有 id 和标题');
ok(new Set(mixed.map((it) => it.id)).size === mixed.length, 'id 没有重复（撞车的被重新编号）');

// ---------- 10. 收尾 ----------
section('10. 收尾');
fs.rmSync(FAKE_USER_DATA, { recursive: true, force: true });
ok(!fs.existsSync(FAKE_USER_DATA), '临时数据目录已清理，没留垃圾');

console.log(`\n===== 结束：${pass} 通过 / ${fail} 失败 =====`);
if (fail === 0) {
  console.log('结论：数据层 OK，可以进 2-2 调度引擎。');
} else {
  console.log('结论：有失败项，先修好再往下走。');
}
process.exit(fail === 0 ? 0 : 1);
