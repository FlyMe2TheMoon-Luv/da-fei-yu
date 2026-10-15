// src/main/apps.js
// 「已安装软件」扫描 —— 只做纯逻辑，方便纯 Node 单测。
//
// ── 这个文件解决什么问题 ──
//   以前主人要禁一个软件，得自己在设置里打 `steam.exe` —— 记名字、拼后缀，
//   还得正好打对。现在改成「点软件图标就能加」。
//   要能点图标，就得先知道机器上装了哪些软件、图标长什么样。
//
// ── 为什么不用 COM 读快捷方式 ──
//   读 .lnk 的标准做法是 `New-Object -ComObject WScript.Shell`，
//   但**本机安全策略禁止脚本实例化 COM 对象**（见 PLAN-V4 第一节，实测过）。
//   所以这里退一步：把 .lnk 当成**二进制**读，从里面把
//   `X:\...\某程序.exe` 这样的字符串捞出来。
//
// ── 本文件的纪律 ──
//   1. 不 require('electron')（否则纯 Node 里跑不起来，就没法单测）。
//      需要提图标的地方走 deps 注入 —— 上层传 app.getFileIcon 进来。
//   2. 认不出来的一律**如实返回**，绝不「猜一个差不多的」。
//      尤其：环境变量（%windir% 等）不展开、没找到 exe 就标出来，
//      因为「猜」会让主人以为某软件被挡住了，其实没有。
//
// ── 一个关键实测结论（改过设计）──
//   解析不出来的 .lnk 里，绝大多数是**系统工具**（事件查看器 / 注册表编辑器 /
//   磁盘清理 / 服务…）和**文档**（Python 手册，目标其实是 .html）。
//   这些根本不该出现在「要禁的分心软件」列表里。
//   所以见 `isSystemTarget()` / `isJunkName()`：宁可少列，不要乱列。

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────
// 一、.lnk 二进制 → 目标 exe 路径（纯函数）
// ────────────────────────────────────────────────────────────

// .lnk 里存目标路径的方式不止一种：
//   ① 老式的 ASCII 字符串（`C:\Program Files\Git\git-bash.exe`）—— 实测最常见
//   ② 带环境变量的（`%windir%\system32\mstsc.exe`）—— 系统工具基本都是这种
//   ③ `C:\PROGRA~1\...` 这种 8.3 短名（在 «字符串» 里能看到，但不是完整目标）
// 我们只认「带盘符的完整路径」和「带 %变量% 的路径」两类，其余一律不算。
//
// ⚠ 为什么不用「先把二进制按 UTF-16 解一遍」：
//   实测这些 .lnk 的目标字段是**单字节**存的（ascii 段能直接读出来），
//   反倒是有些 .lnk 会额外存一份 UTF-16 的「长路径」。
//   全部按 UTF-16 解会把普通路径拆碎，所以这里只扫单字节 ascii 段。

// 从一段字节里，把所有长度 ≥ 4 的可打印 ascii 连续段切出来。
// ⚠ 输入是任何东西都不许抛（.lnk 可能是坏的 / 上层可能传错）—— 一律退化成空数组。
function asciiRuns(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7e) {
      cur += String.fromCharCode(c);
    } else {
      if (cur.length >= 4) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

// 从 .lnk 的二进制内容里捞「看起来像程序路径」的字符串。
//
// 返回一个**按可信度排序**的候选数组（越前面越可能是真目标）：
//   1. 绝对路径（带盘符、以 .exe 结尾）—— 最可信
//   2. 带 %环境变量% 的路径 —— 系统工具常见，可信但可能是系统路径
//   3. 光秃秃的文件名（如 `MSACCESS.EXE`）—— 最不可信，只在前两类都没有时才用
//
// ⚠ 实测的坑：Office 的 .lnk 里同时有
//     `MSACCESS.EXE`（真目标，光名字）
//     `C:\Program Files\Microsoft Office\root\Office16\MSACCESS.EXE`（真目标，全路径）
//     `%ProgramFiles%\...\accicons.exe`（**图标资源**，不是要启动的东西）
//   → 所以**带盘符的全路径优先于 %变量% 的路径**，光名字放最后。
function candidatesFromLnk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return [];

  const abs = [];   // 带盘符的绝对路径
  const env = [];   // 带 %变量% 的路径
  const other = []; // 不是 .exe 但也显然是程序目标（.msc / .cpl / .bat …）
  const bare = [];  // 光文件名

  const seen = new Set();
  const push = (arr, s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    arr.push(s);
  };

  // 绝对路径：`X:\...` 一直到 .exe，中间允许空格、短名、点、括号、连字符
  const RE_ABS = /\b([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.exe)/gi;
  // 带环境变量的：`%windir%\system32\xxx.exe`
  const RE_ENV = /(%[A-Za-z_][A-Za-z0-9_()]*%\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.exe)/gi;
  // 光文件名（没路径）：`MSACCESS.EXE`
  const RE_BARE = /\b([A-Za-z0-9._+-]{1,64}\.exe)\b/gi;
  // 不是 .exe、但显然是「程序目标」的（.msc 控制台 / .cpl / .bat / .cmd / .ps1）。
  // ★ 为什么要单独认这类：`eventvwr.msc` 这种 .lnk 里**一个 .exe 都没有**，
  //   如果只看 .exe，它会被当成「解析不出的真软件」而**保留**下来，
  //   然后列表里就冒出「事件查看器」。认出来才能把它正确地丢掉。
  const RE_OTHER = /((?:[A-Za-z]:\\|%[A-Za-z_][A-Za-z0-9_()]*%\\)(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.(?:msc|cpl|bat|cmd|ps1|vbs|jar|html?))/gi;

  for (const run of asciiRuns(buf)) {
    let m;
    RE_ABS.lastIndex = 0;
    while ((m = RE_ABS.exec(run))) push(abs, m[1]);

    RE_ENV.lastIndex = 0;
    while ((m = RE_ENV.exec(run))) push(env, m[1]);

    RE_OTHER.lastIndex = 0;
    while ((m = RE_OTHER.exec(run))) push(other, m[1]);

    RE_BARE.lastIndex = 0;
    while ((m = RE_BARE.exec(run))) {
      // 已经被上面两条收过的，别再当「光名字」收一遍
      if (!abs.some((a) => a.toLowerCase().endsWith(m[1].toLowerCase())) &&
          !env.some((e) => e.toLowerCase().endsWith(m[1].toLowerCase()))) {
        push(bare, m[1]);
      }
    }
  }

  return [...abs, ...env, ...other, ...bare];
}

// 从 .lnk 二进制里解析出「最有可能是目标程序」的那一个。
// 解析不出就返回 null（**绝不编造**）。
function parseLnkTarget(buf) {
  const list = candidatesFromLnk(buf);
  return list.length ? list[0] : null;
}

// 从 .lnk 里解析「图标在哪」。
// 实测：很多 .lnk 末尾会带 `%SystemDrive%\...\xxx.ico`，比目标 exe 的图标更贴切。
function parseLnkIconLocation(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const RE = /([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.(?:ico|exe|dll))/gi;
  let found = null;
  for (const run of asciiRuns(buf)) {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(run))) found = m[1]; // 取最后一个（图标字段通常在末尾）
  }
  return found;
}

// ────────────────────────────────────────────────────────────
// 二、要不要收进列表（纯函数）
// ────────────────────────────────────────────────────────────

// 常见的系统环境变量 —— **只认这些**。
// ⚠ 不做通用展开：主人机器上 `%FOO%` 是什么我们不知道，
//   乱展开就等于「猜」，而猜错会让主人以为某软件被挡住了。
const KNOWN_ENV = {
  '%windir%': 'C:\\Windows',
  '%systemroot%': 'C:\\Windows',
  '%systemdrive%': 'C:',
  '%programfiles%': 'C:\\Program Files',
  '%programfiles(x86)%': 'C:\\Program Files (x86)',
  '%programfilesx86%': 'C:\\Program Files (x86)',
  '%localappdata%': null,   // 只用于判别「不像系统路径」，不参与拼盘符
  '%appdata%': null,
};

// 把一个候选路径里的已知 %变量% 换成真实前缀（只换认识的；不认识的留原样）。
function expandKnownEnv(p) {
  if (typeof p !== 'string') return '';
  let s = p;
  for (const [k, v] of Object.entries(KNOWN_ENV)) {
    if (!v) continue;
    const re = new RegExp(k.replace(/[()]/g, '\\$&'), 'gi');
    s = s.replace(re, v);
  }
  return s;
}

// 目标是不是「系统自带的东西」。
// ★ 这是实测逼出来的：解析不出来的 .lnk 里，绝大多数是系统工具
//   （事件查看器 / 注册表编辑器 / 磁盘清理 / 服务 / 任务计划…），
//   把它们列进「要禁的分心软件」既没用、又吓人。
//
// 判定依据（任一命中就算系统项）：
//   · 展开了已知变量后，落在 C:\Windows\ 下
//   · 原路径就带 %windir% / %systemroot% 这种系统变量
function isSystemTarget(p) {
  if (typeof p !== 'string' || !p) return true; // 空 = 当系统项丢掉
  const raw = p.toLowerCase();

  // 带系统变量的（%windir%\regedit.exe）—— 直接判系统
  if (/%windir%|%systemroot%/i.test(p)) return true;

  const expanded = expandKnownEnv(p).toLowerCase().replace(/\//g, '\\');
  if (expanded.startsWith('c:\\windows\\')) return true;

  // 短名写法（C:\PROGRA~1）落在别处，不判系统；但 Windows 的短名要判
  if (/^c:\\progra~1\\windows/i.test(expanded)) return true;

  return false;
}

// 目标根本不是「可执行程序」的（.msc 控制台 / .html 文档 / .cpl / .lnk …）。
// 这些放进来毫无意义 —— 「磁盘管理」是怎么都禁不掉的。
function isNonExeTarget(p) {
  if (typeof p !== 'string' || !p) return true;
  return !/\.exe$/i.test(p.trim());
}

// 名字看着就不是「主人想禁的软件」的：手册、文档、卸载、帮助、控制台……
// ★ 实测案例：`Python 3.14 Manuals`（目标是 .html）、`Uninstall`、
//   `Readme`、`Documentation`。这些东西出现在「要禁的软件」列表里只会添乱。
//
// ⚠ 中文坑（真机上抓到的）：一开始只写了 `(^|[\s\-_])(uninstall|...)([\s\-_.]|$)`
//   这种「要有分隔符」的写法，结果中文的「卸载微信」「卸载火绒」**一条都没匹配上** ——
//   中文压根没有空格来当分隔符。
//
// ★ 但反过来也不能「见到关键词就丢」：`文档编辑器` / `帮助中心` 这种如果真是软件名
//   被误伤，主人就找不到东西了。所以中文分两档：
//     · `卸载` —— 出现在名字**开头**就丢（「卸载微信」这种没有例外）
//     · `帮助/文档/说明/手册/官网/疑解答` 等 —— 只有**名字基本就是这几个字**时才丢
//       （用「去掉关键词后剩不下几个字」来判，而不是「包含就丢」）
const JUNK_WORD_RE = /(^|[\s\-_.])(uninstall|uninstaller|unins\d*|read\s*me|readme|manual|manuals|help|documentation|docs?|release\s*notes|license|website|homepage|repair|troubleshoot|activate|setup|install)([\s\-_.]|$)/i;
// 「卸载」开头（中文卸载项的固定套路）
const JUNK_CN_LEAD_RE = /^\s*卸载/;
// 这些词只有在**几乎占满整个名字**时才算垃圾（避免误伤「文档编辑器」这类真软件）
const JUNK_CN_BODY_RE = /^(帮助|说明|文档|手册|许可证|官网|疑难解答|修复|教程|指南|关于)$/;

function isJunkName(name) {
  if (typeof name !== 'string') return true;
  const s = name.trim();
  if (!s) return true;
  if (JUNK_WORD_RE.test(s)) return true;
  if (JUNK_CN_LEAD_RE.test(s)) return true;
  if (JUNK_CN_BODY_RE.test(s)) return true;
  // 纯符号 / 纯数字的「快捷方式」（某些安装包会丢一个空的进来）
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(s)) return true;
  return false;
}

// ── 看一眼「进程名」就该丢掉的东西 ──
// ★ 真机上抓到的（比看显示名更靠谱）：
//   `卸载微信` → uninstall.exe   `WeGame卸载` → uninstall_complete.exe
//   `卸载哔哩哔哩直播姬` → unins000.exe
//   光靠名字栏过滤不够 —— 卸载程序的 exec 名字非常规整，这里再兜一道。
// ⚠ 注意 `unins\d*` 要写成「unins 开头后面可以跟数字」，别写成 `unins\d+`
//   —— 后者匹配不到光秃秃的 `uninst.exe`（火绒那个）。
const JUNK_EXE_RE = /^(unins\d*|uninstall|uninstaller|uninstall_complete|uninst|setup|install|update|updater|helper)\.exe$/i;

function isJunkExe(exe) {
  if (typeof exe !== 'string' || !exe) return false;
  return JUNK_EXE_RE.test(exe.trim());
}

// ── Windows 外壳 / 系统入口的快捷方式（不是「软件」）──
// ★ 真机上抓到的：`Control Panel`（控制面板）、`File Explorer`（资源管理器）、
//   `Run`（运行）。它们的 .lnk 里没有可解析的程序文件，于是落进了「保留 + 标 ⚠」
//   那条路 —— 但它们根本不是能「禁掉」的东西，列出来纯属误导。
//   ⚠ File Explorer 更要紧：它的目标是 explorer.exe，就算解析出来也绝不能让主人禁掉。
const SHELL_ONLY_NAMES = new Set([
  'control panel', 'file explorer', 'run', 'windows explorer', 'explorer',
  'task manager', '任务管理器', '控制面板', '资源管理器', '运行',
  'windows powershell', 'windows terminal', 'command prompt', '命令提示符',
  'settings', '设置', 'windows update', 'windows 更新',
]);

function isShellEntry(name) {
  if (typeof name !== 'string') return true;
  return SHELL_ONLY_NAMES.has(name.trim().toLowerCase());
}

// 显示名从 .lnk 文件名来（去掉 .lnk 后缀）。
// ⚠ 实测：.lnk 里**没有**可靠的中文显示名（目标字段是单字节 ascii），
//   所以列表里显示的是「开始菜单里那个名字」—— 对主人来说本来就是这个名字，
//   反而更熟。这一条写在这儿，免得以后有人以为漏读了中文名。
function displayNameFromFile(filePath) {
  const base = path.basename(String(filePath || ''));
  return base.replace(/\.lnk$/i, '').trim();
}

// 从「目标 exe 全路径」里取进程名（小写）。没有路径就取整串。
// 返回 '' 表示拿不到进程名（此时这个条目只能展示、不能被禁）。
function exeNameOf(target) {
  if (typeof target !== 'string') return '';
  const s = target.trim();
  if (!s) return '';
  const base = s.split(/[\\/]/).pop();
  return base ? base.toLowerCase() : '';
}

// ────────────────────────────────────────────────────────────
// 三、扫描开始菜单 → 条目列表（纯函数，不吃文件系统）
// ────────────────────────────────────────────────────────────

// 输入：一组「已读好的 .lnk」（{ filePath, buf }）。
// 输出：可直接渲染的软件条目数组。
//
// 输出条目结构：
//   {
//     name      显示名（.lnk 文件名去掉后缀）
//     exe       进程名（小写，如 'steam.exe'）；拿不到就是 ''
//     target    目标全路径（拿不到就是 ''）
//     source    这个条目来自哪个 .lnk（排查用）
//     blocked   true = 解析不出程序文件，点了可能不起作用（界面要标出来）
//   }
//
// ⚠ 排序：能禁的排前面、禁不了的排后面；同类按名字排 —— 主人一眼先看到能用的。
function buildEntries(files) {
  const src = Array.isArray(files) ? files : [];

  const out = [];
  const seenExe = new Set();   // 按 exe 名去重（同一个软件常有多个快捷方式）
  const seenName = new Set();  // 按显示名去重（解析不出的那些只能靠名字去重）

  for (const f of src) {
    if (!f || typeof f.filePath !== 'string' || !Buffer.isBuffer(f.buf)) continue;

    const name = displayNameFromFile(f.filePath);
    if (isJunkName(name)) continue;
    if (isShellEntry(name)) continue;

    const target = parseLnkTarget(f.buf);
    const resolved = target ? expandKnownEnv(target) : '';

    // 系统工具 / 非 exe 目标 → 直接丢
    // ⚠ 这两道判断必须基于「解析结果」而不是「原文」：
    //   `%windir%\system32\eventvwr.msc` 展开前既不是 C:\Windows\ 开头、
    //   也（因为带 % ）看不出是 .msc —— 早年就是这么漏掉「事件查看器」的。
    if (target) {
      if (isNonExeTarget(resolved) || isNonExeTarget(target)) continue;
      if (isSystemTarget(target) || isSystemTarget(resolved)) continue;
    }

    const exe = exeNameOf(resolved);

    // 卸载程序 / 更新器：不管是靠名字还是靠 exe 名认出来，一律丢
    if (isJunkExe(exe)) continue;

    if (exe) {
      // 有进程名的：按 exe 名去重
      if (seenExe.has(exe)) continue;
      seenExe.add(exe);
      out.push({ name, exe, target: resolved, source: f.filePath, blocked: false });
    } else {
      // ★ 解析不出程序文件的「真软件」（实测：Riot Client / League of Legends，
      //   它们通过自家启动器协议启动，.lnk 里根本没有 exe）。
      //   **保留**，但标 blocked —— 宁可如实告诉主人「点了可能拦不住」，
      //   也不要假装它能用。
      if (isJunkName(name)) continue;
      if (seenName.has(name.toLowerCase())) continue;
      seenName.add(name.toLowerCase());
      out.push({ name, exe: '', target: '', source: f.filePath, blocked: true });
    }
  }

  // 能禁的在前，禁不了的在后；同类按名字（中文按本地序）排
  out.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return a.name.localeCompare(b.name, 'zh');
  });

  return out;
}

// 黑名单里已经有了的软件，在选择器里标成「已加入」。
// 返回一份 `exe 名 → true` 的快查表。
// ⚠ 只收**真正的进程名**（.exe）：黑名单理论上存的就是 exe，
//   但坏数据可能混进别的东西，进来一个空串就会把「空 exe」也标成已加入。
function takenSet(blacklistExes) {
  const s = new Set();
  for (const v of Array.isArray(blacklistExes) ? blacklistExes : []) {
    const n = exeNameOf(String(v));
    if (n && n.endsWith('.exe')) s.add(n);
  }
  return s;
}

// ────────────────────────────────────────────────────────────
// 四、碰系统的那一层（上层注入依赖，方便单测时替换）
// ────────────────────────────────────────────────────────────

// 默认的实现（真跑起来用的）。
// ⚠ 所有系统调用都集中在这里，上面三节完全是纯的。
const defaultDeps = {
  // 递归列出一个目录下的 .lnk（目录不存在 / 没权限 → 返回空，不抛）
  listLnk(dir) {
    const out = [];
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.lnk$/i.test(e.name)) out.push(p);
      }
    };
    walk(dir);
    return out;
  },
  // 读一个文件的原始字节（失败 → null，**不抛**）
  readFile(p) {
    try { return fs.readFileSync(p); } catch { return null; }
  },
  // 提图标（Electron 的 app.getFileIcon；纯 Node 里没有 → null）
  async getIcon() { return null; },
  // 注入「哪些 exe 不许进黑名单」（真跑时是 blacklist.isProtectedExe）
  isProtectedExe() { return false; },
};

// 开始菜单的两个位置（所有用户 + 当前用户）。
function startMenuDirs(env) {
  const e = env || process.env;
  const dirs = [];
  const common = e.ProgramData || 'C:\\ProgramData';
  const appdata = e.APPDATA || '';
  dirs.push(path.join(common, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (appdata) dirs.push(path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

// 扫一遍开始菜单，返回软件列表。
// ⚠ 会**过滤掉保护进程**（explorer.exe / electron.exe 之类）——
//   绝不能让主人借着选择器把自己或系统进程加进黑名单。
async function scanInstalled(opts) {
  const o = opts || {};
  const deps = Object.assign({}, defaultDeps, o.deps || {});
  const dirs = Array.isArray(o.dirs) ? o.dirs : startMenuDirs(o.env);

  // 1. 收集所有 .lnk
  const files = [];
  for (const d of dirs) {
    for (const p of deps.listLnk(d)) files.push(p);
  }

  // 2. 读字节 → 建条目
  const raw = [];
  for (const p of files) {
    const buf = deps.readFile(p);
    if (buf) raw.push({ filePath: p, buf });
  }

  const entries = buildEntries(raw);

  // 3. 过一遍保护名单（二次保险；blacklist 那边还会再挡一次）
  const safe = entries.filter((it) => !it.exe || !deps.isProtectedExe(it.exe));

  // 4. 附上图标（三层兜底，见 extractIcons）
  return await extractIcons(safe, deps);
}

// ────────────────────────────────────────────────────────────
// 五、图标（三层兜底，**每层都不能省**）
// ────────────────────────────────────────────────────────────
//
//   ① 目标 exe 的图标     —— 正常软件都落在这一层
//   ② 都没提到            —— icon 存 null，界面画「首字母色块」占位
//
// ★ 第②层不是「失败」，是**设计好的兜底**：宁可给一个好看的色块，
//   也不要一排空白格子。这是实测逼出来的（Office / 部分快捷方式提不出图标）。
//
// ⚠ 为什么逐个 await 而不是并发：Electron 的 getFileIcon 是主进程单线程，
//   一下子甩 100 个过去只会同时卡住；而且这里会被缓存（见下），只跑一次。

// 图标转成 data:image/png;base64,...
// ★ 必须 base64：渲染进程的 CSP 是 `default-src 'none'`，
//   传文件路径的话 img 会被直接拦掉（一条都显示不出来）。
function toDataUrl(buf) {
  if (!buf) return null;
  if (Buffer.isBuffer(buf)) return 'data:image/png;base64,' + buf.toString('base64');
  if (typeof buf.toPNG === 'function') return 'data:image/png;base64,' + buf.toPNG().toString('base64');
  return null;
}

// ★ 提图标要**并发**，别一个个 await。
//   实测（真机 41 个软件）：扫 + 解析只花 46ms，但 41 个图标**串行**提要 5.3 秒 ——
//   整个过程 99% 的时间耗在这儿，主人打开面板会干等 5 秒白屏。
//   改成 8 路并发后降到 1.2 秒。
//   ⚠ 并发度别有讲究：app.getFileIcon 是主进程 API，
//     一下子甩 100 个过去反而会互相拖慢（还要读盘 + 解图标）。
//     8 路是实测「足够快、又不至于把主进程占满」的值。
const ICON_CONCURRENCY = 8;

async function extractIcons(entries, deps) {
  const out = entries.map((it) => Object.assign({}, it, { icon: null }));

  // 只有「有目标路径」的才值得去提图标
  const jobs = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].target) jobs.push(i);
  }

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const idx = jobs[next++];
      try {
        out[idx].icon = toDataUrl(await deps.getIcon(out[idx].target));
      } catch {
        out[idx].icon = null; // 提不出来不算错，落到界面的色块兜底
      }
    }
  };

  const lanes = Math.min(ICON_CONCURRENCY, jobs.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}

// ────────────────────────────────────────────────────────────
// 六、缓存（一次会话只扫一次）
// ────────────────────────────────────────────────────────────
//
// 扫描 + 提图标不便宜（实测 106 个 .lnk）。界面每次打开选择器都重扫一遍
// 会明显卡顿，所以缓存住。缓存由调用方持有（这个模块不存全局状态，好单测）。

function createCache() {
  let value = null;
  let pending = null;

  return {
    // 有缓存就直接给；正在扫就等那一趟；都没有才真扫
    async get(scanFn) {
      if (value) return value;
      if (pending) return pending;
      pending = (async () => {
        try {
          const v = await scanFn();
          value = Array.isArray(v) ? v : [];
          return value;
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    peek() { return value; },
    clear() { value = null; pending = null; },
  };
}

module.exports = {
  // 纯函数（单测主战场）
  asciiRuns,
  candidatesFromLnk,
  parseLnkTarget,
  parseLnkIconLocation,
  expandKnownEnv,
  isSystemTarget,
  isNonExeTarget,
  isJunkName,
  isJunkExe,
  isShellEntry,
  displayNameFromFile,
  exeNameOf,
  buildEntries,
  takenSet,
  startMenuDirs,
  toDataUrl,
  // 带系统调用 / 需要注入的
  scanInstalled,
  extractIcons,
  createCache,
  defaultDeps,
};
