// scripts/shot.js
// 开发用截屏工具：把整个桌面抓下来存成 PNG，用来肉眼验收桌宠长什么样。
//
// 为什么不用 PowerShell 截屏：Windows 上 Add-Type 调 .NET 会被安全策略拦，
// 而 Electron 自带 desktopCapturer，不用白不用。
//
// 用法：
//   npm run shot                  → tmp/shot.png
//   npm run shot -- 我的截图.png   → tmp/我的截图.png
//
// 注意：它抓的是「整个桌面」，所以要在桌宠已经跑起来之后再执行。

const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp');

const name = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'shot.png';
const outFile = path.join(OUT_DIR, name.endsWith('.png') ? name : `${name}.png`);

app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor),
      },
    });
    if (!sources.length) throw new Error('没有可捕获的屏幕');

    const img = sources[0].thumbnail;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(outFile, img.toPNG());

    const s = img.getSize();
    console.log(`✓ 已截图 ${path.relative(ROOT, outFile)}  ${s.width}×${s.height}  (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error('✗ 截图失败：' + err.message);
    process.exitCode = 1;
  }
  app.quit();
});
