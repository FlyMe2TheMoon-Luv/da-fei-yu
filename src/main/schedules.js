// src/main/schedules.js
// 阶段 2-1 · 日程数据层
//
// 只干三件事：**校验、增删改查、存盘**。不碰调度（那是 2-2 的 scheduler.js），
// 不碰界面（那是 2-4 的表单窗口）。
//
// 存哪儿：userData/schedules.json（硬性约定第 6 条，绝不写程序目录）
// 存什么（v2：日程分「时间点 / 时段」两类）：
//   {
//     version: 2,
//     items: [
//       {
//         id: "s_1728712345678",       // 时间戳生成，不引 uuid 库
//         title: "开会",
//         kind: "point",               // ★ v2：point（时间点）| span（时段）
//         time: "09:30",               // 本地时间 HH:mm，一律本地，不碰 UTC
//         endTime: null,               // ★ v2：kind=span 时必填且严格晚于 time；
//                                      //        kind=point 时恒为 null
//         repeat: "once",              // once | daily | weekdays | weekly
//         date: "2026-10-13",          // repeat=once 时必填
//         weekdays: [1, 3, 5],         // repeat=weekly 时必填（0=周日）
//         enabled: true,
//         lastFiredDate: null,         // ★ 去重关键：记录「最后一次触发是哪个日期」
//         createdAt: 1728712345678
//       }
//     ]
//   }
//
// v1 → v2 不需要迁移脚本：没有 kind 字段的老记录，读进来自动当成 point
// （见 sanitize 里那行「没给就按时间点」）。
// 时段不允许跨天（endTime 必须严格晚于 time）—— 跨天会让周视图绘制和
// 「提醒在几点」都变复杂，见 PLAN-V2 的决定表。
//
// 设计原则：**坏数据绝不带崩主进程**。
// 文件读坏了 → 当成空的；单条记录坏了 → 丢掉那一条，其余的照常用。

const store = require('./store');

const FILE = 'schedules.json';
const VERSION = 2;

const REPEATS = ['once', 'daily', 'weekdays', 'weekly'];
// v2：日程两种类型。point = 到点提醒一下；span = 占一段时间（只在开始时刻提醒）。
const KINDS = ['point', 'span'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // 00:00 ~ 23:59
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 小工具 ----------

// 本地日期键：YYYY-MM-DD。
// 注意别用 toISOString() —— 那是 UTC，晚上 8 点之后会算成第二天，提醒就串天了。
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isTimeString(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

// 不只是看格式，还要是真实存在的日期（挡掉 2026-02-30 这种）
function isDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// "09:30" → 从今天 0 点起的分钟数（570）。调度引擎算「今天该不该响」会用到。
function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---------- 校验 ----------

// 把一条原始记录洗成规范格式。
// 返回 { ok: true, item } 或 { ok: false, error: '人话原因' }。
// 改动一条时，调用方先把旧值合并进来再调它，所以这里只管「给全了没有 / 合不合法」。
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '日程必须是对象' };

  const out = {};

  // 标题
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return { ok: false, error: '标题不能为空' };
  if (title.length > 100) return { ok: false, error: '标题太长（上限 100 字）' };
  out.title = title;

  // 时间
  if (!isTimeString(raw.time)) return { ok: false, error: '时间格式不对，要 HH:mm，例如 09:30' };
  out.time = raw.time;

  // 类型：没给就按「时间点」—— 这样 v1 的老数据不用迁移脚本，读进来就是合法的 point。
  // 但给了个不认识的（比如 'meeting'）必须报错，绝不能悄悄当 point 收下。
  const rawKind = raw.kind;
  const kind = (rawKind === undefined || rawKind === null || rawKind === '') ? 'point' : rawKind;
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `日程类型只能是 ${KINDS.join(' / ')} 之一` };
  }
  out.kind = kind;

  if (kind === 'point') {
    // 时间点没有「结束时间」这个概念。给了也丢掉，免得留脏数据让周视图画错。
    out.endTime = null;
  } else {
    if (!isTimeString(raw.endTime)) return { ok: false, error: '时段日程要给结束时间，格式 HH:mm' };
    // 不允许相等、不允许跨天：跨天会让周视图和「提醒在几点」都变复杂（见 PLAN-V2 决定表）
    if (minutesOfDay(raw.endTime) <= minutesOfDay(raw.time)) {
      return { ok: false, error: '结束时间要晚于开始时间（暂不支持跨天）' };
    }
    out.endTime = raw.endTime;
  }

  // 重复规则：没给就按「一次性」，给了但不认识 → 直接报错。
  // 必须区分这两种情况 —— 否则「每三天」会被悄悄当成 once，
  // 然后报出「一次性日程要给日期」这种驴唇不对马嘴的提示，让人一头雾水。
  const rawRepeat = raw.repeat;
  const repeat = (rawRepeat === undefined || rawRepeat === null || rawRepeat === '') ? 'once' : rawRepeat;
  if (!REPEATS.includes(repeat)) {
    return { ok: false, error: `重复规则只能是 ${REPEATS.join(' / ')} 之一` };
  }
  out.repeat = repeat;

  // once 必须有日期
  if (repeat === 'once') {
    if (!isDateString(raw.date)) return { ok: false, error: '一次性日程要给日期，格式 YYYY-MM-DD' };
    out.date = raw.date;
    out.weekdays = [];
  } else {
    out.date = null;
    if (repeat === 'weekly') {
      const wd = Array.isArray(raw.weekdays)
        ? [...new Set(raw.weekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
        : [];
      if (!wd.length) return { ok: false, error: '每周重复要选星期几' };
      out.weekdays = wd;
    } else {
      out.weekdays = []; // daily / weekdays 用不上，留空数组，结构统一
    }
  }

  out.enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);

  // lastFiredDate：只认「YYYY-MM-DD」或 null，别的值一律当没触发过（宁可多响一次，不可永久不响）
  out.lastFiredDate = isDateString(raw.lastFiredDate) ? raw.lastFiredDate : null;

  const created = Number(raw.createdAt);
  out.createdAt = Number.isFinite(created) && created > 0 ? created : Date.now();

  // id 由调用方（add/update）保证，这里只做透传校验
  if (typeof raw.id === 'string' && raw.id) out.id = raw.id;

  return { ok: true, item: out };
}

// ---------- 文件读写 ----------

// 读整个文件，顺便把坏数据挡在门外。
// 返回值永远是 { version, items: [] }，绝不抛异常。
function loadAll() {
  const raw = store.read(FILE, null);
  const items = [];
  let dropped = 0;

  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
    const seen = new Set();
    for (const r of raw.items) {
      const res = sanitize(r);
      // id 缺失 / 重复的，重新发一个，别让两条记录共用一个 id
      if (!res.ok) { dropped++; continue; }
      let item = res.item;
      if (!item.id || seen.has(item.id)) item = { ...item, id: nextId(seen) };
      seen.add(item.id);
      items.push(item);
    }
  } else if (raw !== null) {
    console.warn('[schedules] 文件格式不对，已当作空处理');
  }

  if (dropped) console.warn(`[schedules] 有 ${dropped} 条日程数据不合法，已跳过`);

  return { version: VERSION, items };
}

function saveAll(data) {
  return store.write(FILE, { version: VERSION, items: data.items });
}

// 时间戳生成 id，撞了就往后挪 1 毫秒。不引 uuid 库（HANDOFF 明确要求）。
function nextId(existing) {
  let t = Date.now();
  let id = `s_${t}`;
  while (existing && existing.has(id)) id = `s_${++t}`;
  return id;
}

// 按时间排个序，界面上看着顺眼（同时间按创建时间）
function sorted(items) {
  return [...items].sort((a, b) => {
    const d = minutesOfDay(a.time) - minutesOfDay(b.time);
    return d !== 0 ? d : a.createdAt - b.createdAt;
  });
}

// ---------- 对外接口（增删改查）----------

// 全部日程（已排序，副本，改它不会影响文件）
function list() {
  return sorted(loadAll().items);
}

// 取一条，没有就返回 null
function get(id) {
  return loadAll().items.find((it) => it.id === id) || null;
}

// 加一条。成功返回新记录，失败返回 { error }
function add(input) {
  const res = sanitize(input);
  if (!res.ok) return { error: res.error };

  const data = loadAll();
  const ids = new Set(data.items.map((it) => it.id));
  const item = { ...res.item, id: nextId(ids), createdAt: Date.now() };

  data.items.push(item);
  if (!saveAll(data)) return { error: '写文件失败，日程没保存' };
  return item;
}

// 改一条。patch 里给什么改什么，其余保持不变。
// 成功返回改完的记录，失败返回 { error }
function update(id, patch) {
  const data = loadAll();
  const idx = data.items.findIndex((it) => it.id === id);
  if (idx < 0) return { error: '找不到这条日程' };

  const merged = { ...data.items[idx], ...(patch || {}), id };
  // 换了重复规则后，旧的 date / weekdays 可能不合新规则，先清干净再校验
  if (patch && patch.repeat && patch.repeat !== data.items[idx].repeat) {
    merged.date = patch.repeat === 'once' ? (patch.date ?? null) : null;
    merged.weekdays = patch.repeat === 'weekly' ? (patch.weekdays ?? []) : [];
  }

  const res = sanitize(merged);
  if (!res.ok) return { error: res.error };

  const item = { ...res.item, id, createdAt: data.items[idx].createdAt };
  data.items[idx] = item;
  if (!saveAll(data)) return { error: '写文件失败，改动没保存' };
  return item;
}

// 删一条。成功返回 true
function remove(id) {
  const data = loadAll();
  const before = data.items.length;
  data.items = data.items.filter((it) => it.id !== id);
  if (data.items.length === before) return false;
  saveAll(data);
  return true;
}

// 开 / 关一条（不删掉，只是临时静音）
function toggle(id) {
  const cur = get(id);
  if (!cur) return { error: '找不到这条日程' };
  return update(id, { enabled: !cur.enabled });
}

// 标记「今天已经响过了」。调度引擎触发提醒后调它（2-2 用）。
// dateKey 默认取今天，传参是为了方便测试。
function markFired(id, dateKey = localDateKey()) {
  const data = loadAll();
  const idx = data.items.findIndex((it) => it.id === id);
  if (idx < 0) return false;
  data.items[idx].lastFiredDate = dateKey;
  return saveAll(data);
}

module.exports = {
  FILE,
  VERSION,
  REPEATS,
  KINDS,
  list,
  get,
  add,
  update,
  remove,
  toggle,
  markFired,
  // 给 scheduler.js 复用的纯函数
  localDateKey,
  minutesOfDay,
  sanitize,
};
