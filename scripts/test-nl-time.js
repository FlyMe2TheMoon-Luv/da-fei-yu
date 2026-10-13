// scripts/test-nl-time.js
// Task 7 · 中文大白话 → 日程草案 自检
//
// 用法：npm run test:nl-time
//
// 测试原则：不能只挑正常情况——必须专门测边界和反例。

const { parseSchedule } = require('../src/main/nl-time');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negPass = 0;
let negFail = 0;
function ok(cond, label, isNeg = false) {
  if (cond) {
    pass++;
    if (isNeg) negPass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    if (isNeg) negFail++;
    console.log(`  ✗ ${label}  ← 失败`);
  }
}
function section(t) { console.log(`\n${t}`); }

// 固定一个「好算的时间」：2026-10-12 周一 15:12:00
const NOW = new Date(2026, 9, 12, 15, 12, 0);

// 只比 want 里给出的字段（其余忽略）
function match(actual, want) {
  if (want === null) return actual === null;
  if (actual === null) return false;
  for (const k of Object.keys(want)) {
    const a = actual[k];
    const w = want[k];
    if (Array.isArray(w)) {
      if (!Array.isArray(a) || a.length !== w.length) return false;
      for (let i = 0; i < w.length; i++) if (a[i] !== w[i]) return false;
    } else if (a !== w) {
      return false;
    }
  }
  return true;
}

// ---------- 正例 ----------
const CASES = [
  { text: '30分钟后提醒我收衣服', want: { title: '收衣服', kind: 'point', time: '15:42', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '两个小时后提醒我开会', want: { title: '开会', kind: 'point', time: '17:12', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '半小时后提醒我喝水', want: { title: '喝水', kind: 'point', time: '15:42', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '一个半小时后叫我', want: { title: '叫我', kind: 'point', time: '16:42', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '今天下午3点提醒我交表', want: { title: '交表', kind: 'point', time: '15:00', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '明天早上8点提醒我吃药', want: { title: '吃药', kind: 'point', time: '08:00', repeat: 'once', date: '2026-10-13', confidence: 'high' } },
  { text: '后天晚上7点半提醒我拿快递', want: { title: '拿快递', kind: 'point', time: '19:30', repeat: 'once', date: '2026-10-14', confidence: 'high' } },
  { text: '明天下午2点到4点开会', want: { title: '开会', kind: 'span', time: '14:00', endTime: '16:00', repeat: 'once', date: '2026-10-13', confidence: 'high' } },
  { text: '上午9点到11点半写报告', want: { title: '写报告', kind: 'span', time: '09:00', endTime: '11:30', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '9:00-11:00 开会', want: { title: '开会', kind: 'span', time: '09:00', endTime: '11:00', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '每天早上8点提醒我吃药', want: { title: '吃药', kind: 'point', time: '08:00', repeat: 'daily', date: null, confidence: 'high' } },
  { text: '工作日早上9点提醒我打卡', want: { title: '打卡', kind: 'point', time: '09:00', repeat: 'weekdays', date: null, confidence: 'high' } },
  { text: '每周一三五早上9点提醒我开会', want: { title: '开会', kind: 'point', time: '09:00', repeat: 'weekly', weekdays: [1, 3, 5], date: null, confidence: 'high' } },
  { text: '每周二下午2点提醒我例会', want: { title: '例会', kind: 'point', time: '14:00', repeat: 'weekly', weekdays: [2], date: null, confidence: 'high' } },
  { text: '三点提醒我', want: { title: '提醒我', kind: 'point', time: '03:00', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  { text: '中午12点提醒我吃饭', want: { title: '吃饭', kind: 'point', time: '12:00', repeat: 'once', date: '2026-10-12', confidence: 'high' } },
];

section('① 正例：能听懂的说法');
for (const c of CASES) {
  const got = parseSchedule(c.text, NOW);
  ok(match(got, c.want), `${c.text} → ${JSON.stringify(c.want)}`);
}

// ---------- 负对照 ----------
section('② 负对照：不许瞎猜');

ok(parseSchedule('今天天气不错', NOW) === null,
  '「今天天气不错」→ null（有时间词但没有时刻）', true);
ok(parseSchedule('提醒我一下', NOW) === null,
  '「提醒我一下」→ null（有触发词但没有时刻）', true);
ok(parseSchedule('我明天要收衣服', NOW) === null,
  '「我明天要收衣服」→ null（有日期但没有时刻）', true);
ok(parseSchedule('11点到9点开会', NOW) === null,
  '「11点到9点开会」→ null（结束早于开始，跨天，不猜）', true);
ok(parseSchedule('', NOW) === null,
  '空串 → null', true);
ok(parseSchedule('25点提醒我', NOW) === null,
  '「25点」→ null（不存在的时刻）', true);
ok(parseSchedule('0分钟后提醒我', NOW) === null,
  '「0分钟后」→ null（0 分钟不算日程）', true);

// ---------- 收尾 ----------
console.log(`\n===== nl-time 自检结束：${pass} 通过 / ${fail} 失败 =====`);
console.log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
if (fail > 0) process.exit(1);
