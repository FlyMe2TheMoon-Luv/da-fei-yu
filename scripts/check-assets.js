// scripts/check-assets.js
// 素材体检工具：报告图片的尺寸、色彩类型、是否真透明。
//
// 为什么需要它：PNG 带 alpha 通道 ≠ 背景真的透明。
// 很多 AI 生成图或抠图产物看着是透明底，实际背景是一层白色不透明像素，
// 贴到桌面上就会变成一块白方块。这个脚本直接解码像素来验。
//
// 用法：
//   node scripts/check-assets.js <文件或目录> [更多路径...]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COLOR_TYPE = { 0: '灰度', 2: 'RGB（无透明通道）', 3: '索引色', 4: '灰度+alpha', 6: 'RGBA（有透明通道）' };

// 极简 PNG 解码：支持 8 位深、非隔行。够用于素材体检。
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.slice(0, 8).equals(sig)) throw new Error('不是 PNG 文件');

  let off = 8, idat = [], w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) return { w, h, bitDepth, colorType, unsupported: true };

  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (ch === 0) return { w, h, bitDepth, colorType, unsupported: true };

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = y * stride, prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[cur + x - ch] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (y > 0 && x >= ch) ? out[prev + x - ch] : 0;
      const v = line[x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      out[cur + x] = val & 0xff;
    }
  }
  return { w, h, bitDepth, colorType, ch, pixels: out };
}

function inspect(file) {
  const name = path.basename(file);
  let r;
  try { r = decodePNG(file); } catch (err) { console.log(`  ${name}  ✗ 读取失败：${err.message}`); return; }

  const info = `${r.w}×${r.h} · ${COLOR_TYPE[r.colorType] || '未知'}`;
  if (r.unsupported || !r.ch) {
    console.log(`  ${name}  ${info}  （位深/类型不支持详细检测）`);
    return;
  }

  const { w, h, ch, pixels } = r;
  const alphaAt = (x, y) => pixels[(y * w + x) * ch + (ch - 1)];
  const corners = [alphaAt(1, 1), alphaAt(w - 2, 1), alphaAt(1, h - 2), alphaAt(w - 2, h - 2)];
  let transparent = 0, opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const a = pixels[i * ch + (ch - 1)];
    if (a < 8) transparent++; else if (a > 247) opaque++;
  }
  const total = w * h;
  const pct = (n) => (n / total * 100).toFixed(1) + '%';
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
  } else files.push(t);
}

console.log(`体检 ${files.length} 个 PNG 文件：`);
for (const f of files) inspect(f);
