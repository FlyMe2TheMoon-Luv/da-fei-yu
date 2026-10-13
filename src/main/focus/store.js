// src/main/focus/store.js
// 专注模式的数据读写（黑名单 / 时长预设 / 当前专注会话）。
//
// ── 为什么这么薄 ──
//   真正「合并默认值 + 挡掉危险项」的纯逻辑全在 blacklist.js 的 withDefaults 里，
//   那边能脱离 Electron 单测（scripts/test-focus-blacklist.js）。
//   本文件只负责「读 / 写 userData/focus.json」这一件事。
//
// ⚠ 本文件 require 了 ../store（它 require('electron')），
//   所以普通 Node 里跑不起来 —— 别拿它写单测。
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
