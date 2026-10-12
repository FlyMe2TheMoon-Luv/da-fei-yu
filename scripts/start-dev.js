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
  extra.push('--disable-gpu', '--disable-software-rasterizer', '--no-sandbox');
}

const args = ['.', ...extra, ...passthrough.filter((a) => a !== '--no-gpu')];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键：解除「退化成 Node」的开关

const child = spawn(electronBin, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code == null ? 0 : code));
