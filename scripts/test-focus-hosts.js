// scripts/test-focus-hosts.js
// 阶段 3 · Task 3 · hosts 文本操作自检（整份计划里最重要的一组负对照）
//
// 用法：npm run test-focus-hosts
//
// ── 为什么这是最危险的一段 ──
//   hosts 是系统文件。整文件覆盖 = 主人原有的 DNS 配置全没了 = 一堆网站打不开。
//   所以「改」和「删」都必须只动我们自己那几行，其余一字不差。
//   这条「一字不差」没法靠肉眼验证（谁能一眼看出少了空行？），
//   只能靠断言：删完必须和原文**逐字节相等**。
//
// ── 测试原则 ──
//   第 2 节全是负对照（原文不许丢、删完必须还原、没我们的东西不许动文件）。
//   hosts.js 是纯函数、不 require Electron，所以能穷举。

const hosts = require('../src/main/focus/hosts');

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

const { BEGIN_MARK, END_MARK } = hosts;

// 一份「像真的一样」的 hosts：CRLF 行尾、开头有注释、有本机条目、有局域网条目
const ORIGINAL =
  '# Copyright (c) 1993-2009 Microsoft Corp.\r\n' +
  '\r\n' +
  '127.0.0.1  localhost\r\n' +
  '::1        localhost\r\n' +
  '192.168.1.10  nas.local\r\n';

console.log('===== hosts 文本操作自检（hosts.js）=====');

// ---------- 1. 基本：插入 ----------
section('1. 插入标记块');
{
  const a = hosts.applyBlock(ORIGINAL, ['bilibili.com', 'www.bilibili.com']);
  ok(a.includes(BEGIN_MARK) && a.includes(END_MARK), '标记块（BEGIN / END）都在');
  ok(a.includes('0.0.0.0 bilibili.com'), '域名按 0.0.0.0 写进去了');
  ok(a.includes('0.0.0.0 www.bilibili.com'), '第二条也在');
  ok(hosts.detectEol(a) === '\r\n', '★ 原来是 CRLF，改完还是 CRLF（没把整个文件的行尾改掉）');
  ok(a.startsWith(ORIGINAL), '原有内容原封不动地在前面');
}

// ---------- 2. ★ 负对照：绝不能动主人的内容 ----------
section('2. ★ 负对照：原文一字不差');
{
  const a = hosts.applyBlock(ORIGINAL, ['bilibili.com', 'www.bilibili.com']);

  // 逐行比对：原文每一行都必须还在
  const origLines = ORIGINAL.split('\r\n');
  const missing = origLines.filter((l) => !a.includes(l));
  okNeg(missing.length === 0, `★ 原文每一行都还在（丢 ${missing.length} 行）`);

  // 最强的一条：删掉我们加的块，必须和原文**逐字节相等**
  const back = hosts.removeBlock(a);
  okNeg(back === ORIGINAL, '★ 删完和原文逐字节相等（这是「能精确还原」的唯一证据）');

  // 没我们的东西时，删函数必须原样返回 —— 不许「顺手清理」
  okNeg(hosts.removeBlock(ORIGINAL) === ORIGINAL, '★ 没有我们的块时，removeBlock 原样返回');
}

// ---------- 3. 重复插入 = 替换，不叠加 ----------
section('3. 再插一次 → 是替换不是追加（否则块会越堆越多）');
{
  const a = hosts.applyBlock(ORIGINAL, ['bilibili.com', 'www.bilibili.com']);
  const b = hosts.applyBlock(a, ['zhihu.com']);

  okNeg(b.split(BEGIN_MARK).length === 2, '★ 只有一个标记块（没插出第二个）');
  okNeg(!b.includes('bilibili.com'), '★ 第二次是替换，旧域名清掉了');
  ok(b.includes('0.0.0.0 zhihu.com'), '新域名在');
  ok(hosts.removeBlock(b) === ORIGINAL, '替换后再删，依然精确还原原文');
}

// ---------- 4. 读回当前屏蔽了哪些域名 ----------
section('4. blockedDomains：能读回当前屏蔽清单');
{
  const a = hosts.applyBlock(ORIGINAL, ['bilibili.com', 'www.bilibili.com']);
  const list = hosts.blockedDomains(a);
  ok(list.length === 2, `读回 2 条（实际 ${list.length}）`);
  ok(list.includes('bilibili.com') && list.includes('www.bilibili.com'), '两条都对');

  // 手写的块里带注释行 —— 注释不能被当成域名
  const hand = 'x\r\n' + BEGIN_MARK + '\r\n# 我自己加的注释\r\n0.0.0.0 a.com\r\n\r\n0.0.0.0 b.com\r\n' + END_MARK + '\r\n';
  ok(hosts.blockedDomains(hand).length === 2, '★ 块里的注释行 / 空行不算域名');

  ok(hosts.blockedDomains(ORIGINAL).length === 0, '没块时读回空数组');
  ok(hosts.blockedDomains('').length === 0, '空文本读回空数组');
  ok(hosts.blockedDomains(null).length === 0, '★ null 也不崩');
}

// ---------- 5. ★ 负对照：崩溃残留（半截块）必须能清干净 ----------
section('5. ★ 负对照：上次写到一半崩了，半截块也要能清');
{
  // 只有 BEGIN 没有 END
  const half = '127.0.0.1 localhost\r\n' + BEGIN_MARK + '\r\n0.0.0.0 x.com\r\n';
  const cleaned = hosts.removeBlock(half);
  okNeg(!hosts.hasBlock(cleaned), '★ 半截块被清干净');
  ok(cleaned.includes('127.0.0.1 localhost'), '块之前的正常内容留着');

  // 只有 END 没有 BEGIN（更奇怪的情况）→ 不该乱删
  const weird = '127.0.0.1 localhost\r\n' + END_MARK + '\r\n';
  ok(hosts.removeBlock(weird) === weird, '★ 只有 END 没有 BEGIN 时不动文件（不乱删）');

  // 检测函数
  ok(hosts.hasBlock('x\r\n' + BEGIN_MARK + '\r\n') === true, 'hasBlock 认得出半截块');
  ok(hosts.hasBlock(ORIGINAL) === false, '干净文件 hasBlock = false');
  ok(hosts.hasBlock('') === false, '空文本 hasBlock = false');
  ok(hosts.hasBlock(null) === false, '★ null 也不崩');
}

// ---------- 6. 空 / 非法输入 ----------
section('6. 空文件、非法域名');
{
  ok(hosts.applyBlock('', ['a.com']).includes('0.0.0.0 a.com'), '空文件也能插入');
  ok(hosts.removeBlock('') === '', '空进空出');

  // ★ 负对照：域名不合法时，宁可不写，也不许写进去一行坏数据
  okNeg(hosts.applyBlock(ORIGINAL, ['a b.com']) === ORIGINAL, '★ 非法域名 → 原样返回，不落盘');
  okNeg(hosts.applyBlock(ORIGINAL, []) === ORIGINAL, '★ 空清单 → 原样返回');
  okNeg(hosts.applyBlock(ORIGINAL, ['http://']) === ORIGINAL, '★ 只有协议、没有主机名 → 原样返回');

  // 重复域名只写一次
  const dup = hosts.applyBlock(ORIGINAL, ['a.com', 'A.COM', 'https://a.com/x']);
  ok(hosts.blockedDomains(dup).length === 1, '★ 重复域名去重，只写一行');

  ok(typeof hosts.applyBlock(null, ['a.com']) === 'string', '★ text 为 null 也不崩');
  ok(hosts.removeBlock(123) === '', '★ text 是数字也不崩');
}

// ---------- 7. LF 行尾的文件 ----------
section('7. LF 行尾（非 Windows 风格）也要认');
{
  const LF = '127.0.0.1 localhost\n';
  ok(hosts.detectEol(LF) === '\n', 'LF 文件认得出是 LF');
  ok(hosts.detectEol(ORIGINAL) === '\r\n', 'CRLF 文件认得出是 CRLF');

  const lf = hosts.applyBlock(LF, ['x.com']);
  ok(hosts.detectEol(lf) === '\n', '★ LF 文件改完还是 LF');
  okNeg(hosts.removeBlock(lf) === LF, '★ LF 文件也能精确还原');

  // 混用行尾：不许炸
  const mixed = 'a\r\nb\nc\r\n';
  const m = hosts.applyBlock(mixed, ['x.com']);
  ok(typeof m === 'string' && hosts.hasBlock(m), '★ 混用行尾的文件也不炸');
  ok(hosts.blockedDomains(m).length === 1, '混用行尾也能读回域名');
}

// ---------- 8. ★ 负对照：不能写出「永远返回原文」的假实现 ----------
section('8. ★ 负对照：该改的时候必须真的改');
{
  const a = hosts.applyBlock(ORIGINAL, ['bilibili.com']);
  okNeg(a !== ORIGINAL, '★ 有合法域名时，结果必须和原文不同（防假实现）');
  okNeg(a.length > ORIGINAL.length, '★ 结果确实变长了');
  okNeg(hosts.hasBlock(a) === true, '★ 结果里确实有块');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
