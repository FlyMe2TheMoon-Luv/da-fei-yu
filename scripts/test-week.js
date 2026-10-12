// scripts/test-week.js
// v2 · 周视图的「布局数学」自检（纯逻辑，不起窗口）
//
// 用法：npm run test:week
//
// 为什么单独写脚本：桌宠是单实例程序，托盘里跑着时再启动会被顶掉，自检根本不会执行。
//
// 测试原则（HANDOFF 第六节第 19 条）：只测「正常情况通过」不算数，必须配**负对照**。
// 这个文件里带 ★ 的每一条都是负对照 —— 它们才是真正能抓住 bug 的断言。
//   例：如果 weekStartOf 把周日算成「下周第一天」，肉眼根本看不出来，
//       但「周日必须归到本周」这条会立刻变红。

const Module = require('module');
const os = require('os');
const path = require('path');

// ---------- 把 electron 换成假的，让 store.js 能跑在普通 Node 里 ----------
// week.js 自己**不** require electron，但它复用 schedules.localDateKey，
// 而 schedules.js 会链式 require 到 store.js（那里要 electron）。所以这里照
// test-scheduler.js 的老办法打个桩。
const FAKE_USER_DATA = path.join(os.tmpdir(), 'desktop-pet-selftest-week', String(process.pid));

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => FAKE_USER_DATA, isPackaged: false } };
  }
  return origLoad.apply(this, arguments);
};

const week = require('../src/main/week');
const schedules = require('../src/main/schedules');
const { weekStartOf, itemsOfDay, axisOf, blocksOf, PALETTE, colorOf } = week;

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function section(t) { console.log(`\n${t}`); }

// ---------- 小工具 ----------
// 注意月份：这里按「人类习惯」传 1~12 月，内部再减 1（JS 的月份从 0 开始）。
const D = (y, m, d) => new Date(y, m - 1, d);
const key = (d) => schedules.localDateKey(d);
const approx = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;

// 2026-10-12 是周一，2026-10-18 是周日（本机当前时间就是这一天）
const WEEK = [];
for (let i = 0; i < 7; i++) WEEK.push(D(2026, 10, 12 + i));

// 造一条日程的便捷函数
const mk = (o) => ({
  title: 'x', kind: 'point', time: '09:00', endTime: null,
  repeat: 'daily', date: null, weekdays: [], enabled: true, ...o,
});
const counts = (list) => WEEK.map((d) => itemsOfDay(list, d).length);

console.log('===== 周视图布局自检（v2）=====');

// ---------- ① 一周从周一算起 ----------
section('① 一周从周一算起（周一是一周之始）');
ok(key(weekStartOf(D(2026, 10, 12))) === '2026-10-12', '周一自己 → 本周一 2026-10-12');
ok(key(weekStartOf(D(2026, 10, 13))) === '2026-10-12', '周二 → 也归到 2026-10-12');
ok(key(weekStartOf(D(2026, 10, 19))) === '2026-10-19', '下周一 → 2026-10-19');
ok(key(weekStartOf(D(2026, 10, 11))) === '2026-10-05', '上周日 → 归到 2026-10-05');
// ★ 负对照：周日绝不能被算成「下一周的第一天」
ok(key(weekStartOf(D(2026, 10, 18))) === '2026-10-12', '★ 负对照：周日属于本周第 7 天，不是下周第 1 天');
const ws = weekStartOf(D(2026, 10, 14));
ok(ws.getHours() === 0 && ws.getMinutes() === 0 && ws.getSeconds() === 0, '起点时刻归零到 00:00:00');

// ---------- ② 各重复规则的展开 ----------
section('② 各重复规则的展开（七天里各出现几次）');
const daily = mk({ title: '每天' });
const weekdaysOnly = mk({ title: '工作日', repeat: 'weekdays' });
const weekly135 = mk({ title: '每周一三五', repeat: 'weekly', weekdays: [1, 3, 5] });
const onceWed = mk({ title: '本周三一次', repeat: 'once', date: '2026-10-14' });
const onceNextWed = mk({ title: '下周三一次', repeat: 'once', date: '2026-10-21' });
const onceLastMonth = mk({ title: '上月一次', repeat: 'once', date: '2026-09-16' });

const cDaily = counts([daily]);
ok(cDaily.join() === '1,1,1,1,1,1,1', `每天 → 七天都在（实际 ${cDaily.join()}）`);
ok(cDaily.reduce((a, b) => a + b, 0) === 7, '★ 负对照：「每天」不能只出现一天');
ok(counts([daily]).every((n) => n === 1), '★ 负对照：也不能一天出现两次');

const cWd = counts([weekdaysOnly]);
ok(cWd.join() === '1,1,1,1,1,0,0', `工作日 → 周一~周五 5 天（实际 ${cWd.join()}）`);
ok(cWd[5] === 0 && cWd[6] === 0, '★ 负对照：周六周日必须是 0 条');

const cW135 = counts([weekly135]);
ok(cW135.join() === '1,0,1,0,1,0,0', `每周一三五 → 周一/三/五 3 天（实际 ${cW135.join()}）`);
ok(cW135[1] === 0, '★ 负对照：每周一三五，周二不能出现');

const cOnce = counts([onceWed]);
ok(cOnce.join() === '0,0,1,0,0,0,0', `本周三的一次性日程 → 只有周三 1 天（实际 ${cOnce.join()}）`);

ok(counts([onceNextWed]).every((n) => n === 0), '★ 负对照：下周的一次性日程，本周七天一条都不能出现');
ok(counts([onceLastMonth]).every((n) => n === 0), '★ 负对照：上个月的一次性日程，也不能凭空出现在本周');

// 关掉的日程也要返回（界面自己变淡），否则「显示但变淡」这条需求做不出来
const off = mk({ title: '关掉的', enabled: false });
ok(itemsOfDay([off], WEEK[0]).length === 1, '关掉的日程照样返回给界面（由界面决定变淡）');

// 一次只挑当天该显示的（不是把所有条目都倒出来）
const mixed = itemsOfDay([daily, weekdaysOnly, weekly135, onceWed], WEEK[6]);
ok(mixed.length === 1 && mixed[0].title === '每天', `周日只剩「每天」那一条（实际 ${mixed.map((i) => i.title).join('/')}）`);

// ---------- ③ 时间轴 ----------
section('③ 时间轴范围（自适应，最少覆盖 08:00–20:00）');
const ax0 = axisOf([]);
ok(ax0.startHour === 8 && ax0.endHour === 20, `没有日程 → 08:00–20:00（实际 ${ax0.startHour}–${ax0.endHour}）`);
ok(axisOf([mk({ time: '05:00' })]).startHour === 5, '有 05:00 的日程 → 起点提前到 5 点');
ok(axisOf([mk({ time: '22:30' })]).endHour === 23, '有 22:30 的日程 → 终点延到 23 点');
const axSpan = axisOf([mk({ kind: 'span', time: '10:00', endTime: '11:00' })]);
ok(axSpan.startHour === 8 && axSpan.endHour === 20, '一条 10:00–11:00 的时段 → 还是 08:00–20:00（不撑开）');
ok(axisOf([mk({ kind: 'span', time: '06:30', endTime: '07:15' })]).startHour === 6, '06:30 开始的时段 → 起点 6 点');
ok(axisOf([mk({ kind: 'span', time: '22:00', endTime: '23:30' })]).endHour === 24, '22:00–23:30 的时段 → 终点 24 点');
// ★ 负对照：一条普通日程不该把时间轴撑满全天
ok(axisOf([mk({ time: '10:00' })]).startHour === 8, '★ 负对照：只有一条 10:00 的日程，起点仍必须是 8 点（不能撑成 0 点）');
ok(axisOf([mk({ time: '10:00' })]).endHour === 20, '★ 负对照：终点也不能被撑到 24 点');
ok(axisOf([]).endHour - axisOf([]).startHour === 12, '默认跨度正好 12 小时');

// ---------- ④ 方块布局 ----------
section('④ 方块布局（比例，界面负责乘像素）');
const AX = { startHour: 8, endHour: 20 }; // 12 小时跨度
const TODAY = D(2026, 10, 12);

const point10 = mk({ title: '十点的时间点', time: '10:00' });
const span9to11 = mk({ title: '九到十一的时段', kind: 'span', time: '09:00', endTime: '11:00' });
const spanFull = mk({ title: '全天时段', kind: 'span', time: '08:00', endTime: '20:00' });

const bPoint = blocksOf([point10], TODAY, AX);
ok(bPoint.length === 1, '一天里挑出 1 个方块');
ok(approx(bPoint[0].topRatio, 2 / 12), `时间点 10:00 → topRatio ≈ 0.1667（实际 ${bPoint[0].topRatio}）`);
ok(bPoint[0].heightRatio === 0, '时间点的 heightRatio 恒为 0（界面用固定像素高画扁条）');
ok(bPoint[0].item === point10, '方块里带着原条目（界面要拿它的标题和 id）');
ok(bPoint[0].color === colorOf(point10.title), '方块带的 color 就是 colorOf(标题)');

const bSpan = blocksOf([span9to11], TODAY, AX);
ok(approx(bSpan[0].topRatio, 1 / 12), `时段 09:00 → topRatio ≈ 0.0833（实际 ${bSpan[0].topRatio}）`);
ok(approx(bSpan[0].heightRatio, 2 / 12), `时段 09:00–11:00 → heightRatio ≈ 0.1667（实际 ${bSpan[0].heightRatio}）`);
// ★ 负对照：高度恒返回 0 的实现会被这条抓住
ok(bSpan[0].heightRatio > 0.1, '★ 负对照：时段的高度必须明显大于 0.1（否则「时段比时间点高」这条需求是假的）');

const bFull = blocksOf([spanFull], TODAY, AX);
ok(bFull[0].topRatio === 0 && bFull[0].heightRatio === 1, '08:00–20:00 的时段正好铺满整根轴：top 0 / 高 1');

// ★ 负对照：同一时刻的时间点和时段，topRatio 必须相等（都从「时刻」起算）
const both = blocksOf(
  [point10, mk({ title: '也是十点的时段', kind: 'span', time: '10:00', endTime: '11:00' })],
  TODAY, AX
);
ok(both.length === 2, '同一时刻的两条都出现了');
ok(approx(both[0].topRatio, both[1].topRatio), '★ 负对照：同一时刻的时间点和时段 topRatio 相等');
// 排序：时段在前、时间点在后（后画的压在上面，短的不被长的盖住）
ok(both[0].item.kind === 'span' && both[1].item.kind === 'point', '同一时刻：时段排前、时间点排后（短的不会被长的盖住）');

// 不是这一天的日程，一个方块都不该有
ok(blocksOf([mk({ title: '别的日子', repeat: 'once', date: '2026-10-21' })], TODAY, AX).length === 0,
  '★ 负对照：不在这一天的日程，这一天里一个方块都没有');

// 关掉的日程照样画（变淡由界面做）
ok(blocksOf([mk({ title: '关掉的', enabled: false })], TODAY, AX).length === 1, '关掉的日程也画出来');

// 时间轴之外的日程不能算出负数比例（防界面把它画到网格外面去）
const early = blocksOf([mk({ title: '早于轴起点', time: '07:00' })], TODAY, AX);
ok(early[0].topRatio >= 0, `★ 负对照：早于轴起点的日程，比例被夹在 0（实际 ${early[0].topRatio}）`);

// ---------- ⑤ 取色 ----------
section('⑤ 取色（同一个标题永远同一个颜色）');
ok(PALETTE.join() === 'blue,teal,amber,pink,purple,green,coral,gray', `调色板就是约定的 8 个色（实际 ${PALETTE.join()}）`);
ok(colorOf('开会') === colorOf('开会'), '同一个标题 → 永远同一个颜色');
ok(PALETTE.includes(colorOf('开会')), '返回的颜色在调色板里');
ok(colorOf('') === 'gray', '空标题 → gray');
ok(colorOf('   ') === 'gray', '★ 负对照：只有空格的标题也算空 → gray');
ok(colorOf(null) === 'gray' && colorOf(undefined) === 'gray', '★ 负对照：标题不是字符串时也归 gray，不抛异常');
// ★ 负对照：至少两个不同标题要拿到不同颜色（否则等于「全一个色」，需求就废了）
const TITLES = [
  '开会', '写报告', '吃药', '交表', '买菜', '跑步', '读书', '洗澡', '遛狗', '打电话',
  '复习', '看剧', '做饭', '收拾房间', '回邮件', '体检', '理发', '充电', '冥想', '记账',
];
const used = new Set(TITLES.map((t) => colorOf(t)));
ok(used.size >= 3, `★ 负对照：20 个不同标题至少散出 3 种颜色（实际 ${used.size} 种：${[...used].join(',')}）`);
ok([...used].every((c) => PALETTE.includes(c)), '散出来的颜色都在调色板里');
// 颜色不能跟着 id 跳（用 id 取色的话，改一条日程颜色就会变，看着很吵）
const sameTitle = [mk({ title: '开会' }), { ...mk({ title: '开会' }), id: 's_999' }];
ok(blocksOf(sameTitle, TODAY, AX).every((b) => b.color === colorOf('开会')), '★ 负对照：颜色只跟标题走，不跟 id 走');

// ---------- 收尾 ----------
console.log(`\n===== 结束：${pass} 通过 / ${fail} 失败 =====`);
if (fail === 0) {
  console.log('结论：周视图布局数学 OK，可以进 Task 3（表单支持时段）。');
} else {
  console.log('结论：有失败项，先修好再往下走。');
}
process.exit(fail === 0 ? 0 : 1);
