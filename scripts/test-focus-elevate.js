// scripts/test-focus-elevate.js
// 阶段 3 · Task 6 · 提权执行壳自检
//
// 用法：npm run test:focus-elevate
//
// ── 这个自检测什么、不测什么 ──
//   测：拼命令行、写信号文件、判断助手活着没、以及**各种失败路径不能把异常抛出去**。
//   不测：真弹 UAC、真改 hosts —— 那两件事只能真机验收（Task 10 清单）。
//
// ── 为什么能脱离 Electron 跑 ──
//   elevate.js 里碰 electron 的三个依赖都是延迟 require 的，
//   这里全部注入假实现，所以普通 Node 就能跑（也正因为如此，
//   「失败路径」才能被穷举 —— 真起一个提权进程是没法测失败路径的）。
//
// ── 本轮的三个守门员 ──
//   ① UAC 被取消（spawn 抛错 / 退出码非 0）必须返回 { ok:false }，**不能把异常抛出去**
//      —— 抛出去会把「开始专注」整个流程炸掉，界面只看到卡住。
//   ② 路径带空格（项目目录就叫 "WorkBuddy AI"）必须被正确引起来 —— 少一个引号，
//      助手就永远起不来，而且现象是「弹了 UAC 但什么都没发生」，极难查。
//   ③ 这一层**不许有「杀助手进程」的能力** —— 强杀它就没有还原 hosts 的机会了。

const elevator = require('../src/main/focus/elevate');

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

// ---------- 假依赖 ----------

// 一个能手动触发事件的假子进程（真 spawn 里事件是异步来的，这里手动放）
function fakeChild() {
  const handlers = {};
  return {
    once(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    fire(ev, arg) { (handlers[ev] || []).forEach((f) => f(arg)); },
  };
}

// 一份内存版的「userData 目录」
function makeWorld(overrides = {}) {
  const files = {};
  const spawned = [];
  const world = {
    files,
    spawned,
    nextChild: null,
    deps: {
      now: () => 1000,
      readFile: () => Buffer.from('# ps1 source'),
      writeFile: (p, buf) => { files[`@raw:${p}`] = buf; },
      writeJson: (name, data) => { files[name] = data; return true; },
      readJson: (name, fallback) => (name in files ? files[name] : fallback),
      fileOf: (name) => `C:\\fake\\userData\\${name}`,
      helperSource: () => 'C:\\repo\\src\\main\\focus-helper.ps1',
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        return world.nextChild;
      },
    },
  };
  Object.assign(world.deps, overrides);
  return world;
}

const PATHS = {
  hostsPath: elevator.HOSTS_PATH,
  backupPath: 'C:\\fake\\userData\\hosts.backup',
  ctlPath: 'C:\\fake\\userData\\focus-ctl.json',
  hbPath: 'C:\\fake\\userData\\focus-hb.json',
  logPath: 'C:\\fake\\userData\\focus-helper.log',
};

const SAMPLE_PLAN = elevator.makePlan({
  sid: 'sid-1',
  hostsText: '# === FocusMode BEGIN ===\r\n0.0.0.0 bilibili.com\r\n# === FocusMode END ===\r\n',
  restoreText: '# original\r\n',
  exes: ['steam.exe'],
  endsAt: 2000,
  now: 1000,
}, PATHS);

console.log('===== 提权执行壳自检（elevate.js）=====');

// 整段包在 async 里跑：第 8 节要 await（startHelper 是异步的），
// 而 CommonJS 的顶层不许写 await。
async function main() {

// ---------- 1. 常量 ----------
section('1. 常量：hosts 路径必须是系统真实路径');
{
  ok(elevator.HOSTS_PATH === 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts 路径写对了');
  okNeg(elevator.HOSTS_PATH.includes('System32') === true, '★ 不是程序目录里的假文件');
}

// ---------- 2. PowerShell 引号 ----------
section('2. 拼命令行：引号必须能扛住空格和单引号');
{
  ok(elevator.psSingleQuote('abc') === "'abc'", '普通字符串包单引号');

  // ★ 负对照：路径里有单引号，必须写成 '' 才不会把字符串截断
  okNeg(elevator.psSingleQuote("a'b") === "'a''b'", "★ 路径里的单引号被转义成两个（否则命令行会被截断）");

  ok(elevator.winQuote('C:\\a b\\c.ps1') === '"C:\\a b\\c.ps1"', '带空格的路径被双引号包住');

  const argLine = elevator.buildHelperArgLine({
    helperPath: 'C:\\WorkBuddy AI\\desktop-pet\\focus-helper.ps1',
    planPath: 'C:\\fake\\userData\\focus-plan.json',
  });
  ok(argLine.includes('-ExecutionPolicy Bypass'), '带了 ExecutionPolicy Bypass');
  ok(argLine.includes('-WindowStyle Hidden'), '助手窗口是隐藏的');
  okNeg(argLine.includes('"C:\\WorkBuddy AI\\desktop-pet\\focus-helper.ps1"') === true,
    '★ 带空格的助手路径被引号包住了（少这个引号 = 助手永远起不来）');
  okNeg(argLine.includes('"-PlanFile"') === false, '参数名本身没被误加引号');
}

// ---------- 3. 启动命令 ----------
section('3. 启动命令：必须是 RunAs，且不能带任何「杀」的能力');
{
  const cmd = elevator.buildRunAsCommand({
    helperPath: 'C:\\WorkBuddy AI\\desktop-pet\\focus-helper.ps1',
    planPath: 'C:\\fake\\userData\\focus-plan.json',
  });

  ok(cmd.includes('-Verb RunAs'), '用了 -Verb RunAs（会弹 UAC）');
  ok(cmd.includes('exit 0'), '成功时退出码 0');
  okNeg(cmd.includes('catch { exit 1 }') === true, '★ 主人点「否」时退出码是 1（不是 0，否则会被当成成功）');

  // ★ 负对照：启动器只负责「喊起来」，不许自己动任何进程
  okNeg(/Stop-Process|taskkill|TerminateProcess/i.test(cmd) === false,
    '★ 启动命令里没有任何杀进程的写法');

  // ★ 负对照：这条命令里必须出现助手路径，证明参数真的拼进去了
  okNeg(cmd.includes('focus-helper.ps1') === true, '★ 助手路径确实拼进了命令');
}

// ---------- 4. 会话号 ----------
section('4. 会话号：每次都不一样，不能为空');
{
  const a = elevator.newSid();
  const b = elevator.newSid();
  ok(typeof a === 'string' && a.length > 0, '会话号非空');
  okNeg(a !== b, '★ 连着两次拿到的会话号不一样（否则上趟的收工信号会误伤这趟）');
  okNeg(!/\s/.test(a), '★ 会话号里没有空白字符（要拼进命令行和 JSON）');

  const many = new Set();
  for (let i = 0; i < 200; i++) many.add(elevator.newSid());
  okNeg(many.size === 200, '★ 200 次全不重复');
}

// ---------- 5. 计划文件的内容 ----------
section('5. 计划文件：字段齐、坏输入不崩、不许和调用方共用同一个数组');
{
  ok(SAMPLE_PLAN.sid === 'sid-1', 'sid 记下来了');
  ok(SAMPLE_PLAN.hostsPath === elevator.HOSTS_PATH, 'hosts 路径在计划里');
  ok(SAMPLE_PLAN.exes.length === 1 && SAMPLE_PLAN.exes[0] === 'steam.exe', 'exe 列表在计划里');
  ok(SAMPLE_PLAN.endsAt === 2000, '结束时刻在计划里');
  ok(typeof SAMPLE_PLAN.logPath === 'string' && SAMPLE_PLAN.logPath.length > 0, '日志路径在计划里');

  const src = ['steam.exe'];
  const p = elevator.makePlan({ sid: 's', exes: src, endsAt: 1 }, PATHS);
  src.push('wechat.exe');
  okNeg(p.exes.length === 1, '★ 计划里的数组是拷贝，调用方后面改原数组不会污染它');

  const bad = elevator.makePlan({ sid: 's', exes: 'not-an-array', endsAt: NaN, hostsText: 123 }, PATHS);
  okNeg(Array.isArray(bad.exes) && bad.exes.length === 0, '★ exes 传了字符串 → 退化成空数组，不崩');
  okNeg(bad.endsAt === 0, '★ endsAt 是 NaN → 归 0（助手看到 0 会拒绝动手）');
  okNeg(bad.hostsText === null, '★ hostsText 不是字符串 → null，不硬塞进去');

  const empty = elevator.makePlan({}, PATHS);
  ok(empty.sid === '' && empty.exes.length === 0, '什么都不传也不崩');
}

// ---------- 6. 写信号文件 ----------
section('6. 信号文件：收工请求 / 清场');
{
  const w = makeWorld();
  const el = elevator.createElevator(w.deps);

  ok(el.notifyStop('sid-1') === true, '写收工请求成功返回 true');
  ok(w.files[elevator.CTL_FILE].stop === true, '控制文件里 stop 是 true');
  ok(w.files[elevator.CTL_FILE].sid === 'sid-1', '控制文件里带了会话号');
  okNeg(w.files[elevator.CTL_FILE].sid !== undefined, '★ 会话号一定要写进去（否则助手认不出这是给它的）');

  // ★ 负对照：磁盘写失败 → 返回 false，绝不抛异常
  const w2 = makeWorld({ writeJson: () => { throw new Error('disk full'); } });
  const el2 = elevator.createElevator(w2.deps);
  let threw = false;
  let r2 = null;
  try { r2 = el2.notifyStop('sid-1'); } catch { threw = true; }
  okNeg(threw === false, '★ 磁盘写失败时不抛异常（抛出去会把「结束专注」整个炸掉）');
  okNeg(r2 === false, '★ 写失败时如实返回 false');

  const w3 = makeWorld();
  const el3 = elevator.createElevator(w3.deps);
  ok(el3.resetSignals('sid-9') === true, '清场写成功');
  ok(w3.files[elevator.CTL_FILE].stop === false, '清场后控制文件是「不许停」');
  ok(w3.files[elevator.HB_FILE].at === 0, '清场后心跳是「还没听到」');
  okNeg(w3.files[elevator.HB_FILE].at === 0, '★ 心跳归 0 才能避免「新会话一开始就以为助手活着」');
}

// ---------- 7. 判断助手活着没 ----------
section('7. 心跳判定：过期 / 换了会话 / 还没听到，一律算「不在」');
{
  const w = makeWorld();
  const el = elevator.createElevator(w.deps);

  w.files[elevator.HB_FILE] = { sid: 'sid-1', at: 1000 };
  ok(el.isHelperAlive('sid-1') === true, '刚写过心跳 → 活着');

  w.files[elevator.HB_FILE] = { sid: 'sid-1', at: 1000 - elevator.HB_STALE_MS - 1 };
  okNeg(el.isHelperAlive('sid-1') === false, '★ 心跳太旧 → 算不在（不能一直以为它还活着）');

  w.files[elevator.HB_FILE] = { sid: 'sid-2', at: 1000 };
  okNeg(el.isHelperAlive('sid-1') === false, '★ 心跳是上一趟的会话号 → 算不在');

  w.files[elevator.HB_FILE] = { sid: 'sid-1', at: 0 };
  okNeg(el.isHelperAlive('sid-1') === false, '★ 心跳 0 = 从来没听到过 → 算不在');

  delete w.files[elevator.HB_FILE];
  okNeg(el.isHelperAlive('sid-1') === false, '★ 根本没有心跳文件 → 算不在');

  w.files[elevator.HB_FILE] = 'garbage';
  okNeg(el.isHelperAlive('sid-1') === false, '★ 心跳文件是坏数据 → 算不在，不崩');
}

// ---------- 8. 起助手：成功与各种失败路径 ----------
section('8. 起助手：成功走通，失败一律「返回人话」而不是抛异常');
{
  // ① 主人点了「是」
  {
    const w = makeWorld();
    const child = fakeChild();
    w.nextChild = child;
    const el = elevator.createElevator(w.deps);

    const p = el.startHelper(SAMPLE_PLAN);
    ok(typeof p.then === 'function', 'startHelper 返回的是 Promise（不能同步等，会把桌宠卡死）');
    child.fire('close', 0);
    const r = await p;
    ok(r.ok === true, '退出码 0 → 开始成功');
    ok(w.spawned.length === 1, '只起了一个 powershell 进程');
    ok(w.spawned[0].cmd === 'powershell.exe', '起的是 powershell.exe');
    ok(w.spawned[0].opts.windowsHide === true, '不弹控制台窗口');
    ok(w.files[elevator.PLAN_FILE].sid === 'sid-1', '计划文件确实写下去了');
  }

  // ② ★ 主人点了「否」
  {
    const w = makeWorld();
    const child = fakeChild();
    w.nextChild = child;
    const el = elevator.createElevator(w.deps);

    const p = el.startHelper(SAMPLE_PLAN);
    child.fire('close', 1);
    const r = await p;
    okNeg(r.ok === false, '★ 退出码 1（主人点了否）→ 开始失败');
    okNeg(typeof r.error === 'string' && r.error.includes('取消'), '★ 给出人话原因，而不是一个错误码');
  }

  // ③ ★ spawn 直接抛异常（比如系统不让提权）
  {
    const w = makeWorld({ spawn: () => { throw new Error('EACCES'); } });
    const el = elevator.createElevator(w.deps);
    let threw = false;
    let r = null;
    try { r = await el.startHelper(SAMPLE_PLAN); } catch { threw = true; }
    okNeg(threw === false, '★ spawn 抛异常时不往外抛（计划里明确要求）');
    okNeg(r && r.ok === false, '★ 返回 { ok:false }');
    // ⚠ 这里必须 null 安全：改坏实现时 r 会是 null，
    //   直接读 r.error 会把自检自己炸掉、后面的用例全跳过（Task 5 踩过同一个坑）
    const errText = (r && typeof r.error === 'string') ? r.error : '';
    okNeg(errText.length > 0, '★ 带了人话原因');
  }

  // ④ ★ 进程根本起不来（ENOENT 走 error 事件）
  {
    const w = makeWorld();
    const child = fakeChild();
    w.nextChild = child;
    const el = elevator.createElevator(w.deps);
    const p = el.startHelper(SAMPLE_PLAN);
    child.fire('error', new Error('ENOENT'));
    const r = await p;
    okNeg(r.ok === false, '★ spawn error 事件 → 返回失败，不抛异常');
  }

  // ⑤ ★ 计划文件写不进去 → 必须压根不去提权
  {
    const w = makeWorld({ writeJson: () => false });
    const el = elevator.createElevator(w.deps);
    const r = await el.startHelper(SAMPLE_PLAN);
    okNeg(r.ok === false, '★ 计划文件写失败 → 开始失败');
    okNeg(w.spawned.length === 0, '★ 写失败时**不能**去弹 UAC（弹了也是白弹，助手读不到计划）');
  }

  // ⑥ ★ 助手脚本复制不出来 → 同样不该提权
  {
    const w = makeWorld({ readFile: () => { throw new Error('ENOENT: focus-helper.ps1'); } });
    const el = elevator.createElevator(w.deps);
    const r = await el.startHelper(SAMPLE_PLAN);
    okNeg(r.ok === false, '★ 助手脚本读不到 → 开始失败');
    okNeg(w.spawned.length === 0, '★ 脚本都拿不到就不该弹 UAC');
  }

  // ⑦ 只结算一次：error 之后再来个 close(0) 也不能翻案
  {
    const w = makeWorld();
    const child = fakeChild();
    w.nextChild = child;
    const el = elevator.createElevator(w.deps);
    const p = el.startHelper(SAMPLE_PLAN);
    child.fire('error', new Error('boom'));
    child.fire('close', 0);
    const r = await p;
    okNeg(r.ok === false, '★ 先失败后成功的事件乱序，结果仍然按第一次算（不能被翻案）');
  }
}

// ---------- 9. 助手脚本的落地位置 ----------
section('9. 助手脚本：要复制到 userData 再跑，不能直接在项目目录里跑');
{
  const w = makeWorld();
  const el = elevator.createElevator(w.deps);
  const dest = el.prepareHelper();

  ok(dest === 'C:\\fake\\userData\\focus-helper.run.ps1', '复制到 userData 里再跑');
  okNeg(dest !== 'C:\\repo\\src\\main\\focus-helper.ps1',
    '★ 不是直接在项目目录里跑（项目目录带空格、打包后还可能是只读的）');
  ok(w.files['@raw:C:\\fake\\userData\\focus-helper.run.ps1'] !== undefined, '脚本内容确实写过去了');
}

// ---------- 10. ★ 这一层不许有「杀助手」的能力 ----------
section('10. ★ 负对照：提权壳不许提供任何「杀进程」的出口');
{
  const w = makeWorld();
  const el = elevator.createElevator(w.deps);
  const names = Object.keys(el);

  okNeg(typeof el.killHelper === 'undefined', '★ 没有 killHelper');
  okNeg(typeof el.kill === 'undefined', '★ 没有 kill');
  okNeg(typeof el.terminate === 'undefined', '★ 没有 terminate');
  okNeg(names.every((n) => !/kill|terminate|forceStop/i.test(n)),
    '★ 整个模块对外没有任何带 kill/terminate 的名字（结束永远走控制文件）');

  const modNames = Object.keys(elevator);
  okNeg(modNames.every((n) => !/kill|terminate/i.test(n)),
    '★ 模块级导出里也没有杀进程的入口');
}

// ---------- 11. ★ 接口齐全：index.js 要调的方法，实例上必须都有 ----------
section('11. ★ 负对照：模块 ≠ 实例，别把 require 回来的模块当实例用');
{
  const w = makeWorld();
  const el = elevator.createElevator(w.deps);

  // 这一条是被真实 bug 咬出来的：index.js 里一开始写成
  // `const elevator = require('./elevate')`，于是 resetSignals / newSid 全都不存在，
  // 专注一按开始就抛异常。端到端自检抓到了，但纯函数自检抓不到 —— 所以补在这里。
  for (const name of ['newSid', 'plan', 'paths', 'startHelper', 'notifyStop', 'resetSignals', 'isHelperAlive']) {
    ok(typeof el[name] === 'function', `实例上有 ${name}()`);
  }

  okNeg(typeof elevator.resetSignals === 'undefined',
    '★ 模块本身没有 resetSignals（必须 createElevator() 之后才有）');
  okNeg(typeof elevator.startHelper === 'undefined',
    '★ 模块本身没有 startHelper —— 直接 require 模块来用就是上面那个 bug');

  const p = el.plan({ sid: 'sid-7', exes: ['steam.exe'], endsAt: 2000, hostsText: 'x' });
  ok(p.sid === 'sid-7' && p.endsAt === 2000, 'plan() 直接能用，路径自动填好');
  ok(p.ctlPath === 'C:\\fake\\userData\\focus-ctl.json', 'plan() 里控制文件路径是 userData 下的');
  okNeg(p.ctlPath !== p.hbPath, '★ 控制文件和心跳文件是两个不同文件（同文件会有竞态）');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);

}

main().catch((err) => {
  // 自检自己崩了也要给结论，不能静悄悄地卡住（Task 5 的血泪：卡死过一次）
  console.log(`\n✗ 自检自身抛异常：${err && err.message}`);
  console.log(`负对照：${negPass}/${negTotal} 通过`);
  console.log(`===== 结果：${pass} 通过 / ${fail + 1} 失败 =====`);
  process.exit(1);
});
