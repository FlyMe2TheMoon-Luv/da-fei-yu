// src/main/focus/elevate.js
// 提权执行壳 —— 负责「把管理员助手喊起来」和「告诉它该收工了」。
//
// ── 设计（Task 6 的核心，别改）──
//   整段专注**只弹一次 UAC**。做法是起一个**常驻的提权助手**（focus-helper.ps1）：
//
//     主进程（普通权限）                      助手（管理员，全程活着）
//        │ 1. 写 focus-plan.json                │
//        │ 2. Start-Process -Verb RunAs ───────▶│ 3. 备份 hosts → 写新内容 → flushdns
//        │      ★ 此刻弹唯一一次 UAC            │ 4. 循环：杀黑名单 / 看控制文件 / 看结束时间
//        │ 5. 结束 → 写 focus-ctl.json {stop}──▶│ 6. 看到 stop → 还原 hosts → 退出
//        │                                       │ （主进程崩了 → 到结束时间自己还原）
//
// ── 为什么结束走「控制文件」而不是杀进程 ──
//   强杀助手 = 不给它收尾的机会，hosts 会留着一个指向 0.0.0.0 的标记块，
//   主人的网站就一直打不开。控制文件是「请你自己收工」，
//   而「到点自愈」是兜底 —— 就算主进程整个崩了，hosts 也一定会被还原。
//
// ── 为什么分成两个文件（比计划里多一个）──
//   计划里写的是「控制文件里既放 stop 又放心跳」，但那样**有竞态**：
//   主进程写 stop 的同时，助手正好在写心跳，就会把 stop 覆盖掉，专注结束不了。
//   所以拆成两个文件，**每个文件只有一个写入者**，竞态从根上消失：
//     focus-ctl.json ← 只有主进程写（主 → 助手：请你收工）
//     focus-hb.json  ← 只有助手写  （助手 → 主：我还活着）
//
// ── 为什么这个文件在纯 Node 里也能 require ──
//   碰 electron 的三个依赖（store 的 read/write/fileOf）都是**延迟 require** 的
//   —— 包在函数体里，只有真正调用时才加载。所以 scripts/test-focus-elevate.js
//   能注入假依赖、把这一层完整测掉，不需要起 Electron、更不需要提权。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- 常量 ----------

const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

const PLAN_FILE = 'focus-plan.json';   // 主 → 助手：这一趟要干什么
const CTL_FILE = 'focus-ctl.json';     // 主 → 助手：请你收工
const HB_FILE = 'focus-hb.json';       // 助手 → 主：我还活着
const BACKUP_FILE = 'hosts.backup';    // 原始 hosts 的字节级备份
const HELPER_LOG = 'focus-helper.log'; // 助手自己的日志（排查用）

const HELPER_SCRIPT = 'focus-helper.ps1';      // 仓库里的原件
const HELPER_COPY = 'focus-helper.run.ps1';    // 复制到 userData 后真正跑的那份

// 助手每 3 秒写一次心跳；超过这个时间没动静就算它不在了。
const HB_STALE_MS = 15000;

// ---------- 纯函数（可单测，不碰系统）----------

// PowerShell 单引号字符串：内部的 ' 要写成 ''
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Windows 命令行里的路径引号。路径里不可能有 "，所以直接剥掉更安全。
function winQuote(s) {
  return `"${String(s).replace(/"/g, '')}"`;
}

// 助手自己的命令行参数（会被当成一整条字符串塞给 Start-Process）
function buildHelperArgLine({ helperPath, planPath }) {
  return [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', winQuote(helperPath),
    '-PlanFile', winQuote(planPath),
  ].join(' ');
}

// 真正 spawn 给 powershell.exe 的那条命令。
// 它只干一件事：用 RunAs 起助手，然后立刻退出，用退出码汇报「主人点了是还是否」。
//   exit 0 → UAC 通过了
//   exit 1 → 主人点了「否」，或者系统拒绝提权
function buildRunAsCommand({ helperPath, planPath }) {
  const inner = buildHelperArgLine({ helperPath, planPath });
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ${psSingleQuote(inner)}`,
    '  exit 0',
    '} catch { exit 1 }',
  ].join('\n');
}

// 一次专注的会话号。控制文件靠它认领：上一趟遗留的 stop 不该结束这一趟。
function newSid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `f${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// 组装计划文件的内容（纯函数，Task 7 直接拿来用）
//
// mode 两种，助手的行为完全不同（见 focus-helper.ps1）：
//   'session' —— 一整段专注：备份 → 写 hosts → 循环（杀进程/看信号/看时间）→ 还原
//   'restore' —— 一次性清残留：只写一次干净内容就退出，**不备份、不还原、不循环**
//                ★ 清残留绝不能用 session 模式：那时 hosts 正是脏的那份，
//                  备份下来就等于「把脏的当原始内容」，最后还原时又写回去了。
function makePlan({ mode, sid, hostsText, restoreText, exes, endsAt, now }, paths) {
  return {
    mode: (mode === 'restore') ? 'restore' : 'session',
    sid: String(sid || ''),
    hostsPath: paths.hostsPath,
    hostsText: typeof hostsText === 'string' ? hostsText : null,
    restoreText: typeof restoreText === 'string' ? restoreText : null,
    exes: Array.isArray(exes) ? exes.slice() : [],
    endsAt: Number.isFinite(endsAt) ? endsAt : 0,
    backupPath: paths.backupPath,
    ctlPath: paths.ctlPath,
    hbPath: paths.hbPath,
    logPath: paths.logPath,
    createdAt: Number.isFinite(now) ? now : 0,
  };
}

function msg(err) {
  return (err && err.message) ? err.message : String(err);
}

// ---------- 可注入的实例 ----------

function createElevator(overrides = {}) {
  const deps = Object.assign({
    spawn,
    now: () => Date.now(),
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, buf) => fs.writeFileSync(p, buf),
    // ⚠ 下面三个要碰 electron，故意延迟到「真正调用时」才 require
    writeJson: (name, data) => require('../store').write(name, data),
    readJson: (name, fallback) => require('../store').read(name, fallback),
    fileOf: (name) => require('../store').fileOf(name),
    helperSource: () => path.join(__dirname, '..', HELPER_SCRIPT),
  }, overrides);

  function paths() {
    return {
      hostsPath: HOSTS_PATH,
      planPath: deps.fileOf(PLAN_FILE),
      ctlPath: deps.fileOf(CTL_FILE),
      hbPath: deps.fileOf(HB_FILE),
      backupPath: deps.fileOf(BACKUP_FILE),
      logPath: deps.fileOf(HELPER_LOG),
      helperCopyPath: deps.fileOf(HELPER_COPY),
    };
  }

  // 把 .ps1 复制到 userData 再跑。
  // 两个好处：① 程序目录可能是只读的（打包后），助手读自己更稳；
  //           ② 路径短、没有空格（项目目录带空格，拼命令行容易出错）。
  function prepareHelper() {
    const src = deps.helperSource();
    const dest = deps.fileOf(HELPER_COPY);
    const buf = deps.readFile(src);
    deps.writeFile(dest, buf);
    return dest;
  }

  // 起助手。返回 Promise（不能同步等 —— UAC 弹窗可能停好几秒，
  // 同步等会把桌宠整个卡死）。
  function startHelper(plan) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

      let helperPath;
      try {
        helperPath = prepareHelper();
      } catch (err) {
        finish({ ok: false, error: `助手脚本没能准备好，没法开始专注（${msg(err)}）` });
        return;
      }

      if (!deps.writeJson(PLAN_FILE, plan)) {
        finish({ ok: false, error: '计划文件写不进去，没法开始专注' });
        return;
      }

      const cmd = buildRunAsCommand({ helperPath, planPath: deps.fileOf(PLAN_FILE) });

      let child;
      try {
        child = deps.spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-Command', cmd,
        ], { windowsHide: true, stdio: 'ignore' });
      } catch (err) {
        finish({ ok: false, error: `没能喊起管理员助手（${msg(err)}）` });
        return;
      }

      if (!child || typeof child.once !== 'function') {
        finish({ ok: false, error: '没能喊起管理员助手' });
        return;
      }

      child.once('error', (err) => {
        finish({ ok: false, error: `没能喊起管理员助手（${msg(err)}）` });
      });
      child.once('close', (code) => {
        if (code === 0) finish({ ok: true });
        else finish({ ok: false, error: '需要你点一下「是」才能开始专注，刚才被取消了' });
      });
    });
  }

  // 请助手收工。只写文件，**绝不杀进程** —— 强杀不给它还原 hosts 的机会。
  function notifyStop(sid) {
    try {
      return deps.writeJson(CTL_FILE, { sid: String(sid || ''), stop: true, at: deps.now() });
    } catch {
      return false;
    }
  }

  // 开新一段专注前清一遍信号：控制文件标成「不许停」，心跳标成「还没听到」。
  // （心跳这个文件在助手起来之前由主进程写一次是安全的 —— 那会儿还没人跟它抢。）
  function resetSignals(sid) {
    const s = String(sid || '');
    const a = deps.writeJson(CTL_FILE, { sid: s, stop: false, at: deps.now() });
    const b = deps.writeJson(HB_FILE, { sid: s, at: 0 });
    return !!(a && b);
  }

  function readHeartbeat() {
    const hb = deps.readJson(HB_FILE, null);
    if (!hb || typeof hb !== 'object') return null;
    return hb;
  }

  // 助手还活着吗（心跳够新 + 是同一趟专注）
  function isHelperAlive(sid) {
    const hb = readHeartbeat();
    if (!hb) return false;
    if (sid && String(hb.sid) !== String(sid)) return false;
    if (!Number.isFinite(hb.at) || hb.at <= 0) return false;
    return (deps.now() - hb.at) <= HB_STALE_MS;
  }

  // 组装计划文件：路径由实例自己填，调用方只管给内容。
  // Task 7 开始专注时就是走这个。
  function plan(input = {}) {
    return makePlan({
      mode: input.mode,
      sid: input.sid,
      hostsText: input.hostsText,
      restoreText: input.restoreText,
      exes: input.exes,
      endsAt: input.endsAt,
      now: Number.isFinite(input.now) ? input.now : deps.now(),
    }, paths());
  }

  // 把计划落盘。真机上 startHelper 内部会做这件事；
  // 单独拎出来是为了让**沙箱（自检）**也能写出同一份文件 ——
  // 「主进程 → 助手」的唯一契约就是这个文件的序列化结果，
  // 沙箱跳过它就等于没验这一步（exes 只有一项时会退化成字符串，是真踩过的坑）。
  function writePlan(p) {
    return deps.writeJson(PLAN_FILE, p);
  }

  return {
    newSid,
    plan,
    writePlan,
    PLAN_FILE,
    paths,
    prepareHelper,
    startHelper,
    notifyStop,
    resetSignals,
    readHeartbeat,
    isHelperAlive,
    deps,
  };
}

module.exports = {
  HOSTS_PATH,
  PLAN_FILE,
  CTL_FILE,
  HB_FILE,
  BACKUP_FILE,
  HELPER_LOG,
  HELPER_SCRIPT,
  HELPER_COPY,
  HB_STALE_MS,
  psSingleQuote,
  winQuote,
  buildHelperArgLine,
  buildRunAsCommand,
  newSid,
  makePlan,
  createElevator,
};
