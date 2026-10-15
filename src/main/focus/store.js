// src/main/focus/store.js
// 专注模式的数据读写（黑名单 / 时长预设 / 当前专注会话）。
//
// ── 为什么这么薄 ──
//   真正「合并默认值 + 挡掉危险项」的纯逻辑全在 blacklist.js 的 withDefaults 里，
//   那边能脱离 Electron 单测（scripts/test-focus-blacklist.js）。
//   本文件只负责「读 / 写 userData/focus.json」这一件事。
//
// ⚠ 本文件本身很薄，没单独写单测 —— 值得测的「合并默认值 + 挡危险项」
//   已经在 blacklist.js 里测过了；底下 store.js 的读 / 写 / 兜底 / 原子写
//   由 scripts/test-store.js 覆盖（批次 4-a 起 store.js 能在普通 Node 里跑了）。
//
// 用户数据一律放 app.getPath('userData')，绝不写程序目录（CLAUDE.md 硬性约定 3）。

const store = require('../store');
const { withDefaults } = require('./blacklist');

const FILE = 'focus.json';

// 读：文件不存在 / 内容坏了 / 字段缺了，一律回落到能用的默认配置。
// 永远返回一个对象，绝不返回 null。
function read() {
  return withDefaults(store.read(FILE, null));
}

// 写：先过一遍 withDefaults 再落盘 —— 等于最后一道安全网，
// 就算调用方不小心把 electron.exe 塞进来，也不会写进文件。
function write(cfg) {
  return store.write(FILE, withDefaults(cfg));
}

module.exports = { read, write, FILE };
