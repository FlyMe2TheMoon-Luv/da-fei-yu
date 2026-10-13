// src/main/brain/cloud.js
// Task 9 · 云端大脑：OpenAI 兼容请求 + 回复解析
//
// 原则：
// 1. 绝不抛异常 —— 任何错误都包成 { error: '人话原因' } 返回。
// 2. 错误消息里绝不带 apiKey（脱敏处理）。
// 3. 回复解析只做「剥围栏 → 找 JSON → 取字段」，不做校验。
//    校验统一在 schedules.sanitize，这是硬性约定。

const TIMEOUT_MS = 15000;

let config = { baseUrl: '', apiKey: '', model: '', timeoutMs: TIMEOUT_MS };

function configure({ baseUrl, apiKey, model, timeoutMs }) {
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (model !== undefined) config.model = model;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
}

function isConfigured() {
  return Boolean(config.baseUrl && config.apiKey);
}

// 简单掩码（不依赖 ai-config.js，避免循环引入风险）
function maskKey(key) {
  if (!key) return '（没填）';
  if (key.length <= 10) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

// 剥掉 ```json 围栏，从第一个 { 到最后一个 } 截出来解析
function extractReply(raw) {
  const text = String(raw).trim();

  // 剥代码围栏
  let inner = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) inner = fenceMatch[1].trim();

  // 找 JSON 对象
  const jsonMatch = inner.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { reply: text, draft: null };
  }

  try {
    const obj = JSON.parse(jsonMatch[0]);
    return {
      reply: String(obj.reply || text),
      draft: obj.schedule || null,
    };
  } catch {
    return { reply: text, draft: null };
  }
}

function buildSystemPrompt(ctx) {
  const now = ctx && ctx.now ? ctx.now : new Date();
  const items = ctx && Array.isArray(ctx.items) ? ctx.items : [];
  const titles = items.map((it) => it.title).join('、');
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return `你是大肥鱼，一只软萌的桌面宠物。主人正在跟你聊天。
当前时间：${date} ${time}
主人已有的日程：${titles || '（暂无）'}

如果主人想加日程，请只输出一个 JSON 对象：
{"reply":"给主人看的话","schedule":{"title":"事情","kind":"point","time":"HH:mm","endTime":null,"repeat":"once","date":"YYYY-MM-DD","weekdays":[]}}

如果听不出要加什么，schedule 设为 null。不知道就 null，绝对不要编时间。`;
}

async function respond(text, ctx) {
  if (!isConfigured()) {
    return { error: '云端 AI 还没配置好' };
  }

  const url = `${config.baseUrl}/chat/completions`.replace(/\/+/g, '/').replace(':/', '://');
  const systemPrompt = buildSystemPrompt(ctx);

  const body = {
    model: config.model || 'default',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!res.ok) {
      return { error: `云端出错了（${res.status}），等下再试吧` };
    }

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      // 返回的不是 JSON → 整段当 reply
      return { reply: rawText, draft: null };
    }
    const rawContent = data.choices?.[0]?.message?.content || '';
    return extractReply(rawContent);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { error: '云端连不上，可能网络有点卡' };
    }
    // 绝不泄漏 apiKey
    let msg = err.message || '未知错误';
    if (config.apiKey) msg = msg.replaceAll(config.apiKey, maskKey(config.apiKey));
    return { error: `请求失败：${msg}` };
  }
}

module.exports = { configure, isConfigured, respond, extractReply, TIMEOUT_MS };
