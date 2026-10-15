// scripts/test-apps.js
// v4 · 批次 1 · 「已安装软件」扫描自检（纯 Node，不 require Electron）
//
// 用法：npm run test:apps
//
// ── 为什么值得单独测 ──
//   这个模块决定「选择器里出现哪些软件」。它一旦把系统工具当软件列出去，
//   主人就会看到「注册表编辑器」「磁盘清理」，既没用又吓人；
//   一旦漏掉真软件，主人又找不到要禁的东西。
//   两种错都只有真机点开才知道 —— 所以纯逻辑必须在这儿钉死。
//
// ── 测试原则（HANDOFF 第六节第 19 条）──
//   每条负对照都要能答上「它怎样才能红」。答不上来的是装饰。
//   本文件里最值钱的几条：
//     · 系统工具必须被丢（含 %windir% 形式）
//     · Office 的 VFS 图标资源不许被当成目标（否则会得到 accicons.exe）
//     · Riot 那种解析不出的真软件必须**保留**（防「一律丢空」的假实现）
//     · 保护进程必须被挡

const path = require('path');
const realFs = require('fs');

const apps = require('../src/main/apps');
const bl = require('../src/main/focus/blacklist');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negTotal = 0;
let negPass = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? extra : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? extra : ''}  ← 失败`); }
}
function okNeg(cond, label, extra) {
  negTotal++;
  if (cond) negPass++;
  ok(cond, label, extra);
}
function section(t) { console.log(`\n${t}`); }

// ---------- 造「假 .lnk」的小工具 ----------
// 我们不复制真实 .lnk（体积大、还依赖机器状态），
// 而是按**实测到的真实布局**手写字节：ascii 段用 \0 分开。
function fakeLnk(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from('\u0001\u0014\u0002', 'latin1')); // 一段假的头
    chunks.push(Buffer.from(p, 'latin1'));
    chunks.push(Buffer.from([0x00, 0x00, 0x00]));
  }
  return Buffer.concat(chunks);
}

console.log('===== 已安装软件扫描自检（apps.js）=====');

// ★ 整段包在 async main 里 —— 第 9 节是异步的（scanInstalled / 缓存）。
//   早年的写法是「同步跑完就打印结论」，结果第 9 节的断言**一条都没执行**，
//   汇总里却看不出异常（数字对得上，只是悄悄少了几条）。
//   异步自检必须 await 到底，再打印汇总。
async function main() {
try { // ★ 整段包住：崩了也必须打印结论（Task 5 卡死过，别再来第二次）

// ---------- 1. asciiRuns：切出可打印段 ----------
section('1. asciiRuns：从二进制里切出可打印的 ascii 段');
{
  const runs = apps.asciiRuns(Buffer.from('ab\u0000hello world\u0000xyz12345', 'latin1'));
  ok(runs.includes('hello world'), '带空格的段能整段切出来');
  ok(runs.includes('xyz12345'), '长度够的段能切出来');
  ok(!runs.includes('ab'), '太短的段（<4）被丢掉');

  okNeg(apps.asciiRuns(Buffer.alloc(0)).length === 0, '★ 空 buffer → 空数组，不崩');
  okNeg(apps.asciiRuns(null).length === 0, '★ null → 空数组，不崩（防 TypeError）');
}

// ---------- 2. parseLnkTarget：捞目标 exe ----------
section('2. parseLnkTarget：从 .lnk 里认出目标程序');
{
  // 实测版式：Git Bash 的 .lnk
  const gitBash = fakeLnk(['/C:\\', 'PROGRA~1', 'git-bash.exe', 'C:\\Program Files\\Git\\git-bash.exe']);
  ok(apps.parseLnkTarget(gitBash) === 'C:\\Program Files\\Git\\git-bash.exe',
    'Git Bash → 认出全路径 git-bash.exe', ` → ${apps.parseLnkTarget(gitBash)}`);

  // 实测版式：Office 的 .lnk（光名字 + 全路径 + VFS 图标资源三个候选）
  const office = fakeLnk([
    '/C:\\', 'PROGRA~1', 'root', 'Office16',
    'MSACCESS.EXE',
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\MSACCESS.EXE',
    '%ProgramFiles%\\Microsoft Office\\Root\\VFS\\Windows\\Installer\\{9016}\\accicons.exe',
  ]);
  const offTarget = apps.parseLnkTarget(office);
  ok(offTarget === 'C:\\Program Files\\Microsoft Office\\root\\Office16\\MSACCESS.EXE',
    '★ Office → 取带盘符的全路径，**不是** accicons.exe 这个图标资源', ` → ${offTarget}`);
  okNeg(offTarget !== '%ProgramFiles%\\Microsoft Office\\Root\\VFS\\Windows\\Installer\\{9016}\\accicons.exe',
    '★ 负对照：VFS 图标资源绝不能被当成目标');

  // 实测版式：系统工具（带 %windir%）
  const mstsc = fakeLnk(['1SPS', '%windir%\\system32\\mstsc.exe']);
  ok(apps.parseLnkTarget(mstsc) === '%windir%\\system32\\mstsc.exe',
    '带 %windir% 的目标能认出来', ` → ${apps.parseLnkTarget(mstsc)}`);

  // ★ 负对照：认不出就得说认不出，不许编
  okNeg(apps.parseLnkTarget(fakeLnk(['1SPS', '%windir%\\system32\\eventvwr.msc'])) === '%windir%\\system32\\eventvwr.msc',
    '★ .msc 也能被「认出」，但稍后会被 isNonExeTarget 丢掉（分工要清楚）');
  okNeg(apps.parseLnkTarget(Buffer.from('nothing here at all', 'latin1')) === null,
    '★ 没有任何 exe 的 .lnk → null，**绝不编造一个路径**');
  okNeg(apps.parseLnkTarget(null) === null, '★ null 输入 → null，不崩');
  okNeg(apps.parseLnkTarget('不是 buffer') === null, '★ 传字符串 → null，不崩');
}

// ---------- 3. isSystemTarget：系统工具必须被丢 ----------
section('3. isSystemTarget：系统自带的东西不许进列表');
{
  ok(apps.isSystemTarget('%windir%\\system32\\regedit.exe') === true, '注册表编辑器（%windir%）判为系统项');
  ok(apps.isSystemTarget('%windir%\\system32\\cleanmgr.exe') === true, '磁盘清理（%windir%）判为系统项');
  ok(apps.isSystemTarget('C:\\Windows\\System32\\notepad.exe') === true, 'C:\\Windows 下的绝对路径判为系统项');
  ok(apps.isSystemTarget('c:\\windows\\explorer.exe') === true, '大小写不敏感');
  ok(apps.isSystemTarget('%SystemRoot%\\system32\\perfmon.exe') === true, '%SystemRoot% 也算系统项');

  ok(apps.isSystemTarget('C:\\Program Files\\Git\\git-bash.exe') === false, 'Program Files 下的 Git 是**正常软件**');
  ok(apps.isSystemTarget('D:\\Games\\steam.exe') === false, '别的盘的游戏是正常软件');
  ok(apps.isSystemTarget('C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE') === false,
    'Office 是正常软件（不能被误伤）');

  // ★ 负对照：防「一律返回 true」的假实现
  okNeg(apps.isSystemTarget('C:\\Users\\FlyMe\\AppData\\Local\\Programs\\X\\x.exe') === false,
    '★ 用户目录下的程序不许被误判成系统项（防「一律 true」）');
  okNeg(apps.isSystemTarget(null) === true && apps.isSystemTarget('') === true,
    '★ 空 / null 当系统项丢掉（宁可少列）');
}

// ---------- 4. isNonExeTarget / isJunkName ----------
section('4. 非程序目标 / 垃圾名字');
{
  ok(apps.isNonExeTarget('%windir%\\system32\\eventvwr.msc') === true, '.msc 控制台不算程序');
  ok(apps.isNonExeTarget('C:\\Python\\Doc\\manual.html') === true, '.html 文档不算程序');
  ok(apps.isNonExeTarget('C:\\Steam\\steam.exe') === false, '.exe 才算程序');

  ok(apps.isJunkName('Uninstall') === true, '卸载快捷方式丢掉');
  ok(apps.isJunkName('Python 3.14 Manuals') === true, '「Python 3.14 Manuals」丢掉（实测真案例）');
  ok(apps.isJunkName('Readme.txt') === true, 'Readme 丢掉');
  ok(apps.isJunkName('微信') === false, '中文软件名要留下');
  ok(apps.isJunkName('Steam') === false, '普通软件名要留下');
  ok(apps.isJunkName('Visual Studio Code') === false, '带空格的正常名字要留下');

  // ★ 真机上抓到的中文卸载项（第一版正则漏掉了它们，因为中文没空格当分隔符）
  ok(apps.isJunkName('卸载微信') === true, '★ 「卸载微信」丢掉（中文无分隔符，实测漏过）');
  ok(apps.isJunkName('卸载火绒') === true, '★ 「卸载火绒」丢掉');
  ok(apps.isJunkName('卸载哔哩哔哩直播姬') === true, '★ 「卸载哔哩哔哩直播姬」丢掉');

  // ★ 负对照：中文里带「文档」「帮助」的**真软件**不能被误伤
  okNeg(apps.isJunkName('文档编辑器') === false, '★ 「文档编辑器」这种真软件名不许被当垃圾丢掉');
  okNeg(apps.isJunkName('帮助中心') === false, '★ 名字含「帮助」但不只是这两个字 → 不丢（防误伤真软件）');
  ok(apps.isJunkName('帮助') === true, '★ 名字**就是**「帮助」→ 丢掉（这种才是垃圾）');

  // ---- isJunkExe：看 exe 名再兜一道（真机的卸载程序 exe 名很规整）----
  ok(apps.isJunkExe('uninstall.exe') === true, 'uninstall.exe 丢掉');
  ok(apps.isJunkExe('uninstall_complete.exe') === true, 'uninstall_complete.exe 丢掉（WeGame卸载）');
  ok(apps.isJunkExe('unins000.exe') === true, 'unins000.exe 丢掉（哔哩哔哩直播姬卸载）');
  ok(apps.isJunkExe('uninst.exe') === true, '★ uninst.exe 丢掉（火绒卸载，光秃秃的 uninst）');
  ok(apps.isJunkExe('steam.exe') === false, 'steam.exe 是正常程序');
  okNeg(apps.isJunkExe('') === false && apps.isJunkExe(null) === false,
    '★ 空 / null exe → 不当垃圾（否则所有 blocked 项会被一起丢掉）');

  // ---- isShellEntry：Windows 外壳入口不是「软件」----
  ok(apps.isShellEntry('Control Panel') === true, 'Control Panel 丢掉（真机案例）');
  ok(apps.isShellEntry('File Explorer') === true, '★ File Explorer 丢掉（它的目标是 explorer.exe，绝不能进列表）');
  ok(apps.isShellEntry('Run') === true, 'Run 丢掉（真机案例）');
  ok(apps.isShellEntry('Steam') === false, 'Steam 不是外壳入口');
  okNeg(apps.isShellEntry('Explorer++') === false,
    '★ Explorer++ 这种第三方文件管理器不能被当系统外壳丢掉（防「一律 true」）');

  // ★ 负对照：防「一律 true」
  okNeg(apps.isNonExeTarget('C:\\Games\\LOL.exe') === false, '★ 真程序不许被当成非程序');
  okNeg(apps.isJunkName('Discord') === false, '★ Discord 不许被当垃圾名丢掉');
  okNeg(apps.isJunkName('') === true && apps.isJunkName(null) === true, '★ 空名字当垃圾丢掉');
}

// ---------- 5. exeNameOf / displayNameFromFile ----------
section('5. 取进程名 / 取显示名');
{
  ok(apps.exeNameOf('C:\\Program Files\\Git\\git-bash.exe') === 'git-bash.exe', '全路径 → 进程名');
  ok(apps.exeNameOf('C:\\Program Files\\Git\\GIT-BASH.EXE') === 'git-bash.exe', '统一小写');
  ok(apps.exeNameOf('%windir%\\system32\\mstsc.exe') === 'mstsc.exe', '带变量的也能取');
  okNeg(apps.exeNameOf('') === '' && apps.exeNameOf(null) === '', '★ 空 / null → 空串，不崩');

  ok(apps.displayNameFromFile('D:\\x\\Steam.lnk') === 'Steam', '去掉 .lnk 后缀');
  ok(apps.displayNameFromFile('D:\\x\\Visual Studio Code.lnk') === 'Visual Studio Code', '带空格的名字完整保留');
  // ⚠ 实测：.lnk 里没有可靠的中文显示名，所以显示名就是开始菜单里的这个文件名。
  ok(apps.displayNameFromFile('D:\\x\\微信.lnk') === '微信', '中文名来自文件名（这是刻意的，不是漏读）');
}

// ---------- 6. buildEntries：整条流水线 ----------
section('6. buildEntries：去重 / 过滤 / 排序 / blocked 标记');
{
  const files = [
    // 正常软件
    { filePath: 'D:\\sm\\Steam.lnk', buf: fakeLnk(['C:\\Program Files (x86)\\Steam\\steam.exe']) },
    // 同一个软件的第二、三个快捷方式 → 必须去重
    { filePath: 'D:\\sm\\Steam (2).lnk', buf: fakeLnk(['C:\\Program Files (x86)\\Steam\\steam.exe']) },
    { filePath: 'D:\\sm\\STEAM.lnk', buf: fakeLnk(['D:\\other\\steam.exe']) },
    // 系统工具 → 必须丢
    { filePath: 'D:\\sm\\Registry Editor.lnk', buf: fakeLnk(['%windir%\\regedit.exe']) },
    { filePath: 'D:\\sm\\Disk Cleanup.lnk', buf: fakeLnk(['%windir%\\system32\\cleanmgr.exe']) },
    { filePath: 'D:\\sm\\Event Viewer.lnk', buf: fakeLnk(['%windir%\\system32\\eventvwr.msc']) },
    // 文档 / 卸载 → 必须丢
    { filePath: 'D:\\sm\\Python 3.14 Manuals.lnk', buf: fakeLnk(['C:\\Python\\Doc\\manual.html']) },
    { filePath: 'D:\\sm\\Uninstall.lnk', buf: fakeLnk(['C:\\Games\\unins000.exe']) },
    // 真软件但解析不出 exe → 必须**保留**并标 blocked
    { filePath: 'D:\\sm\\Riot Client.lnk', buf: fakeLnk(['1SPS', 'riotclient://launch']) },
    // 保护进程 → 稍后被 scanInstalled 挡掉；buildEntries 本身不过这一关
    { filePath: 'D:\\sm\\Explorer.lnk', buf: fakeLnk(['C:\\Windows\\explorer.exe']) },
  ];

  const out = apps.buildEntries(files);
  const names = out.map((x) => x.name);
  const exes = out.map((x) => x.exe);

  ok(out.length === 2, `10 个 .lnk 只剩 2 条（Steam + Riot Client）→ ${JSON.stringify(names)}`);
  ok(exes.filter((x) => x === 'steam.exe').length === 1, '★ 三个 Steam 快捷方式只留一条（按 exe 去重）');
  ok(names.includes('Riot Client'), '★ 解析不出 exe 的真软件被**保留**了');
  ok(!names.includes('Registry Editor'), '★ 注册表编辑器被丢掉');
  ok(!names.includes('Event Viewer'), '★ 事件查看器（.msc）被丢掉');
  ok(!names.includes('Python 3.14 Manuals'), '★ Python 手册（.html）被丢掉');
  ok(!names.includes('Uninstall'), '★ 卸载快捷方式被丢掉');

  const riot = out.find((x) => x.name === 'Riot Client');
  ok(riot && riot.blocked === true && riot.exe === '', '★ Riot Client 标了 blocked、exe 为空（如实告知，不假装能用）');
  const steam = out.find((x) => x.name === 'Steam');
  ok(steam && steam.blocked === false && steam.exe === 'steam.exe', 'Steam 正常，exe 取到 steam.exe');

  // 排序：能禁的在前
  ok(out[0].blocked === false && out[out.length - 1].blocked === true, '★ 能禁的排在前面，禁不了的垫底');

  // ★ 负对照：防「一律丢空」的假实现（这条就是为本项目「别过度过滤」而写）
  okNeg(out.length > 0, '★ 不许把所有东西都过滤光（防「一律 return []」）');
  okNeg(apps.buildEntries([]).length === 0, '★ 空输入 → 空数组，不崩');
  okNeg(apps.buildEntries(null).length === 0, '★ null 输入 → 空数组，不崩');
  okNeg(apps.buildEntries([{ filePath: 'x.lnk', buf: 'not a buffer' }]).length === 0,
    '★ 混进坏条目 → 只跳过它，不崩');
}

// ---------- 7. takenSet：已经在黑名单里的标灰 ----------
section('7. takenSet：已在黑名单里的软件要能被标出来');
{
  const t = apps.takenSet(['Steam.exe', 'C:\\x\\WeChat.exe']);
  ok(t.has('steam.exe') === true, '大小写不敏感地认出已在名单里');
  ok(t.has('wechat.exe') === true, '带路径的也能认出');
  ok(t.has('chrome.exe') === false, '没在名单里的不误标');
  okNeg(apps.takenSet(null).size === 0, '★ null → 空集合，不崩');
  okNeg(apps.takenSet(['', '   ', 123]).size === 0, '★ 垃圾项不会混进集合');
}

// ---------- 8. 图标：base64 转换 ----------
section('8. 图标转 base64（CSP 要求，不能传文件路径）');
{
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // 假的 PNG magic
  const url = apps.toDataUrl(buf);
  ok(typeof url === 'string' && url.startsWith('data:image/png;base64,'), 'Buffer → data URL');
  ok(url === 'data:image/png;base64,' + buf.toString('base64'), '编码内容正确');

  okNeg(apps.toDataUrl(null) === null, '★ 没有图标 → null（界面据此画色块，不是空白）');
  okNeg(apps.toDataUrl('随便一个字符串') === null, '★ 非 Buffer 且没有 toPNG → null，不崩');
}

// ---------- 9. scanInstalled：能注入依赖（沙箱里也能测全流程）----------
section('9. scanInstalled：注入假文件系统，跑完整条链路');
{
  const fakeFs = {
    'C:\\SM\\Programs\\Steam.lnk': fakeLnk(['C:\\Program Files (x86)\\Steam\\steam.exe']),
    'C:\\SM\\Programs\\Chrome.lnk': fakeLnk(['C:\\Program Files\\Google\\Chrome\\chrome.exe']),
    'C:\\SM\\Programs\\Registry Editor.lnk': fakeLnk(['%windir%\\regedit.exe']),
    'C:\\SM\\Programs\\Riot Client.lnk': fakeLnk(['riotclient://launch']),
    // ★ 保护进程：绝不能因为它在开始菜单里就放进来
    'C:\\SM\\Programs\\Electron.lnk': fakeLnk(['C:\\dev\\node_modules\\electron.exe']),
  };
  const dirs = ['C:\\SM\\Programs'];

  const deps = {
    listLnk(dir) {
      return Object.keys(fakeFs).filter((p) => path.dirname(p) === dir);
    },
    readFile(p) { return fakeFs[p] || null; },
    async getIcon(target) {
      // 假图标：除了 steam 都没有 → 顺带验证兜底
      if (/steam\.exe$/i.test(target)) return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const err = new Error('no icon'); throw err;
    },
    isProtectedExe: bl.isProtectedExe,
  };

  await apps.scanInstalled({ dirs, deps }).then(async (list) => {
    const names = list.map((x) => x.name);
    const exes = list.map((x) => x.exe);

    ok(list.length === 3, `5 个 .lnk → 3 条（Steam / Chrome / Riot）→ ${JSON.stringify(names)}`);
    ok(!exes.includes('electron.exe'), '★ 保护进程 electron.exe 被 scanInstalled 挡掉了');
    ok(!names.includes('Registry Editor'), '★ 系统工具被挡掉了');
    ok(names.includes('Riot Client'), 'Riot Client 保留（标 blocked）');

    const steam = list.find((x) => x.exe === 'steam.exe');
    ok(steam && typeof steam.icon === 'string' && steam.icon.startsWith('data:image/'),
      '★ Steam 拿到了 base64 图标');
    const chrome = list.find((x) => x.exe === 'chrome.exe');
    ok(chrome && chrome.icon === null, '★ 提不出图标的条目 icon === null（界面会画色块兜底）');

    okNeg(exes.includes('explorer.exe') === false, '★ 负对照：保护名单里任何一项都不许出现在结果里');

    // ---- 缓存：第二次调用不许重复扫 ----
    const cache = apps.createCache();
    let scans = 0;
    const countingScan = async () => { scans++; return [{ name: 'X', exe: 'x.exe', blocked: false }]; };
    await cache.get(countingScan);
    const v = await cache.get(countingScan);
    ok(scans === 1, '★ 缓存生效：扫一次，第二次直接用', ` → 实际扫了 ${scans} 次`);
    ok(Array.isArray(v) && v.length === 1, '缓存拿回来的是同一份数据');
    cache.clear();
    await cache.get(countingScan);
    ok(scans === 2, 'clear() 之后会重新扫');
  }).catch((err) => {
    fail++;
    console.log(`  ✗ 异步部分抛异常：${err && err.message}  ← 失败`);
  });

}

// ---------- 9b. extractIcons：并发提图标，但顺序不能乱 ----------
section('9b. extractIcons：8 路并发提图标，顺序和兜底都要对');
{
  const entries = [
    { name: 'A', exe: 'a.exe', target: 'C:\\a.exe', blocked: false },
    { name: 'B', exe: 'b.exe', target: 'C:\\b.exe', blocked: false },
    { name: 'C', exe: '', target: '', blocked: true },              // 没目标 → 不该去提图标
    { name: 'D', exe: 'd.exe', target: 'C:\\d.exe', blocked: false },
  ];

  let calls = 0;
  let maxInFlight = 0;
  let inFlight = 0;
  const deps = {
    async getIcon(p) {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // B 故意慢一点 —— 并发下它该「后完成」，但**位置仍要在第 2 位**
      await new Promise((r) => setTimeout(r, /b\.exe$/i.test(p) ? 40 : 5));
      inFlight--;
      if (/d\.exe$/i.test(p)) throw new Error('提不出来'); // D 模拟失败 → 兜底 null
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
  };

  await apps.extractIcons(entries, deps).then((out) => {
    ok(out.length === 4, '四条都还在（没有一个被吞掉）');
    ok(out.map((x) => x.name).join('') === 'ABCD', '★★ 并发之后**顺序没乱**（A B C D 原样）',
      ` → ${out.map((x) => x.name).join('')}`);
    ok(calls === 3, '★ 没有 target 的那条（C）不去提图标，省一次调用', ` → 实际调了 ${calls} 次`);
    ok(maxInFlight > 1, '★ 确实是并发的（同时有多个请求在飞）', ` → 峰值 ${maxInFlight} 路`);
    ok(typeof out[0].icon === 'string' && out[0].icon.startsWith('data:image/'), 'A 拿到了图标');
    ok(out[2].icon === null, '★ C（无目标）icon === null，走界面色块兜底');
    ok(out[3].icon === null, '★ D（提取抛异常）icon === null —— 单个失败不能连累整批');
    ok(out[1].name === 'B' && typeof out[1].icon === 'string', '★ 慢的那个（B）也拿到了图标，且没挪位');

    // ★ 负对照：并发不能变成「全都失败也当成功」
    okNeg(out.filter((x) => x.icon === null).length === 2,
      '★ 负对照：恰好 2 个没图标（C 无目标 + D 提取失败），不多不少');
  }).catch((err) => {
    fail++;
    console.log(`  ✗ 9b 抛异常：${err && err.message}  ← 失败`);
  });
}

// ---------- 10. startMenuDirs ----------section('10. 开始菜单目录（全用户 + 当前用户）');
{
  const dirs = apps.startMenuDirs({ ProgramData: 'C:\\PD', APPDATA: 'C:\\AD' });
  ok(dirs.length === 2, '两个位置都算上');
  ok(dirs[0] === path.join('C:\\PD', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), '第一个是全用户');
  ok(dirs[1] === path.join('C:\\AD', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), '第二个是当前用户');
  okNeg(apps.startMenuDirs({ ProgramData: 'C:\\PD' }).length === 1, '★ 没有 APPDATA 时只列一个，不崩');
}

} catch (err) {
  fail++;
  console.log(`\n✗✗ 自检自身抛异常：${err && err.message}  ← 失败`);
  console.log(err && err.stack);
}
} // main()

// ---------- 汇总 ----------
main().then(() => {
  console.log(`\n负对照：${negPass}/${negTotal} 通过`);
  console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
  process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
}).catch((err) => {
  console.log(`\n✗✗ main() 本身抛异常：${err && err.message}  ← 失败`);
  console.log(err && err.stack);
  console.log(`===== 结果：${pass} 通过 / ${fail + 1} 失败 =====`);
  process.exit(1);
});
