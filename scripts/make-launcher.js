// scripts/make-launcher.js
// 生成「双击就能开关桌宠」的桌面快捷方式 —— 让主人不依赖小安、不依赖 npm 也能自己开桌宠。
//
// 用法：
//   npm run make-launcher                     → 生成到桌面
//   npm run make-launcher -- --out=tmp/xxx    → 生成到指定目录（开发/测试用，不碰主人的桌面）
//   npm run make-launcher -- --no-icon        → 只生成快捷方式，不重做图标
//
// 产出：
//   桌面\启动桌宠.lnk    双击 → 桌宠出现（已经在跑的话，把已有的唤到前面）
//   桌面\停止桌宠.lnk    双击 → 桌宠优雅退出（走 --pet-quit，见 src/main/main.js）
//   src/assets/pet/桌宠.ico   多尺寸图标（16/32/48/64/128/256）
//   launcher\start-pet.bat / stop-pet.bat / start-pet.vbs / stop-pet.vbs
//       ↑ 备胎：万一 .lnk 坏了（被杀毒软件删了、项目挪了位置），
//         可以直接双击这几个，或者用记事本打开看它到底干了什么。
//
// ─────────── 这个文件为什么有「两种身份」 ───────────
// 生成 .lnk 得用 Windows 的 Shell API。Node 自己拼 .lnk 的二进制很容易拼错，
// 而 Electron 自带 shell.writeShortcutLink（已实测：生成的快捷方式真的能启动桌宠）。
// 所以本脚本会跑两遍：
//   第 1 遍（node 跑）      ：生成图标 + 备胎脚本，然后用 electron 再把自己跑一遍
//   第 2 遍（electron 跑）  ：只负责写那两个 .lnk
//
// ─────────── 两个必须记住的坑 ───────────
// 坑 A：.bat 文件里**绝对不能写中文**。
//   cmd.exe 是按系统 ANSI 代码页（中文系统是 GBK）读 .bat 的，而我们的文件是
//   UTF-8 存的，中文会变成乱码，而且乱码里可能带出引号/重定向符号，
//   把后面几行命令一起带崩（实测：整个脚本报「不是内部或外部命令」）。
//   → 所以 launcher\ 里的文件全部只用英文，连**文件名**都用英文
//     （.vbs 里要写 .bat 的文件名，.vbs 同样只能存 ANSI）。
//     桌面上的图标名是中文没关系 —— 那是 NTFS 文件名，走的是 Unicode。
//
// 坑 B：桌面可能被 OneDrive 接管了。
//   主人这台机器上 %USERPROFILE%\Desktop 根本不存在，真实桌面在
//   C:\Users\FlyMe\OneDrive\Desktop。自己拼路径会写到空气里，
//   所以一律用 app.getPath('desktop')（它会问系统要真实位置）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICO_PATH = path.join(ROOT, 'src', 'assets', 'pet', '桌宠.ico');
const LAUNCHER_DIR = path.join(ROOT, 'launcher');

// 和 scripts/start-dev.js 里 --no-gpu 翻译出来的那组完全一致。
// 这台机器没有可用 GPU：不带这组参数 electron 会 FATAL: GPU process isn't usable 直接死。
// 里面的 --enable-unsafe-swiftshader 是让软件渲染兜底，否则 Live2D 的 WebGL 起不来。
const GPU_ARGS = '--disable-gpu --enable-unsafe-swiftshader --no-sandbox --disable-gpu-process-crash-limit';

const isElectron = !!process.versions.electron;

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { outDir: null, noIcon: false };
  for (const a of argv) {
    if (a.startsWith('--out=')) out.outDir = a.slice('--out='.length);
    else if (a === '--no-icon') out.noIcon = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ============================================================
//  第 1 遍：普通 Node —— 生成图标 + 备胎脚本，然后交给 electron
// ============================================================
if (!isElectron) {
  const { decodePNG, encodePNG, toRGBA, contentBounds, crop, fitSquare } = require('./lib/png');

  // ---------- 图标 ----------
  // Windows 会按场合挑不同尺寸：任务栏 32、桌面大图标 48/64、Alt+Tab 32、
  // 高分屏（主人这台是 150% 缩放）会挑更大的，所以做成多尺寸一套。
  // 每个尺寸都单独从原图缩，而不是「缩一次再逐级缩」，避免累积模糊。
  const ICON_SIZES = [16, 32, 48, 64, 128, 256];

  function buildIco(images) {
    // ICO 容器：6 字节头 + 每张 16 字节目录项 + 各张图片数据。
    // 目录项里 256 要写成 0（一个字节存不下 256）。图片数据直接用 PNG
    // （Vista 以后都支持，比 BMP 省事而且自带透明通道）。
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);              // reserved
    header.writeUInt16LE(1, 2);              // type: 1 = 图标
    header.writeUInt16LE(images.length, 4);  // 图片张数

    const entries = [];
    const blobs = [];
    let offset = 6 + 16 * images.length;
    for (const img of images) {
      const e = Buffer.alloc(16);
      e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);  // 宽
      e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);  // 高
      e.writeUInt8(0, 2);                               // 调色板颜色数（真彩写 0）
      e.writeUInt8(0, 3);                               // reserved
      e.writeUInt16LE(1, 4);                            // 色彩平面
      e.writeUInt16LE(32, 6);                           // 每像素位数
      e.writeUInt32LE(img.png.length, 8);               // 这张图片多少字节
      e.writeUInt32LE(offset, 12);                      // 从文件头算起的偏移
      offset += img.png.length;
      entries.push(e);
      blobs.push(img.png);
    }
    return Buffer.concat([header, ...entries, ...blobs]);
  }

  function makeIcon() {
    const src = path.join(ROOT, 'src', 'assets', 'pet', '正面.png');
    const img = decodePNG(fs.readFileSync(src));
    if (img.unsupported) throw new Error(`源图格式不支持（位深 ${img.bitDepth} / 类型 ${img.colorType}）`);

    const rgba = toRGBA(img);
    const bounds = contentBounds(img.w, img.h, rgba);
    if (!bounds) throw new Error('源图整张都是透明的，没内容可裁');

    // 先裁到角色本体（去掉四周空白），再居中放进正方形画布。
    // 不裁的话角色在图标里会偏小、还偏一边。
    const cropped = crop(img.w, img.h, rgba, bounds);
    const images = ICON_SIZES.map((size) => ({
      size,
      png: encodePNG(size, size, fitSquare(bounds.w, bounds.h, cropped, size)),
    }));

    fs.mkdirSync(path.dirname(ICO_PATH), { recursive: true });
    fs.writeFileSync(ICO_PATH, buildIco(images));

    // 自检：写出来的 .ico 结构对不对（读回来数一遍）
    const back = fs.readFileSync(ICO_PATH);
    const count = back.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const b = back.readUInt8(6 + 16 * i);
      sizes.push(b === 0 ? 256 : b);
    }
    console.log(`  ✓ 图标 ${path.relative(ROOT, ICO_PATH)}  ${(back.length / 1024).toFixed(1)} KB`);
    console.log(`    源图 ${img.w}×${img.h} → 裁到角色本体 ${bounds.w}×${bounds.h}`);
    console.log(`    内含 ${count} 个尺寸：${sizes.join(' / ')}`);
    if (count !== ICON_SIZES.length || sizes.join() !== ICON_SIZES.join()) {
      throw new Error('生成的 .ico 结构不对，读回来的尺寸和预期对不上');
    }
  }

  // ---------- 备胎脚本（全部纯英文，原因见文件头「坑 A」）----------
  function batBody(what, tail) {
    return `@echo off
rem ${what}
rem Generated by scripts/make-launcher.js -- edit that file, not this one.
rem ASCII ONLY: cmd.exe reads .bat in the ANSI codepage, so non-ASCII breaks it.
setlocal
rem Pitfall 7: if this is inherited, electron degenerates into plain Node and crashes.
set "ELECTRON_RUN_AS_NODE="
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "EXE=%ROOT%\\node_modules\\electron\\dist\\electron.exe"
if not exist "%EXE%" (
  echo [ERROR] electron.exe not found:
  echo         %EXE%
  echo         The project folder was probably moved or renamed.
  echo         Fix: run "npm run make-launcher" again.
  pause
  exit /b 1
)
${tail}
`;
  }

  const START_TAIL = `start "" "%EXE%" "%ROOT%" ${GPU_ARGS}`;
  const STOP_TAIL = `"%EXE%" "%ROOT%" --pet-quit`;

  // .vbs 只是把同目录的 .bat 藏起来跑，好处是双击时不闪黑框。
  // 真正的逻辑全在 .bat 里 —— .bat 能单独双击、也能被测试脚本直接跑，
  // 而 .vbs 需要 Windows Script Host，某些安全软件会禁掉，所以只当包装层。
  function vbsBody(batName) {
    return `' Generated by scripts/make-launcher.js
' Runs ${batName} with a hidden window so no black console flashes.
' ASCII ONLY (WSH reads .vbs in the ANSI codepage).
Option Explicit
Dim fso, sh, here, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
bat = fso.BuildPath(here, "${batName}")
If Not fso.FileExists(bat) Then
  MsgBox "Missing " & bat & vbCrLf & "Re-run: npm run make-launcher", 16, "Desktop Pet"
  WScript.Quit 1
End If
sh.Run """" & bat & """", 0, False
`;
  }

  const FILES = {
    'start-pet.bat': batBody('Double-click to START the desktop pet.', START_TAIL),
    'stop-pet.bat': batBody('Double-click to STOP the desktop pet (graceful).', STOP_TAIL),
    'start-pet.vbs': vbsBody('start-pet.bat'),
    'stop-pet.vbs': vbsBody('stop-pet.bat'),
  };

  console.log('生成桌宠快捷方式\n');

  if (!ARGS.noIcon) {
    console.log('1. 图标');
    makeIcon();
  } else {
    console.log('1. 图标（--no-icon，跳过）');
  }

  console.log('\n2. 备胎脚本 launcher/');
  fs.mkdirSync(LAUNCHER_DIR, { recursive: true });
  for (const [name, body] of Object.entries(FILES)) {
    // 自检：这些文件必须真的是纯 ASCII，否则 cmd 会读崩（坑 A）
    const bad = [...body].find((ch) => ch.charCodeAt(0) > 127);
    if (bad) throw new Error(`${name} 里出现了非 ASCII 字符 ${JSON.stringify(bad)}，cmd 会读崩`);
    fs.writeFileSync(path.join(LAUNCHER_DIR, name), body, 'ascii');
    console.log(`  ✓ launcher/${name}  ${body.length} 字节 · 纯 ASCII`);
  }

  console.log('\n3. 桌面快捷方式（换 electron 跑第 2 遍）');
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');   // 普通 Node 下 = electron.exe 的绝对路径
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronBin, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  if (r.error) throw r.error;
  process.exit(r.status == null ? 1 : r.status);
}

// ============================================================
//  第 2 遍：Electron —— 只负责写 .lnk
// ============================================================
const { app, shell } = require('electron');

// 直接指向 electron.exe，不经过 .bat/.vbs。
// 好处：electron.exe 是 GUI 程序，双击**不会闪黑框**，也不用经过脚本引擎
// （Windows Script Host 被安全软件禁掉也不影响）。
// 代价：.lnk 没法帮忙清掉 ELECTRON_RUN_AS_NODE（那是环境变量），
//       万一遇到坑 7，就改用 launcher/start-pet.vbs（它里面清了）。
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const SHORTCUTS = [
  {
    file: '启动桌宠.lnk',
    args: `"${ROOT}" ${GPU_ARGS}`,
    description: '打开桌宠',
  },
  {
    file: '停止桌宠.lnk',
    args: `"${ROOT}" --pet-quit`,
    description: '关闭桌宠',
  },
];

app.whenReady().then(() => {
  try {
    const outDir = ARGS.outDir ? path.resolve(ROOT, ARGS.outDir) : app.getPath('desktop');
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`  （真实桌面位置：${app.getPath('desktop')}）`);
    console.log(`  输出目录：${outDir}`);

    if (!fs.existsSync(ELECTRON_EXE)) {
      throw new Error(`找不到 electron.exe：${ELECTRON_EXE}\n  先跑 npm install`);
    }
    if (!fs.existsSync(ICO_PATH)) {
      console.log('  ⚠ 没有图标，改用 electron.exe 自带图标（下次别加 --no-icon）');
    }

    let bad = 0;
    for (const s of SHORTCUTS) {
      const target = path.join(outDir, s.file);
      const okWrite = shell.writeShortcutLink(target, 'create', {
        target: ELECTRON_EXE,
        args: s.args,
        cwd: ROOT,
        description: s.description,
        ...(fs.existsSync(ICO_PATH) ? { icon: ICO_PATH, iconIndex: 0 } : {}),
      });
      if (!okWrite) { bad++; console.log(`  ✗ ${s.file} 写入失败`); continue; }

      // 自检：把刚写的读回来对一遍。只写不验的话，参数写错了
      // 要等主人双击发现没反应才知道。
      const back = shell.readShortcutLink(target);
      const same = back.target === ELECTRON_EXE && back.args === s.args && back.cwd === ROOT;
      if (same) {
        console.log(`  ✓ ${s.file}`);
        console.log(`      目标 ${back.target}`);
        console.log(`      参数 ${back.args}`);
        console.log(`      起始目录 ${back.cwd}`);
        console.log(`      图标 ${back.icon || '(默认)'}`);
      } else {
        bad++;
        console.log(`  ✗ ${s.file} 读回来对不上：`);
        console.log(`      期望 target=${ELECTRON_EXE}`);
        console.log(`           args=${s.args}`);
        console.log(`      实际 target=${back.target}`);
        console.log(`           args=${back.args}`);
      }
    }

    if (bad) {
      console.log(`\n✗ 有 ${bad} 个快捷方式没写成功`);
      app.exit(1);
      return;
    }

    console.log('\n✓ 全部完成。以后直接双击桌面上的「启动桌宠」/「停止桌宠」就行。');
    console.log('  （项目挪位置或改名之后，重新跑一次 npm run make-launcher 即可）');
    app.exit(0);
  } catch (err) {
    console.error('\n✗ 生成快捷方式失败：', err && err.message);
    app.exit(1);
  }
});
