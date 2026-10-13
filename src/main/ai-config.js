// src/main/ai-config.js
// Task 9 · 云端 AI 配置存取
//
// 存 userData/ai-config.json，绝不写程序目录。
// 读失败返回默认值，不抛异常。

const fs = require('fs');
const path = require('path');

function userDataDir() {
  if (process.env.PET_USERDATA) return process.env.PET_USERDATA;
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(__dirname, '..', '..', 'tmp');
  }
}

function filePath() {
  return path.join(userDataDir(), 'ai-config.json');
}

function read() {
  try {
    const text = fs.readFileSync(filePath(), 'utf8');
    const raw = JSON.parse(text);
    return {
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      enabled: Boolean(raw.enabled),
    };
  } catch {
    return { baseUrl: '', apiKey: '', model: '', enabled: false };
  }
}

function write(cfg) {
  const target = filePath();
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.error('[ai-config] 写入失败', err.message);
    try { fs.unlinkSync(tmp); } catch { /* 无所谓 */ }
    return false;
  }
}

function maskKey(key) {
  if (!key) return '（没填）';
  if (key.length <= 10) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

module.exports = { read, write, maskKey };
