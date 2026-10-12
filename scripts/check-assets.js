// scripts/check-assets.js
// 素材体检工具：报告图片的尺寸、色彩类型、是否真透明。
//
// 为什么需要它：PNG 带 alpha 通道 ≠ 背景真的透明。
// 很多 AI 生成图或抠图产物看着是透明底，实际背景是一层白色不透明像素，
// 贴到桌面上就会变成一块白方块。这个脚本直接解码像素来验。
//
// 用法：
//   npm run check-assets src/assets/pet
//   node scripts/check-assets.js <文件或目录> [更多路径...]

const fs = require('fs');
const path = require('path');
const { decodePNG, COLOR_TYPE } = require('./lib/png');

function inspect(file) {
  const name = path.basename(file);
  let r;
  try {
    r = decodePNG(file);
  } catch (err) {
    console.log(`  ${name}  ✗ 读取失败：${err.message}`);
    return;
  }

  const info = `${r.w}×${r.h} · ${COLOR_TYPE[r.colorType] || '未知'}`;
  if (r.unsupported || !r.ch) {
    console.log(`  ${name}  ${info}  （位深/类型不支持详细检测）`);
    return;
  }

  const { w, h, ch, pixels } = r;
  const alphaAt = (x, y) => pixels[(y * w + x) * ch + (ch - 1)];
  const corners = [alphaAt(1, 1), alphaAt(w - 2, 1), alphaAt(1, h - 2), alphaAt(w - 2, h - 2)];

  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const a = pixels[i * ch + (ch - 1)];
    if (a < 8) transparent++;
    else if (a > 247) opaque++;
  }

  const total = w * h;
  const pct = (n) => ((n / total) * 100).toFixed(1) + '%';
  const cornerOpaque = corners.every((a) => a > 247);
  const verdict = cornerOpaque ? '✗ 背景不透明（四角是实色）' : '✓ 背景透明（四角是空的）';

  console.log(`  ${name}  ${info}`);
  console.log(`      ${verdict} · 完全透明 ${pct(transparent)} · 完全不透明 ${pct(opaque)}`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log('用法：node scripts/check-assets.js <文件或目录> [更多路径...]');
  process.exit(1);
}

const files = [];
for (const t of targets) {
  const st = fs.statSync(t);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(t)) {
      const full = path.join(t, f);
      if (fs.statSync(full).isDirectory()) {
        for (const g of fs.readdirSync(full)) if (g.endsWith('.png')) files.push(path.join(full, g));
      } else if (f.endsWith('.png')) files.push(full);
    }
  } else {
    files.push(t);
  }
}

console.log(`体检 ${files.length} 个 PNG 文件：`);
for (const f of files) inspect(f);
