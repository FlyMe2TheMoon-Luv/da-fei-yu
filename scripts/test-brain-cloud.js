// scripts/test-brain-cloud.js
// Task 9 · 云端大脑自检
//
// 用法：npm run test:brain-cloud
//
// 起一台假 HTTP 服务器当对照，验证请求/解析/超时/错误处理。

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negPass = 0;
let negFail = 0;
function ok(cond, label, isNeg = false) {
  if (cond) {
    pass++;
    if (isNeg) negPass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    if (isNeg) negFail++;
    console.log(`  ✗ ${label}  ← 失败`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ---------- 假服务器 ----------
let server = null;
let serverPort = 0;
let lastRequestBody = null;

function startServer(handler) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = body; }
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });
}

// ---------- 模块 ----------
// 延迟 require，等服务器起来后再配
let cloud;
let aiConfig;

// ---------- 用例 ----------
async function run() {
  cloud = require('../src/main/brain/cloud');
  aiConfig = require('../src/main/ai-config');

  // ① 正常：假服务器返回合法 JSON
  section('① 正常响应');
  await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: '好呀',
            schedule: { title: '收衣服', kind: 'point', time: '15:42', endTime: null, repeat: 'once', date: '2026-10-12', weekdays: [] },
          }),
        },
      }],
    }));
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 5000 });
  const r1 = await cloud.respond('30分钟后提醒我收衣服', { now: new Date(), items: [] });
  ok(!r1.error, '没有 error');
  ok(r1.reply === '好呀', 'reply = 好呀');
  ok(r1.draft && r1.draft.title === '收衣服', 'draft.title = 收衣服');
  await stopServer();

  // ② 负对照：HTTP 500 → 不抛异常，返回 error
  section('② HTTP 500（负对照）');
  await startServer((req, res) => {
    res.writeHead(500);
    res.end('Internal Server Error');
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 5000 });
  const r2 = await cloud.respond('随便说点什么', { now: new Date(), items: [] });
  ok(r2.error !== undefined, '返回了 error 字段', true);
  ok(!r2.reply, '没有 reply');
  await stopServer();

  // ③ 负对照：超时
  section('③ 超时（负对照）');
  await startServer((req, res) => {
    // 故意不响应
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 300 });
  const t0 = Date.now();
  const r3 = await cloud.respond('随便说', { now: new Date(), items: [] });
  const dt = Date.now() - t0;
  ok(r3.error !== undefined, '超时后返回 error', true);
  ok(dt < 1200, `必须在 2 秒内返回（实际 ${dt}ms）`, true);
  await stopServer();

  // ④ 负对照：非 JSON 响应
  section('④ 非 JSON 响应（负对照）');
  await startServer((req, res) => {
    res.writeHead(200);
    res.end('抱歉我不会');
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 5000 });
  const r4 = await cloud.respond('随便说', { now: new Date(), items: [] });
  ok(r4.reply === '抱歉我不会', '整段文本当 reply');
  ok(r4.draft === null, 'draft 为 null', true);
  await stopServer();

  // ⑤ 负对照：```json 围栏
  section('⑤ 代码围栏 JSON（负对照）');
  await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({
      choices: [{ message: { content: '```json\n{"reply":"知道了","schedule":null}\n```' } }],
    }));
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 5000 });
  const r5 = await cloud.respond('随便说', { now: new Date(), items: [] });
  ok(r5.reply === '知道了', '剥掉围栏后解析成功');
  await stopServer();

  // ⑥ 负对照：幻觉草案（time=25:00）→ extractReply 照样递出来，由路由层挡
  section('⑥ 幻觉草案（负对照）');
  await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reply: '好', schedule: { title: 'x', kind: 'point', time: '25:00', repeat: 'once', date: '2026-10-12' } }) } }],
    }));
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-test', model: 'test', timeoutMs: 5000 });
  const r6 = await cloud.respond('x', { now: new Date(), items: [] });
  ok(r6.draft !== null, 'draft 非 null（由路由层负责挡，这里只断言原样递出）', true);
  await stopServer();

  // ⑦ 负对照：Key 泄漏
  section('⑦ Key 不泄漏（负对照）');
  const logs = [];
  const origError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'hi', schedule: null }) } }] }));
  });
  cloud.configure({ baseUrl: `http://127.0.0.1:${serverPort}/v1`, apiKey: 'sk-SECRET-1234', model: 'test', timeoutMs: 5000 });
  const r7 = await cloud.respond('hi', { now: new Date(), items: [] });
  console.error = origError;
  const allText = JSON.stringify(r7) + '\n' + logs.join('\n');
  ok(!allText.includes('SECRET'), '返回值和日志里都不出现 SECRET', true);
  await stopServer();

  // ⑧ maskKey
  section('⑧ maskKey');
  ok(aiConfig.maskKey('sk-1234567890abcd') === 'sk-****abcd', 'maskKey 正确');
  ok(aiConfig.maskKey('') === '（没填）', '空串 mask');
  ok(aiConfig.maskKey('short') === '****', '短串全掩');

  // ⑨ ai-config 读写 + 坏文件兜底
  section('⑨ ai-config 读写 + 坏文件兜底');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ai-test-'));
  const origUserData = process.env.PET_USERDATA;
  process.env.PET_USERDATA = tmpDir;
  // 清掉 require 缓存，让 ai-config 读到新目录
  delete require.cache[require.resolve('../src/main/ai-config')];
  const cfgMod = require('../src/main/ai-config');
  const ok1 = cfgMod.write({ baseUrl: 'http://test', apiKey: 'sk-xxx', model: 'm', enabled: true });
  ok(ok1, 'write 成功');
  const rCfg = cfgMod.read();
  ok(rCfg.baseUrl === 'http://test' && rCfg.apiKey === 'sk-xxx' && rCfg.model === 'm' && rCfg.enabled === true, 'read 出来一致');
  // 写坏文件
  fs.writeFileSync(path.join(tmpDir, 'ai-config.json'), '{oops');
  delete require.cache[require.resolve('../src/main/ai-config')];
  const cfgMod2 = require('../src/main/ai-config');
  const rCfg2 = cfgMod2.read();
  ok(rCfg2.baseUrl === '' && rCfg2.apiKey === '' && rCfg2.model === '' && rCfg2.enabled === false, '坏文件返回默认值，不抛异常', true);
  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origUserData !== undefined) process.env.PET_USERDATA = origUserData;
  else delete process.env.PET_USERDATA;

  // ---------- 收尾 ----------
  console.log(`\n===== 云端大脑自检结束：${pass} 通过 / ${fail} 失败 =====`);
  console.log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('自检异常：', err && err.message);
  process.exit(1);
});
