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

const { spawn } = require('child_process');

// 在普通 Node 下 require('electron') 拿到的是 electron 可执行文件的绝对路径
const electronBin = require('electron');

const passthrough = process.argv.slice(2);
const extra = [];

if (passthrough.includes('--no-gpu')) {
  // 注意：这里**不能**用 --disable-software-rasterizer。
  // 它会把软件光栅化也一起关掉，于是在没有独显的环境里 WebGL 直接不可用，
  // 桌宠会白屏并报 "WebGL unsupported"。
  // 正确组合是：禁用硬件 GPU + 允许 SwiftShader 软件渲染兜底。
  extra.push('--disable-gpu', '--enable-unsafe-swiftshader', '--no-sandbox');
}

const args = ['.', ...extra, ...passthrough.filter((a) => a !== '--no-gpu')];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键：解除「退化成 Node」的开关

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code == null ? 0 : code));
