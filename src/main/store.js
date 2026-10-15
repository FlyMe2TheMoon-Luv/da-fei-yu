// src/main/store.js
// 本地数据读写。
//
// 硬性约定（CLAUDE.md 第 6 条）：用户数据一律放 app.getPath('userData')，
// **绝不写程序目录** —— 打包后程序目录是只读的，写进去会直接报错。
//
// 存的是 JSON，读取失败一律返回兜底值，不让程序因为一个坏文件起不来。
//
// ── 为什么 baseDir 是「用到才解析」 ──
//   原来文件顶部就 `require('electron')`，于是普通 Node（自检）里根本
//   require 不了本文件 —— 结果这个「存着用户全部数据」的模块长期没有自检
//   （focus/store.js 顶部那条「别拿它写单测」的注释就是这么来的）。
//   改成延迟解析 + 允许注入目录之后，scripts/test-store.js 就能在临时目录上
//   真跑一遍读 / 写 / 坏文件 / 原子写。接口没变（read / write / fileOf）。

const fs = require('fs');
const path = require('path');

// 仅供自检使用：把读写目录指到临时目录。传 null / undefined 恢复默认。
// 生产代码**永远不该**调它。
let injectedBaseDir = null;

function setBaseDir(dir) {
  injectedBaseDir = dir || null;
}

function baseDir() {
  if (injectedBaseDir) return injectedBaseDir;
  // 延迟 require：只有真的要用目录时，才去问 electron。
  const { app } = require('electron');
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('[store] 拿不到 userData 目录（既不在 Electron 里，也没注入 baseDir）');
  }
  return app.getPath('userData');
}

function fileOf(name) {
  return path.join(baseDir(), name);
}

// 读 JSON；文件不存在 / 内容坏了 / 权限不够，都返回 fallback
function read(name, fallback = null) {
  try {
    const text = fs.readFileSync(fileOf(name), 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// 写 JSON（先写临时文件再改名，避免写一半断电留下坏文件）
function write(name, data) {
  const target = fileOf(name);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.error('[store] 写入失败', name, err.message);
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓 */ }
    return false;
  }
}

module.exports = { read, write, fileOf, setBaseDir };
