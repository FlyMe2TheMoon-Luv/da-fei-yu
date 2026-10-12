// spike/l2d/main.js
// Live2D 最小验证 —— 这不是正式代码，验证完可整目录删除。
//
// 要验证 4 件事：
//   1. 透明窗口里 WebGL 能不能正常显示（不出现黑底/白底）
//   2. Live2D 模型能不能加载出来
//   3. 眨眼、待机动作能不能跑
//   4. 实测帧率（Live2D 每帧跑物理+变形，性能是最大变数）
//
// 验证"透明无黑边"的办法：
//   开窗前拍一张桌面底图 → 开窗并加载模型后再拍一张 → 在窗口矩形内逐像素比对。
//   透明生效时，窗口内除模型/红色角标外的区域应与底图完全一致。

const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const W = 480;
const H = 640;

let win = null;
let baseline = null; // 开窗前的桌面底图（nativeImage）

// ---------- 抓一张全屏 ----------
async function grabScreen() {
  const d = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
    },
  });
  if (!sources.length) return null;
  return sources[0].thumbnail;
}

// ---------- 在指定矩形内比对两张图 ----------
// nativeImage.toBitmap() 给的是 BGRA 原始字节，不用解 PNG。
function compareRegion(imgA, imgB, rect) {
  const sa = imgA.getSize();
  const sb = imgB.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) {
    return { error: `尺寸不一致 ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}` };
  }
  const a = imgA.toBitmap();
  const b = imgB.toBitmap();
  const stride = sa.width * 4;

  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(sa.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(sa.height, Math.round(rect.y + rect.height));

  let sum = 0;
  let n = 0;
  let maxd = 0;
  let changed = 0; // 差异明显的像素数

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * stride + x * 4;
      const d =
        Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]);
      sum += d;
      n++;
      if (d > maxd) maxd = d;
      if (d > 24) changed++;
    }
  }
  return {
    pixels: n,
    avgDiff: n ? sum / n / 3 : 0,
    maxDiff: maxd / 3,
    changedRatio: n ? changed / n : 0,
  };
}

// ---------- 统计一块区域里"纯黑/纯白"的占比 ----------
function solidRatio(img, rect) {
  const s = img.getSize();
  const bmp = img.toBitmap();
  const stride = s.width * 4;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(s.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(s.height, Math.round(rect.y + rect.height));

  let black = 0;
  let white = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * stride + x * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      n++;
      if (r < 10 && g < 10 && b < 10) black++;
      else if (r > 245 && g > 245 && b > 245) white++;
    }
  }
  return { pixels: n, blackRatio: n ? black / n : 0, whiteRatio: n ? white / n : 0 };
}

// ---------- 取某点颜色（用来找红色角标） ----------
function pixelAt(img, x, y) {
  const s = img.getSize();
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return null;
  const bmp = img.toBitmap();
  const i = y * s.width * 4 + x * 4;
  return [bmp[i + 2], bmp[i + 1], bmp[i]]; // RGB
}

app.whenReady().then(async () => {
  // ===== 第一步：先拍底图（此时还没有我们的窗口） =====
  baseline = await grabScreen();
  if (baseline) {
    const s = baseline.getSize();
    console.log(`[main] 桌面底图已抓取 ${s.width}x${s.height}`);
    fs.writeFileSync(path.join(OUT, 'desktop-before.png'), baseline.toPNG());
  } else {
    console.log('[main] ⚠ 抓不到屏幕，透明验证将跳过');
  }

  // ===== 第二步：开窗 =====
  win = new BrowserWindow({
    width: W,
    height: H,
    x: 120,
    y: 120,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：透明窗口 + WebGL 常驻，不能被后台降频，否则动画会像卡住
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  // 把渲染进程的日志转发到终端，方便看验证结果
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message);
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
});

// 渲染进程请求截图 —— 用来确认"模型画出来了 + 背景是透明的"
ipcMain.handle('spike:capture', async (_e, name) => {
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  return `${file} (${size.width}x${size.height})`;
});

// 画布自导出 —— capturePage() 抓不到 WebGL 内容，只能让画布自己吐出来
ipcMain.handle('spike:save-canvas', (_e, dataUrl, name) => {
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, buf);
  return `${file} (${buf.length} 字节)`;
});

// 抓整个桌面并与底图比对 —— 验证"透明窗口在桌面上有没有黑边/白底"
ipcMain.handle('spike:capture-desktop', async () => {
  if (!baseline) return '没有底图，跳过';
  const after = await grabScreen();
  if (!after) return '抓不到屏幕';
  fs.writeFileSync(path.join(OUT, 'desktop-after.png'), after.toPNG());

  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor;
  const b = win.getBounds();
  // 窗口矩形换算成物理像素（截图是物理像素）
  const rect = {
    x: b.x * sf,
    y: b.y * sf,
    width: b.width * sf,
    height: b.height * sf,
  };

  const lines = [];
  lines.push(`窗口矩形(物理像素) x=${Math.round(rect.x)} y=${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);

  // 1) 整块窗口区域与底图的差异
  const whole = compareRegion(baseline, after, rect);
  if (whole.error) {
    lines.push('整体比对失败: ' + whole.error);
  } else {
    lines.push(
      `整窗比对: 平均色差 ${whole.avgDiff.toFixed(2)} · 最大 ${whole.maxDiff.toFixed(2)} · 变化像素占比 ${(whole.changedRatio * 100).toFixed(1)}%`
    );
  }

  // 2) 窗口顶部一条横带（模型肯定没覆盖到这里）—— 透明成功的话应与底图一致
  const topBand = {
    x: rect.x + rect.width * 0.15,
    y: rect.y + rect.height * 0.02,
    width: rect.width * 0.7,
    height: rect.height * 0.08,
  };
  const band = compareRegion(baseline, after, topBand);
  if (!band.error) {
    lines.push(
      `顶部空带比对: 平均色差 ${band.avgDiff.toFixed(2)} · 最大 ${band.maxDiff.toFixed(2)} · 变化像素占比 ${(band.changedRatio * 100).toFixed(1)}%`
    );
  }

  // 3) 窗口区域是不是一整片黑/白
  const solid = solidRatio(after, rect);
  lines.push(
    `窗口区域纯黑占比 ${(solid.blackRatio * 100).toFixed(1)}% · 纯白占比 ${(solid.whiteRatio * 100).toFixed(1)}%`
  );

  // 4) 四个红角标在不在（在 → 说明窗口真的被合成到桌面上了）
  const probe = 9 * sf; // 角标线宽 3px，画在距边 6px 处
  const pts = {
    左上: [rect.x + probe, rect.y + probe],
    右上: [rect.x + rect.width - probe, rect.y + probe],
    左下: [rect.x + probe, rect.y + rect.height - probe],
    右下: [rect.x + rect.width - probe, rect.y + rect.height - probe],
  };
  const found = [];
  for (const [k, [px, py]] of Object.entries(pts)) {
    const c = pixelAt(after, Math.round(px), Math.round(py));
    const isRed = c && c[0] > 150 && c[1] < 120 && c[2] < 120;
    found.push(`${k}:${isRed ? '红' : c ? `rgb(${c.join(',')})` : '越界'}`);
  }
  lines.push('角标探测 ' + found.join(' · '));

  return lines.join('\n');
});

ipcMain.on('spike:done', () => {
  console.log('[main] 渲染进程报告完成，1.5 秒后自动退出');
  setTimeout(() => app.quit(), 1500);
});

app.on('window-all-closed', () => app.quit());
