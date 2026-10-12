// src/main/store.js
// 本地数据读写。
//
// 硬性约定（CLAUDE.md 第 6 条）：用户数据一律放 app.getPath('userData')，
// **绝不写程序目录** —— 打包后程序目录是只读的，写进去会直接报错。
//
// 存的是 JSON，读取失败一律返回兜底值，不让程序因为一个坏文件起不来。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function fileOf(name) {
  return path.join(app.getPath('userData'), name);
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

module.exports = { read, write, fileOf };
