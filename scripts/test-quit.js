// scripts/test-quit.js
// 「停止桌宠」端到端自检
//
// 用法：npm run test:quit
//
// 背景：
//   桌面上那两个双击图标（见 scripts/make-launcher.js）里，「停止桌宠」走的是
//   「再启动一次自己 + 带上 --pet-quit」这条路 —— 已经开着的实例在
//   second-instance 事件里收到这个参数，然后优雅退出。
//
// 为什么必须端到端，不能只做单元测试：
//   --pet-quit 能不能真的传到位，取决于「Electron 会不会把自定义命令行参数
//   原样交给 second-instance 的 argv」——这是框架行为，mock 不出来。
//   如果 Chromium 把这个参数吃掉了，单元测试照样绿，桌面上点「停止」却没反应。
//
// 为什么必须有负对照（HANDOFF 第六节第 19 条）：
//   如果只断言「带 --pet-quit 启动之后桌宠没了」，那万一桌宠压根没启动成功，
//   测试也会通过 —— 典型的假绿。所以第 2 步先证明「不带参数再启动一次，
//   桌宠依然活着、而且新来的那个自己退了」。

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron');   // 普通 Node 下拿到的是 electron.exe 的绝对路径
const UD = path.join(os.tmpdir(), 'desktop-pet-quit-test');

// 和 scripts/start-dev.js 里 --no-gpu 翻译出来的那组完全一致。
// 这台机器没有可用 GPU（不带这组参数会 FATAL: GPU process isn't usable），
// 测试要跑在跟真实使用一样的环境里。
const GPU_FLAGS = [
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-process-crash-limit',
];

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败${extra}`); }
}
function section(t) { console.log(`\n${t}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个桌宠实例（用的是独立的 user-data-dir，不会打扰主人正在用的那个）
function launch(extraArgs = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 坑 7：不清掉的话 electron 会退化成普通 Node
  return spawn(
    ELECTRON,
    [ROOT, ...GPU_FLAGS, `--user-data-dir=${UD}`, ...extraArgs],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
}

// 等一个子进程结束，返回退出码；超时返回 null（= 还活着）
function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    child.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code == null ? 0 : code);
    });
  });
}

// 等某个实例打出「已就绪」那行日志（比死等固定秒数可靠）
function waitReady(child, ms) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(false), ms);
    const onData = (d) => {
      buf += d.toString();
      // createWindow 之后第一行日志就是这个，说明窗口和渲染进程都起来了
      if (/\[main\] 屏幕 \d+×\d+/.test(buf)) finish(true);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', () => finish(false));
  });
}

// ---------- 主流程 ----------

(async () => {
  console.log('「停止桌宠」端到端自检');
  console.log(`electron: ${ELECTRON}`);
  console.log(`项目目录: ${ROOT}`);
  console.log(`独立数据目录: ${UD}`);

  // 清掉上一次跑剩的，免得状态互相干扰
  try { fs.rmSync(UD, { recursive: true, force: true }); } catch { /* 无所谓 */ }

  let pet = null;
  const strays = [];

  try {
    // ---------- 1. 先把桌宠正常启动起来 ----------
    section('1. 启动桌宠');
    pet = launch();
    const ready = await waitReady(pet, 30000);
    ok(ready, '桌宠启动成功（日志里出现了「屏幕 …」那一行）');
    if (!ready) throw new Error('桌宠没起来，后面的测试没意义');

    // ---------- 2. 负对照：普通地「再启动一次」，桌宠不能被关掉 ----------
    section('2. 负对照 · 不带 --pet-quit 再启动一次');
    {
      const second = launch();
      strays.push(second);
      const code = await waitExit(second, 20000);
      ok(code !== null, '★ 负对照：新实例自己退出了（单实例锁生效）', code === null ? ' → 它一直不退，超时' : ` → 退出码 ${code}`);
      ok(pet.exitCode === null, '★ 负对照：桌宠本体依然活着（普通重复启动不该把它关掉）');
      if (pet.exitCode !== null) throw new Error('桌宠被误关了，后面的测试没意义');
    }

    // ---------- 3. 正菜：带 --pet-quit 再启动一次，桌宠应该优雅退出 ----------
    section('3. 带 --pet-quit 再启动一次');
    {
      const second = launch(['--pet-quit']);
      strays.push(second);
      const code2 = await waitExit(second, 20000);
      ok(code2 !== null, '通知用的那个实例立刻退出（不常驻）', code2 === null ? ' → 超时' : ` → 退出码 ${code2}`);

      const petCode = await waitExit(pet, 20000);
      ok(petCode !== null, '★ 桌宠本体收到指令后真的退出了', petCode === null ? ' → 20 秒还没退，--pet-quit 没传到位' : ` → 退出码 ${petCode}`);
      ok(petCode === 0, '★ 是「优雅退出」不是崩溃（退出码 0）', ` → 实际 ${petCode}`);
    }

    // ---------- 4. 负对照：没在跑的时候点「停止桌宠」，不能卡住 ----------
    section('4. 负对照 · 没在跑的时候点「停止桌宠」');
    {
      const lone = launch(['--pet-quit']);
      strays.push(lone);
      const code = await waitExit(lone, 20000);
      ok(code !== null, '★ 负对照：直接安静退出，不会卡在那里', code === null ? ' → 超时' : ` → 退出码 ${code}`);
      ok(code === 0, '★ 负对照：退出码为 0（不是报错退出）', ` → 实际 ${code}`);
    }
  } catch (err) {
    fail++;
    console.log(`\n  ✗ 测试中断：${err && err.message}`);
  } finally {
    // 收拾干净：这次测试起过的实例一个都不能留
    for (const c of [pet, ...strays]) {
      if (c && c.exitCode === null) { try { c.kill(); } catch { /* 已经没了 */ } }
    }
    await sleep(600);
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch { /* 无所谓 */ }
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
})();
