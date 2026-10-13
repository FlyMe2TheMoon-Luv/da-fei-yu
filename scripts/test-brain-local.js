// scripts/test-brain-local.js
// Task 8 · 本地大脑自检
//
// 用法：npm run test:brain-local

const { respond } = require('../src/main/brain/local');

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

const NOW = new Date(2026, 9, 12, 15, 12, 0);

// ---------- ① 解析成功 → draft 齐全 + 复述 ----------
section('① 解析成功');
{
  const r = respond('30分钟后提醒我收衣服', { now: NOW, items: [] });
  ok(r.intent === 'add', '意图是 add');
  ok(r.draft && r.draft.title === '收衣服', 'draft.title = 收衣服');
  ok(r.draft && r.draft.time === '15:42', 'draft.time = 15:42');
  ok(r.reply.includes('收衣服'), '回复里复述了「收衣服」');
  ok(r.reply.includes('15:42') || r.reply.includes('30'), '回复里带时间（15:42 或 30 分钟）');
}

// ---------- ② 有触发词但没时刻 → 反问 ----------
section('② 有触发词无时刻 → 反问（负对照）');
{
  const r = respond('提醒我一下', { now: NOW, items: [] });
  ok(r.intent === 'add', '意图仍是 add');
  ok(r.draft === null, '★ draft 必须是 null（不能凭空建日程）', true);
  ok(r.reply.includes('几点'), '回复里带「几点」反问');
}

// ---------- ③ 问日程 ----------
section('③ 问日程');
{
  const items = [
    { title: '吃药', time: '08:00', repeat: 'daily', enabled: true },
    { title: '开会', time: '14:00', repeat: 'once', date: '2026-10-12', enabled: true },
  ];
  const r = respond('今天有什么事', { now: NOW, items });
  ok(r.intent === 'list', '意图是 list');
  ok(r.reply.includes('吃药'), '回复里出现「吃药」');
  ok(r.reply.includes('开会'), '回复里出现「开会」');
}

// ---------- ④ 问日程（空列表） ----------
section('④ 问日程（空列表 · 负对照）');
{
  const r = respond('今天有什么安排', { now: NOW, items: [] });
  ok(r.intent === 'list', '意图是 list');
  ok(!r.reply.includes('0 个'), '不能说「0 个」这种机器话', true);
  ok(!r.reply.includes('吃药'), '空列表时不能出现具体标题', true);
  ok(r.reply.length > 0, '回复非空');
}

// ---------- ⑤ 闲聊 ----------
section('⑤ 闲聊');
{
  const r = respond('你好呀', { now: NOW, items: [] });
  ok(r.intent === 'chat', '意图是 chat');
  ok(r.reply.length > 0, '回复非空');
}

// ---------- ⑥ 台词可复现 ----------
section('⑥ 台词可复现（负对照）');
{
  const r1 = respond('啦啦啦', { now: NOW, items: [] }, () => 0.3);
  const r2 = respond('啦啦啦', { now: NOW, items: [] }, () => 0.3);
  ok(r1.reply === r2.reply, '同样的 rand 必须出同样的台词', true);
}

// ---------- ⑦ 台词库无空串 ----------
section('⑦ 台词库无空串（负对照）');
{
  // 通过 require 拿到台词库常量（模块故意导出以便测试）
  const { PERSONA } = require('../src/main/brain/local');
  let emptyCount = 0;
  for (const group of Object.values(PERSONA)) {
    for (const line of group) {
      if (typeof line !== 'string' || line.trim() === '') emptyCount++;
    }
  }
  ok(emptyCount === 0, '台词库里没有空字符串', true);
}

// ---------- 收尾 ----------
console.log(`\n===== 本地大脑自检结束：${pass} 通过 / ${fail} 失败 =====`);
console.log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
if (fail > 0) process.exit(1);
