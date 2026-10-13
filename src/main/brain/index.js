// src/main/brain/index.js
// Task 10 · 大脑路由器：本地优先、云端兜底、失败降级
//
// 路由顺序（写死在注释里，不能换）：
// 1. 本地高置信命中 → 直接返回，不问云端（0 延迟、离线可用）。
// 2. 否则若云端已配置且启用 → 问云端。
//    拿到 draft 后**必须**过 schedules.sanitize()：
//    - 通过 → 用 sanitize 洗过的结果（不是原始草案）
//    - 不通过 → draft = null、rejected = 原因，只回文字
// 3. 云端没配 / 超时 / 报错 / 草案被拒 → 退回本地大脑。
//    若本地也听不出日程，就给一句台词 + note。

const local = require('./local');
const cloud = require('./cloud');
const schedules = require('../schedules');
const aiConfig = require('../ai-config');

let state = {
  getItems: () => [],
  getConfig: () => aiConfig.read(),
  localBrain: local,
  cloudBrain: cloud,
};

function init({ getItems, getConfig, localBrain, cloudBrain }) {
  if (getItems) state.getItems = getItems;
  if (getConfig) state.getConfig = getConfig;
  if (localBrain) state.localBrain = localBrain;
  if (cloudBrain) state.cloudBrain = cloudBrain;
}

function fallbackToLocal(localResult, note) {
  // 本地结果里的 draft 如果存在，也过一遍 sanitize（防御性）
  let draft = null;
  if (localResult.draft) {
    const s = schedules.sanitize(localResult.draft);
    if (s.ok) draft = s.item;
  }
  return {
    reply: localResult.reply,
    draft,
    source: 'local',
    note: note || null,
    rejected: null,
  };
}

async function respond(text, now = new Date()) {
  const items = state.getItems();
  const config = state.getConfig();
  const localBrain = state.localBrain;
  const cloudBrain = state.cloudBrain;

  // ① 本地先试一试
  const localResult = localBrain.respond(text, { now, items });

  // 本地高置信命中 → 直接返回
  if (localResult.draft && localResult.confidence === 'high') {
    const s = schedules.sanitize(localResult.draft);
    if (s.ok) {
      return {
        reply: localResult.reply,
        draft: s.item,
        source: 'local',
        note: null,
        rejected: null,
      };
    }
    // 高置信却 sanitize 不过（理论上不该发生），降级处理
    return {
      reply: localResult.reply,
      draft: null,
      source: 'local',
      note: null,
      rejected: s.error,
    };
  }

  // ② 云端兜底
  if (config.enabled && cloudBrain.isConfigured()) {
    try {
      cloudBrain.configure({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      });
      const cloudResult = await cloudBrain.respond(text, { now, items });

      if (cloudResult.error) {
        return fallbackToLocal(localResult, '云端暂时用不了，先用本地模式回你');
      }

      if (cloudResult.draft) {
        const s = schedules.sanitize(cloudResult.draft);
        if (s.ok) {
          return {
            reply: cloudResult.reply,
            draft: s.item,
            source: 'cloud',
            note: null,
            rejected: null,
          };
        }
        // 草案被校验拒掉
        return {
          reply: cloudResult.reply,
          draft: null,
          source: 'cloud',
          note: null,
          rejected: s.error,
        };
      }

      // 云端没给草案，但回复可用
      return {
        reply: cloudResult.reply,
        draft: null,
        source: 'cloud',
        note: null,
        rejected: null,
      };
    } catch {
      // 任何异常都降级，绝不抛给界面
      return fallbackToLocal(localResult, '云端出了点问题，先用本地模式回你');
    }
  }

  // ③ 没配云端 → 纯本地
  return fallbackToLocal(localResult, null);
}

module.exports = { init, respond };
