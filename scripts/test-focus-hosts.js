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
const doh = require('../src/main/focus/doh');

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

// ---------- 9. 安全 DNS（DoH）检测：纯函数部分（Task 7）----------
section('9. 安全 DNS 检测：读浏览器配置文本 → 判断开着没');
{
  // ① 显式关掉
  ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"off"}}') === 'off', '显式写着 off → 关着');

  // ★ 负对照：没这个字段时**不许瞎判成「关着」**
  //   判成 off 就等于「放心，屏蔽会生效」，结果主人发现网站照样能开 ——
  //   这是「悄悄给一个错答案」，比说「不知道」坏得多。
  okNeg(doh.parseChromePrefs('{}') === 'unknown', '★ 配置里根本没这一项 → 必须说「不知道」，不许当成关着');
  okNeg(doh.parseChromePrefs('{"other":1}') === 'unknown', '★ 有别的配置但没有 DoH → 还是「不知道」');

  // ② 开着
  ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"secure"}}') === 'on', '强制安全 DNS → 开着');
  ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"automatic"}}') === 'on', '自动模式也算开着');

  // ★ 负对照：不认识的取值不许猜
  okNeg(doh.parseChromePrefs('{"dns_over_https":{"mode":"what"}}') === 'unknown', '★ 取值不认识 → 「不知道」，不猜');
  okNeg(doh.parseChromePrefs('{"dns_over_https":"yes"}') === 'unknown', '★ 结构不对（不是对象）→ 「不知道」');

  // ★ 负对照：坏输入不许抛异常
  okNeg(doh.parseChromePrefs('{oops') === 'unknown', '★ 坏 JSON 不崩，返回「不知道」');
  okNeg(doh.parseChromePrefs('') === 'unknown', '★ 空文本不崩');
  okNeg(doh.parseChromePrefs(null) === 'unknown', '★ null 不崩');
  okNeg(doh.parseChromePrefs(undefined) === 'unknown', '★ undefined 不崩');
  okNeg(doh.parseChromePrefs(12345) === 'unknown', '★ 数字不崩');
}

section('10. 安全 DNS：注册表策略（企业强制）也要认');
{
  const sample = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome',
    '    DnsOverHttpsMode    REG_SZ    secure',
    '',
  ].join('\r\n');

  ok(doh.parseRegQuery(sample) === 'on', '注册表里策略是 secure → 开着');

  const offSample = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\r\n    DnsOverHttpsMode    REG_SZ    off\r\n';
  ok(doh.parseRegQuery(offSample) === 'off', '注册表里策略是 off → 关着');

  // ★ 负对照：查不到（reg query 会输出「错误: 找不到指定的注册表项」）不许当成 off
  okNeg(doh.parseRegQuery('错误: 系统找不到指定的注册表项或值。') === 'unknown',
    '★ 注册表里没这项 → 「不知道」，不许当成关着');
  okNeg(doh.parseRegQuery('') === 'unknown', '★ 空输出 → 「不知道」');
  okNeg(doh.parseRegQuery(null) === 'unknown', '★ null → 「不知道」');
  okNeg(doh.parseRegQuery('DnsOverHttpsMode    REG_SZ    ???') === 'unknown',
    '★ 取值不认识 → 「不知道」');
}

// ---------- 11. 区分两种「不知道」 ----------
// 这一段是「提示语曾经骗过人」的直接产物：
// 真机上 Chrome / Edge 都装了，但两个 Preferences 里都没有 dns_over_https 这一项，
// 而当时的提示语却说「没检测到 Chrome / Edge」—— 主人看到这句话会以为「我不用管了」，
// 实际上浏览器照样能绕过 hosts。所以「不知道」必须再分两种，各自说清。
section('11. prefsHasDoh：这份配置里到底有没有安全 DNS 这一项');
{
  ok(doh.prefsHasDoh('{"dns_over_https":{"mode":"off"}}') === true, '有这一项 → true');
  ok(doh.prefsHasDoh('{"dns_over_https":{"mode":"what"}}') === true, '★ 有这一项、但取值不认识 → 也是 true');
  ok(doh.prefsHasDoh('{}') === false, '没这一项 → false');
  ok(doh.prefsHasDoh('{"other":1}') === false, '有别的配置但没有它 → false');
  // ★ 负对照：坏输入不许抛异常
  okNeg(doh.prefsHasDoh('{oops') === false, '★ 坏 JSON → false，不崩');
  okNeg(doh.prefsHasDoh('') === false, '★ 空文本 → false');
  okNeg(doh.prefsHasDoh(null) === false, '★ null → false');
}

// ---------- 12. 提示语：四种情况必须说四句不同的话 ----------
// 主人该做的事不一样，糊成一句就是骗人。
section('12. adviceFor：提示语要「说清是哪种情况」');
{
  const on = doh.adviceFor('on', { names: ['Chrome'], installedCount: 1, sawPref: true });
  ok(on.includes('开着'), '① 开着 → 明说开着');
  ok(on.includes('关掉'), '① 开着 → 给出关掉的方法');
  ok(on.includes('Chrome'), '① 开着 → 点名是哪个浏览器');

  const off = doh.adviceFor('off', { names: ['Chrome'], installedCount: 1, sawPref: true });
  ok(off.includes('没开'), '② 关着 → 明说没开、屏蔽会生效');

  // ③ 装了浏览器，读到了这一项，但取值不认识
  const sawPref = doh.adviceFor('unknown', { names: ['Chrome', 'Edge'], installedCount: 2, sawPref: true });
  ok(sawPref.includes('取值不认识'), '③ 有这一项但读不懂 → 说「取值不认识」');
  okNeg(!sawPref.includes('没检测到'), '★ ③ 绝不能说出「没检测到浏览器」这句错话');

  // ④ 装了浏览器，但配置里压根没这一项（= 主人从没改过它）
  const noPref = doh.adviceFor('unknown', { names: ['Chrome', 'Edge'], installedCount: 2, sawPref: false });
  ok(noPref.includes('没有'), '④ 装了但没这一项 → 说「配置里没有这一项」');
  okNeg(!noPref.includes('没检测到'), '★ ④ 也不能说「没检测到浏览器」（这是真机上出现过的错话）');
  okNeg(noPref !== sawPref, '★ ③ 和 ④ 必须说不一样的话（不能糊成一句）');

  // ⑤ 一个浏览器都没装
  const none = doh.adviceFor('unknown', { names: [], installedCount: 0, sawPref: false });
  ok(none.includes('没检测到'), '⑤ 真的没装 → 才可以说「没检测到」');

  // ★ 负对照：四种情况的提示语两两不许相同（防「随便返回一句固定的」）
  const all = [on, off, sawPref, noPref, none];
  const uniq = new Set(all);
  okNeg(uniq.size === 5, '★ 五种情况的提示语两两不同（防返回固定一句话的假实现）');

  // ★ 负对照：不传 info 也不许崩
  okNeg(typeof doh.adviceFor('unknown') === 'string', '★ 不传 info 也不崩');
  okNeg(typeof doh.adviceFor('on', []) === 'string', '★ info 传成数组也不崩（旧调用方式）');
}

// ---------- 13. 用假世界跑一遍探测层（真机那种情况）----------
// createDetector 的探测依赖全可注入，所以能在没有 Chrome / Edge 的机器上
// 复现「装了但配置里没这一项」这个真实场景。
section('13. createDetector：假世界里复现真机情况');
{
  const fakePrefsNoDoh = JSON.stringify({ profile: { name: 'x' }, some_other_setting: 1 });

  function makeWorld({ chrome = true, edge = true, prefsText = fakePrefsNoDoh, regOut = null } = {}) {
    const files = {};
    const dirs = {};
    if (chrome) {
      dirs['C:\\LA\\Google\\Chrome\\User Data'] = ['Default'];
      files['C:\\LA\\Google\\Chrome\\User Data\\Default\\Preferences'] = prefsText;
    }
    if (edge) {
      dirs['C:\\LA\\Microsoft\\Edge\\User Data'] = ['Default'];
      files['C:\\LA\\Microsoft\\Edge\\User Data\\Default\\Preferences'] = prefsText;
    }
    return {
      env: { LOCALAPPDATA: 'C:\\LA' },
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p) || Object.prototype.hasOwnProperty.call(dirs, p),
      readText: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
      listDirs: (p) => {
        const names = dirs[p];
        if (!names) throw new Error('ENOENT');
        return names.map((n) => ({ name: n, isDirectory: () => true }));
      },
      regQuery: () => regOut,
    };
  }

  // 真机情况：两个浏览器都装了，但配置里都没有 dns_over_https
  const d1 = doh.createDetector(makeWorld()).detect();
  ok(d1.level === 'unknown', '两个都装了但没配 → 总状态「不知道」');
  ok(d1.browsers.filter((b) => b.installed).length === 2, '认出装了 2 个浏览器');
  ok(d1.sawPref === false, 'sawPref = false（确实没有这一项）');
  okNeg(!d1.advice.includes('没检测到'), '★ 提示语不能说「没检测到浏览器」（真机错话）');
  ok(d1.advice.includes('没有'), '提示语说清是「配置里没有这一项」');

  // 配置里明确写着开着
  const d2 = doh.createDetector(makeWorld({ prefsText: '{"dns_over_https":{"mode":"secure"}}' })).detect();
  ok(d2.level === 'on', '配置写着 secure → 总状态「开着」');
  ok(d2.advice.includes('开着'), '提示语说「开着」');

  // 配置里明确写着关掉
  const d3 = doh.createDetector(makeWorld({ prefsText: '{"dns_over_https":{"mode":"off"}}' })).detect();
  ok(d3.level === 'off', '配置写着 off → 总状态「关着」');

  // 一个浏览器都没装
  const d4 = doh.createDetector(makeWorld({ chrome: false, edge: false })).detect();
  ok(d4.level === 'unknown', '一个都没装 → 「不知道」');
  ok(d4.advice.includes('没检测到'), '一个都没装才说「没检测到」');

  // 企业策略强制开着 —— 即使浏览器自己说关着，也必须判「开着」
  const regOn =
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\r\n    DnsOverHttpsMode    REG_SZ    secure\r\n';
  const d5 = doh.createDetector(makeWorld({ prefsText: '{"dns_over_https":{"mode":"off"}}', regOut: regOn })).detect();
  okNeg(d5.level === 'on', '★ 浏览器说关着、企业策略说开着 → 以「开着」为准（策略优先级高）');
  ok(d5.policy === 'on', 'policy 字段也报「开着」');

  // ★ 负对照：探测层内部抛异常时，detect() 不许把异常抛出来
  const boom = doh.createDetector({
    env: { LOCALAPPDATA: 'C:\\LA' },
    exists: () => { throw new Error('boom'); },
    readText: () => { throw new Error('boom'); },
    listDirs: () => { throw new Error('boom'); },
    regQuery: () => { throw new Error('boom'); },
  });
  let threw = false;
  let d6 = null;
  try { d6 = boom.detect(); } catch { threw = true; }
  okNeg(threw === false, '★ 探测内部炸了，detect() 也不许抛异常');
  okNeg(d6 && typeof d6.advice === 'string', '★ 炸了也要给出一句人话，不能返回空');
}

// ---------- 14. shouldPopupForDoh：什么时候才值得弹窗打扰主人 ----------
// 这是一个**策略**函数（不是技术函数）：弹窗会打断主人，弹多了主人就学会闭眼点掉，
// 真需要看的那次反而看不见了。所以口径必须是「只在**确认开着**时才弹」。
section('14. shouldPopupForDoh：只在确认开着时才弹窗');
{
  ok(doh.shouldPopupForDoh('on') === true,
    '安全 DNS 确认开着 → 要弹窗（hosts 屏蔽会被整个绕过，不提醒等于白做）');
  // ★ 负对照三连：只有 'on' 才配弹窗，其余一律不弹
  okNeg(doh.shouldPopupForDoh('off') === false,
    '★ 负对照：确认关着 → 不许弹（没毛病就别打扰主人）');
  okNeg(doh.shouldPopupForDoh('unknown') === false,
    '★ 负对照：不知道 → 不许弹（真机上最常见，乱弹会训练出「闭眼点掉」）');
  okNeg(doh.shouldPopupForDoh(undefined) === false,
    '★ 负对照：坏输入 undefined → 不许弹、不许崩');
  okNeg(doh.shouldPopupForDoh('ON') === false,
    '★ 负对照：大小写不对（ON）→ 不许当「开着」（口径是严格相等）');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
