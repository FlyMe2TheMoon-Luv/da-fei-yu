// src/main/focus/intercept.js
// 「拦截」这条链的纯逻辑 + 文件读写 —— 介于纯函数和 Electron 之间的一层。
//
// ── 它负责什么 ──
//   1. 读 / 写 hosts 文件（**latin1，逐字节往返**）
//   2. 算「这次专注要把 hosts 改成什么」（新全文 + 还原用的全文）
//   3. 判断 hosts 里有没有上次留下的残留
//   4. 组装交给提权助手的计划文件
//
// ── 为什么不放在 focus/index.js 里 ──
//   index.js require 了 ./store（它 require('electron')），普通 Node 里跑不起来，
//   所以它的逻辑一条都测不了。这一层刻意**不碰 electron**，
//   于是「读 hosts / 算新内容 / 判断残留」全都能在纯 Node 里穷举测试。
//   index.js 只剩「编排」——把这一层和提权助手串起来。
//
// ── ★ 为什么是 latin1 ──
//   hosts 是系统文件，里面可能有主人自己写的注释（GBK 或 UTF-8 都可能）。
//   用 latin1（ISO-8859-1）读，一个字节 = 一个字符；写回去时一个字符 = 一个字节，
//   所以「读进来再写出去」是**逐字节相等**的 —— 不管原文是什么编码都不会被改坏。
//   用 'utf8' 读一份 GBK 文件，那几个字节会变成 U+FFFD，写回去就是永久损坏。
//   助手侧对应的写法是 GetEncoding(28591)，两边必须一致。

const fs = require('fs');
const hosts = require('./hosts');
const elevator = require('./elevate');

// 读 hosts 全文。
// ★ 读不到一律返回 null，**绝不返回空串** ——
//   返回空串会让上层以为「hosts 本来就是空的」，然后拿一份只有我们标记块的内容
//   把整个文件覆盖掉，主人原有的 DNS 配置就全没了。null 是「不知道」，空串是「确实是空的」。
// 最近一次「读 hosts 失败」的原因。
//
// ★ 为什么必须留着它 —— 真机踩到过。
//   原来这里 catch 完直接吞掉，只返回 null，界面于是只能说
//   「可能是被杀毒软件挡住了，或者权限不够」—— 那是**猜**，不是诊断。
//   主人拿着这句话，既没法确认是不是杀软、也不知道下一步该点哪里。
//   把系统给的错误码留下来，就能一眼分清是谁干的：
//     ENOENT       文件不在了（被改名 / 删除 / 路径不对）
//     EACCES/EPERM 被拒绝（杀毒、安全软件、权限）
//     EBUSY        被别的程序占着（比如实时扫描）
let lastReadError = null;

function readHostsText(hostsPath) {
  try {
    const text = fs.readFileSync(hostsPath).toString('latin1');
    // ★ 读成功必须把上一次的失败清掉。
    //   不清的话，之后某次「其实读到了、但上层别的判断失败」会被怪到
    //   这次头上，指着一个早就过去的错误码瞎猜。
    lastReadError = null;
    return text;
  } catch (err) {
    lastReadError = {
      code: (err && err.code) || '',
      message: (err && err.message) || String(err),
      path: String(hostsPath),
    };
    return null;
  }
}

// 最近一次读失败的原因；从没失败过就是 null。
function readError() {
  return lastReadError;
}

// 把系统错误码翻译成「主人看得懂 + 能照做」的一句话。
// ★ 不同错误码必须给出**不同**的话 —— 都说同一句等于没说。
function explainReadError(info) {
  const code = info && info.code;
  if (code === 'ENOENT') return 'hosts 文件不在了（可能被安全软件改名或删除）';
  if (code === 'EACCES' || code === 'EPERM') {
    return '系统拒绝了读取（多半是杀毒 / 安全软件在拦，把它加入信任区再试）';
  }
  if (code === 'EBUSY') return '文件正被别的程序占用，过一会儿再试';
  return '系统没给出具体原因';
}

// 写 hosts 全文（latin1，逐字节）。
//
// ★ 这里有个必须守住的约定：**传进来的字符串每个字符都不能超过 U+00FF**。
//   因为 latin1 是「一个字符 = 一个字节」，字符超过 0xFF 会被 Buffer 悄悄截断，
//   变成任意字节 —— 而其中完全可能撞上 0x0D / 0x0A，于是「注释里的一小段」
//   突然变成了一个换行。文件不会报错，只是内容被悄悄改了。
//   （这个坑真的踩到过：沙箱 hosts 里写了一句中文，还原后凭空多出一个换行。）
//   所以这里宁可**响亮地报错**，也不要静默写坏。
//
// 合法来源只有两个：readHostsText() 读回来的（本来就是 latin1），以及我们自己的标记块（纯 ASCII）。
function writeHostsText(hostsPath, text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) {
      throw new Error(
        `hosts 内容里出现了非 latin1 字符（第 ${i + 1} 个字符 U+${s.charCodeAt(i).toString(16).toUpperCase()}）。`
        + '它会被截断成任意字节、可能伪装成换行把文件写坏 —— 拒绝写入。'
      );
    }
  }
  fs.writeFileSync(hostsPath, Buffer.from(s, 'latin1'));
  return true;
}

// 算这次专注要写什么。
//   newText     = 原文 + 我们的标记块（已有块则先精确替换）
//   restoreText = 把 newText 里的块精确删掉 → 必须和原文逐字节相等
//   changed     = 有没有真的动到（一个合法域名都没有时是 false，此时不该去改文件）
function computeBlock(originalText, domains) {
  const src = typeof originalText === 'string' ? originalText : '';
  const list = Array.isArray(domains) ? domains : [];
  const newText = hosts.applyBlock(src, list);
  return {
    newText,
    restoreText: hosts.removeBlock(newText),
    changed: newText !== src,
  };
}

// hosts 里有没有上次留下的残留。
//   dirty       = 有我们的标记块
//   domains     = 残留块里挡着哪些域名（好告诉主人「上次挡的是这些」）
//   interrupted = 残留 + 还有一个「进行中」的会话 → 说明是**中断**了
//                 （不是正常结束没清干净），主人可能还等着继续
function residueOf(text, running) {
  const src = typeof text === 'string' ? text : '';
  if (!src || !hosts.hasBlock(src)) {
    return { dirty: false, domains: [], interrupted: false, restoreText: null };
  }
  return {
    dirty: true,
    domains: hosts.blockedDomains(src),
    interrupted: !!running,
    restoreText: hosts.removeBlock(src),
  };
}

// 组装「开始专注」的计划文件（mode = session：备份 → 写 → 循环 → 还原）
function buildPlan({ session, originalText, domains, exes, paths, now }) {
  const { newText, restoreText } = computeBlock(originalText, domains);
  return elevator.makePlan({
    mode: 'session',
    sid: session && session.sid,
    hostsText: newText,
    restoreText,
    exes,
    endsAt: session && session.endsAt,
    now,
  }, paths);
}

// 组装「清残留」的计划文件（mode = restore：只写一次干净内容就退出）。
// ★ 这里**绝不能**用 session 模式：session 模式会先备份当前 hosts ——
//   而当前 hosts 正是脏的那份，备份下来就成了「把脏的当原始内容」，
//   最后还原时又把它写回去了，白忙一场。
function buildRestorePlan({ restoreText, paths, now }) {
  return elevator.makePlan({
    mode: 'restore',
    sid: `residue-${now}`,
    hostsText: restoreText,
    restoreText: null,
    exes: [],
    // restore 模式不看结束时间，但计划校验要求它非 0，给个能过校验的值
    endsAt: now + 60000,
    now,
  }, paths);
}

module.exports = {
  readHostsText,
  readError,
  explainReadError,
  writeHostsText,
  computeBlock,
  residueOf,
  buildPlan,
  buildRestorePlan,
};
