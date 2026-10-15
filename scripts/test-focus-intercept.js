// scripts/test-focus-intercept.js
// 阶段 3 · Task 7 · 拦截链纯逻辑自检（intercept.js）
//
// 用法：npm run test:focus-intercept
//
// ── 这一层在防什么 ──
//   它是「读 hosts → 算新内容 → 交给提权助手」中间的那一段。
//   出错的话，后果不是「功能没生效」，而是**主人的 hosts 被写坏**。
//   所以本轮的重点全在「坏情况下的行为」：
//     ★ 读不到 hosts 时，必须说「不知道」，**绝不能当成空文件**
//       （当成空文件 → 拿一份只有标记块的内容覆盖整个文件 → 主人的 DNS 配置全没了）
//     ★ 一个合法域名都没有时，**不许去改文件**
//     ★ 「清残留」必须用 restore 模式，用 session 模式会把脏的当原始内容备份
//
// ── 为什么能跑纯 Node ──
//   intercept.js 刻意不 require electron，只用 fs + 两个纯函数模块。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ic = require('../src/main/focus/intercept');
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

// ---------- 测试数据 ----------

// 一份「脏」的 hosts：CRLF + UTF-8 中文 + GBK 中文 + 二进制字节
const ORIGINAL = Buffer.concat([
  Buffer.from('# fake hosts\r\n', 'latin1'),
  Buffer.from('127.0.0.1 localhost\r\n', 'latin1'),
  Buffer.from('127.0.0.1 x ', 'latin1'),
  Buffer.from([0xe6, 0xb5, 0x8b, 0xe8, 0xaf, 0x95]),
  Buffer.from(' # ', 'latin1'),
  Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  Buffer.from(' # ', 'latin1'),
  Buffer.from([0x80, 0x81, 0xfe, 0xff]),
  Buffer.from('\r\n', 'latin1'),
]);
const ORIGINAL_TEXT = ORIGINAL.toString('latin1');

const PATHS = {
  hostsPath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
  backupPath: 'C:\\fake\\hosts.backup',
  ctlPath: 'C:\\fake\\focus-ctl.json',
  hbPath: 'C:\\fake\\focus-hb.json',
  logPath: 'C:\\fake\\focus-helper.log',
};

const SESSION = { sid: 'sid-1', endsAt: 2000 };

const tmpDirs = [];
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-intercept-'));
  tmpDirs.push(dir);
  return path.join(dir, 'hosts');
}

console.log('===== 拦截链纯逻辑自检（intercept.js）=====');

// ---------- 1. hosts 读写必须逐字节往返 ----------
section('1. hosts 读写：latin1 逐字节往返');
{
  const p = tmpFile();
  fs.writeFileSync(p, ORIGINAL);

  const text = ic.readHostsText(p);
  ok(typeof text === 'string', '读得回来');
  okNeg(Buffer.from(text, 'latin1').equals(ORIGINAL), '★ 读出来再编码回去，和原文件逐字节相同');
  okNeg(Buffer.from(text, 'utf8').equals(ORIGINAL) === false, '★ 用 UTF-8 读会丢字节（所以必须 latin1）');

  ic.writeHostsText(p, text);
  okNeg(fs.readFileSync(p).equals(ORIGINAL), '★ 写回去之后文件一个字节都没变');
}

// ---------- 1b. ★ 负对照：非 latin1 字符必须被拒绝 ----------
section('1b. ★ 负对照：hosts 内容里有非 latin1 字符 → 拒绝写入');
{
  // 这个坑是端到端自检抓出来的：沙箱 hosts 里写了一句中文，
  // Buffer.from(str,'latin1') 把中文截断成任意字节，其中恰好有 0x0D（回车），
  // 于是「注释里的一小段」凭空变成了一个换行 —— 还原后文件多了一行，却没有任何报错。
  const p = tmpFile();
  fs.writeFileSync(p, ORIGINAL);

  let threw = false;
  let msg = '';
  try {
    ic.writeHostsText(p, '# ok\r\n中文注释\r\n');
  } catch (err) {
    threw = true;
    msg = (err && err.message) || '';
  }

  okNeg(threw === true, '★ 含中文的内容被拒绝写入（宁可报错，也不要静默写坏）');
  okNeg(msg.includes('latin1'), '★ 报错说清了原因（提到了 latin1）');
  okNeg(fs.readFileSync(p).equals(ORIGINAL), '★ 被拒绝时文件一个字节都没动');

  // 反过来：纯 latin1 的字符串（含 0x80~0xFF 的单字节）必须能正常写
  const okText = '# \u00e9\u00e8\r\n127.0.0.1 localhost\r\n';
  ic.writeHostsText(p, okText);
  okNeg(ic.readHostsText(p) === okText, '★ 合法 latin1 内容（0x80~0xFF 单字节）照常能写');
}

// ---------- 2. ★ 读不到 ≠ 空文件 ----------
section('2. ★ 负对照：读不到 hosts 时必须说「不知道」，绝不许当成空文件');
{
  const missing = tmpFile();          // 造了目录但没造文件
  const r = ic.readHostsText(missing);

  okNeg(r === null, '★ 文件不存在 → 返回 null（不是空串）');
  okNeg(r !== '', '★ 不是空串 —— 空串会让上层以为「hosts 本来就是空的」，然后整个覆盖掉');

  // 对比：真的存在一个空文件时，返回的才是空串
  const empty = tmpFile();
  fs.writeFileSync(empty, Buffer.alloc(0));
  okNeg(ic.readHostsText(empty) === '', '★ 文件真的存在且为空 → 这时才返回空串（两者必须能区分）');
}

// ---------- 2b. ★ 读失败要留下「为什么」 ----------
section('2b. ★ 读不到时要留下原因（错误码），读成功时必须清掉旧原因');
{
  const missing = tmpFile();          // 造了目录但没造文件
  okNeg(ic.readHostsText(missing) === null, '★ 读不存在的文件 → null');

  const info = ic.readError();
  okNeg(!!info && info.code === 'ENOENT', `★ 失败原因记下来了：ENOENT（实际 ${info && info.code}）`);
  okNeg(!!info && String(info.path).includes('focus-intercept-'), '★ 原因里带着路径，方便定位是哪个文件');

  // ★ 关键负对照：读成功之后，上一次的失败原因必须消失
  const good = tmpFile();
  fs.writeFileSync(good, Buffer.from('127.0.0.1 localhost\n', 'latin1'));
  ok(ic.readHostsText(good) === '127.0.0.1 localhost\n', '再读一个正常文件 → 成功');
  okNeg(ic.readError() === null, '★ 读成功后旧原因被清掉（否则会拿上次的错去解释这次）');

  // ★ 翻译成人话：不同错误码必须给出不同的话
  const eAccess = ic.explainReadError({ code: 'EACCES' });
  const eNoent = ic.explainReadError({ code: 'ENOENT' });
  const eBusy = ic.explainReadError({ code: 'EBUSY' });
  const eOther = ic.explainReadError({ code: '' });
  okNeg(new Set([eAccess, eNoent, eBusy, eOther]).size === 4,
    '★ 四种错误码 → 四句不同的话（不许都吐同一句）');
  okNeg(/信任区/.test(eAccess), '★ EACCES 的话里要明确告诉主人「加入信任区」这一步');
  ok(ic.explainReadError({ code: 'EPERM' }) === eAccess, 'EPERM 和 EACCES 归为同一类（都是「被拒绝」）');
  okNeg(ic.explainReadError(null) === eOther, '★ 没给原因时归到「没给出具体原因」，不许冒充「被拒绝」');
}

// ---------- 3. 算新内容 ----------
section('3. computeBlock：新全文 + 还原全文');
{
  const r = ic.computeBlock(ORIGINAL_TEXT, ['bilibili.com', 'www.bilibili.com']);

  ok(hosts.hasBlock(r.newText), '新全文里有我们的标记块');
  ok(r.changed === true, '确实改动了');
  okNeg(Buffer.from(r.restoreText, 'latin1').equals(ORIGINAL),
    '★ 还原全文和原 hosts 逐字节相同（含 GBK / 二进制那几段）');
  okNeg(!hosts.hasBlock(r.restoreText), '★ 还原全文里没有块');
  ok(r.newText.includes('0.0.0.0 bilibili.com'), '域名写进去了');

  // ★ 负对照：一个合法域名都没有 → 不许改文件
  const none = ic.computeBlock(ORIGINAL_TEXT, []);
  okNeg(none.changed === false, '★ 域名列表为空 → changed=false，上层据此不去碰文件');
  okNeg(none.newText === ORIGINAL_TEXT, '★ 空列表时新全文就是原文，一字不动');

  // ★ 负对照：全是非法域名 → 同样不许改
  const bad = ic.computeBlock(ORIGINAL_TEXT, ['不是网址', '***', '', null]);
  okNeg(bad.changed === false, '★ 全是非法域名 → 也不改文件（宁可什么都不做）');

  // ★ 负对照：坏输入不崩
  ok(ic.computeBlock(null, ['bilibili.com']).changed === true, '原文是 null 也不崩，照样能算');
  ok(ic.computeBlock(undefined, null).changed === false, '两个都坏也不崩');
}

// ---------- 4. 判断残留 ----------
section('4. residueOf：hosts 里有没有上次留下的东西');
{
  const clean = ic.residueOf(ORIGINAL_TEXT, false);
  ok(clean.dirty === false, '干净文件 → 没有残留');
  ok(clean.restoreText === null, '没残留就不给还原内容');

  const dirtyText = hosts.applyBlock(ORIGINAL_TEXT, ['bilibili.com', 'zhihu.com']);

  const running = ic.residueOf(dirtyText, true);
  ok(running.dirty === true, '有块 → 有残留');
  okNeg(running.interrupted === true, '★ 还有进行中的会话 → 是「中断」，不是「没清干净」');
  ok(running.domains.length === 2 && running.domains.includes('zhihu.com'), '读得出残留挡了哪些域名');
  okNeg(Buffer.from(running.restoreText, 'latin1').equals(ORIGINAL), '★ 还原内容和原文逐字节相同');

  const orphan = ic.residueOf(dirtyText, false);
  okNeg(orphan.interrupted === false, '★ 没有进行中的会话 → 是「孤儿残留」，该清掉');

  // ★ 负对照：坏输入
  okNeg(ic.residueOf(null, false).dirty === false, '★ null 不崩、不算有残留');
  okNeg(ic.residueOf('', false).dirty === false, '★ 空串不算有残留');
  okNeg(ic.residueOf('127.0.0.1 localhost\r\n', false).dirty === false,
    '★ 主人自己的 hosts 内容不算我们的残留（不许误删）');
}

// ---------- 5. 计划文件 ----------
section('5. buildPlan：交给提权助手的计划');
{
  const p = ic.buildPlan({
    session: SESSION,
    originalText: ORIGINAL_TEXT,
    domains: ['bilibili.com'],
    exes: ['steam.exe'],
    paths: PATHS,
    now: 1000,
  });

  ok(p.mode === 'session', 'mode 是 session（整段专注）');
  ok(p.sid === 'sid-1', '会话号带上了');
  ok(p.endsAt === 2000, '结束时刻带上了');
  ok(p.hostsPath === PATHS.hostsPath, 'hosts 路径带上了');
  ok(p.exes.length === 1 && p.exes[0] === 'steam.exe', '要杀的软件带上了');
  okNeg(hosts.hasBlock(p.hostsText) === true, '★ 计划里的 hostsText 确实是「要写进去的新内容」');
  okNeg(hosts.hasBlock(p.restoreText) === false, '★ 计划里的 restoreText 是干净的（不含块）');
  okNeg(Buffer.from(p.restoreText, 'latin1').equals(ORIGINAL), '★ restoreText 能逐字节还原');

  // ★ 负对照：计划里的数组必须和调用方的不是同一个
  const exes = ['steam.exe'];
  const p2 = ic.buildPlan({ session: SESSION, originalText: ORIGINAL_TEXT, domains: [], exes, paths: PATHS, now: 1 });
  exes.push('wechat.exe');
  okNeg(p2.exes.length === 1, '★ 计划里的数组是拷贝，调用方后面改不会污染它');
}

section('6. buildRestorePlan：清残留必须走 restore 模式');
{
  const p = ic.buildRestorePlan({ restoreText: ORIGINAL_TEXT, paths: PATHS, now: 3000 });

  ok(p.mode === 'restore', 'mode 是 restore');
  okNeg(p.mode !== 'session',
    '★ 绝不能是 session —— session 会先备份「脏的」hosts，最后又把它还原回来，白忙一场');
  ok(p.hostsText === ORIGINAL_TEXT, '要写的内容就是干净全文');
  ok(p.restoreText === null, 'restore 模式下不给还原内容（不需要）');
  okNeg(Array.isArray(p.exes) && p.exes.length === 0, '★ 清残留不杀任何进程（这时候不该动主人的软件）');
  okNeg(Number.isFinite(p.endsAt) && p.endsAt > 0, '★ endsAt 非 0（否则计划校验过不去，助手会拒绝动手）');
  okNeg(typeof p.sid === 'string' && p.sid.length > 0, '★ sid 非空（计划校验要求）');
}

// ---------- 收尾 ----------
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }

console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
