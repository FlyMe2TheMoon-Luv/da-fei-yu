// src/main/nl-time.js
// Task 7 · 中文大白话 → 日程草案
//
// 纯函数、不 require electron，Node 可直接单测。
// 原则：听不出「日程」就返回 null —— 宁可什么都不做，也不能瞎猜。

const { localDateKey } = require('./schedules');

// ---------- 小工具 ----------

function fmt(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function validTime(h, m) {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// 中文数字 → 阿拉伯数字（只处理 0–24，够用即可）
const CN = {
  '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
  '十六': 16, '十七': 17, '十八': 18, '十九': 19,
  '二十': 20, '二十一': 21, '二十二': 22, '二十三': 23, '二十四': 24,
};

function cnNum(s) {
  if (!s) return NaN;
  s = s.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (CN[s] !== undefined) return CN[s];
  // 十三、二十三……
  if (s.startsWith('十')) {
    const u = s.slice(1);
    return 10 + (CN[u] || 0);
  }
  if (s.endsWith('十')) {
    const t = s.slice(0, -1);
    return (CN[t] || 0) * 10;
  }
  if (s.includes('十')) {
    const [t, u] = s.split('十');
    return (CN[t] || 0) * 10 + (CN[u] || 0);
  }
  return NaN;
}

// 把「早上/上午/中午/下午/晚上」+ 小时 转成 24 小时制
function applyAmpm(h, ampm) {
  if (!ampm) return h;
  if (ampm.includes('下午') || ampm.includes('晚上')) {
    if (h >= 1 && h <= 11) return h + 12;
  }
  if (ampm.includes('中午')) {
    if (h === 12) return 12;
  }
  // 早上/上午 或 无前缀：1–11 不变，12 不变
  return h;
}

function parseClock(hourStr, minuteStr, ampm) {
  let h = cnNum(hourStr);
  if (isNaN(h) || h < 0 || h > 23) return null;

  let m = 0;
  if (minuteStr === '半') {
    m = 30;
  } else if (minuteStr) {
    m = cnNum(minuteStr);
    if (isNaN(m) || m < 0 || m > 59) return null;
  }

  h = applyAmpm(h, ampm);
  if (!validTime(h, m)) return null;
  return { h, m };
}

// ---------- 触发词 ----------
// 有这些词 + 时间信息，才认为是「要建日程」
const TRIGGER_RE = /提醒我|叫我|帮我记|记得|别忘/;

function hasTrigger(text) {
  return TRIGGER_RE.test(text);
}

// ---------- 日期词 ----------

function dateFromWord(w, now) {
  if (w === '明天') return addDays(now, 1);
  if (w === '后天') return addDays(now, 2);
  return now; // 今天 或 默认
}

// ---------- 重复规则 ----------

function extractRepeat(text) {
  if (/每\s*天/.test(text)) return { repeat: 'daily', weekdays: [] };
  if (/工作\s*日/.test(text)) return { repeat: 'weekdays', weekdays: [] };
  const m = text.match(/每\s*周\s*([一二三四五六日天七]+)/);
  if (m) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '七': 0 };
    const days = [];
    for (const c of m[1]) {
      if (map[c] !== undefined && !days.includes(map[c])) days.push(map[c]);
    }
    return { repeat: 'weekly', weekdays: days.sort((a, b) => a - b) };
  }
  return { repeat: 'once', weekdays: [] };
}

// ---------- 剥标题 ----------

function cleanTitle(s) {
  s = s.replace(/^[,，、\s]+|[,，、\s]+$/g, '');
  // ① 去掉重复关键词（它们不该进标题）
  let t = s.replace(/^(每天|工作日|每周[一二三四五六日天七\s,，、]+)[,，、\s]*/, '')
           .replace(/[,，、\s]*(每天|工作日|每周[一二三四五六日天七\s,，、]+)$/, '');
  s = t || s;
  // ② 去掉时间前缀（早上/上午/下午/晚上/中午）
  t = s.replace(/^(早上|上午|下午|晚上|中午)[,，、\s]*/, '')
       .replace(/[,，、\s]*(早上|上午|下午|晚上|中午)$/, '');
  s = t || s;
  // ③ 去掉触发词；去掉后若为空则保留原文
  t = s.replace(/^(提醒我|帮我记|记得|别忘)[吧啊呢呀]*[,，、\s]*/, '')
       .replace(/[,，、\s]*[吧啊呢呀]*(提醒我|帮我记|记得|别忘)$/, '');
  s = t || s;
  s = s.trim();
  // 如果剥完只剩空，给个兜底
  return s || '提醒';
}

// 从原文里剪掉匹配到的子串，剩下当标题
function extractTitle(text, matched) {
  const idx = text.indexOf(matched);
  if (idx === -1) return cleanTitle(text);
  const before = text.slice(0, idx);
  const after = text.slice(idx + matched.length);
  return cleanTitle(before + after);
}

// ---------- 相对时间 ----------

function tryRelative(text, now) {
  // 30分钟后 / 两个小时后 / 半小时后 / 一个半小时后 / 两小时后
  const re = /(\d+|半|一个半|两)\s*个?(分钟?|小时?)后/;
  const m = text.match(re);
  if (!m) return null;

  let minutes = 0;
  const amt = m[1];
  const unit = m[2];

  if (amt === '半') {
    minutes = 30;
  } else if (amt === '一个半') {
    minutes = unit.includes('小时') ? 90 : 30;
  } else if (amt === '两') {
    minutes = unit.includes('小时') ? 120 : 2;
  } else {
    minutes = parseInt(amt, 10);
    if (unit.includes('小时')) minutes *= 60;
  }

  if (minutes <= 0) return null; // 0 分钟后不算日程

  const totalMin = now.getHours() * 60 + now.getMinutes() + minutes;
  const crossed = totalMin >= 24 * 60;
  const h = Math.floor(totalMin / 60) % 24;
  const min = totalMin % 60;
  const date = crossed ? addDays(now, 1) : now;

  const title = extractTitle(text, m[0]);
  return {
    title,
    kind: 'point',
    time: fmt(h, min),
    endTime: null,
    repeat: 'once',
    date: localDateKey(date),
    weekdays: [],
    confidence: 'high',
    matched: m[0],
  };
}

// ---------- 时段（span） ----------

function trySpan(text, now) {
  // ① 数字格式：9:00-11:00
  const digRe = /(\d{1,2})[:：](\d{2})\s*[-~到]\s*(\d{1,2})[:：](\d{2})/;
  let dm = text.match(digRe);
  if (dm) {
    const sh = parseInt(dm[1], 10), sm = parseInt(dm[2], 10);
    const eh = parseInt(dm[3], 10), em = parseInt(dm[4], 10);
    if (!validTime(sh, sm) || !validTime(eh, em)) return null;
    if (eh * 60 + em <= sh * 60 + sm) return null;

    const title = extractTitle(text, dm[0]);
    return {
      title,
      kind: 'span',
      time: fmt(sh, sm),
      endTime: fmt(eh, em),
      repeat: 'once',
      date: localDateKey(now),
      weekdays: [],
      confidence: 'high',
      matched: dm[0],
    };
  }

  // ② 中文格式：明天下午2点到4点 / 上午9点到11点半
  //    (日期前缀)? (上午/下午)? 几点 (半/几分)? 到 (上午/下午)? 几点 (半/几分)?
  const cnRe = /(?:(今天|明天|后天)\s*)?(?:(早上|上午|中午|下午|晚上)\s*)?([一二三四五六七八九十\d]+)\s*点\s*(半|(?:([一二三四五六七八九十\d]+)\s*分?))?\s*(?:到|~|-)\s*(?:(早上|上午|中午|下午|晚上)\s*)?([一二三四五六七八九十\d]+)\s*点\s*(半|(?:([一二三四五六七八九十\d]+)\s*分?))?/;
  const m = text.match(cnRe);
  if (!m) return null;

  let s = parseClock(m[3], m[4] || m[5], m[2]);
  let e = parseClock(m[7], m[8] || m[9], m[6]);
  if (!s || !e) return null;
  // 结束时间没写上下午，但开始写了，且按上午算导致结束 <= 开始 →
  // 合理推断结束也是同一段（例：下午2点到4点）
  if (!m[6] && m[2] && e.h * 60 + e.m <= s.h * 60 + s.m) {
    const e2 = parseClock(m[7], m[8] || m[9], m[2]);
    if (e2) e = e2;
  }
  if (e.h * 60 + e.m <= s.h * 60 + s.m) return null;

  const dateWord = m[1];
  const date = dateWord ? dateFromWord(dateWord, now) : now;
  const title = extractTitle(text, m[0]);

  return {
    title,
    kind: 'span',
    time: fmt(s.h, s.m),
    endTime: fmt(e.h, e.m),
    repeat: 'once',
    date: localDateKey(date),
    weekdays: [],
    confidence: 'high',
    matched: m[0],
  };
}

// ---------- 绝对时间（point） ----------

function tryAbsolute(text, now) {
  const rep = extractRepeat(text);

  // ① 数字格式：15:30
  const digRe = /(\d{1,2})[:：](\d{2})/;
  const dm = text.match(digRe);
  if (dm) {
    const h = parseInt(dm[1], 10), m = parseInt(dm[2], 10);
    if (!validTime(h, m)) return null;

    const date = /明天/.test(text) ? addDays(now, 1)
      : /后天/.test(text) ? addDays(now, 2)
      : now;
    const title = extractTitle(text, dm[0]);
    return {
      title,
      kind: 'point',
      time: fmt(h, m),
      endTime: null,
      repeat: rep.repeat,
      date: rep.repeat === 'once' ? localDateKey(date) : null,
      weekdays: rep.weekdays,
      confidence: 'high',
      matched: dm[0],
    };
  }

  // ② 中文格式：(今天/明天/后天)? (上午/下午/…)? 几点 (半/几分)?
  const cnRe = /(?:(今天|明天|后天)\s*)?(?:(早上|上午|中午|下午|晚上)\s*)?([一二三四五六七八九十\d]+)\s*点\s*(半|(?:([一二三四五六七八九十\d]+)\s*分?))?/;
  const m = text.match(cnRe);
  if (!m) return null;

  const c = parseClock(m[3], m[4] || m[5], m[2]);
  if (!c) return null;

  // 如果没有触发词、没有日期词、也没有重复词，就不认为是日程
  const dateWord = m[1];
  if (!hasTrigger(text) && !dateWord && rep.repeat === 'once') {
    // 例外：像 "三点" 这种单独时间词，如果没有上下文，不猜
    return null;
  }

  const date = dateWord ? dateFromWord(dateWord, now) : now;
  const title = extractTitle(text, m[0]);

  return {
    title,
    kind: 'point',
    time: fmt(c.h, c.m),
    endTime: null,
    repeat: rep.repeat,
    date: rep.repeat === 'once' ? localDateKey(date) : null,
    weekdays: rep.weekdays,
    confidence: 'high',
    matched: m[0],
  };
}

// ---------- 主入口 ----------

function parseSchedule(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;

  // 顺序：时段（最具体）→ 相对时间 → 绝对时间
  const span = trySpan(t, now);
  if (span) return span;

  const rel = tryRelative(t, now);
  if (rel) return rel;

  const abs = tryAbsolute(t, now);
  if (abs) return abs;

  return null;
}

module.exports = { parseSchedule };
