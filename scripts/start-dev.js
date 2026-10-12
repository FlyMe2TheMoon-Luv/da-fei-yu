// scripts/start-dev.js
// 开发启动器：抹平两个「环境坑」，让 `npm start` 在哪都能开起来。
//
// 坑 1 · ELECTRON_RUN_AS_NODE
//   某些终端（VS Code / 部分 IDE 集成终端）会预设 ELECTRON_RUN_AS_NODE=1，
//   这会让 electron 退化成「普通 Node」来跑 main.js，
//   于是报 `Cannot read properties of undefined (reading 'whenReady')`。
//   → 本脚本在启动前把这个变量从子进程环境里删掉。
//
// 坑 2 · 没有可用 GPU
//   虚拟机 / 远程桌面 / 无显卡驱动时，Chromium 的 GPU 进程会崩溃并 FATAL 退出。
//   → 传 `--no-gpu` 即可：npm start -- --no-gpu
//   注意这条会顺带打开 SwiftShader 软件渲染，保证 WebGL 还能用（桌宠靠它渲染 Live2D）。
//
// 用法：
//   npm start                 正常启动
//   npm start -- --no-gpu     无 GPU 环境启动
//   npm start -- <其他参数>    额外参数原样透传给 electron
//
// 开发自检（两个便利参数，由本脚本翻译成环境变量 / 启动参数）：
//   npm start -- --no-gpu --selftest=gaze      拖拽时「视线跟随」开关自检
//   npm start -- --no-gpu --selftest=drag      拖拽性能自检（搬窗口频率 / 帧间隔）
//   npm start -- --no-gpu --selftest=exit      退出按钮自检（含「控件能不能点到」）
//   npm start -- --no-gpu --selftest=scheduler 调度引擎端到端（要等 30 秒轮询）
//   npm start -- --no-gpu --selftest=reminder  提醒呈现自检（会真的弹一条系统通知）
//   npm start -- --no-gpu --selftest=settings  日程管理窗口自检（会真的开窗口、写一条日程再删掉）
//   npm start -- --no-gpu --selftest=1         原有的穿透 + 表情自检
//   --isolated  用独立的临时 user-data-dir（每次启动前会先清空）
//               —— 桌宠是单实例程序，已经开着一个时，再启动会被直接顶掉，
//                  自检根本不会跑（很容易误判成「通过」），所以跑自检务必加上它。
//               注意它是「干净」目录：自检会挪桌宠、存位置，复用旧目录会让
//               结果取决于上次跑剩什么（见下面 isolated 分支的注释）。
//
// 环境变量（开发便利）：
//   PET_OPEN_SETTINGS=1  启动时自动把日程管理窗口开出来（做视觉验收 / 截图用）

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 在普通 Node 下 require('electron') 拿到的是 electron 可执行文件的绝对路径
const electronBin = require('electron');

const passthrough = process.argv.slice(2);
const extra = [];
const rest = [];
let selftest = null;
let isolated = false;

for (const arg of passthrough) {
  if (arg === '--no-gpu') {
    // 注意：这里**不能**用 --disable-software-rasterizer。
    // 它会把软件光栅化也一起关掉，于是在没有独显的环境里 WebGL 直接不可用，
    // 桌宠会白屏并报 "WebGL unsupported"。
    // 正确组合是：禁用硬件 GPU + 允许 SwiftShader 软件渲染兜底。
    // 再加 --disable-gpu-process-crash-limit：
    //   SwiftShader 在软件渲染下偶尔会把 GPU 子进程搞崩，默认策略是
    //   「崩几次就整个浏览器自杀」。加上这条它会一直重启子进程，桌宠不会整个消失。
    extra.push(
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-gpu-process-crash-limit'
    );
  } else if (arg.startsWith('--selftest=')) {
    selftest = arg.slice('--selftest='.length);
  } else if (arg === '--isolated') {
    isolated = true;
  } else {
    rest.push(arg);
  }
}

if (isolated) {
  // ⚠ 必须先把上一次的目录删掉再启动，别直接复用。
  //   自检会拖动桌宠窗口、并把位置存进 userData；如果沿用旧目录，
  //   桌宠就会停在「上一次自检结束时」的位置上 —— 而窗口尺寸、
  //   跟设置窗口的重叠面积都跟位置有关，于是自检结果变成
  //   「取决于上一次跑剩了什么」。
  //   实测踩到过：设置窗口自检在有旧位置时报「压住桌宠 5.3%」，
  //   清空目录后是 2.3%（阈值 5%）。
  const dir = path.join(os.tmpdir(), 'desktop-pet-selftest');
  fs.rmSync(dir, { recursive: true, force: true });
  rest.push(`--user-data-dir=${dir}`);
}

const args = ['.', ...extra, ...rest];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键：解除「退化成 Node」的开关
if (selftest) env.PET_SELFTEST = selftest;

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code == null ? 0 : code));
