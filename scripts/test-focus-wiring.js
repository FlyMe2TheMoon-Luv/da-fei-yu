// scripts/test-focus-wiring.js
// 阶段 3 · 「接线」自检 —— 专抓「自检全绿、真机必挂」的那一类错。
//
// 用法：npm run test:focus-wiring
//
// ── 为什么单独开这一套 ──
//   2026-10-15 真机踩到：`focus/index.js` 里写
//       const elevator = require('./elevate').createElevator();
//       hostsPath: elevator.HOSTS_PATH,
//   可是 **HOSTS_PATH 只在模块上，实例上没有** → hostsPath 静默变成 undefined →
//   主人一点「开始专注」就报 `ERR_INVALID_ARG_TYPE`。
//
//   所有的纯 Node 自检和端到端自检**全都是绿的**，因为：
//     - 纯 Node 自检只测 elevate.js 的纯函数，不碰 index.js；
//     - 端到端自检是**沙箱模式**，main.js 会 init({hostsPath: 假文件})，
//       把那个 undefined 覆盖掉了 —— 错值从来没被看过一眼。
//
//   ★ 结论（项目级教训）：**「默认值」本身也需要被检查**，
//     尤其当它会被别处覆盖时 —— 覆盖之后测再多也不代表默认值是对的。
//     这一套就是干这个的：静态读源码 + 加载模块，检查接线与默认值。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELEVATE = path.join(ROOT, 'src/main/focus/elevate.js');
const INDEX = path.join(ROOT, 'src/main/focus/index.js');

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

console.log('===== 专注模式「接线 / 默认值」自检（wiring）=====');

try {
  // ---------- 1. 模块导出哪些东西、实例导出哪些东西 ----------
  section('1. elevate：模块导出 vs 实例导出');
  {
    const mod = require(ELEVATE);
    ok(typeof mod.HOSTS_PATH === 'string' && mod.HOSTS_PATH.length > 0,
      `模块上有 HOSTS_PATH（${mod.HOSTS_PATH}）`);
    ok(typeof mod.createElevator === 'function', '模块上有 createElevator');

    okNeg(typeof mod.startHelper !== 'function',
      '★ 模块上**不该**有 startHelper（它是实例方法，防「把模块当实例用」）');
  }

  // ---------- 2. ★ 实例上必须没有 HOSTS_PATH（这是错值来源） ----------
  section('2. ★ 负对照：实例上没有 HOSTS_PATH —— 从实例取一定是 undefined');
  {
    const src = fs.readFileSync(ELEVATE, 'utf8');
    // 从 createElevator 的 return {...} 里确认没有 HOSTS_PATH
    const m = src.match(/function createElevator[\s\S]*?\n  return \{([\s\S]*?)\n  \};/);
    ok(!!m, '能定位 createElevator 的返回对象');
    if (m) {
      const returned = m[1];
      okNeg(!/^\s*HOSTS_PATH\s*,/m.test(returned),
        '★ 实例的返回对象里确实没有 HOSTS_PATH（所以 `实例.HOSTS_PATH` 恒为 undefined）');
      ok(/^\s*paths\s*,/m.test(returned), '实例上有 paths（要路径请走它）');
    }
  }

  // ---------- 3. ★ 源码层：index.js 不许从实例取常量 ----------
  section('3. ★ index.js 源码：hostsPath 不许写成 `elevator.HOSTS_PATH`');
  {
    const raw = fs.readFileSync(INDEX, 'utf8');
    // ★ 先剥掉注释再检查 —— 否则「注释里提到过这个错误写法」也会被误判成错。
    //   （第一版就踩了这个：自检自己把注释当代码，报了假失败。）
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
      .replace(/^\s*\/\/.*$/gm, '');      // 行注释

    // 反面：`elevator.HOSTS_PATH`（实例上取常量）—— 这是我们踩过的那个写法
    okNeg(!/\belevator\.HOSTS_PATH\b/.test(src),
      '★ 代码里（不含注释）没有 `elevator.HOSTS_PATH`');

    // 正面：必须从模块取
    ok(/\belevatorMod\.HOSTS_PATH\b/.test(src),
      '代码里是从模块（elevatorMod）取 HOSTS_PATH');

    // ★ 负对照：正面检查必须能红 —— 造一份含错误写法的文本试一下
    const broken = 'let o = { hostsPath: elevator.HOSTS_PATH };';
    okNeg(/\belevator\.HOSTS_PATH\b/.test(broken),
      '★ 负对照：错误写法确实能被这个正则抓到（否则上面那条断言是装饰）');

    // 声明顺序：elevatorMod 必须在 elevator 之间定义（用代码，不含注释）
    const clean = raw.replace(/^\s*\/\/.*$/gm, '');
    const iMod = clean.indexOf('const elevatorMod =');
    const iInst = clean.indexOf('const elevator = elevatorMod');
    ok(iMod >= 0 && iInst >= 0 && iMod < iInst,
      'elevatorMod 先于 elevator 定义（顺序不能反）');
  }

  // ---------- 4. ★ 真加载 index.js（在 Electron 环境下）看默认值 ----------
  section('4. ★ 真跑一遍：加载 index.js，检查「模块级默认 hostsPath」');
  {
    // index.js require 了 store.js（要 electron），所以必须用 **electron 二进制**跑。
    //   ★ 不能用 process.execPath —— 那是 node，`require('electron')` 拿到的是
    //     一个路径字符串而不是 app（第一版就栽在这：静默拿到 null）。
    //   `require('electron')` 在普通 Node 下返回的正是 electron 可执行文件的路径。
    //
    // ★ 这个探针**不调用 init()**，所以读到的是源码里那个模块级默认值 ——
    //   也就是主人真机上「点开始专注」时会用到的那个。
    //   （端到端自检读的是 init 之后的沙箱值，所以它天然看不到这个 bug。）
    const electronBin = require('electron');
    const stamp = `${Date.now()}`;
    const probe = path.join(os.tmpdir(), `focus-wiring-probe-${stamp}.js`);
    const outFile = path.join(os.tmpdir(), `focus-wiring-out-${stamp}.json`);
    fs.writeFileSync(probe, `
const { app } = require('electron');
const fs = require('fs');
const OUT = ${JSON.stringify(outFile)};
const dump = (o) => { try { fs.writeFileSync(OUT, JSON.stringify(o), 'utf8'); } catch {} };
process.on('uncaughtException', (e) => { dump({ err: String((e && e.stack) || e) }); app.exit(0); });
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  let out = { ok: false };
  try {
    const focus = require(${JSON.stringify(INDEX)});
    out.hostsPath = focus.hostsPath();
    out.ok = typeof out.hostsPath === 'string' && out.hostsPath.length > 0;
  } catch (e) {
    out.err = String((e && e.stack) || e);
  }
  dump(out);
  app.exit(0);
}).catch((e) => { dump({ err: String((e && e.stack) || e) }); app.exit(0); });
`, 'utf8');

    // ★ 用 spawnSync + stdio:'ignore'，结果走文件。
    //   第一版把探针输出走管道（默认 pipe），在这台机器上直接 EBUSY
    //   （spawnSync 与父进程管道抢锁）。写文件既稳又不受编码影响。
    const { spawnSync } = require('child_process');
    try {
      spawnSync(electronBin, [probe, '--no-sandbox'], {
        cwd: ROOT,
        env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
        stdio: 'ignore',
        timeout: 60000,
      });
    } catch { /* 忽略，看结果文件 */ }

    let res = null;
    try { res = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* ignore */ }

    if (!res) {
      console.log('      （探针没写结果文件 —— 可能 electron 没起来）');
    }
    ok(!!res && !res.err, 'index.js 能被加载（没在 require 阶段炸）');
    if (res && res.err) console.log(`      ${res.err.split('\n').slice(0, 3).join(' | ')}`);

    okNeg(!!res && typeof res.hostsPath === 'string' && res.hostsPath.length > 0,
      `★ 默认 hostsPath 是有效字符串（实际 ${JSON.stringify(res && res.hostsPath)}）`);
    ok(!!res && /[\\/]hosts$/i.test(res.hostsPath || ''),
      `★ 默认 hostsPath 形如 …\\hosts（实际 ${res && res.hostsPath}）`);
    okNeg(!!res && res.hostsPath === require(ELEVATE).HOSTS_PATH,
      '★ 默认 hostsPath 就是模块里那个 HOSTS_PATH（不是从实例取的 undefined）');

    try { fs.unlinkSync(probe); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }

  // ---------- 5. ★ 端到端必须真的用上真路径（沙箱才允许覆盖） ----------
  section('5. ★ main.js：只有自检才允许覆盖 hostsPath');
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
    ok(/focusSandbox/.test(mainSrc), 'main.js 里有 focusSandbox 判定');
    ok(/hostsPath:\s*focusSandbox\s*\?/.test(mainSrc),
      'hostsPath 只在沙箱（focusSandbox）时才被覆盖');
    okNeg(!/hostsPath:\s*['"]C:\\\\Windows/.test(mainSrc),
      '★ 没有把真实 hosts 路径硬编码进 main.js 的 init 调用（真路径应来自 focus 模块默认值）');
  }
} catch (err) {
  fail++;
  console.log(`\n✗ 自检自身抛异常：${(err && err.stack) || err}`);
}

console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exitCode = fail ? 1 : 0;
