// scripts/make-tray-icon.js
// 生成托盘图标：src/assets/tray.png
//
// 为什么要单独生成：
//   现有的 src/assets/pet/icon.png 是 48×64（竖长方形），
//   直接丢给 Electron 当托盘图标会被压成正方形，角色会变形。
//   这里把它裁到角色本体、再居中放进一个方形透明画布，就正常了。
//
// 用法：
//   npm run make-tray-icon
//
// 换形象时重跑一次即可。

const fs = require('fs');
const path = require('path');
const { decodePNG, encodePNG, toRGBA, contentBounds, crop, fitSquare } = require('./lib/png');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'assets', 'pet', 'icon.png');
const OUT = path.join(ROOT, 'src', 'assets', 'tray.png');

// Windows 托盘在 100% 缩放下用 16×16，200% 用 32×32。
// 给 32×32 让系统自己缩，比给 16×16 清晰。
const SIZE = 32;

const img = decodePNG(SRC);
if (img.unsupported) {
  console.error(`✗ ${path.relative(ROOT, SRC)} 的格式不支持（位深 ${img.bitDepth} / 类型 ${img.colorType}）`);
  process.exit(1);
}

const rgba = toRGBA(img);
const bounds = contentBounds(img.w, img.h, rgba);
if (!bounds) {
  console.error('✗ 整张图都是透明的，没内容可裁');
  process.exit(1);
}

console.log(`源图 ${img.w}×${img.h} → 角色实际范围 ${bounds.w}×${bounds.h}（x${bounds.x} y${bounds.y}）`);

const cropped = crop(img.w, img.h, rgba, bounds);
const square = fitSquare(bounds.w, bounds.h, cropped, SIZE);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG(SIZE, SIZE, square));

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`✓ 已生成 ${path.relative(ROOT, OUT)}  ${SIZE}×${SIZE}  ${kb} KB`);
