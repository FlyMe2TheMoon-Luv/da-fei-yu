// src/main/focus/doh.js
// 安全 DNS（DoH）检测 —— 专注模式里最容易被忽略、但会让整个屏蔽「静默失效」的一件事。
//
// ── 为什么必须检测它 ──
//   我们靠改 hosts 把网站指到 0.0.0.0。但浏览器一旦开了「安全 DNS」，
//   域名解析就不走系统了 —— 它自己加密问外面的服务器，hosts 被完全绕过。
//   结果是：hosts 改得一点没错，网站照样打得开。主人会以为「专注模式坏了」。
//   这是本项目里唯一一个「我们全对、功能全废」的坑，所以开始专注前必须查一遍。
//
// ── 为什么不自己关掉它 ──
//   那是主人的浏览器设置，改它要动主人的配置文件 / 注册表策略，
//   属于「越权替他做决定」。我们的做法是：**检测 + 说清楚怎么关**，决定权留给主人。
//
// ── 三态，不是两态 ──
//   每个判断都返回 'off' | 'on' | 'unknown'。
//   ★ 'unknown' 绝不能偷偷当成 'off' —— 那等于告诉主人「放心，屏蔽会生效」，
//     然后他发现问题时已经浪费了半小时。宁可说「不知道」，也不能给一个假的安心。
//
// ── 为什么能单测 ──
//   解析部分是纯函数（parseChromePrefs / parseRegQuery），不 require electron；
//   真正读文件 / 查注册表的部分做成可注入的探测层（createDetector）。
//   见 scripts/test-focus-hosts.js 第 9、10 节。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 纯函数：解析 ----------

// 一份浏览器 Preferences（JSON 文本）里的 DoH 状态。
//   {"dns_over_https":{"mode":"off"}}       → 'off'
//   {"dns_over_https":{"mode":"automatic"}} → 'on'   （自动挑安全 DNS 也算开着）
//   {"dns_over_https":{"mode":"secure"}}    → 'on'
//   没有这一项 / 取值不认识 / 坏 JSON       → 'unknown'  ★ 一律不许猜
function parseChromePrefs(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return 'unknown';   // 配置写坏了 / 读了一半 → 不知道，不崩
  }
  if (!obj || typeof obj !== 'object') return 'unknown';

  const node = obj.dns_over_https;
  if (!node || typeof node !== 'object') return 'unknown';

  return modeToLevel(node.mode);
}

// mode 取值 → 三态
function modeToLevel(mode) {
  if (typeof mode !== 'string') return 'unknown';
  const m = mode.trim().toLowerCase();
  if (m === 'off') return 'off';
  if (m === 'secure' || m === 'automatic') return 'on';
  return 'unknown';
}

// 这份配置里**到底有没有**安全 DNS 这一项。
// 用来区分两种「不知道」：
//   「压根没这一项」= 主人从没改过它（提示语要这么说）
//   「有这一项但值不认识」= 版本太新（提示语要说另一句）
function prefsHasDoh(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    const o = JSON.parse(text);
    const node = o && typeof o === 'object' ? o.dns_over_https : null;
    return !!(node && typeof node === 'object');
  } catch {
    return false;
  }
}

// reg query 的输出 → 三态
//   HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome
//       DnsOverHttpsMode    REG_SZ    secure
//   查不到时 reg 会输出「错误: 系统找不到指定的注册表项或值。」→ 'unknown'
function parseRegQuery(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';

  const m = text.match(/DnsOverHttpsMode\s+REG_[A-Z_]+\s+(\S+)/i);
  if (!m) return 'unknown';
  return modeToLevel(m[1]);
}

// 把若干个三态合成一个总的三态
//   - 只要有一个「开着」→ 开着（开着就足以绕过 hosts）
//   - 否则只要有一个「不知道」→ 不知道（我们不能替它保证）
//   - 全是「关着」→ 关着
function mergeLevels(levels) {
  const list = (Array.isArray(levels) ? levels : []).filter((x) => x === 'on' || x === 'off' || x === 'unknown');
  if (list.length === 0) return 'unknown';
  if (list.includes('on')) return 'on';
  if (list.includes('unknown')) return 'unknown';
  return 'off';
}

// 给主人看的一句话。三态各一句，而且**说清是哪种「不知道」**：
//   - 一个浏览器都没装
//   - 装了，但配置里压根没有安全 DNS 这一项（= 你从没改过它）
//   - 读到了这一项，但取值不认识
// 这三种情况主人该做的事不一样，糊成一句就是在骗人。
function adviceFor(level, info = {}) {
  const names = Array.isArray(info.names) ? info.names : [];
  const installedCount = Number.isFinite(info.installedCount) ? info.installedCount : names.length;
  const sawPref = !!info.sawPref;
  const who = names.length ? names.join(' / ') : '浏览器';

  if (level === 'on') {
    return `${who} 的「安全 DNS」开着 —— 它会绕过 hosts 屏蔽，这些网站可能照样打得开。`
      + '想真正拦住，先去浏览器的「设置 → 隐私和安全 → 安全」里把「使用安全 DNS」关掉，再开始专注。';
  }

  if (level === 'off') {
    return '浏览器没开「安全 DNS」，网站屏蔽会正常生效。';
  }

  if (installedCount > 0 && sawPref) {
    return `读到了 ${who} 的安全 DNS 设置，但取值不认识（可能版本太新）。`
      + '不敢替你保证 —— 发现网站还能打开，就去浏览器设置里把「使用安全 DNS」关掉。';
  }

  if (installedCount > 0) {
    return `装了 ${who}，但它们配置里都没有「安全 DNS」这一项（说明你没改过它）。`
      + '不同版本的默认值不一样，所以我不敢替你保证 —— '
      + '发现网站还能打开，就去浏览器「设置 → 隐私和安全 → 安全」里把「使用安全 DNS」关掉。';
  }

  return '没检测到 Chrome / Edge。如果你用的是别的浏览器，它自己的「安全 DNS」一样会绕过屏蔽 —— '
    + '发现网站还能打开，就去它的设置里关掉。';
}

// 要不要为了「安全 DNS」**弹一个抢焦点的窗口**（Task 9）？
//
// 这是一个刻意保守的选择，只有**确认开着**才弹：
//   'on'      → 弹。这是真风险：hosts 屏蔽会被整个绕过，主人必须知道，
//               而且这事「不说就等于骗他」——他会以为专注在挡。
//   'unknown' → **不弹**。这一条最反直觉，但很重要：
//               真机上（Chrome/Edge 装了、但配置里没有这一项）永远是这个状态，
//               每次开始专注都弹 = 训练主人闭眼点掉。
//               一个被闭眼点掉的警告，比没有警告更坏 ——
//               真正出事那天他也会闭眼点掉。
//               设置页里那条常驻横幅已经够了（就在「开始专注」按钮上方）。
//   'off'     → 不弹。没什么可说的。
//
// ★ 别把 'unknown' 改成「也弹一下比较保险」。保险的做法是**别浪费他的注意力**。
function shouldPopupForDoh(level) {
  return level === 'on';
}

// ---------- 探测层（可注入，好测）----------
const CHROMIUM_BROWSERS = [
  { name: 'Chrome', parts: ['Google', 'Chrome', 'User Data'] },
  { name: 'Edge', parts: ['Microsoft', 'Edge', 'User Data'] },
];

// 企业策略（注册表）里强制开的 DoH。优先级高于浏览器自己的设置。
const POLICY_KEYS = [
  { name: 'Chrome', key: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome' },
  { name: 'Edge', key: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge' },
];

// 真去查注册表。查不到会抛异常（reg 的退出码非 0），这里一律吞掉返回 null。
function realRegQuery(key, value) {
  try {
    return execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

function createDetector(overrides = {}) {
  const deps = Object.assign({
    env: process.env,
    readText: (p) => fs.readFileSync(p, 'utf8'),
    exists: (p) => fs.existsSync(p),
    listDirs: (p) => fs.readdirSync(p, { withFileTypes: true }),
    regQuery: realRegQuery,
  }, overrides);

  function safeRead(p) {
    try { return deps.readText(p); } catch { return null; }
  }

  // ★ 存在性判断也要包起来。真机上 fs.existsSync 不会抛，
  //   但「绝不抛异常」是 detect() 对外的承诺 —— 承诺就得自己兜住，不能指望底层。
  //   （这条是负对照逼出来的：注入一个会抛的 exists 时，detect() 当场炸了。）
  function safeExists(p) {
    try { return !!deps.exists(p); } catch { return false; }
  }

  // 一个 Chromium 系浏览器的所有配置文件目录（Default + Profile 1/2/...）
  function profilesOf(root) {
    const out = [];
    try {
      for (const e of deps.listDirs(root)) {
        if (!e || !e.isDirectory || !e.isDirectory()) continue;
        const n = String(e.name || '');
        if (n === 'Default' || /^Profile \d+$/.test(n)) out.push(n);
      }
    } catch { /* 目录读不了就当没有 */ }
    // Default 排前面：它是最常用的那个，先命中就先算数
    out.sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)));
    return out;
  }

  function detectBrowser(b) {
    const localAppData = (deps.env && deps.env.LOCALAPPDATA) || '';
    if (!localAppData) return { name: b.name, installed: false, doh: 'unknown', sawPref: false };

    const root = path.join(localAppData, ...b.parts);
    if (!safeExists(root)) return { name: b.name, installed: false, doh: 'unknown', sawPref: false };

    const levels = [];
    // sawPref：任意一个配置文件里**到底有没有** dns_over_https 这一项。
    // 它和 level 是两件事：level='unknown' 可能是「没这一项」也可能是「值不认识」，
    // 而主人该做的事不一样（前者=你从没改过它；后者=版本太新）。所以两个都要带出去。
    let sawPref = false;
    for (const prof of profilesOf(root)) {
      const f = path.join(root, prof, 'Preferences');
      if (!safeExists(f)) continue;
      const raw = safeRead(f);
      if (prefsHasDoh(raw)) sawPref = true;
      levels.push(parseChromePrefs(raw));
    }
    if (!levels.length) return { name: b.name, installed: true, doh: 'unknown', sawPref: false };

    return { name: b.name, installed: true, doh: mergeLevels(levels), sawPref };
  }

  function detectPolicy() {
    const levels = [];
    const sources = [];
    for (const p of POLICY_KEYS) {
      let out = null;
      try { out = deps.regQuery(p.key, 'DnsOverHttpsMode'); } catch { out = null; }
      const lv = parseRegQuery(out);
      if (lv !== 'unknown') { levels.push(lv); sources.push(p.name); }
    }
    return { level: mergeLevels(levels), sources };
  }

  // 永远返回一个对象，绝不抛异常。
  function detect() {
    // 逐个浏览器兜底：任何一个探测分支出意外，都只让它自己变成「不知道」，
    // 不能连累整个检测 —— 检测失败本身不该让主人开不了专注。
    const browsers = CHROMIUM_BROWSERS.map((b) => {
      try {
        return detectBrowser(b);
      } catch {
        return { name: b.name, installed: false, doh: 'unknown', sawPref: false };
      }
    });
    const installed = browsers.filter((b) => b.installed);
    const policy = detectPolicy();

    const levels = [];
    // 策略是硬性的：它说开着就一定开着，说关着也一定关着（企业下发的，浏览器改不了）
    if (policy.level === 'on') levels.push('on');
    else if (policy.level === 'off') levels.push('off');
    for (const b of installed) levels.push(b.doh);

    const level = mergeLevels(levels);
    const names = installed.map((b) => b.name);
    if (policy.level === 'on' && policy.sources.length) {
      names.push(`${policy.sources.join('/')} 企业策略`);
    }

    // ★ 只把「浏览器」算进 installedCount —— 策略命中的名字不算「装了浏览器」，
    //   否则没装浏览器但被企业策略点名时会说出「装了 Chrome 企业策略」这种鬼话。
    const sawPref = installed.some((b) => b.sawPref);

    return {
      level,
      browsers,
      policy: policy.level,
      sawPref,
      advice: adviceFor(level, { names, installedCount: installed.length, sawPref }),
    };
  }

  return { detect, detectBrowser, detectPolicy, profilesOf };
}

// 默认实例（真读文件 / 真查注册表）。任何意外都兜成 unknown。
const defaultDetector = createDetector();

function detectDoh() {
  try {
    return defaultDetector.detect();
  } catch {
    return {
      level: 'unknown',
      browsers: [],
      policy: 'unknown',
      sawPref: false,
      advice: adviceFor('unknown', { names: [], installedCount: 0, sawPref: false }),
    };
  }
}

module.exports = {
  CHROMIUM_BROWSERS,
  POLICY_KEYS,
  parseChromePrefs,
  parseRegQuery,
  modeToLevel,
  prefsHasDoh,
  mergeLevels,
  adviceFor,
  shouldPopupForDoh,
  createDetector,
  detectDoh,
};
