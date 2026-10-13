// src/main/focus/blacklist.js
// 纯函数：把主人随手输的「网址 / 程序名」洗成能用的黑名单条目，并挡住会伤到系统的项。
//
// ── 为什么不 require('electron') ──
//   一旦 require 了，普通 Node 里就跑不起来，也就没法单测了。
//   本文件只做字符串处理，没有任何系统调用（见 scripts/test-focus-blacklist.js）。
//
// ── 为什么「拒收」比「尽力解析」更重要 ──
//   黑名单里混进 electron.exe / explorer.exe，专注一开始就会
//   把桌宠自己杀了、或者把桌面杀了 —— 后果比「没生效」严重得多。
//   所以这里的策略是：看不懂的、危险的，一律拒收并给出人话原因，
//   绝不「猜一个差不多的」。
//
// ── 三处使用（只有一处规则）──
//   1. 界面「加一条」时：立刻告诉主人这条行不行（normalizeDomain / normalizeExe）
//   2. 保存整份名单时：清洗 + 去重 + 记账（sanitizeBlacklist）
//   3. 从文件读回来时：兜底 + 再挡一次危险项（withDefaults）
//   三处都走本文件，界面不许自带第二套规则。

const path = require('path');

// ── 系统关键进程 / 我们自己的进程：一律不许进黑名单 ──
// 杀掉它们的后果：explorer.exe → 桌面和任务栏全没；csrss/winlogon/lsass/smss/wininit
// → 蓝屏或强制重启；dwm → 窗口特效崩；svchost/services → 一堆系统服务挂掉。
const PROTECTED_EXES = [
  // 我们自己（开发时是 electron.exe，打包后是桌宠自己的 exe —— 下面还有动态兜底）
  'electron.exe',
  'node.exe',
  // Windows 桌面外壳与系统关键进程
  'explorer.exe',
  'csrss.exe',
  'winlogon.exe',
  'lsass.exe',
  'services.exe',
  'wininit.exe',
  'smss.exe',
  'dwm.exe',
  'svchost.exe',
  // 其它杀掉会明显影响使用的基础进程
  'taskhostw.exe',
  'sihost.exe',
  'fontdrvhost.exe',
  'ctfmon.exe',
  'spoolsv.exe',
  'audiodg.exe',
  'searchindexer.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
];

// 桌宠自己的进程名 —— 动态取，不写死。
// 开发时 process.execPath 是 .../electron.exe；打包后是桌宠自己的 exe 名。
// 拿不到就退化成空串（此时只靠上面的静态名单兜底）。
const SELF_EXE = (() => {
  try {
    return path.basename(process.execPath || '').toLowerCase();
  } catch {
    return '';
  }
})();

// 这个程序名是不是「碰不得」的
function isProtectedExe(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (PROTECTED_EXES.includes(n)) return true;
  if (SELF_EXE && n === SELF_EXE) return true;
  return false;
}

// ── 域名 ──
// 认识的形式：https://www.bilibili.com/video/x?t=1 → www.bilibili.com
// 拒收：空、带空格、中文、没有点、带通配符 *
function normalizeDomain(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '请输入网址，比如 bilibili.com' };

  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, error: '请输入网址，比如 bilibili.com' };

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 去掉 https:// 这类协议头
  s = s.split(/[/?#]/)[0];                      // 去掉路径 / 查询串 / 锚点
  s = s.split(':')[0];                          // 去掉端口
  s = s.replace(/\.+$/, '');                    // 去掉末尾的点

  if (!s) return { ok: false, error: '这看着不像网址，比如 bilibili.com' };
  if (s.includes('*')) return { ok: false, error: '暂不支持通配符，请写完整域名（比如 www.bilibili.com）' };

  const shape = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  if (!shape.test(s)) return { ok: false, error: '这看着不像网址，比如 bilibili.com' };

  const tld = s.split('.').pop();
  if (!/^[a-z]{2,}$/.test(tld)) return { ok: false, error: '域名结尾看着不对，比如 bilibili.com' };

  return { ok: true, value: s };
}

// ── 程序名 ──
// 认识的形式：C:\Program Files\Steam\steam.exe → steam.exe；steam → steam.exe
// 拒收：空、带空格、非 .exe、危险进程
function normalizeExe(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '请输入程序名，比如 steam.exe' };

  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, error: '请输入程序名，比如 steam.exe' };

  s = s.split(/[\\/]/).pop(); // 只留文件名
  if (!s) return { ok: false, error: '这看着不像程序名，比如 steam.exe' };

  if (!s.includes('.')) s += '.exe';               // 没写扩展名就补 .exe
  if (!s.endsWith('.exe')) return { ok: false, error: '目前只支持 .exe 结尾的程序' };

  if (!/^[a-z0-9][a-z0-9._+-]*\.exe$/.test(s)) {
    return { ok: false, error: '程序名里有不认识的字符，比如 steam.exe' };
  }

  if (isProtectedExe(s)) {
    return { ok: false, error: `「${s}」不能加 —— 它是系统或桌宠自己的程序，关掉会出问题` };
  }

  return { ok: true, value: s };
}

// ── 清洗整份名单 ──
// 输入可以是任何东西（甚至 null）。永远返回数组，绝不抛异常。
// rejected 里记着「哪些没收、为什么」，好让界面如实告诉主人 ——
// 悄悄丢掉是最坏的做法（主人以为挡住了，其实没有）。
function sanitizeBlacklist(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dIn = Array.isArray(src.domains) ? src.domains : [];
  const eIn = Array.isArray(src.exes) ? src.exes : [];

  const out = { ok: true, domains: [], exes: [], rejected: [] };

  const seenD = new Set();
  for (const item of dIn) {
    const r = normalizeDomain(item);
    if (!r.ok) { out.rejected.push({ input: item, error: r.error }); continue; }
    if (seenD.has(r.value)) continue;
    seenD.add(r.value);
    out.domains.push(r.value);
  }

  const seenE = new Set();
  for (const item of eIn) {
    const r = normalizeExe(item);
    if (!r.ok) { out.rejected.push({ input: item, error: r.error }); continue; }
    if (seenE.has(r.value)) continue;
    seenE.add(r.value);
    out.exes.push(r.value);
  }

  out.ok = out.rejected.length === 0;
  return out;
}

// ── 默认配置 ──
const DEFAULT_CONFIG = {
  domains: [],
  exes: [],
  presets: [25, 45, 60], // 分钟
  lastMinutes: 25,
  session: null,         // 没有进行中的专注
};

const MAX_MINUTES = 24 * 60;

// 一份 session 只认「进行中」的形态；别的（坏数据、已结束）一律当没有
function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  if (!Number.isFinite(s.endsAt)) return null;
  if (s.state !== 'running') return null;
  return {
    startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null,
    endsAt: s.endsAt,
    minutes: Number.isInteger(s.minutes) && s.minutes > 0 ? s.minutes : null,
    state: 'running',
  };
}

// 从文件读回来的东西可能是坏的 / 缺字段的 —— 一律补齐成一份能用的配置。
// 注意：这里也会再过一遍危险进程过滤（防「有人手改了 focus.json」）。
function withDefaults(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const cleaned = sanitizeBlacklist({ domains: src.domains, exes: src.exes });

  const presets = (Array.isArray(src.presets) ? src.presets : [])
    .filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_MINUTES);

  const lastMinutes = (Number.isInteger(src.lastMinutes) && src.lastMinutes > 0 && src.lastMinutes <= MAX_MINUTES)
    ? src.lastMinutes
    : DEFAULT_CONFIG.lastMinutes;

  return {
    domains: cleaned.domains,
    exes: cleaned.exes,
    presets: presets.length ? presets : DEFAULT_CONFIG.presets.slice(),
    lastMinutes,
    session: normalizeSession(src.session),
  };
}

module.exports = {
  PROTECTED_EXES,
  SELF_EXE,
  DEFAULT_CONFIG,
  MAX_MINUTES,
  isProtectedExe,
  normalizeDomain,
  normalizeExe,
  sanitizeBlacklist,
  withDefaults,
};
