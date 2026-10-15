// scripts/check-package.js
// 打包配置体检（只读，不真打包）
//
// 用法：npm run check:package         体检
//       npm run check:package -- --selfcheck   验「体检自己」灵不灵
//
// ── 为什么要有这个 ──
//   打包配置错一点，**构建照样成功**，只是产物不对：
//     · appId 和 main.js 的 setAppUserModelId 不一致 → 任务栏图标/通知归组异常
//     · files 白名单漏了许可文件 → **CC BY-NC-SA 的署名义务直接违约**，而且没人会发现
//     · 图标缺 256×256 → 某些 Windows 上安装包图标糊成一团
//     · deleteAppDataOnUninstall 变成 true → 卸载时把主人的日程一起删了
//   这些**一条都不会报错**，所以必须专门体检。
//
//   ★ appId 那条和第 72 条坑是同一类：**同一个值写在两个地方**，
//     留一条会红的断言比写一句「记得保持一致」有用得多。
//
// ── 结构 ──
//   审计逻辑抽成纯函数 audit()，--selfcheck 拿假数据喂它 —— 证明它真能红。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── 纯函数：给一份配置 + 几个探测结果，返回问题清单 ──
// cfg         electron-builder 配置对象（null = 读不到）
// appIdInMain main.js 里 app.setAppUserModelId(...) 的值（null = 找不到）
// exists      (相对路径) => 文件是否存在
// sizes       图标的尺寸数组（null = 读不出来）
// schema      electron-builder 的 scheme.json（null = 不做键名校验）
// aboutText   应用内「关于 · 署名」弹窗的源码片段（null = 找不到）
function audit({ cfg, appIdInMain, exists, sizes, schema, aboutText }) {
  const bad = [];
  if (!cfg) return ['读不到 electron-builder 配置'];

  // ① appId 必须和主进程一致
  if (!cfg.appId) bad.push('appId 没写');
  else if (!appIdInMain) bad.push('main.js 里找不到 app.setAppUserModelId(...) —— 没法比对');
  else if (cfg.appId !== appIdInMain) {
    bad.push(`appId 和 main.js 不一致：配置 "${cfg.appId}" vs 代码 "${appIdInMain}"`);
  }

  // ② 程序名
  if (!cfg.productName) bad.push('productName 没写（装出来会叫 package.json 的 name）');

  // ③ 图标：存在，且含 256×256
  const icon = cfg.win && cfg.win.icon;
  if (!icon) bad.push('win.icon 没写（会退回 Electron 默认图标）');
  else if (!exists(icon)) bad.push(`win.icon 指向的文件不存在：${icon}`);
  else if (sizes && !sizes.includes(256)) {
    bad.push(`图标里没有 256×256（实际 ${sizes.join('/')}）—— 某些 Windows 上会糊`);
  }

  // ④ 许可文件必须随包（CC BY-NC-SA 的署名义务，不是「顺手带上」）
  const files = (cfg.files || []).map(String);
  for (const f of ['LICENSE', 'LICENSE-ASSETS.md', 'CREDITS.md']) {
    if (!files.includes(f)) {
      bad.push(`files 白名单里没有 ${f} —— 署名/协议没随包分发（CC BY-NC-SA 要求）`);
    } else if (!exists(f)) {
      bad.push(`${f} 在仓库里不存在`);
    }
  }

  // ⑤ 运行必须的东西
  if (!files.some((f) => f.startsWith('src/'))) bad.push('files 白名单里没有 src/ —— 打出来跑不起来');
  if (!files.includes('package.json')) bad.push('files 白名单里没有 package.json —— 运行时读不到 main');

  // ⑥ 白名单里不该出现「全量」模式
  if (files.some((f) => f === '**/*' || f === '*')) {
    bad.push('files 里出现了全量模式（**/*）—— 整个仓库（含 tmp/、开发脚本、文档）都会被打进包');
  }

  // ⑦ 卸载不能删用户数据
  const del = cfg.nsis && cfg.nsis.deleteAppDataOnUninstall;
  if (del !== false) {
    bad.push(`nsis.deleteAppDataOnUninstall 是 ${JSON.stringify(del)}，必须是 false`
      + ' —— 否则卸载会把主人的日程一起删掉');
  }

  // ⑧ 键名必须真的存在
  //   ★ 这条是被真事逼出来的：`win: { sign: false }` 里那个 `sign` 不是合法键名，
  //     构建直接失败，而报错是「configuration.win should be one of these: null」
  //     —— 完全看不出是哪个键写错了。所以拿官方 schema 对一遍。
  if (schema && schema.properties) {
    const SECTIONS = {
      win: 'WindowsConfiguration',
      nsis: 'NsisOptions',
      mac: 'MacConfiguration',
      linux: 'LinuxConfiguration',
      directories: 'Directories',
    };
    for (const [key, defName] of Object.entries(SECTIONS)) {
      const sub = cfg[key];
      if (!sub || typeof sub !== 'object') continue;
      const def = schema.definitions && schema.definitions[defName];
      if (!def || !def.properties) continue;
      for (const k of Object.keys(sub)) {
        if (!(k in def.properties)) bad.push(`${key}.${k} 不是合法键名（构建会直接失败）`);
      }
    }
    for (const k of Object.keys(cfg)) {
      if (!(k in schema.properties)) bad.push(`${k} 不是合法的顶层键名（构建会直接失败）`);
    }
  }

  // ⑨ 应用内的署名必须完整
  //   ★ CC BY-NC-SA 要求「适当署名」，而署名链上**三个人一个都不能少**
  //     （尤其「氵六青」，CREDITS.md 里专门标了「署名时不能漏」）。
  //     有人改关于弹窗时手滑删掉一个名字，界面上完全看不出来 —— 所以要钉住。
  if (aboutText === null || aboutText === undefined) {
    bad.push('main.js 里找不到 showAbout 的署名文本（应用内署名入口可能被删了）');
  } else {
    for (const who of ['上善无形', 'ZipZipPipe', '氵六青']) {
      if (!aboutText.includes(who)) {
        bad.push(`应用内署名漏了权利人「${who}」（CC BY-NC-SA 要求完整署名）`);
      }
    }
    if (!aboutText.includes('CC BY-NC-SA')) bad.push('应用内署名没写协议名 CC BY-NC-SA');
  }

  return bad;
}

// ── 真实探测 ──
function icoSizes(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 6 || b.readUInt16LE(2) !== 1) return null;
    const n = b.readUInt16LE(4);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16;
      if (o + 16 > b.length) break;
      out.push(b[o] === 0 ? 256 : b[o]);
    }
    return out;
  } catch { return null; }
}

function loadYaml(text) {
  try { return require('js-yaml').load(text); } catch { return null; }
}

function realInputs() {
  const cfgPath = path.join(ROOT, 'electron-builder.yml');
  let cfg = null;
  try { cfg = loadYaml(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = null; }

  let appIdInMain = null;
  try {
    const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const m = mainJs.match(/setAppUserModelId\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) appIdInMain = m[1];
  } catch { /* 读不到就是 null */ }

  const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
  const sizes = cfg && cfg.win && cfg.win.icon ? icoSizes(path.join(ROOT, cfg.win.icon)) : null;

  // 「关于 · 署名」弹窗的源码片段（从 function showAbout 到下一个顶格 }）
  let aboutText = null;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
    const i = src.indexOf('function showAbout');
    if (i >= 0) {
      const j = src.indexOf('\n}', i);
      aboutText = src.slice(i, j < 0 ? undefined : j);
    }
  } catch { aboutText = null; }

  // 官方 schema：用来验「键名是不是真的存在」（见 audit 第 ⑧ 条）
  let schema = null;
  try { schema = require('app-builder-lib/scheme.json'); } catch { schema = null; }
  return { cfg, appIdInMain, exists, sizes, schema, aboutText };
}

// ── 体检模式 ──
function run() {
  let pass = 0, fail = 0;
  const ok = (cond, label, detail = '') => {
    cond ? pass++ : fail++;
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  };

  const { cfg, appIdInMain, exists, sizes, schema, aboutText } = realInputs();

  console.log('打包配置体检（只读，不真打包）\n');
  console.log('1. 配置能读到');
  ok(!!cfg, 'electron-builder.yml 存在且能解析');
  ok(!!appIdInMain, 'main.js 里能找到 app.setAppUserModelId', appIdInMain || '');
  // ★ 这两条是**防「静默跳过」**的：下面每一项体检都依赖一份「原料」，
  //   原料没拿到时对应那条会自动不报错（看着全绿）。写这个脚本时就真踩过：
  //   audit() 调用处漏传 aboutText，署名校验整条变成摆设，界面上一点提示都没有。
  ok(!!schema, '拿到官方 schema（拿不到 → 「键名校验」会被静默跳过）');
  ok(aboutText !== null && aboutText !== undefined,
    '拿到「关于 · 署名」文本（拿不到 → 「署名校验」会被静默跳过）');

  console.log('\n2. 逐项体检（下面每条都是一类「构建成功但产物不对」的坑）');
  const bad = audit({ cfg, appIdInMain, exists, sizes, schema, aboutText });
  const CHECKS = [
    'appId', 'productName', 'win.icon', '图标里没有', 'files 白名单里没有',
    '仓库里不存在', 'src/', 'package.json', '全量模式', 'deleteAppDataOnUninstall',
    '键名', '署名',
  ];
  // 把问题清单摊成「每类一条」，便于一眼看出红在哪
  for (const key of CHECKS) {
    const hit = bad.filter((m) => m.includes(key));
    ok(hit.length === 0, `${key} 这项没问题`, hit.join(' / '));
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  if (bad.length) {
    console.log('\n发现的问题：');
    for (const m of bad) console.log(`  · ${m}`);
  }
  return fail === 0 ? 0 : 1;
}

// ── 自检模式：拿假数据证明 audit() 真能红 ──
function selfcheck() {
  let pass = 0, fail = 0, neg = 0, negFail = 0;
  const ok = (cond, label, negative = false, detail = '') => {
    if (negative) { neg++; if (!cond) negFail++; }
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${negative ? '[负对照] ' : ''}${label}${detail ? `  ${detail}` : ''}`);
  };
  const okNeg = (cond, label, detail = '') => ok(cond, label, true, detail);
  const ALL = () => true;
  const ICON6 = [16, 32, 48, 64, 128, 256];
  // 假的官方 schema：只要能让第 ⑧ 条（键名校验）跑起来就够了
  const SCHEMA = {
    properties: { appId: {}, productName: {}, files: {}, win: {}, nsis: {}, copyright: {}, directories: {}, asar: {}, publish: {} },
    definitions: {
      WindowsConfiguration: { properties: { icon: {}, target: {}, forceCodeSigning: {}, signAndEditExecutable: {} } },
      NsisOptions: {
        properties: {
          oneClick: {}, perMachine: {}, allowToChangeInstallationDirectory: {},
          createDesktopShortcut: {}, createStartMenuShortcut: {}, shortcutName: {},
          deleteAppDataOnUninstall: {},
        },
      },
    },
  };
  const GOOD = {
    appId: 'com.x.y',
    productName: 'P',
    files: ['src/**/*', 'package.json', 'LICENSE', 'LICENSE-ASSETS.md', 'CREDITS.md'],
    win: { icon: 'i.ico' },
    nsis: { deleteAppDataOnUninstall: false },
  };
  const A = (cfg, extra = {}) => audit({
    cfg,
    appIdInMain: 'com.x.y',
    exists: ALL,
    sizes: ICON6,
    schema: SCHEMA,
    aboutText: '权利人：上善无形 / ZipZipPipe / 氵六青 · 协议 CC BY-NC-SA 4.0',
    ...extra,
  });

  console.log('=== 打包配置体检 · 自检 ===\n');

  ok(A(GOOD).length === 0, '正常配置 → 0 个问题', false, JSON.stringify(A(GOOD)));
  // ★ 负对照：这条必须成立，否则下面那些「红了」说明不了什么
  okNeg(A(GOOD).length === 0, '正常配置确实是干净的（上面每条「红」才有意义）');

  const cases = [
    ['appId 和代码不一致', { ...GOOD, appId: 'com.other.app' }, 'appId'],
    ['appId 没写', { ...GOOD, appId: undefined }, 'appId'],
    ['productName 没写', { ...GOOD, productName: undefined }, 'productName'],
    ['图标文件不存在', GOOD, 'win.icon 指向的文件不存在', { exists: (p) => p !== 'i.ico' }],
    ['图标缺 256', GOOD, '图标里没有', { sizes: [16, 32, 48] }],
    ['许可文件没随包', { ...GOOD, files: ['src/**/*', 'package.json'] }, 'CREDITS.md'],
    ['files 漏了 src/', { ...GOOD, files: ['package.json', 'LICENSE', 'LICENSE-ASSETS.md', 'CREDITS.md'] }, 'src/'],
    ['files 用了全量模式', { ...GOOD, files: ['**/*'] }, '全量模式'],
    ['卸载会删用户数据', { ...GOOD, nsis: { deleteAppDataOnUninstall: true } }, 'deleteAppDataOnUninstall'],
    // ★ 这条是**照着真事写的**：`win.sign` 不是合法键名，构建会失败，
    //   而报错完全看不出是哪个键 —— 所以体检必须自己认得出来。
    ['win 里写了不存在的键', { ...GOOD, win: { icon: 'i.ico', sign: false } }, '不是合法键名'],
    ['顶层写了不存在的键', { ...GOOD, productNam: 'P' }, '不是合法的顶层键名'],
    // ★ 署名链上三个人一个都不能少（「氵六青」尤其容易漏）
    ['应用内署名漏了权利人', GOOD, '漏了权利人', { aboutText: '权利人：上善无形 / ZipZipPipe · 协议 CC BY-NC-SA 4.0' }],
    ['应用内署名没写协议', GOOD, '没写协议名', { aboutText: '权利人：上善无形 / ZipZipPipe / 氵六青' }],
    ['找不到应用内署名入口', GOOD, '找不到 showAbout', { aboutText: null }],
  ];
  for (const [name, cfg, expect, extra] of cases) {
    const got = A(cfg, extra || {});
    ok(got.some((m) => m.includes(expect)), `「${name}」→ 报出来了`, false, got.join(' / ') || '(没报)');
  }

  console.log(`\n===== 体检自检：${pass} 通过 / ${fail} 失败 · 负对照 ${neg - negFail}/${neg} =====`);
  return fail === 0 && negFail === 0 ? 0 : 1;
}

// 自检自身崩了也必须打印结论（CLAUDE.md 自检铁律 7）
function safe(fn) {
  try { return fn(); } catch (e) {
    console.log(`\n  ✗ 体检自身抛异常：${e && e.message}`);
    console.log('===== 结果：0 通过 / 1 失败 =====');
    return 1;
  }
}

process.exit(safe(process.argv.includes('--selfcheck') ? selfcheck : run));
