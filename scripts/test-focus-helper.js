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
    mode = 'session',
    dirtyHosts = false,
    planOverrides = {},
  } = opts;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-helper-'));
  const p = {
    hostsPath: path.join(dir, 'fake-hosts'),
    backupPath: path.join(dir, 'hosts.backup'),
    ctlPath: path.join(dir, 'focus-ctl.json'),
    hbPath: path.join(dir, 'focus-hb.json'),
    logPath: path.join(dir, 'focus-helper.log'),
  };

  const newText = hosts.applyBlock(ORIGINAL_TEXT, BLOCKED);
  const restoreText = hosts.removeBlock(newText);

  // dirtyHosts：假装「上次专注没清干净」，文件里已经带着我们的块
  fs.writeFileSync(p.hostsPath, dirtyHosts ? Buffer.from(newText, 'latin1') : ORIGINAL);
  if (preExistingBackup) fs.writeFileSync(p.backupPath, preExistingBackup);

  const plan = {
    mode,
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
    ...planOverrides,
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

// ---------- 6. restore 模式：一次性清残留 ----------
section('6. restore 模式：只写一次干净内容就退出，绝不备份、绝不循环');
{
  const s = makeSandbox({
    mode: 'restore',
    dirtyHosts: true,                                   // 文件里已经带着我们的块
    planOverrides: { hostsText: ORIGINAL_TEXT },        // 要写的 = 干净原文
  });
  try {
    ok(readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')),
      '（准备）文件一开始确实是脏的');

    const code = await runHelper(s.planPath);
    ok(code === 0, 'restore 模式正常退出');

    okNeg(readBytes(s.p.hostsPath).equals(ORIGINAL), '★ hosts 被清干净了（逐字节等于原文）');
    okNeg(!fs.existsSync(s.p.backupPath),
      '★ 没有产生备份文件 —— 这一条最关键：一旦备份了，脏内容就被当成「原始内容」记下来');
    okNeg(!fs.existsSync(s.p.hbPath),
      '★ 没有写心跳 —— 证明它没有进循环，是「一次性」的');

    const log = fs.existsSync(s.p.logPath) ? fs.readFileSync(s.p.logPath, 'utf8') : '';
    okNeg(/backed up/i.test(log) === false, '★ 日志里没有「备份」这一步');
  } finally {
    cleanup(s.dir);
  }

  // ★ 负对照：restore 模式但计划里没有 hostsText → 必须拒绝动手
  {
    const s2 = makeSandbox({ mode: 'restore', dirtyHosts: true, planOverrides: { hostsText: null } });
    try {
      const code = await runHelper(s2.planPath);
      okNeg(code === 2, '★ restore 模式没给内容 → 退出码 2');
      okNeg(readBytes(s2.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')),
        '★ 文件保持原样（宁可不清，也不能瞎写）');
    } finally { cleanup(s2.dir); }
  }
}

// ---------- 7. ★ 负对照：助手自己的保护名单真的会跳过危险程序（Task 8）----------
// 这是「把自己杀了 / 把系统杀了」这条红线的**最后一道闸**。
//
// 为什么以前没法验、现在能验了：
//   要证明「保护名单生效」，最直接的办法是让名单里出现 explorer.exe，看它会不会被杀。
//   ——但这正是我们不能做的事：万一保护名单坏了，桌面当场就没了。
//   所以给助手加了一个 dryRun：**只记日志、不动手**。
//   于是「会不会杀」变成了「日志里写了什么」，既安全又能验。
//
// ⚠ 真机上 elevate.js 永远不会写 dryRun 这个字段（makePlan 里根本没有它）。
//   它只为自检存在 —— 这一点在脚本里也写了注释。
section('7. ★ 负对照：助手自己的保护名单（dryRun：只记不动手）');
{
  // 挑几个「万一真被杀就出事」的名字 + 一个不存在但也不受保护的靶子。
  // ★ 靶子用不存在的进程名：就算保护名单完全失效，也杀不到任何真东西。
  const GUARDED = ['explorer.exe', 'csrss.exe', 'lsass.exe', 'svchost.exe', 'electron.exe', 'node.exe'];
  const BOGUS = 'zzz-focus-selftest-bogus.exe';

  const s = makeSandbox({
    endsAtOffsetMs: 6000,
    exes: GUARDED.concat([BOGUS]),
    planOverrides: { dryRun: true },
  });

  try {
    const exitP = runHelper(s.planPath);
    await waitFor(() => readBytes(s.p.hostsPath).includes(Buffer.from(hosts.BEGIN_MARK, 'latin1')), 20000, 'hosts 被写入');

    // ⚠ 先等「循环真的跑过一轮」的证据（心跳），再去查日志。
    //   反过来的话，保护名单一旦失效就是「等日志超时」——
    //   红是红了，但红得很难看、也说不清哪一条错了（第一版就是这样）。
    //   心跳 = 循环第 d 步，跳过记录 = 第 c 步，所以心跳出现时日志一定已经写过。
    await waitFor(() => {
      const hb = readJsonOrNull(s.p.hbPath);
      return hb && hb.sid === 'test-sid' && hb.at > 0;
    }, 20000, '心跳文件（证明循环跑起来了）');

    const log = fs.existsSync(s.p.logPath) ? fs.readFileSync(s.p.logPath, 'utf8') : '';

    // ① 每一个危险名字都必须被跳过
    for (const g of GUARDED) {
      const base = g.replace(/\.exe$/, '');
      okNeg(new RegExp(`skipped \\(guard\\): ${g.replace('.', '\\.')}`, 'i').test(log),
        `★ ${g} 被保护名单拦下（没动手）`);
    }

    // ② ★★ 最强的一条：整份日志里**一次都不能出现真的杀进程记录**。
    //    dryRun 下只许出现 "would kill"；出现 "killed " 就说明 dryRun 被绕过了。
    okNeg(/(^|\s)killed\s/i.test(log) === false,
      '★★ 日志里没有任何「真杀」记录（dryRun 下只许有 would kill）');

    // ②b ★★ 保护名单里的名字，连「打算动手」都不许有。
    //     只看 "killed" 是不够的：dryRun 下保护失效会记成 "would kill"，
    //     上面那条照样是绿的。这一条才真的把「名单失效」钉死。
    const wouldKillGuarded = GUARDED.filter((g) => {
      const base = g.replace(/\.exe$/, '');
      return new RegExp(`would kill ${g.replace('.', '\\.')}\\b`, 'i').test(log)
        || new RegExp(`would kill ${base}\\b`, 'i').test(log);
    });
    okNeg(wouldKillGuarded.length === 0,
      '★★ 保护名单里的程序连「打算关掉」都没出现过',
      ` → ${JSON.stringify(wouldKillGuarded)}`);

    // ③ 负对照的另一半：助手确实起来了、确实进了循环 ——
    //    否则「什么都没杀」也可能是因为它压根没跑，上面的断言就是假的。
    ok(/helper started/.test(log), '助手确实起来了（不是「什么都没发生」）');
    const hb = readJsonOrNull(s.p.hbPath);
    ok(!!hb && hb.sid === 'test-sid', '★ 心跳写了 —— 证明它真的进了轮询循环，不是启动失败');

    const code = await exitP;
    ok(code === 0, '到点自己收工退出');

    // ④ 收尾之后日志里依然没有真杀记录（整段生命周期都没杀过东西）
    const log2 = fs.existsSync(s.p.logPath) ? fs.readFileSync(s.p.logPath, 'utf8') : '';
    okNeg(/(^|\s)killed\s/i.test(log2) === false, '★ 整个生命周期都没有真杀过进程');
  } finally {
    cleanup(s.dir);
  }

  // ★ 负对照：保护名单必须真的「认识」这些名字 —— 用 base name（不带 .exe）也要拦。
  //   计划文件里 exes 的形态是 JS 侧给的（带 .exe），但万一有人给了裸名字，
  //   助手也得分得清。这一条用 dryRun 验「裸名字 explorer 一样被跳过」。
  {
    const s2 = makeSandbox({
      endsAtOffsetMs: 5000,
      exes: ['explorer', 'lsass'],
      planOverrides: { dryRun: true },
    });
    try {
      const exitP = runHelper(s2.planPath);
      // 同样先等「循环跑过了」的证据，再去查日志（理由见上一段）
      await waitFor(() => {
        const hb = readJsonOrNull(s2.p.hbPath);
        return hb && hb.sid === 'test-sid' && hb.at > 0;
      }, 20000, '心跳文件（证明循环跑起来了）');
      const log = fs.existsSync(s2.p.logPath) ? fs.readFileSync(s2.p.logPath, 'utf8') : '';
      okNeg(/skipped \(guard\): explorer/i.test(log), '★ 裸名字「explorer」（不带 .exe）也一样被拦');
      okNeg(/skipped \(guard\): lsass/i.test(log), '★ 裸名字「lsass」也一样被拦');
      okNeg(/(^|\s)killed\s/i.test(log) === false, '★ 依然没有任何真杀记录');
      okNeg(/would kill (explorer|lsass)\b/i.test(log) === false,
        '★ 裸名字也没被「打算关掉」过');
      fs.writeFileSync(s2.p.ctlPath, JSON.stringify({ sid: 'test-sid', stop: true, at: Date.now() }), 'utf8');
      await exitP;
    } finally { cleanup(s2.dir); }
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
