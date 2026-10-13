// src/main/brain/local.js
// Task 8 · 本地大脑：台词库 + 加日程/查日程/闲聊 三种意图
//
// 原则：本地永远可用、0 延迟、比 AI 更准（因为格式是死的）。

const { parseSchedule } = require('../nl-time');
const { localDateKey } = require('../schedules');

// ---------- 台词库 ----------
// 按关键词分组；匹配不到任何关键词时，fallback 用「日常」组。
const PERSONA = {
  打招呼: [
    '嗨～主人今天心情怎么样呀',
    '在的在的，大肥鱼一直陪着你呢',
    '你好呀，有什么想跟我说的吗',
    '见到主人好开心～',
  ],
  夸她: [
    '嘿嘿，被主人夸了，尾巴都要摇起来啦',
    '主人眼光最好了',
    '大肥鱼会继续保持可爱的',
    '那当然，我可是最乖的',
  ],
  抱怨: [
    '抱抱主人，不开心的话跟我聊聊吧',
    '烦的时候就来戳戳我，我会陪你',
    '深呼吸，大肥鱼也在陪着你呢',
    '主人辛苦了，休息一下好不好',
  ],
  累了: [
    '困了就眯一会儿吧，我帮你守着',
    '累了就休息，不要硬撑哦',
    '要不要我提醒你早点睡呀',
    '主人的健康最重要，快去休息',
  ],
  晚安: [
    '晚安主人，做个好梦呀',
    '睡吧睡吧，明天见～',
    '好梦，大肥鱼也在梦里陪你',
    '早点休息，主人晚安',
  ],
  饿了: [
    '饿了就去吃点好吃的，不要饿着肚子',
    '要不要我提醒你按时吃饭呀',
    '吃点东西才有力气干活哦',
    '主人想吃什么，我虽然不能做饭但可以陪你',
  ],
  不知道: [
    '大肥鱼没听懂呢，换个说法试试？',
    '这个我也不知道，主人教教我好不好',
    '唔……没太明白，再说一次嘛',
    '我还在学习中，这句话暂时没听懂',
  ],
  日常: [
    '嗯嗯，我在听呢',
    '大肥鱼一直陪着主人',
    '有什么想跟我说的吗',
    '我在呢，随时待命～',
  ],
};

const KEYWORDS = {
  打招呼: /你好|嗨|在吗|在嘛|hello|hi|你好呀/,
  夸她: /可爱|好看|乖|棒|厉害|漂亮|聪明/,
  抱怨: /烦|累|不想|讨厌|郁闷|难受|生气/,
  累了: /困|睡|休息|好累|疲倦|想睡/,
  晚安: /晚安|睡觉|睡了|再见|拜拜| bedtime/,
  饿了: /饿|吃|饭|零食|夜宵|好吃/,
  不知道: /什么|怎么|为什么|不懂|不会|啥/,
};

// ---------- 触发词 ----------
const TRIGGER_RE = /提醒我|叫我|帮我记|记得|别忘/;

// ---------- 查询日程 ----------

function listToday(items, now) {
  const today = localDateKey(now);
  const dow = now.getDay();
  return items.filter((it) => {
    if (!it.enabled) return false;
    if (it.repeat === 'once') return it.date === today;
    if (it.repeat === 'daily') return true;
    if (it.repeat === 'weekdays') return dow >= 1 && dow <= 5;
    if (it.repeat === 'weekly') return Array.isArray(it.weekdays) && it.weekdays.includes(dow);
    return false;
  });
}

function formatList(items) {
  if (items.length === 0) return '今天没什么安排，可以躺平～';
  const lines = items.map((it) => {
    const t = it.kind === 'span' && it.endTime
      ? `${it.time}–${it.endTime}`
      : it.time;
    return `· ${it.title}（${t}）`;
  });
  return `今天有 ${items.length} 件事：\n${lines.join('\n')}`;
}

// ---------- 时间描述 ----------

function describeWhen(draft, now) {
  const today = localDateKey(now);
  let dateText = '';
  if (draft.repeat === 'once') {
    if (draft.date === today) dateText = '今天';
    else if (draft.date === localDateKey(new Date(now.getTime() + 86400000))) dateText = '明天';
    else if (draft.date === localDateKey(new Date(now.getTime() + 172800000))) dateText = '后天';
    else dateText = draft.date;
  } else if (draft.repeat === 'daily') {
    dateText = '每天';
  } else if (draft.repeat === 'weekdays') {
    dateText = '工作日';
  } else if (draft.repeat === 'weekly') {
    const map = ['日', '一', '二', '三', '四', '五', '六'];
    const days = draft.weekdays.map((d) => map[d]).join('');
    dateText = `每周${days}`;
  }

  const timeText = draft.kind === 'span' && draft.endTime
    ? `${draft.time}–${draft.endTime}`
    : draft.time;

  return `${dateText} ${timeText}`;
}

// ---------- 主入口 ----------

function respond(text, ctx, rand = Math.random) {
  if (!text || typeof text !== 'string') {
    return { reply: '大肥鱼没听清呢', draft: null, intent: 'chat', confidence: 'low' };
  }
  const t = text.trim();
  if (!t) {
    return { reply: '大肥鱼没听清呢', draft: null, intent: 'chat', confidence: 'low' };
  }

  const now = ctx && ctx.now ? ctx.now : new Date();
  const items = ctx && Array.isArray(ctx.items) ? ctx.items : [];

  // ① 解析出日程 → 加日程
  const draft = parseSchedule(t, now);
  if (draft) {
    const when = describeWhen(draft, now);
    return {
      reply: `好，我 ${when} 提醒你${draft.title}`,
      draft,
      intent: 'add',
      confidence: draft.confidence || 'high',
    };
  }

  // ② 有触发词但没解析出时刻 → 反问
  if (TRIGGER_RE.test(t)) {
    return {
      reply: '几点提醒你呀？你可以说「30分钟后提醒我收衣服」',
      draft: null,
      intent: 'add',
      confidence: 'low',
    };
  }

  // ③ 问日程
  if (/今天|明天|后天|日程|安排|什么事|有什么/.test(t)) {
    const todayItems = listToday(items, now);
    return {
      reply: formatList(todayItems),
      draft: null,
      intent: 'list',
      confidence: 'high',
    };
  }

  // ④ 闲聊 → 台词库
  let group = '日常';
  for (const [name, re] of Object.entries(KEYWORDS)) {
    if (re.test(t)) {
      group = name;
      break;
    }
  }
  const lines = PERSONA[group] || PERSONA['日常'];
  const idx = Math.floor(rand() * lines.length);
  return {
    reply: lines[idx],
    draft: null,
    intent: 'chat',
    confidence: 'low',
  };
}

module.exports = { respond, PERSONA };
