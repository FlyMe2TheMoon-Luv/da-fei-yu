// scripts/test-focus-helper.js
// 阶段 3 · Task 6 · 常驻助手（focus-helper.ps1）真跑自检
//
// 用法：npm run test:focus-helper
//
// ── 为什么这条自检值钱 ──
//   前面那些自检只能证明「我们拼的命令是对的」。
//   这一条是**真的把 focus-helper.ps1 跑起来**，走完
//   「读计划 → 备份 → 写 hosts → 循环 → 收工 → 还原」的全流程。
//
// ── 为什么不提权也能跑 ──
//   关键一招：**把 hosts 指向临时目录里的假副本**。
//   助手只认计划文件里给的路径，它根本不知道真实 hosts 在哪。
//   所以这里全程不需要管理员权限，也不碰主人任何一个真实文件。
//   代价：它验不了「UAC 弹窗」和「真的能改系统文件」——那两条只能真机验收。
//
// ── 本轮的守门员 ──
//   ① hosts 必须**逐字节**还原 —— 原文件里故意塞了非 ASCII 字节
//      （一段 UTF-8 中文 + 一段 GBK 中文），编码弄错一个字节就会红。
//   ② 已存在的备份**绝不能被覆盖** —— 覆盖了就等于把我们自己写的块
//      当成「原始内容」备份下来，以后永远还原不回去。
//   ③ 到点必须**自己收工** —— 主进程崩了没人写 stop，hosts 也得回来。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

// ---------- 工具 ----------

const HELPER = path.join(__dirname, '..', 'src', 'main', 'focus-helper.ps1');

// 一份「故意脏」的假 hosts：
//   - 用 CRLF（Windows hosts 的正常风格）
//   - 塞了一段 UTF-8 中文、一段 GBK 中文、还有一段纯二进制字节
//     → 任何一处编码弄错，还原时都不可能逐字节相等
const ORIGINAL = Buffer.concat([
  Buffer.from('# fake hosts for tests\r\n', 'latin1'),
  Buffer.from('127.0.0.1 localhost\r\n', 'latin1'),
  Buffer.from('127.0.0.1 x ', 'latin1'),
  Buffer.from([0xe6, 0xb5, 0x8b, 0xe8, 0xaf, 0x95]), // UTF-8: 测试
  Buffer.from(' # ', 'latin1'),
  Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),             // GBK: 中文（不是合法 UTF-8）
  Buffer.from(' # ', 'latin1'),
  Buffer.from([0x80, 0x81, 0xfe, 0xff]),             // 纯二进制
  Buffer.from('\r\n', 'latin1'),
  Buffer.from('0.0.0.0 keep-this-line.example\r\n', 'latin1'),
]);
const ORIGINAL_TEXT = ORIGINAL.toString('latin1');

const BLOCKED = ['bilibili.com', 'www.bilibili.com'];

function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = fn(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}

// 真跑助手（不提权）。返回退出码。
function runHelper(planPath) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', HELPER, '-PlanFile', planPath,
  ], { windowsHide: true, stdio: 'ignore' });

  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
}

// 造一个临时沙箱：假 hosts + 各信号文件的路径 + 写计划文件
function makeSandbox(opts = {}) {
  const {
    endsAtOffsetMs = 60000,
    exes = [],
    sid = 'test-sid',
    preExistingBackup = null,
    omitSid = false,
    endsAt = null,
  } = opts;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-helper-'));
  const p = {
    hostsPath: path.join(dir, 'fake-hosts'),
    backupPath: path.join(dir, 'hosts.backup'),
    ctlPath: path.join(dir, 'focus-ctl.json'),
    hbPath: path.join(dir, 'focus-hb.json'),
    logPath: path.join(dir, 'focus-helper.log'),
  };

  fs.writeFileSync(p.hostsPath, ORIGINAL);
  if (preExistingBackup) fs.writeFileSync(p.backupPath, preExistingBackup);

  const newText = hosts.applyBlock(ORIGINAL_TEXT, BLOCKED);
  const restoreText = hosts.removeBlock(newText);

  const plan = {
    sid: omitSid ? '' : sid,
    hostsPath: p.hostsPath,
    hostsText: newText,
    restoreText,
    exes,
    endsAt: endsAt !== null ? endsAt : Date.now() + endsAtOffsetMs,
    backupPath: p.backupPath,
    ctlPath: p.ctlPath,
    hbPath: p.hbPath,
    logPath: p.logPath,
    createdAt: Date.now(),
  };

  const planPath = path.join(dir, 'focus-plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  return { dir, p, plan, planPath, newText, restoreText };
}

function readBytes(p) { return fs.readFileSync(p); }
function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

// ---------- 主流程 ----------

console.log('===== 常驻助手真跑自检（focus-helper.ps1，不提权、用假 hosts）=====');

async function main() {

// ---------- 0. 先证明测试数据本身是「脏」的 ----------
section('0. 准备：测试用的假 hosts 本身就不干净（含非法 UTF-8 字节）');
{
  ok(ORIGINAL.includes(0xfe) && ORIGINAL.includes(0xff), '假 hosts 里确实有非 ASCII 字节');
  const rt = Buffer.from(ORIGINAL_TEXT, 'latin1');
  ok(rt.equals(ORIGINAL), 'latin1 读写能逐字节往返（后面全靠这条）');
  okNeg(Buffer.from(ORIGINAL_TEXT, 'utf8').equals(ORIGINAL) === false,
    '★ 用 UTF-8 读会丢字节 —— 所以助手必须走 latin1');
}

// ---------- 1. 完整走一遍：备份 → 写 hosts → 收工 → 还原 ----------
section('1. 全流程：备份 → 写入 → 心跳 → 收工 → 逐字节还原');
{
  const s = makeSandbox();
  try {
    const exitP = runHelper(s.planPath);

    // ① 备份出现，且和原文逐字节相同
    await waitFor(() => fs.existsSync(s.p.backupPath), 20000, '备份文件出现');
    okNeg(readBytes(s.p.backupPath).equals(ORIGINAL), '★ 备份和原 hosts 逐字节相同');

    // ② 新 hosts 写进去了（内容 = JS 算出来的那份）
    await waitFor(() => {
      const cur = readBytes(s.p.hostsPath);
      return cur.includes(Buffer.from(hosts.BEGIN_MARK, 'latin1'));
    }, 20000, 'hosts 里出现标记块');
    const written = readBytes(s.p.hostsPath);
    okNeg(written.equals(Buffer.from(s.newText, 'latin1')), '★ 写进去的内容和 JS 算的完全一致');
    ok(written.includes(Buffer.from('0.0.0.0 bilibili.com', 'latin1')), '被禁的域名在块里');
    okNeg(written.includes(ORIGINAL), '★ 主人原有的内容还在（没被整文件覆盖）');

    // ③ 心跳出现了，而且带着这趟的会话号
    await waitFor(() => {
      const hb = readJsonOrNull(s.p.hbPath);
      return hb && hb.sid === 'test-sid' && hb.at > 0;
    }, 20000, '心跳文件');
    const hb = readJsonOrNull(s.p.hbPath);
    okNeg(hb.sid === 'test-sid', '★ 心跳带了正确的会话号');
    ok(Number.isFinite(hb.pid) && hb.pid > 0, '心跳里记了助手自己的 PID（排查用）');

    // ④ 写收工请求 → 助手应当自己还原并退出
    fs.writeFileSync(s.p.ctlPath, JSON.stringify({ sid: 'test-sid', stop: true, at: Date.now() }), 'utf8');
    const code = await exitP;
    ok(code === 0, '收到收工请求后正常退出（退出码 0）');

    // ⑤ 逐字节还原 + 备份被清掉
    okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 被逐字节还原（含 GBK / 二进制那几段）');
    okNeg(!fs.existsSync(s.p.backupPath), '★ 备份是「一次性」的，用完就删（下次重新备份）');

    const log = fs.existsSync(s.p.logPath) ? fs.readFileSync(s.p.logPath, 'utf8') : '';
    okNeg(!/killed/i.test(log), '★ 这一趟没有杀任何进程（exe 列表是空的）');
  } finally {
    cleanup(s.dir);
  }
}

// ---------- 2. ★ 负对照：主进程崩了没人写 stop → 到点自己收工 ----------
section('2. ★ 负对照：没人写收工请求，助手到点必须自己还原（主进程崩了的场景）');
{
  const s = makeSandbox({ endsAtOffsetMs: 4000 });
  try {
    const exitP = runHelper(s.planPath);
    await waitFor(() => readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')), 20000, 'hosts 被写入');

    // 全程不写 stop，就等它自己到点
    const code = await exitP;
    okNeg(code === 0, '★ 到点自己退出（没人通知它也收工了）');
    okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 自己回来了 —— 这就是「主进程崩了也不留垃圾」');
  } finally {
    cleanup(s.dir);
  }
}

// ---------- 3. ★ 负对照：已有的备份绝不能被覆盖 ----------
section('3. ★ 负对照：已经有备份时，助手不许覆盖它');
{
  const sentinel = Buffer.from('# 这是一份上一趟留下的备份\n', 'latin1');
  const s = makeSandbox({ preExistingBackup: sentinel });
  try {
    const exitP = runHelper(s.planPath);
    await waitFor(() => readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')), 20000, 'hosts 被写入');

    okNeg(readBytes(s.p.backupPath).equals(sentinel),
      '★ 旧备份原封不动（覆盖了就等于把「我们写的块」当成原始内容，以后永远还原不回去）');

    fs.writeFileSync(s.p.ctlPath, JSON.stringify({ sid: 'test-sid', stop: true, at: Date.now() }), 'utf8');
    await exitP;

    okNeg(readBytes(s.p.hostsPath).equals(sentinel),
      '★ 还原走的是「那份备份」，所以 hosts 变成了备份的内容（证明还原真的用了备份）');
  } finally {
    cleanup(s.dir);
  }
}

// ---------- 4. ★ 负对照：计划文件残缺 → 碰都不许碰 ----------
section('4. ★ 负对照：计划文件残缺时，助手必须什么都不动');
{
  // ① 没有会话号
  {
    const s = makeSandbox({ omitSid: true });
    try {
      const code = await runHelper(s.planPath);
      okNeg(code === 2, '★ 没有会话号 → 退出码 2');
      okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 一个字没动');
      okNeg(!fs.existsSync(s.p.backupPath), '★ 连备份都没做');
    } finally { cleanup(s.dir); }
  }

  // ② 结束时间是 0（坏数据）
  {
    const s = makeSandbox({ endsAt: 0 });
    try {
      const code = await runHelper(s.planPath);
      okNeg(code === 2, '★ endsAt 是 0 → 退出码 2（不许拿一个没有终点的计划去改系统）');
      okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 一个字没动');
    } finally { cleanup(s.dir); }
  }

  // ③ 计划文件压根不存在
  {
    const s = makeSandbox();
    try {
      const missing = path.join(s.dir, 'nope.json');
      const code = await runHelper(missing);
      okNeg(code === 2, '★ 计划文件不存在 → 退出码 2，不崩');
      okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 一个字没动');
    } finally { cleanup(s.dir); }
  }
}

// ---------- 5. ★ 负对照：上一趟的收工信号不能结束这一趟 ----------
section('5. ★ 负对照：控制文件里是别的会话号 → 不许收工');
{
  const s = makeSandbox({ endsAtOffsetMs: 8000 });
  try {
    // 一上来就放一个「上一趟遗留的 stop」
    fs.writeFileSync(s.p.ctlPath, JSON.stringify({ sid: 'old-session', stop: true, at: Date.now() }), 'utf8');

    const exitP = runHelper(s.planPath);
    await waitFor(() => readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')), 20000, 'hosts 被写入');

    // 等一会儿：如果助手认了那个 stale stop，它早就退出了
    await new Promise((r) => setTimeout(r, 5000));
    okNeg(readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')),
      '★ 5 秒后还在专注 —— 没被上一趟的遗留信号结束掉');

    const code = await exitP;
    ok(code === 0, '最后还是到点自己收工');
    okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 还原干净');
  } finally {
    cleanup(s.dir);
  }
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);

}

main().catch((err) => {
  console.log(`\n✗ 自检自身抛异常：${err && err.message}`);
  console.log(`负对照：${negPass}/${negTotal} 通过`);
  console.log(`===== 结果：${pass} 通过 / ${fail + 1} 失败 =====`);
  process.exit(1);
});
