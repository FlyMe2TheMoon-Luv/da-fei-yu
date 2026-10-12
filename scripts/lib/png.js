// scripts/lib/png.js
// 极简 PNG 解码 / 编码，零依赖（只用 Node 自带的 zlib）。
//
// 为什么自己写：项目约定不引第三方依赖，而「验素材透明度」「生成托盘图标」
// 这类事只需要读像素、写像素，为它装个 sharp（几十 MB）不划算。
//
// 能力边界（够用就行，不追求完整实现）：
//   解码：8 位深、非隔行、灰度/RGB/RGBA
//   编码：8 位深 RGBA、filter 固定 None

const zlib = require('zlib');
const fs = require('fs');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE = {
  0: '灰度',
  2: 'RGB（无透明通道）',
  3: '索引色',
  4: '灰度+alpha',
  6: 'RGBA（有透明通道）',
};

// ---------- 解码 ----------

// 返回 { w, h, bitDepth, colorType, ch, pixels }；pixels 是 RGBA 或原通道的字节
function decodePNG(file) {
  const buf = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (!buf.slice(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件');

  let off = 8;
  const idat = [];
  let w = 0, h = 0, bitDepth = 8, colorType = 6, interlace = 0;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
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
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const cur = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[cur + x - ch] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= ch ? out[prev + x - ch] : 0;
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

// 统一转成 RGBA，方便后续处理（灰度/RGB 补上 alpha=255）
function toRGBA(img) {
  if (img.ch === 4) return img.pixels;
  const { w, h, ch, pixels } = img;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    const d = i * 4;
    if (ch === 3) {
      out[d] = pixels[s]; out[d + 1] = pixels[s + 1]; out[d + 2] = pixels[s + 2]; out[d + 3] = 255;
    } else {
      out[d] = out[d + 1] = out[d + 2] = pixels[s]; out[d + 3] = 255;
    }
  }
  return out;
}

// ---------- 编码 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgba: Buffer(w*h*4)，长度必须是 w*h*4
function encodePNG(w, h, rgba) {
  if (rgba.length !== w * h * 4) throw new Error(`像素数据长度不对：期望 ${w * h * 4}，实际 ${rgba.length}`);

  const rowLen = 1 + w * 4;
  const raw = Buffer.alloc(h * rowLen);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0; // filter: None
    rgba.copy(raw, y * rowLen + 1, y * w * 4, (y + 1) * w * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 常用变换 ----------

// 找出 alpha > threshold 的像素范围；全透明返回 null
function contentBounds(w, h, rgba, threshold = 16) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 裁切
function crop(w, h, rgba, r) {
  const out = Buffer.alloc(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    rgba.copy(out, y * r.w * 4, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4);
  }
  return out;
}

// 缩放到目标尺寸（盒式平均，缩小时比最近邻干净很多）
function resize(w, h, rgba, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = w / tw;
  const sy = h / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil((ty + 1) * sy)));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil((tx + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          // 按 alpha 加权，避免透明像素的黑色把边缘染脏
          const wgt = rgba[i + 3] / 255;
          r += rgba[i] * wgt; g += rgba[i + 1] * wgt; b += rgba[i + 2] * wgt; a += rgba[i + 3];
          n += wgt;
        }
      }
      const o = (ty * tw + tx) * 4;
      if (n > 0) {
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
      }
      out[o + 3] = Math.round(a / (x1 - x0) / (y1 - y0));
    }
  }
  return out;
}

// 把内容居中放进一个 size×size 的透明方框（内容按 margin 比例缩小留白）
function fitSquare(w, h, rgba, size, margin = 0.06) {
  const inner = Math.round(size * (1 - margin * 2));
  const scale = Math.min(inner / w, inner / h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const scaled = resize(w, h, rgba, tw, th);

  const out = Buffer.alloc(size * size * 4); // 全透明
  const ox = Math.round((size - tw) / 2);
  const oy = Math.round((size - th) / 2);
  for (let y = 0; y < th; y++) {
    scaled.copy(out, ((oy + y) * size + ox) * 4, y * tw * 4, (y + 1) * tw * 4);
  }
  return out;
}

module.exports = { decodePNG, encodePNG, toRGBA, contentBounds, crop, resize, fitSquare, COLOR_TYPE };
