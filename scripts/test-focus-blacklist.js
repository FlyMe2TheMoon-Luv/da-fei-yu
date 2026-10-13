// scripts/test-focus-blacklist.js
// 阶段 3 · Task 1 · 专注黑名单校验自检
//
// 用法：npm run test-focus-blacklist
//
// ── 为什么值得单独测 ──
//   黑名单里混进一个 electron.exe / explorer.exe，专注一开始就会
//   「把自己杀了」或者「把桌面杀了」——后果比「没生效」严重得多。
//   这类「规范化 + 拒收」的代码又最容易写漏边界（带路径的、大写的、带端口的）。
//   blacklist.js 是纯函数、不 require Electron，所以能穷举。
//
// ── 测试原则（HANDOFF 第六节第 19 条）──
//   不能只测「正常能过」。第 3、4 节专门测「坏东西必须被拒」，
//   第 3 节末尾还有一条反向的负对照（好人不许被误拦）——
//   否则「一律返回 false」这种假实现也能全绿。

const bl = require('../src/main/focus/blacklist');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negTotal = 0;
let negPass = 0;

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
// 负对照：单独计数，最后必须 100% 通过
function okNeg(cond, label) {
  negTotal++;
  if (cond) negPass++;
  ok(cond, label);
}
function section(t) { console.log(`\n${t}`); }

const d = (raw) => bl.normalizeDomain(raw);
const e = (raw) => bl.normalizeExe(raw);

console.log('===== 专注黑名单校验自检（blacklist.js）=====');

// ---------- 1. 域名规范化 ----------
section('1. 域名规范化：把主人随手粘的一行，洗成能用的域名');
{
  ok(d('bilibili.com').ok === true && d('bilibili.com').value === 'bilibili.com', '普通域名原样通过');
  ok(d('https://www.bilibili.com/video/BV1xx?t=1').value === 'www.bilibili.com', '去协议 / 去路径 / 去查询串');
  ok(d('http://bilibili.com:443/').value === 'bilibili.com', '去协议 + 去端口 + 去路径');
  ok(d('BILIBILI.COM').value === 'bilibili.com', '大写转小写');
  ok(d('  bilibili.com  ').value === 'bilibili.com', '去首尾空格');
  ok(d('www.zhihu.com').value === 'www.zhihu.com', '保留 www 前缀（它和裸域名是两条）');
  ok(d('a-b.c-d.com').value === 'a-b.c-d.com', '中间的连字符允许');
  ok(d('bilibili.com.').value === 'bilibili.com', '末尾多写一个点也认');
}

// ---------- 2. exe 规范化 ----------
section('2. 程序名规范化：只留文件名、转小写、补 .exe');
{
  ok(e('steam.exe').ok === true && e('steam.exe').value === 'steam.exe', '普通程序名原样通过');
  ok(e('C:\\Program Files\\Steam\\steam.exe').value === 'steam.exe', '带完整路径 → 只留文件名');
  ok(e('Steam.EXE').value === 'steam.exe', '大写转小写');
  ok(e('steam').value === 'steam.exe', '不写扩展名 → 自动补 .exe');
  ok(e('  notepad.exe  ').value === 'notepad.exe', '去首尾空格');
  ok(e('/usr/bin/foo.exe').value === 'foo.exe', '正斜杠路径也认');
  ok(e('notepad++').value === 'notepad++.exe', '名字里有加号也认');
}

// ---------- 3. ★ 负对照：危险进程必须被拒 ----------
section('3. ★ 负对照：会伤到系统 / 自己的进程，一个都不许进黑名单');
{
  // 3.1 静态保护名单里的每一个都要拦住
  const mustBlock = [
    'electron.exe', 'node.exe',
    'explorer.exe', 'csrss.exe', 'winlogon.exe', 'lsass.exe', 'services.exe',
    'wininit.exe', 'smss.exe', 'dwm.exe', 'svchost.exe',
  ];
  let blocked = 0;
  for (const name of mustBlock) {
    if (e(name).ok === false) blocked++;
    else console.log(`     漏网：${name}`);
  }
  okNeg(blocked === mustBlock.length, `★ 危险进程全部被拒（${blocked}/${mustBlock.length}）`);

  // 3.2 导出名单本身也要自洽
  const listOk = Array.isArray(bl.PROTECTED_EXES) &&
    bl.PROTECTED_EXES.every((n) => bl.isProtectedExe(n) === true && e(n).ok === false);
  okNeg(listOk, '★ PROTECTED_EXES 里每一项都真的被拦（不是摆着好看的）');

  // 3.3 桌宠「自己」的进程名 —— 动态取，不写死
  okNeg(typeof bl.SELF_EXE === 'string' && bl.SELF_EXE.length > 0, 'SELF_EXE 能取到当前进程名');
  okNeg(bl.isProtectedExe(bl.SELF_EXE) === true, `★ 拒收桌宠自身进程名（${bl.SELF_EXE}）`);
  okNeg(e(bl.SELF_EXE).ok === false, '★ normalizeExe 也拒收自身进程名');

  // 3.4 大小写 / 带路径 也拦得住（防「只比对原样字符串」的假实现）
  okNeg(e('EXPLORER.EXE').ok === false, '★ 大写 EXPLORER.EXE 也拦得住');
  okNeg(e('C:\\Windows\\explorer.exe').ok === false, '★ 带路径的 explorer.exe 也拦得住');

  // 3.5 ★ 反向负对照：好人不能被误拦
  //     （没有这一条的话，「全部返回 false」这种假实现也能全绿）
  const goodOnes = ['steam.exe', 'wechat.exe', 'notepad.exe', 'chrome.exe', 'notepad++.exe'];
  const goodOk = goodOnes.every((n) => e(n).ok === true);
  ok(goodOk, '普通软件不受影响（防「一律拒收」的假实现）');
}

// ---------- 4. ★ 负对照：非法输入必须被拒 ----------
section('4. ★ 负对照：乱七八糟的输入不许当成合法条目');
{
  okNeg(d('').ok === false, '★ 空域名拒收');
  okNeg(d('   ').ok === false, '★ 全空格拒收');
  okNeg(d('http://').ok === false, '★ 只有协议、没有主机名');
  okNeg(d('这不是域名').ok === false, '★ 中文不是域名');
  okNeg(d('a b.com').ok === false, '★ 含空格');
  okNeg(d('localhost').ok === false, '★ 没有点的不当域名（免得误伤 hosts 自己的条目）');
  okNeg(d('*.bilibili.com').ok === false, '★ 通配符拒收（hosts 不支持，写了也是白写）');
  okNeg(d('bilibili').ok === false, '★ 只有一段、没有点');
  okNeg(d(123).ok === false, '★ 不是字符串（数字）也不崩');
  okNeg(d(null).ok === false, '★ null 也不崩');

  okNeg(e('').ok === false, '★ 空程序名拒收');
  okNeg(e('   ').ok === false, '★ 全空格拒收');
  okNeg(e('steam.bat').ok === false, '★ 非 .exe 程序拒收（我们只关 exe）');
  okNeg(e('a b.exe').ok === false, '★ 含空格的程序名');
  okNeg(e(42).ok === false, '★ 不是字符串（数字）也不崩');
  okNeg(e(null).ok === false, '★ null 也不崩');
}

// ---------- 5. 整份名单的清洗 ----------
section('5. sanitizeBlacklist：清洗整份名单 + 去重 + 记账');
{
  const s = bl.sanitizeBlacklist({
    domains: ['https://www.bilibili.com/x', 'BILIBILI.com', 'bilibili.com'],
    exes: ['steam.exe', 'electron.exe', 'steam.exe'],
  });
  ok(s.domains.length === 2, `域名去重后 2 条（实际 ${s.domains.length}）`);
  ok(s.exes.length === 1 && s.exes[0] === 'steam.exe', '程序名去重后只剩 steam.exe');
  okNeg(s.rejected.length === 1 && s.rejected[0].input === 'electron.exe',
    '★ 被拒的 electron.exe 记进了 rejected（能告诉主人为什么没收）');
  ok(s.ok === false, '有被拒项时 ok = false');

  const s2 = bl.sanitizeBlacklist(null);
  ok(s2.domains.length === 0 && s2.exes.length === 0 && s2.ok === true, 'null → 空名单且 ok');

  const s3 = bl.sanitizeBlacklist({ domains: 'not-an-array', exes: 42 });
  ok(s3.domains.length === 0 && s3.exes.length === 0, '★ 字段类型不对时不崩、当空处理');

  const s4 = bl.sanitizeBlacklist({ domains: ['a.com'], exes: ['a b.exe', 'ok.exe'] });
  okNeg(s4.exes.length === 1 && s4.exes[0] === 'ok.exe', '★ 坏的丢掉、好的留下');

  // 重复调用结果必须稳定（防「每次顺序不一样」）
  const r1 = JSON.stringify(bl.sanitizeBlacklist({ domains: ['b.com', 'a.com', 'b.com'] }).domains);
  const r2 = JSON.stringify(bl.sanitizeBlacklist({ domains: ['b.com', 'a.com', 'b.com'] }).domains);
  ok(r1 === r2, '同样的输入两次，结果完全一样');
}

// ---------- 6. withDefaults：读一份可能坏掉的文件时的兜底 ----------
section('6. withDefaults：文件坏 / 缺字段时回落默认值');
{
  const w = bl.withDefaults(null);
  ok(Array.isArray(w.domains) && w.domains.length === 0, '默认 domains 是空数组');
  ok(JSON.stringify(w.presets) === '[25,45,60]', '默认时长预设是 25 / 45 / 60');
  ok(w.lastMinutes === 25, '默认上次时长是 25');
  ok(w.session === null, '默认没有进行中的专注');

  const w2 = bl.withDefaults({
    exes: ['steam.exe', 'electron.exe'],
    presets: 'abc',
    lastMinutes: -5,
    session: { endsAt: 'garbage' },
  });
  okNeg(w2.exes.length === 1 && w2.exes[0] === 'steam.exe', '★ 从文件读进来的危险进程也被挡掉');
  ok(JSON.stringify(w2.presets) === '[25,45,60]', '★ 坏预设回落默认');
  ok(w2.lastMinutes === 25, '★ 负数时长回落 25');
  ok(w2.session === null, '★ 坏 session 回落 null');

  const w3 = bl.withDefaults({ lastMinutes: 45, session: { endsAt: 1700000000000, state: 'running', minutes: 45, startedAt: 1 } });
  ok(w3.lastMinutes === 45, '合法时长原样保留');
  ok(w3.session !== null && w3.session.state === 'running', '合法 session 原样保留');

  const w4 = bl.withDefaults({ session: { endsAt: 1700000000000, state: 'idle' } });
  ok(w4.session === null, '★ state 不是 running 的 session 不收（只认进行中的）');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
