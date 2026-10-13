// src/main/focus/hosts.js
// 纯函数：对「hosts 文件的内容」做插入 / 更新 / 精确删除标记块。
//
// ── 只做字符串进、字符串出 ──
//   本文件**绝不** fs.readFileSync / writeFileSync —— 读真文件、写真文件是
//   另一层薄壳（focus/index.js）的事。这样这里能跑上百个测试。
//   也刻意不 require('electron')，普通 Node 里就能跑（见 scripts/test-focus-hosts.js）。
//
// ── 唯一的铁律：绝不整文件覆盖 ──
//   hosts 是系统文件，覆盖了会出 DNS 故障。我们只做两件事：
//     插入/更新：把我们那几行包在 BEGIN/END 之间，附在文件末尾
//     删除：    精确删掉 BEGIN..END 之间（含）的内容，其余一字不动
//   保证「删完 == 原文逐字节相等」是这个文件存在的全部意义。
//
// ── 块长这样 ──
//     # === FocusMode BEGIN ===
//     0.0.0.0 bilibili.com
//     0.0.0.0 www.bilibili.com
//     # === FocusMode END ===
//
// ── 行尾风格 ──
//   原来用 CRLF 就还它 CRLF，用 LF 就还它 LF（detectEol）。
//   绝不因为改了 3 行，就把整个文件的行尾都换掉。

const { normalizeDomain } = require('./blacklist');

const BEGIN_MARK = '# === FocusMode BEGIN ===';
const END_MARK = '# === FocusMode END ===';

// 按任意换行风格切行（CRLF / LF / CR 都认），用于「找标记块在哪一行」
function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

// 这份文本用的是哪种换行风格。默认 CRLF（Windows 的 hosts 就是 CRLF）。
function detectEol(text) {
  if (typeof text === 'string' && text.includes('\r\n')) return '\r\n';
  if (typeof text === 'string' && text.includes('\n')) return '\n';
  return '\r\n';
}

// 标记块在不在（BEGIN 行存在就算）
function hasBlock(text) {
  if (typeof text !== 'string' || text === '') return false;
  return splitLines(text).some((l) => l.trim() === BEGIN_MARK);
}

// 找出标记块占用的行区间 [begin, end]（含两端）。
// end === -1 表示「只有 BEGIN 没有 END」= 上次写到一半崩了。
function findBlock(lines) {
  const begin = lines.findIndex((l) => l.trim() === BEGIN_MARK);
  if (begin === -1) return null;
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].trim() === END_MARK) return { begin, end: i };
  }
  return { begin, end: -1 };
}

// 精确删掉标记块（含块内所有行）。
// 没有我们的块时**原样返回** —— 绝不「顺手清理」主人的内容。
function removeBlock(text) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';

  const lines = splitLines(text);
  const found = findBlock(lines);
  if (!found) return text;

  // 半截块（没有 END）→ 从 BEGIN 一直删到文件末尾
  const cutTo = found.end === -1 ? lines.length - 1 : found.end;
  const kept = lines.slice(0, found.begin).concat(lines.slice(cutTo + 1));
  return kept.join(detectEol(text));
}

// 读回当前屏蔽了哪些域名（用于核对「我以为还在专注」）
function blockedDomains(text) {
  if (typeof text !== 'string' || text === '') return [];

  const lines = splitLines(text);
  const found = findBlock(lines);
  if (!found) return [];

  const out = [];
  const stop = found.end === -1 ? lines.length : found.end;
  for (let i = found.begin + 1; i < stop; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue; // 注释行 / 空行不算
    const parts = line.split(/\s+/);
    if (parts.length >= 2) out.push(parts[1]);
  }
  return out;
}

// 把 domains 写进标记块，返回「新的 hosts 全文」。
//   - 已经有块 → 先精确删掉旧块，再写新的（不叠加）
//   - 一个合法域名都没有 → 原样返回（不写空块）
//   - 非法域名 → 跳过（不抛异常），宁可少写一行坏数据
function applyBlock(text, domains) {
  const src = typeof text === 'string' ? text : '';
  const list = Array.isArray(domains) ? domains : [];

  const valid = [];
  const seen = new Set();
  for (const d of list) {
    const r = normalizeDomain(d);
    if (!r.ok) continue;
    if (seen.has(r.value)) continue;
    seen.add(r.value);
    valid.push(r.value);
  }
  if (valid.length === 0) return src;

  // 先清掉旧块（这一步天然处理了「重复插入」和「半截块」）
  let base = removeBlock(src);
  const eol = detectEol(base || src);

  // 保证块从新的一行开始
  if (base !== '' && !base.endsWith(eol)) base += eol;

  const block = [BEGIN_MARK, ...valid.map((d) => `0.0.0.0 ${d}`), END_MARK].join(eol) + eol;
  return base + block;
}

module.exports = {
  BEGIN_MARK,
  END_MARK,
  detectEol,
  hasBlock,
  removeBlock,
  blockedDomains,
  applyBlock,
};
