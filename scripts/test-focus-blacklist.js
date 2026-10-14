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

  // 会话号（Task 6）：提权助手靠它认领「这趟专注的收工信号」。
  // 这条断言看着小，但少了它，「sid 被谁删掉」要等到真机验收才会暴露。
  const w5 = bl.withDefaults({
    session: { endsAt: 1700000000000, state: 'running', minutes: 25, startedAt: 1, sid: 'abc-123' },
  });
  ok(w5.session && w5.session.sid === 'abc-123', '★ 会话号跟着 session 一起存活（助手靠它认领收工信号）');

  const w6 = bl.withDefaults({
    session: { endsAt: 1700000000000, state: 'running', minutes: 25, startedAt: 1, sid: 42 },
  });
  okNeg(w6.session !== null && w6.session.sid === null, '★ 会话号不是字符串 → 退化成 null，不崩');
}

// ---------- 8. killListOf：真正要交给助手去关的名单（Task 8）----------
// 这是「不许把自己杀了 / 不许把系统杀了」这条红线的守门员之一。
//
// ⚠ 一个必须说清的事实（不然这节的负对照是假的）：
//   `killListOf` 里那句 `if (isProtectedExe(...)) continue` 目前是**纯冗余** ——
//   `normalizeExe` 内部已经拒收保护进程了，所以把它注释掉，本节**照样全绿**（真的试过）。
//   也就是说：本节能证明「危险项到不了助手手里」，但**证明不了是哪一道闸拦的**。
//   这不是测试写坏了，是链子上确实有两道闸，而它们口径完全一致。
//
//   那为什么还留着这道冗余？因为它防的是**将来**：normalizeExe 的拒收规则属于
//   「主人填的东西能不能收」（界面语义），将来可能因为界面需求放宽；
//   而这条链子的尽头是助手**无条件照杀**。到那时这里是唯一还站着的闸。
//   所以本节的价值是「钉住契约」（结果里永远没有危险项），不是「钉住某一行代码」。
section('8. killListOf：交给助手的名单（最后一道闸）');
{
  // ① 正常：干净的名单原样过去
  const k1 = bl.killListOf(['steam.exe', 'wechat.exe']);
  ok(Array.isArray(k1), '返回的是数组');
  ok(k1.length === 2 && k1.includes('steam.exe') && k1.includes('wechat.exe'), '正常名单原样通过');

  // ★ 负对照：混进保护进程 → 必须只剩好人
  const k2 = bl.killListOf(['steam.exe', 'electron.exe', 'explorer.exe']);
  okNeg(k2.length === 1 && k2[0] === 'steam.exe',
    '★ 混进 electron.exe / explorer.exe → 只剩 steam.exe（不许把自己和桌面杀了）',
    ` → ${JSON.stringify(k2)}`);

  // ★ 负对照：系统关键进程一个都不许漏
  const allBad = ['csrss.exe', 'winlogon.exe', 'lsass.exe', 'services.exe',
    'wininit.exe', 'smss.exe', 'dwm.exe', 'svchost.exe', 'explorer.exe'];
  const k3 = bl.killListOf(allBad);
  okNeg(k3.length === 0, '★ 全是系统关键进程 → 返回空数组（一个都不放行）',
    ` → ${JSON.stringify(k3)}`);

  // ★ 负对照：空 → 空
  okNeg(bl.killListOf([]).length === 0, '★ 空名单 → 空（不能凭空造出东西）');

  // ★ 大小写归一：绕过界面直接写 'STEAM.EXE' 也要能识别
  const k4 = bl.killListOf(['STEAM.EXE']);
  okNeg(k4.length === 1 && k4[0] === 'steam.exe',
    '★ 大写也认（绕过界面写的脏数据要归一）', ` → ${JSON.stringify(k4)}`);

  // ★ 负对照：'ELECTRON.EXE' 大写形态一样要拦住 ——
  //   如果实现里只比对小写字符串、忘了先归一，这条会红。
  okNeg(bl.killListOf(['ELECTRON.EXE']).length === 0, '★ 大写的 ELECTRON.EXE 也要拦住');

  // ★ 负对照：'C:\path\to\electron.exe' 带路径形态也要拦住
  okNeg(bl.killListOf(['C:\\Program Files\\Foo\\electron.exe']).length === 0,
    '★ 带路径的 electron.exe 也要拦住（不能只看字符串开头）');

  // 去重
  const k5 = bl.killListOf(['steam.exe', 'STEAM.EXE', 'steam.exe']);
  ok(k5.length === 1, '★ 重复项去重（别让助手白跑几遍）', ` → ${JSON.stringify(k5)}`);

  // ★ 负对照：坏输入不许抛异常（focus.json 被改坏时桌宠不能起不来）
  okNeg(bl.killListOf(null).length === 0, '★ null → 空数组，不崩');
  okNeg(bl.killListOf(undefined).length === 0, '★ undefined → 空数组，不崩');
  okNeg(bl.killListOf('steam.exe').length === 0, '★ 传字符串（不是数组）→ 空数组，不崩');
  okNeg(bl.killListOf([null, 123, '', '  ', {}]).length === 0,
    '★ 数组里全是垃圾 → 空数组，不崩');

  // 垃圾和好货混在一起 → 只留好货
  const k6 = bl.killListOf([null, 'steam.exe', '', 'electron.exe', 42, 'wechat.exe']);
  ok(k6.length === 2 && k6.includes('steam.exe') && k6.includes('wechat.exe'),
    '★ 垃圾混好货 → 只留两个好货', ` → ${JSON.stringify(k6)}`);

  // ★★ 最强的一条：killListOf 的结果必须**恒等于**「逐项过 isProtectedExe 之后剩下的」。
  //    这是防「两套规则各写一遍、慢慢长歪」—— 比如 killListOf 里漏抄了某个保护项，
  //    或者手写了一个不同的判断，这条会红。
  const sample = ['steam.exe', 'electron.exe', 'wechat.exe', 'node.exe', 'explorer.exe',
    'notepad.exe', 'svchost.exe', 'dingtalk.exe'];
  const expected = sample.filter((x) => !bl.isProtectedExe(x));
  const actual = bl.killListOf(sample);
  okNeg(JSON.stringify(actual) === JSON.stringify(expected),
    '★★ killListOf 与 isProtectedExe 口径完全一致（防两套规则长歪）',
    ` → 实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

  // ★ 负对照：好人不许被误拦 —— 防「一律返回空数组」这种假实现
  okNeg(bl.killListOf(['steam.exe', 'wechat.exe', 'notepad.exe', 'chrome.exe']).length === 4,
    '★ 好人不许被误拦（防「一律清空」的假实现）');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
