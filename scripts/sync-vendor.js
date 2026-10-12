// scripts/sync-vendor.js
// 把第三方运行时从 node_modules 同步到渲染进程的 vendor 目录。
//
// 为什么要这么做：
//   本项目不用打包器（CLAUDE.md 硬性约定），渲染进程直接 <script src> 引文件，
//   所以必须有一份「拷出来的」产物。这个脚本保证它可复现、来源可追溯。
//
// 用法：
//   npm run sync-vendor
//
// 注意：live2dcubismcore.min.js（Live2D Cubism Core）不来自 npm，
// 它是 Live2D 官方分发的专有运行时，需单独获取，见 vendor/README.md。
// 本脚本只负责校验它在不在、并打印它的哈希。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'src', 'renderer', 'pet', 'vendor');

// 拷贝清单：[node_modules 里的路径, vendor 里的文件名]
const COPY = [
  ['pixi.js/dist/browser/pixi.min.js', 'pixi.min.js'],
  ['pixi-live2d-display/dist/cubism4.min.js', 'cubism4.min.js'],
];

// 不从 npm 来的文件，只校验存在性
const EXTERNAL = ['live2dcubismcore.min.js'];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

fs.mkdirSync(VENDOR, { recursive: true });

console.log('同步第三方运行时 → src/renderer/pet/vendor/\n');

for (const [from, to] of COPY) {
  const src = path.join(ROOT, 'node_modules', from);
  const dst = path.join(VENDOR, to);
  if (!fs.existsSync(src)) {
    console.error(`  ✗ 找不到 ${from}（先跑 npm install）`);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(src, dst);
  const kb = (fs.statSync(dst).size / 1024).toFixed(0);
  console.log(`  ✓ ${to.padEnd(28)} ${kb.padStart(5)} KB  sha256:${sha256(dst)}`);
}

for (const f of EXTERNAL) {
  const dst = path.join(VENDOR, f);
  if (fs.existsSync(dst)) {
    const kb = (fs.statSync(dst).size / 1024).toFixed(0);
    console.log(`  ✓ ${f.padEnd(28)} ${kb.padStart(5)} KB  sha256:${sha256(dst)}  （外部来源，未改动）`);
  } else {
    console.error(`  ✗ ${f} 缺失 —— 这是 Live2D Cubism Core，需从官方获取，见 vendor/README.md`);
    process.exitCode = 1;
  }
}

console.log('\n完成。版本：');
for (const p of ['pixi.js', 'pixi-live2d-display']) {
  try {
    console.log(`  ${p}@${require(path.join(ROOT, 'node_modules', p, 'package.json')).version}`);
  } catch {
    console.log(`  ${p} 未安装`);
  }
}
