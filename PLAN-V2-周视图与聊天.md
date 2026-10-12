# 桌宠升级 v2 · 周视图与聊天 Implementation Plan

> **执行方式：** 本仓库由「小安」在 WorkBuddy 会话里**逐任务执行**。
> 每个 Task 结束必须：跑该任务的验证命令 → 看到预期输出 → `git commit` 一次。
> **任务之间不要合并提交**，也不要跳过负对照步骤。
>
> （本仓库不使用外部 sub-skill 编排：桌宠是单实例 Electron 程序，
> 自检必须串行跑，并行子代理会互相顶掉进程。）

**Goal:** 让主人能「看见」一周的安排并在上面直接改，并且能像跟宠物说话一样，用大白话让桌宠记下日程。

**Architecture:**
数据层（`schedules.js`）从「只有时间点」升级为「时间点 / 时段」两种类型，版本号 v1→v2；
新增 `week.js`（纯函数：周展开 + 时间轴 + 方块布局 + 取色）把布局数学全部留在主进程，
渲染进程只拿比例数字去乘像素；新增「大脑」层（`brain/`），本地规则与云端 AI 各一个实现，
由一个路由器按「本地命中优先、云端兜底」的顺序调用，**任何大脑产出的日程草案都必须过
`schedules.sanitize` 才能落盘**；聊天以独立窗口（`chat-window.js`）实现，复用 `place.js`
贴在桌宠旁边。

**Tech Stack:** Electron 44.7.0 + 原生 HTML/CSS/JS；无框架、无打包器、无 TypeScript；
云端 AI 走 Node 内置 `fetch`（**不新增任何 npm 依赖**）；Live2D 相关版本锁死不动
（`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`）。

**Spec:** 主人 2026-10-12 的原话（见「零、需求原文」），加上主人当天用选择题拍板的四条
（见「零、已拍板的四个选择」）。

---

## 零、需求原文

> 「日程安排界面新增一个按钮 按周一、二、三、四、五、六、日分类 可以可视化
> （以不同颜色的圆角长方体代表这个任务的时段）每周中每天的安排 并可以在上面修改
> 日程安排要分两种类型（时间点和时段，时间点用略扁的圆角长方体来可视化）
> 并且在增加聊天框功能 用户可以和大肥鱼聊天对话 同时可以直接在聊天框中表达想要增加的日程
> 比如30分钟后提醒我收衣服。另外先不做禁网站的功能 ，你帮我生成一个计划」

### 已拍板的四个选择（主人 2026-10-12）

| 问题 | 选择 |
|---|---|
| 聊天靠什么理解人话 | **两套都做**：本地规则保底 + 云端 AI 当主力（没网自动退回本地） |
| 周视图上怎么改 | **点一下方块弹出表单**（拖动改时间留到以后） |
| 聊天框长什么样 | **贴着桌宠的小气泡条**（独立窗口，跟着桌宠走） |
| 周视图要不要翻页 | **不用翻页**，固定周一到周日 |

### 由小安拍板、主人可随时推翻的细节

| 细节 | 决定 | 理由 |
|---|---|---|
| 时段会不会跨天 | **不允许**（`endTime` 必须严格晚于 `time`） | 跨天会让周视图绘制和「提醒在几点」都变复杂，先挡住 |
| 时段在几点提醒 | **只在开始时刻提醒一次** | 和现在的时间点行为完全一致，可预测 |
| 每个任务的颜色 | **按标题自动取色**（同一标题永远同色），不做手动挑色 | 主人要的是「能区分」，不是「能挑色」，少一个控件少一份维护 |
| 周视图上关掉的日程 | **显示，但半透明** | 和列表现有行为一致，主人能看出「它还在，只是关着」 |
| 聊天里说加日程 | **直接建，但回复必须复述「什么事、几点」**，消息下面带一个「撤销」 | 不多点一次确认，但错了能立刻撤回 |
| 时间轴范围 | 按当周日程**自适应**，最少覆盖 08:00–20:00 | 只有一条 10:00 的日程时，不该画一整天空网格 |
| 云端 AI 的接口 | 任意 **OpenAI 兼容**的 `/chat/completions`（DeepSeek / 通义 / Kimi 都行） | 不绑定某一家，主人自己填地址 + Key + 模型名 |
| 不配 API Key 时 | **纯本地模式照常用**，只是闲聊会变成台词库 | 不填也能用，不阻塞 |

---

## Global Constraints

以下每条都是本仓库已有的硬性约定，**每个 Task 都隐含包含**，不要重新发明：

- **渲染进程绝不碰系统**：一律走 IPC；`contextIsolation: true` + preload + `contextBridge`，
  **绝不**开 `nodeIntegration`（`CLAUDE.md` 硬性约定 1、2 条）。
- **不新增 npm 依赖**。云端 AI 用 Node 内置 `fetch`；假服务器用内置 `node:http`。
  Live2D 版本锁死（`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`），**不要 `npm update`**。
- **用户数据一律放 `app.getPath('userData')`**，绝不写程序目录（约定第 6 条）。
- **校验只有一处**：全部在 `src/main/schedules.js` 的 `sanitize()`。
  界面、本地大脑、云端大脑**都不得自带第二套规则** —— 两套规则迟早会不一致。
- **时间一律本地时间 `HH:mm` / `YYYY-MM-DD`**，绝不碰 UTC，**绝不用 `toISOString()`**
  （晚上 8 点后会串天，见 `schedules.js` 里 `localDateKey` 的注释）。
- **自检必须带负对照**：只验「我调了函数、没报错」不算证据；必须有一条「坏数据必须被拒」
  或者「旧写法必须复现问题」的断言（`HANDOFF.md` 第六节第 19 条）。
- **纯函数刻意不 `require('electron')`**，这样能脱离 Electron 单测（照 `place.js` 的做法）。
- **数据层自检走独立 Node 脚本**（`scripts/test-*.js`），不要塞进 Electron 自检 ——
  桌宠是单实例程序，跑着的时候再启动会直接退出。
- **往桌宠界面加任何 DOM 控件必须挂 `data-ui`**，否则穿透判定看不见它，控件会**静默点不到**
  （`HANDOFF.md` 第六节第 21 条）。
- **焦点策略各不相同，别照抄**：桌宠 `focusable:false` + `showInactive()`；
  提醒气泡 `focusable:false`；设置窗口和**新的聊天条**必须能抢焦点（主人要打字）。
- **摆窗口位置一律用 `src/main/place.js` 的 `placeNear()`**，不要自己算；
  带标题栏的窗口在 1.5 倍缩放下外框会飘，位置用固定标称尺寸算、再用 `setBounds()` 一起写回。
- **界面文案全中文、大白话**，不出现「字段」「参数」「API」这类词（主人是 AI 小白）。
- **每个 Task 一次 commit**，提交信息用中文，说清「做了什么 + 为什么」。

---

## Review Focus

以下是需求里没明说、但一碰到就会让主人骂人的五件事。**每一条都必须在对应 Task 里有测试钉住**：

1. **云端 AI 返回的日程草案是幻觉**（`time: "25:00"`、`endTime` 早于 `time`、标题空、
   `weekdays: [9]`）。合理预期：被 `sanitize()` 拒掉，聊天框只显示文字回复、**不建日程、
   不报错、不崩**。→ Task 9、Task 10
2. **网络卡住导致聊天框假死**。合理预期：15 秒内一定有结果；超时后自动退回本地模式并
   告诉主人一句人话，输入框立刻恢复可用。→ Task 9、Task 10、Task 13
3. **API Key 泄漏**：出现在终端日志里、出现在聊天记录里、出现在界面标题上。
   合理预期：任何日志、错误消息、界面展示里都只有掩码形式 `sk-****abcd`。→ Task 9、Task 11
4. **一次性日程的日期不在本周时凭空出现在周视图上**（或反过来，「每天」的日程只出现一天）。
   合理预期：周视图严格按「周一为一周之始」的七天规则展开。→ Task 2、Task 6
5. **主人输入的文本被当 HTML 执行**（在聊天框里打 `<img src=x onerror=...>`）。
   合理预期：聊天记录、日程标题一律用 `textContent` 渲染，页面上不出现任何被解析的标签。
   → Task 11、Task 13

---

## 文件结构（先定死，别让执行者乱放）

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/week.js` | 纯函数：周展开、时间轴范围、方块布局比例、按标题取色。**不 require electron** |
| `src/main/nl-time.js` | 纯函数：把中文大白话解析成日程草案（`parseSchedule`）。**不 require electron** |
| `src/main/ai-config.js` | 云端大脑的配置存取（地址 / Key / 模型名），含 Key 掩码 |
| `src/main/brain/local.js` | 本地大脑：台词库 + 意图判定 |
| `src/main/brain/cloud.js` | 云端大脑：OpenAI 兼容请求 + 回复解析 |
| `src/main/brain/index.js` | 大脑路由器：本地命中优先、云端兜底、失败降级 |
| `src/main/chat-window.js` | 聊天条窗口（贴着桌宠的小气泡条） |
| `src/main/preload-chat.js` | 聊天条的安全桥梁（用多少给多少） |
| `src/renderer/chat/index.html` | 聊天条界面 |
| `src/renderer/chat/chat.js` | 聊天条逻辑（发消息、渲染、⚙ 设置面板） |
| `src/main/selftest-week.js` | 周视图端到端自检 |
| `src/main/selftest-chat.js` | 聊天端到端自检 |
| `scripts/test-week.js` | `week.js` 的 Node 单测 |
| `scripts/test-nl-time.js` | `nl-time.js` 的 Node 单测（表驱动，含负对照） |
| `scripts/test-brain-local.js` | 本地大脑单测 |
| `scripts/test-brain-cloud.js` | 云端大脑单测（起一个假 HTTP 服务器当对照） |

### 修改

| 文件 | 改什么 |
|---|---|
| `src/main/schedules.js` | v1→v2：新增 `kind` / `endTime`，时段校验，老数据自动升级 |
| `src/main/settings-window.js` | 新增 `week:data` 通道；新增「列表 / 周视图」两种窗口尺寸切换 |
| `src/main/preload-settings.js` | 新增 `weekData()` |
| `src/renderer/settings/index.html` | 工具栏加「周视图」按钮；周视图容器；表单加「时间点 / 时段」切换 |
| `src/renderer/settings/settings.js` | 列表显示时段；周视图渲染与点击；表单支持时段 |
| `src/main/main.js` | 分发新自检；初始化聊天条；托盘菜单加「和大肥鱼聊天」 |
| `src/renderer/pet/index.html` | 桌宠界面加「聊天」按钮（**必须挂 `data-ui`**） |
| `src/renderer/pet/renderer.js` | 聊天按钮的点击 → IPC |
| `src/main/preload.js` | 暴露 `openChat()` |
| `package.json` | 新增测试脚本（见下表） |
| `HANDOFF.md` / `CLAUDE.md` | 新坑、新命令、目录树 |

**`package.json` 要新增的脚本（一次加齐，别分散在各 Task 里临时加）：**

```json
"test:week": "node scripts/test-week.js",
"test:nl-time": "node scripts/test-nl-time.js",
"test:brain-local": "node scripts/test-brain-local.js",
"test:brain-cloud": "node scripts/test-brain-cloud.js",
"test:brain-router": "node scripts/test-brain-router.js",
"test:week-e2e": "node scripts/start-dev.js --no-gpu --selftest=week --isolated",
"test:chat-e2e": "node scripts/start-dev.js --no-gpu --selftest=chat --isolated"
```

（放在现有 `test:drag` 之后，保持「纯 Node 单测在前、Electron 自检在后」的现有排序。
**在每个新测试文件诞生的那个 Task 里，就把它对应的脚本加进 `package.json` 并一起提交** ——
不要留到最后补，否则 Task 14 的全量回归会因为「找不到脚本」直接挂掉。）

### 明确不动的

`src/main/scheduler.js`（时段的提醒就在开始时刻，判定逻辑一个字都不用改）、
`src/main/reminder.js`、`src/main/place.js`、`src/renderer/bubble/*`、Live2D 相关全部。

---

### Task 1: 数据层支持「时段」（v1 → v2）

**Files:**
- Modify: `src/main/schedules.js`
- Test: `scripts/test-schedules.js`（现有 46 条断言的文件，往后追加）

**Interfaces:**
- Produces: `schedules.KINDS === ['point', 'span']`；`schedules.VERSION === 2`；
  条目新增两个字段 —— `kind: 'point' | 'span'`、`endTime: 'HH:mm' | null`。
  语义：`kind === 'point'` 时 `endTime` 恒为 `null`，`time` 就是提醒时刻；
  `kind === 'span'` 时 `endTime` 必填且**严格晚于** `time`（不允许跨天、不允许相等）。

- [ ] **Step 1: 写失败的测试**

在 `scripts/test-schedules.js` 末尾追加（沿用该文件已有的 `ok(cond, label, extra)` 风格）：

```js
// ---- v2：时段 ----
// 正例：合法的时段
const span = schedules.add({ title: '自检·开会', kind: 'span', time: '09:30', endTime: '11:00', repeat: 'daily' });
// 断言：span.error 为 undefined，且 span.kind === 'span'，span.endTime === '11:00'

// 负对照①：结束时间和开始时间一样 → 必须被拒
const same = schedules.add({ title: '自检·一样', kind: 'span', time: '09:30', endTime: '09:30', repeat: 'daily' });
// 断言：same.error 是字符串（不能建成功）

// 负对照②：结束时间早于开始时间 → 必须被拒
const back = schedules.add({ title: '自检·倒流', kind: 'span', time: '11:00', endTime: '09:30', repeat: 'daily' });
// 断言：back.error 是字符串

// 负对照③：时段缺 endTime → 必须被拒
const missing = schedules.add({ title: '自检·缺尾巴', kind: 'span', time: '09:30', repeat: 'daily' });
// 断言：missing.error 是字符串

// 负对照④：endTime 格式错 → 必须被拒
const badFmt = schedules.add({ title: '自检·格式', kind: 'span', time: '09:30', endTime: '25:00', repeat: 'daily' });
// 断言：badFmt.error 是字符串

// 负对照⑤：kind 不认识 → 必须被拒（不能悄悄当 point）
const badKind = schedules.add({ title: '自检·怪类型', kind: 'meeting', time: '09:30', repeat: 'daily' });
// 断言：badKind.error 是字符串

// point 不许带 endTime：给了也要被清成 null（不能留脏数据）
const p = schedules.add({ title: '自检·时间点', kind: 'point', time: '07:15', endTime: '08:00', repeat: 'daily' });
// 断言：p.error 为 undefined，且 p.endTime === null

// v1 老数据自动升级：手工往文件里写一条没有 kind 的记录，读出来必须是 point
// 做法：直接调用 schedules.sanitize({ title: '老数据', time: '09:00', repeat: 'once', date: '2026-10-13' })
// 断言：结果 ok 且 item.kind === 'point' 且 item.endTime === null
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:schedules`
Expected: FAIL —— 出现「结束时间和开始时间一样」这类负对照**没被拒**的失败行（因为现在还不认识 `kind`，`endTime` 被直接忽略）。

- [ ] **Step 3: 实现**

在 `src/main/schedules.js` 里：

1. `VERSION` 从 `1` 改成 `2`。
2. 新增 `const KINDS = ['point', 'span'];`
3. 在 `sanitize()` 里，`out.time = raw.time;` 之后插入 kind / endTime 的校验与归一：

```js
// kind：没给就按「时间点」—— 这样 v1 的老数据不用迁移脚本，读进来就是合法的 point
const rawKind = raw.kind;
const kind = (rawKind === undefined || rawKind === null || rawKind === '') ? 'point' : rawKind;
if (!KINDS.includes(kind)) return { ok: false, error: `日程类型只能是 ${KINDS.join(' / ')} 之一` };
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
```

4. 文件顶部那段「存什么」的注释同步补上 `kind` / `endTime` 两个字段和 v2 说明。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:schedules`
Expected: 原 46 条 + 新增的 8 组全绿，最后一行是 `===== 日程数据层自检结束：NN 通过 / 0 失败 =====`。

- [ ] **Step 5: 跑全量回归确认没碰坏别的**

Run: `npm run test:scheduler && npm run test:reminder && npm run test:place`
Expected: 三个都 0 失败。（`scheduler` 只用 `item.time`，不该受影响 —— 这一步是证明它。）

- [ ] **Step 6: Commit**

```bash
git add src/main/schedules.js scripts/test-schedules.js
git commit -m "数据层：日程分「时间点/时段」两类（v1→v2，老数据自动升级）"
```

---

### Task 2: `week.js` —— 周展开、时间轴、方块布局、取色（纯函数）

**Files:**
- Create: `src/main/week.js`
- Test: `scripts/test-week.js`（新建）

**Interfaces:**
- Consumes: `schedules.localDateKey`、`schedules.minutesOfDay`（都是纯函数，可 require）
- Produces（全部导出，全部同步、无副作用）：

```js
// 本周一 00:00:00.000（本地时间）。周一是一周之始 —— 周日属于「本周的第 7 天」。
weekStartOf(date) → Date

// 那一天该显示哪些条目（enabled:false 的也返回，界面自己变淡）。
// 规则：daily → 每天；weekdays → 周一~周五；weekly → weekdays 里包含那天；
//       once → 只有 date 正好等于那天。
itemsOfDay(items, date) → item[]

// 时间轴范围（整点）。最少覆盖 08:00–20:00，有更早/更晚的日程就往外扩。
// 返回 { startHour, endHour }，例如 { startHour: 8, endHour: 20 }
axisOf(items) → { startHour, endHour }

// 某一天的方块列表。topRatio / heightRatio 都是 0..1 的比例，
// 相对 [axis.startHour, axis.endHour] 这一段。界面负责乘像素。
// 同一个开始时刻的方块按「时段在前、时间点在后」排，保证短的不会被长的盖住。
blocksOf(items, date, axis) → [{
  item,           // 原条目
  topRatio,       // 0..1，方块顶边位置（时间点用它的时刻）
  heightRatio,    // 0..1，只有 span 有意义（point 恒为 0，界面用固定像素高）
  color,          // colorOf(item.title) 的结果
}]

// 8 色调色板（键名固定，界面用 data-color 属性选样式）
PALETTE → ['blue','teal','amber','pink','purple','green','coral','gray']

// 同一个标题永远同一个颜色；空标题归到 gray
colorOf(title) → 'blue' | 'teal' | ... | 'gray'
```

- [ ] **Step 1: 写失败的测试**

新建 `scripts/test-week.js`，骨架照抄 `scripts/test-place.js`（自带 `ok()` 计数器和
`===== 结束：N 通过 / M 失败 =====` 收尾行）。必须包含下面这些**带负对照**的断言：

```js
// ① 一周从周一算起
// 2026-10-12 是周一，2026-10-18 是周日
weekStartOf(new Date(2026, 9, 12))  → 2026-10-12 00:00
weekStartOf(new Date(2026, 9, 18))  → 2026-10-12 00:00   // ★ 周日必须归到「本周」
weekStartOf(new Date(2026, 9, 19))  → 2026-10-19 00:00   // 下周一
// ★ 负对照：周日绝不能被算成下一周的第一天
ok(localKey(weekStartOf(new Date(2026,9,18))) === '2026-10-12', '周日属于本周第 7 天，不是下周第 1 天')

// ② 各重复规则的展开
// daily  → 七天都在（★ 负对照：不能只出现一天）
// weekdays → 周一~周五 5 天，周六周日不在（★ 负对照：周六必须为 0 条）
// weekly:[1,3,5] → 周一/周三/周五 3 天，周二不在（★ 负对照）
// once + date=本周三 → 只有周三 1 天
// once + date=下周 → 本周七天全 0（★ 负对照：不在本周的一次性日程不能凭空出现）
// once + date=上周 → 本周七天全 0

// ③ 时间轴
axisOf([])                          → { startHour: 8, endHour: 20 }
axisOf([{time:'05:00'}])            → startHour: 5
axisOf([{time:'22:30'}])            → endHour: 23   // 23:00 起
axisOf([{time:'10:00', endTime:'11:00', kind:'span'}]) → { startHour: 8, endHour: 20 }
// ★ 负对照：只有一条 10:00 的日程时，时间轴不能被撑成 0~24
ok(axisOf([point('10:00')]).startHour === 8, '一条日程不该把时间轴撑满全天')

// ④ 方块布局（用 axis {8,20}，即 12 小时跨度）
// 时间点 10:00 → topRatio ≈ (10-8)/12 = 0.1667，heightRatio === 0
// 时段 09:00–11:00 → topRatio ≈ 1/12 = 0.0833，heightRatio ≈ 2/12 = 0.1667
// 时段 08:00–20:00 → topRatio === 0，heightRatio === 1
// ★ 负对照：时段 09:00–11:00 的 heightRatio 必须明显大于 0.1
//    （如果实现把 heightRatio 恒返回 0，这条要红）
// ★ 负对照：时间点 10:00 和时段 10:00–11:00 的 topRatio 必须相等（都从时刻起算）

// ⑤ 取色
colorOf('开会') === colorOf('开会')            // 同标题稳定同色
colorOf('') === 'gray'
// ★ 负对照：至少两个不同标题必须拿到不同颜色（否则等于「全一个色」）
//   做法：统计 20 个不同标题里出现过的颜色种类数，必须 >= 3
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-week.js`
Expected: FAIL —— `Cannot find module '../src/main/week'`。

- [ ] **Step 3: 实现 `src/main/week.js`**

顶部写清「本文件刻意不 require electron，好脱离 Electron 单测」。
`itemsOfDay` 的星期判定要和 `scheduler.js` 的 `todayTarget()` **用同一套规则**
（`getDay()`，0 = 周日）—— 在那两个文件里互相留一句交叉引用注释，避免以后改一边忘一边。

`colorOf` 用「标题字符码累加后取模」这类稳定哈希（**不要用 `item.id`** —— id 会变，
颜色跟着跳会显得很吵）。**不要**用随机数。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-week.js`
Expected: 全绿，收尾行 0 失败。

- [ ] **Step 5: Commit**

```bash
git add src/main/week.js scripts/test-week.js
git commit -m "周视图：周展开/时间轴/方块布局/取色的纯函数 + 单测"
```

---

### Task 3: 表单与列表支持「时段」

**Files:**
- Modify: `src/renderer/settings/index.html`（表单加一行「类型」）
- Modify: `src/renderer/settings/settings.js`
- Test: `src/main/main.js`（扩展 `runSettingsSelfTest`，加 2 组断言）

**Interfaces:**
- Consumes: `settingsAPI.add/update`（已有）；`schedules` 的 `kind` / `endTime`（Task 1）
- Produces: 列表项的时间显示变成 `09:30` 或 `09:30–11:00`；
  表单里新增 `#f-kind`（`<select>`，选项 `point` / `span`）和 `#f-endtime`（`<input type="time">`），
  以及一行 `#row-endtime`（选 `point` 时隐藏，规则同现有的 `#row-date` / `#row-weekdays`）。

- [ ] **Step 1: 写失败的断言**

在 `src/main/main.js` 的 `runSettingsSelfTest()` 里，第 ⑤ 步（添加一条日程）之后插入：

```js
// ⑤b 时段日程：界面上填得出、存得进、列表显示成「开始–结束」
// 做法：点「＋ 添加日程」→ 标题「自检·时段」→ 类型选 span → 开始 14:00 结束 16:30
//       → 保存 → 等 400ms
// 断言 1：界面那一行的时间文本 === '14:00–16:30'
// 断言 2：★ 主进程那边读到的 kind === 'span' 且 endTime === '16:30'
//        （只看界面不算数，界面假装显示对了也能骗过测试）
// 断言 3：★ 负对照：把类型切回 point，结束时间那一行必须隐藏，
//        且此时保存出来的 endTime === null

// ⑤c 负对照：结束时间早于开始时间 → 必须被拦下，且不能写进文件
// 做法：标题「自检·倒流」→ 类型 span → 开始 15:00 结束 14:00 → 点保存
// 断言：表单还开着、错误提示可见、主进程那边条数没变
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:settings-e2e`
Expected: FAIL —— 找不到 `#f-kind`，或者时间文本还是 `14:00`。

- [ ] **Step 3: 实现**

`index.html`：在「几点」那一行之后插入

```html
<div class="field">
  <span>类型</span>
  <select id="f-kind">
    <option value="point">时间点（到点提醒一下）</option>
    <option value="span">时段（占一段时间）</option>
  </select>
</div>
<div class="field hidden" id="row-endtime">
  <span>到几点</span>
  <input id="f-endtime" type="time" value="11:00" />
</div>
```

`settings.js`：
- `el` 里加 `kind: #f-kind`、`endTime: #f-endtime`、`rowEndTime: #row-endtime`
- 新增 `syncKindRows()`：`el.rowEndTime.classList.toggle('hidden', el.kind.value !== 'span')`，
  绑定方式和 `syncRepeatRows()` 完全一样（`change` 事件）
- `openForm(it)`：`el.kind.value = it ? it.kind : 'point'`；
  `el.endTime.value = it && it.endTime ? it.endTime : '11:00'`
- `onSave()`：`input.kind = el.kind.value`；`if (input.kind === 'span') input.endTime = el.endTime.value`
- 新增 `timeText(it)`：`it.kind === 'span' && it.endTime ? `${it.time}–${it.endTime}` : it.time`，
  在 `buildItem()` 里替换掉现在直接写的 `it.time`
- **轻量提示照旧**：`if (input.kind === 'span' && !input.endTime) return showFormError('选了「时段」，得填到几点')`。
  真正的「结束必须晚于开始」仍然只由主进程判定，界面**不要**再写一遍。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:settings-e2e`
Expected: 45 条 → 约 54 条，0 失败。

- [ ] **Step 5: 目视确认一次**

Run: `PET_OPEN_SETTINGS=1 npm start -- --no-gpu`（或 `npm start`）
Expected: 窗口里点「＋ 添加日程」→ 类型选「时段」→ 冒出「到几点」那一行；保存后列表上是 `14:00–16:30`。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings/index.html src/renderer/settings/settings.js src/main/main.js
git commit -m "日程界面：能填「时段」，列表显示成 开始–结束"
```

---

### Task 4: 周视图骨架 —— 按钮、七列、时间刻度、彩色方块

**Files:**
- Modify: `src/main/settings-window.js`（新增 `week:data` 通道 + 两种窗口尺寸）
- Modify: `src/main/preload-settings.js`
- Modify: `src/renderer/settings/index.html`
- Modify: `src/renderer/settings/settings.js`
- Test: `src/main/main.js`（扩展 `runSettingsSelfTest`）

**Interfaces:**
- Consumes: `week.js`（Task 2）的 `weekStartOf` / `itemsOfDay` / `axisOf` / `blocksOf` / `colorOf` / `PALETTE`
- Produces:

```js
// settings-window.js 新增导出
SIZES === { list: { w: 480, h: 640 }, week: { w: 1000, h: 680 } }
sizeOf(mode, workArea) → { w, h }   // 工作区放不下时按 90% 缩，最小不低于 list 尺寸

// 新增 IPC（返回已算好的布局，界面不做任何数学）
ipcMain.handle('week:data', () => {
  // → {
  //   weekStart: '2026-10-12',
  //   todayKey: '2026-10-12',
  //   axis: { startHour, endHour },
  //   days: [{ key: '2026-10-12', dow: 1, label: '周一', isToday: true,
  //            blocks: [{ id, title, kind, time, endTime, repeatText, enabled,
  //                       topRatio, heightRatio, color }] }]   // 固定 7 个
  // }
})

// preload-settings.js 新增三个
weekData: () => ipcRenderer.invoke('week:data')
setMode: (mode) => ipcRenderer.invoke('week:set-mode', mode)   // → 'list' | 'week'
onMode: (cb) => ipcRenderer.on('week:mode', (_e, m) => cb(m))  // 主进程确认后的回执
```

- [ ] **Step 1: 写失败的断言**

在 `runSettingsSelfTest()` 第 ⑤ 步之后插入：

```js
// ⑤d 周视图
// 做法：点工具栏的「#btn-week」→ 等 900ms（窗口要变尺寸 + 重新摆位）
// 断言 1：★ 周视图容器 #week 可见，列表容器 .list-wrap 隐藏
// 断言 2：★ 网格里正好 7 个列头，文本依次是 周一…周日
//         （用 DOM 里真实的列头文本比，不要比我们自己生成的数组）
// 断言 3：★ 窗口尺寸变成了周视图的标称值（±2 像素，见第 ①b 步的说明）
// 断言 4：★ 周视图上「自检·时段」那一块真的出现了，而且它的高度比
//         「自检·日程」（时间点）那一块**高** —— 这是「时段用高的长方体、
//         时间点用扁的」这条需求的唯一证据
// 断言 5：★ 负对照：切回列表（再点一次 #btn-week）后 #week 隐藏、.list-wrap 可见，
//         窗口尺寸变回 480×640
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:settings-e2e`
Expected: FAIL —— 找不到 `#btn-week`。

- [ ] **Step 3: 实现 —— 主进程侧**

`settings-window.js`：
1. 顶部常量改成 `const SIZES = { list: { w: 480, h: 640 }, week: { w: 1000, h: 680 } };`
   并保留 `WIN_W` / `WIN_H` 作为 `SIZES.list` 的别名（现有自检和 `placeNear` 复算要用，
   **不要**直接删掉，会连带弄红 `test:settings-e2e` 的第 ①b 步）。
2. 新增 `let mode = 'list';`
3. 新增 `sizeOf(m, workArea)`：工作区宽/高放不下时按 90% 缩（`Math.round(workArea.width * 0.9)`），
   但不小于 `SIZES.list`。**这是为了小屏笔记本上也能用。**
4. `positionNearPet()` 里把 `WIN_W/WIN_H` 换成 `sizeOf(mode, display.workArea)`。
5. 新增 `setMode(next)`：切 `mode` → `win.setMinimumSize(...)` →
   `win.setBounds({ x, y, ...sizeOf(mode, workArea) })` → `positionNearPet()` →
   把 `mode` 通过 IPC 告诉界面（`win.webContents.send('week:mode', mode)`）。
   **先 `setMinimumSize` 再 `setBounds`** —— 顺序反了会被最小尺寸卡住。
6. `open()` 时把 `mode` 重置成 `'list'`（每次打开都从列表开始，行为可预测）。
7. 新增 `ipcMain.handle('week:data', ...)`：调 `week.js` 算好，`blocksOf` 的每条
   再补上 `id / title / kind / time / endTime / repeatText / enabled`。
   `repeatText` 复用界面那份文案（`只一次 · 日期` / `每天` / `工作日` / `每周 X`）——
   **在主进程里重写一遍**，并在两边注释里互相指向，说明这份文案暂时有两份。

`preload-settings.js`：加 `weekData` 和 `onMode(cb)`（`ipcRenderer.on('week:mode', ...)`）。

- [ ] **Step 4: 实现 —— 界面侧**

`index.html`：
- 工具栏加 `<button id="btn-week" class="ghost">周视图</button>`（文案在列表模式显示「周视图」，
  周视图模式显示「列表」，由 JS 切换）
- 在 `.list-wrap` 之后加 `<div id="week" class="hidden">`，里面是
  `<div id="week-head"></div>`（列头）+ `<div id="week-grid"></div>`（网格）
- 周视图的 CSS 用 CSS 变量写颜色，8 个色：
  ```css
  --c-blue:#3b82f6; --c-teal:#14b8a6; --c-amber:#f59e0b; --c-pink:#ec4899;
  --c-purple:#8b5cf6; --c-green:#22c55e; --c-coral:#fb7185; --c-gray:#94a3b8;
  #week-grid { display:grid; grid-template-columns: 52px repeat(7,1fr); }
  .blk { border-radius: 6px; padding: 2px 5px; font-size: 11px;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
         cursor: pointer; color: #fff; }
  .blk.point { height: 22px; }          /* 时间点：略扁 */
  .blk.off { opacity: .45; }            /* 关掉的日程：变淡，但还在 */
  .day-col.today { background: #eff6ff; }  /* 今天那一列淡蓝底 */
  ```

`settings.js`：
- 新增 `let mode = 'list'`、`let weekData = null`
- `renderWeek(data)`：
  - 画 7 个列头（`周一`…`周日`），今天那列加 `today` 类
  - 画时间刻度列（`axis.startHour` 到 `axis.endHour`，每小时一格，格子高度 40px）
  - 每条 block：`top = topRatio * gridH`、`height = kind === 'point' ? 22 : Math.max(22, heightRatio * gridH)`，
    用 `position:absolute` 定位；**方块里的文字一律 `textContent`**（主人自己输的标题）
  - 方块上挂 `dataset.id`，为 Task 5 的点击做准备
  - 打开周视图后自动滚到「今天最早的日程」所在位置（没有就滚到 08:00）
- `toggleMode()`：切 `mode` → 调 `settingsAPI.setMode(mode)`（新增）→ 切容器的 `hidden` →
  重新拉一次 `weekData()` 渲染
- `settingsAPI.onMode` 收到主进程的确认后同步按钮文案

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test:settings-e2e`
Expected: 约 54 条 → 约 63 条，0 失败。

- [ ] **Step 6: 目视确认一次**

Run: `PET_OPEN_SETTINGS=1 npm start -- --no-gpu`
Expected: 点「周视图」→ 窗口变大、出现七列彩色方块；时段明显比时间点高；今天的列底色不同。

- [ ] **Step 7: Commit**

```bash
git add src/main/settings-window.js src/main/preload-settings.js src/renderer/settings/index.html src/renderer/settings/settings.js src/main/main.js
git commit -m "周视图：七列彩色方块 + 时间刻度 + 窗口随模式变形"
```

---

### Task 5: 在周视图上修改 —— 点方块打开表单、点空白新建

**Files:**
- Modify: `src/renderer/settings/settings.js`
- Test: `src/main/main.js`（扩展 `runSettingsSelfTest`）

**Interfaces:**
- Consumes: Task 4 的 `renderWeek()`、方块上的 `dataset.id`；现有 `openForm(it)`
- Produces: 点方块 → 切回列表模式并打开表单，且**表单里已经填好那条的值**；
  点某天某小时的空白格 → 打开表单，标题空着、类型 `point`、时间预填那个整点、
  重复选 `once`、日期预填那一天。

- [ ] **Step 1: 写失败的断言**

在 `runSettingsSelfTest()` 里接在 ⑤d 之后：

```js
// ⑤e 在周视图上点方块改
// 做法：切到周视图 → 在 DOM 里找到标题为「自检·时段」的 .blk → 真点一下（.click()）
//       → 等 500ms
// 断言 1：★ 表单打开了（#form 不再 hidden）
// 断言 2：★ 表单里 #f-title 的值 === '自检·时段'（不是空的，也不是别的日程的标题）
// 断言 3：★ #f-kind 的值 === 'span'，#f-endtime 的值 === '16:30'
// 断言 4：★ 模式切回了列表（#week 隐藏）—— 不然表单会被周视图的网格盖住
// 断言 5：★ 负对照：把标题改成「自检·时段改」，结束时间改成 17:00 保存后，
//         主进程那边读到的 title 和 endTime 都变了（证明「在上面修改」是真的改了）
// 断言 6：★ 负对照：点周视图的空白格（比如周三 13:00）打开表单时，
//         #f-title 必须是空的 —— 不能把上次点过的日程带进来

// 收尾：把「自检·时段改」删掉，别留垃圾
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:settings-e2e`
Expected: FAIL —— 点方块之后表单没打开。

- [ ] **Step 3: 实现**

`settings.js`：
- `renderWeek()` 里给每个方块挂 `blk.addEventListener('click', () => openFromWeek(blockId))`
- 新增 `async function openFromWeek(id)`：从**最新拉取的** `weekData` 里按 id 找到那条的
  完整字段（`weekData` 里已经带了 `kind/time/endTime/repeat/weekdays/date`），
  切回列表模式（`setMode('list')`），再 `openForm(item)`。
  ⚠ **不要**用「点的时候闭包捕获的那份 item」—— 周视图可能已经过时了，
  要按 id 去 `await api.list()` 拿最新的（或者在 `openForm` 前先 `await load()`）。
- 新增 `openFromBlank(dayKey, hour)`：`openForm(null)` 之后手工把
  `el.time.value = String(hour).padStart(2,'0') + ':00'`、
  `el.repeat.value = 'once'`、`el.date.value = dayKey`，并调 `syncRepeatRows()` / `syncKindRows()`。
- 网格空白格：在 `renderWeek()` 里按「每天 × 每小时」生成透明的 `.slot` 元素
  （`position:absolute`，高度 40px，`z-index` 低于方块），挂 `openFromBlank`。
  **不要**给 `.slot` 挂 `data-ui`（那是桌宠窗口的约定，设置窗口是普通窗口，不需要）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:settings-e2e`
Expected: 约 63 条 → 约 72 条，0 失败。

- [ ] **Step 5: 目视确认一次**

Run: `PET_OPEN_SETTINGS=1 npm start -- --no-gpu`
Expected: 周视图里点任意彩色方块 → 跳回列表并弹出填好的表单；点空白格 → 弹出空白表单、时间已经是那一格。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings/settings.js src/main/main.js
git commit -m "周视图：点方块改日程、点空白格新建"
```

---

### Task 6: 周视图端到端自检（独立哨兵）

**Files:**
- Create: `src/main/selftest-week.js`
- Modify: `src/main/main.js`（加一个 `PET_SELFTEST === 'week'` 的分支）
- Modify: `package.json`

**Interfaces:**
- Consumes: `settingsWindow`、`week`、`schedules`
- Produces: `module.exports = { run(ctx) }`，`ctx = { win, log, ok, finish, settingsWindow, week, schedules, sleep }`。
  `main.js` 里只加两行：`if (!app.isPackaged && process.env.PET_SELFTEST === 'week') setTimeout(() => require('./selftest-week').run({...}), 1500);`

- [ ] **Step 1: 写自检**

自检要验的是「主人真的能看见、能改」，不是「我写了函数」。关键断言：

```js
// ① 先塞三条不同重复规则的日程（daily / weekly:[3] / once=下周三）+ 一条时段
//    ★ 负对照：塞一条「一次性、日期在上个月」的 —— 它在周视图上必须一条都不出现
// ② 打开设置窗口 → 切到周视图 → 读主进程的 week:data
//    ★ 断言：days.length === 7，且 days[0].label === '周一'、days[6].label === '周日'
//    ★ 断言：daily 那条出现在全部 7 天里（不是 1 天）
//    ★ 断言：weekly:[3] 那条只出现在周三那 1 天
//    ★ 断言：上个月那条在任何一天里都找不到
// ③ 问界面 DOM：方块总数 === 主进程算出来的总数（两边对得上才算数）
// ④ 问界面 DOM：时段方块的像素高度 > 时间点方块的像素高度
// ⑤ 负对照：把窗口切回列表再切回周视图，方块数量和位置必须一致（不能越切越多）
// ⑥ 清理：把自检数据删干净，断言文件里没有 title 以「自检·」开头的记录
```

- [ ] **Step 2: 跑自检确认通过**

先在 `package.json` 加脚本，然后：

```bash
npm run test:week-e2e
```
（该脚本 = `node scripts/start-dev.js --no-gpu --selftest=week --isolated`，
`--isolated` 会先清空临时目录，保证可复现）

Expected: `===== 周视图自检结束：NN 通过 / 0 失败 =====`

- [ ] **Step 3: 故意把实现改坏，确认自检能红**

把 `renderWeek()` 里 `height` 那行临时改成固定 `22`（时段就画不出高度了），
重跑 `npm run test:week-e2e`。
Expected: 第 ④ 条断言**变红**。
确认之后**改回去**，再跑一次确认全绿。
（这一步是 `HANDOFF.md` 第六节第 19 条的规矩：不能证明「能抓到问题」的自检等于没写。）

- [ ] **Step 4: Commit**

```bash
git add src/main/selftest-week.js src/main/main.js package.json
git commit -m "周视图端到端自检：七天展开、时段高度、切模式不累积"
```

---

### Task 7: `nl-time.js` —— 把大白话解析成日程（纯函数）

**Files:**
- Create: `src/main/nl-time.js`
- Test: `scripts/test-nl-time.js`（新建，表驱动）

**Interfaces:**
- Produces:

```js
// 听不出「日程」就返回 null（这是最重要的一条：宁可什么都不做，也不能瞎猜）
parseSchedule(text, now = new Date()) → null | {
  title,        // 剥掉时间部分之后剩下的，例："收衣服"
  kind,         // 'point' | 'span'
  time,         // 'HH:mm'
  endTime,      // 'HH:mm' | null
  repeat,       // 'once' | 'daily' | 'weekdays' | 'weekly'
  date,         // 'YYYY-MM-DD' | null（repeat='once' 时必填）
  weekdays,     // number[]（repeat='weekly' 时必填，0=周日）
  confidence,   // 'high' | 'low'
  matched,      // 命中的那段原文，例："30分钟后"
}
```

**必须支持的说法**（每条都要有测试）：

| 类别 | 例子 | 期望 |
|---|---|---|
| 相对分钟 | `30分钟后提醒我收衣服` | point 15:42（now+30min，秒归零），once，date=今天，title=`收衣服` |
| 相对小时 | `两个小时后提醒我开会` | point now+2h |
| 半小时 | `半小时后提醒我喝水` | point now+30min |
| 一个半 | `一个半小时后叫我` | point now+90min |
| 今天几点 | `今天下午3点提醒我交表` | point 15:00，once，今天 |
| 明天 | `明天早上8点提醒我吃药` | point 08:00，once，明天 |
| 后天 | `后天晚上7点半提醒我拿快递` | point 19:30，once，后天 |
| 时段 | `明天下午2点到4点开会` | span 14:00–16:00，once，明天，title=`开会` |
| 时段（半） | `上午9点到11点半写报告` | span 09:00–11:30 |
| 时段（冒号） | `9:00-11:00 开会` | span 09:00–11:00 |
| 每天 | `每天早上8点提醒我吃药` | point 08:00，daily |
| 工作日 | `工作日早上9点提醒我打卡` | point 09:00，weekdays |
| 每周某几天 | `每周一三五早上9点提醒我开会` | point 09:00，weekly，weekdays=[1,3,5] |
| 每周单天 | `每周二下午2点提醒我例会` | weekly，weekdays=[2] |
| 中文数字 | `三点提醒我` | 15:00（下午）还是 03:00？**定：`三点` 单独出现按 03:00；带「下午/晚上」才是 15:00** |
| 十二点 | `中午12点提醒我吃饭` | 12:00 |

**必须返回 `null` 的负对照**（这些是「不许瞎猜」的证据）：

```js
parseSchedule('今天天气不错', now)        → null   // 有时间词「今天」但没有时刻
parseSchedule('提醒我一下', now)          → null   // 有触发词但没有时刻
parseSchedule('我明天要收衣服', now)      → null   // 有日期但没有时刻
parseSchedule('11点到9点开会', now)       → null   // ★ 结束早于开始（跨天），不猜，交给大脑反问
parseSchedule('', now)                    → null
parseSchedule('25点提醒我', now)          → null   // 不存在的时刻
parseSchedule('0分钟后提醒我', now)        → null   // ★ 0 分钟不算日程（否则会立刻重复提醒）
```

- [ ] **Step 1: 写失败的测试**

新建 `scripts/test-nl-time.js`，表驱动：

```js
// now 固定成一个「好算的时间」，避免测试依赖真实时间：
//   const NOW = new Date(2026, 9, 12, 15, 12, 0);   // 2026-10-12 周一 15:12:00
const CASES = [
  { text: '30分钟后提醒我收衣服', want: { title: '收衣服', kind: 'point', time: '15:42',
      repeat: 'once', date: '2026-10-12', confidence: 'high' } },
  // ... 上面表格里的每一条 ...
  { text: '今天天气不错', want: null },
  // ...
];
// 逐条比对：只比 want 里给出的字段（其余字段忽略），
// 每条打印一行「✓/✗ 原文 → 实际结果」。
// ★ 文件末尾必须单独统计一次「负对照通过数」，负对照一条都不许失败。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-nl-time.js`
Expected: FAIL —— `Cannot find module '../src/main/nl-time'`。

- [ ] **Step 3: 实现 `src/main/nl-time.js`**

分三步做，每步做完都跑一次测试（不要一次写完）：

1. **时刻识别**：`parseClock(s)` 处理 `8点 / 8点半 / 8点15分 / 08:15 / 20:00`，
   以及中文数字 `三点 / 十点 / 十二点半`；配合 `早上|上午|中午|下午|晚上` 定上下午。
   规则：`下午/晚上` + 1~11 点 → +12；`早上/上午` + 12 点 → 12:00；没有前缀时
   1~11 点按上午算，12 点按 12:00。
2. **日期与重复识别**：`今天 / 明天 / 后天`、`每天 / 工作日 / 每周X / 周一 / 周天`。
   日期一律用 `schedules.localDateKey()` 算，**不要**手写 `toISOString()`。
3. **拼装 + 剥标题**：把命中的片段从原文里剪掉，剩下的当 `title`；
   剪完如果为空（比如「30分钟后提醒我」），`title` 用 `'提醒'`，并把 `confidence` 降成 `'low'`。

`confidence` 的规则写死在注释里：**所有字段都明确识别出来 → 'high'；
靠默认值补出来的 → 'low'**。Task 10 的路由要用它。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-nl-time.js`
Expected: 全部用例通过，负对照 7 条全通过，收尾行 0 失败。

- [ ] **Step 5: Commit**

```bash
git add src/main/nl-time.js scripts/test-nl-time.js
git commit -m "聊天大脑·本地：中文大白话 → 日程草案（含 7 条不许瞎猜的负对照）"
```

---

### Task 8: 本地大脑 —— 台词库 + 意图判定

**Files:**
- Create: `src/main/brain/local.js`
- Test: `scripts/test-brain-local.js`（新建）

**Interfaces:**
- Consumes: `nl-time.js` 的 `parseSchedule`（Task 7）
- Produces:

```js
// ctx = { now: Date, items: item[] }
// rand 是注入的随机源（默认 Math.random），测试时传固定值让台词可预测
respond(text, ctx, rand = Math.random) → {
  reply: string,      // 大肥鱼要说的话
  draft: null | { title, kind, time, endTime, repeat, date, weekdays },
  intent: 'add' | 'list' | 'chat',
  confidence: 'high' | 'low',
}
```

**意图判定顺序**（写死在注释里，顺序不能换）：

1. `parseSchedule()` 命中 → `intent: 'add'`，`draft` 就是解析结果，
   `reply` 必须**复述**它听到了什么：`好，我 ${whenText} 提醒你${title}`。
2. 有触发词（`提醒我 / 记得 / 别忘 / 帮我记`）但没解析出时刻 → `intent: 'add'`，
   `draft: null`，`reply` 是反问：`几点提醒你呀？你可以说「30分钟后提醒我收衣服」`。
3. 问日程（`今天有什么 / 明天安排 / 我有什么事`）→ `intent: 'list'`，
   `reply` 用 `ctx.items` 拼出人话列表（空列表要说「今天没什么安排，可以躺平～」）。
4. 其它 → `intent: 'chat'`，从台词库里按关键词挑一句。

- [ ] **Step 1: 写失败的测试**

`scripts/test-brain-local.js` 的断言：

```js
// ① 解析成功 → draft 齐全 + 回复里复述了时间和事情
//    ★ 断言：reply 同时包含「收衣服」和「15:42」（复述是需求的一部分，不是装饰）
// ② 只有触发词没有时刻 → draft === null 且 reply 里带「几点」
//    ★ 负对照：这种情况**绝不能**返回一个 draft（否则会凭空建一条日程）
// ③ 问日程 → intent === 'list'，reply 里包含已存在日程的标题
//    ★ 负对照：items 为空时 reply 里不能出现任何标题，且不能说「你有 0 个安排」这种机器话
// ④ 闲聊 → intent === 'chat'，reply 非空、长度 > 0
// ⑤ ★ 负对照：同样的输入 + 固定 rand，两次调用必须得到同一句台词（可复现，不是随机乱飘）
// ⑥ ★ 负对照：台词库里每一条都不能是空字符串（防手滑留空行）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-brain-local.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/main/brain/local.js`**

台词库放在文件顶部的 `PERSONA` 常量里，按关键词分组（`打招呼 / 夸她 / 抱怨 / 累了 /
晚安 / 饿了 / 不知道`），每组 3~5 句，**用「大肥鱼」的语气**（软、短、偶尔带点撒娇，
不要用感叹号连发，不要用网络烂梗）。挑句子用 `rand()` 取下标，**不要**用 `Date.now()`
当随机源（那样测试不可复现）。

`whenText` 是给主人看的自然语言时间（`30 分钟后 / 明天早上 8:00 / 每周一三五 09:00`），
写成一个小的 `describeWhen(draft, now)` 放在本文件里。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-brain-local.js`
Expected: 0 失败。

- [ ] **Step 5: Commit**

```bash
git add src/main/brain/local.js scripts/test-brain-local.js
git commit -m "聊天大脑·本地：台词库 + 加日程/查日程/闲聊三种意图"
```

---

### Task 9: 云端大脑 —— OpenAI 兼容请求 + 回复解析 + Key 掩码

**Files:**
- Create: `src/main/ai-config.js`
- Create: `src/main/brain/cloud.js`
- Test: `scripts/test-brain-cloud.js`（新建，起假服务器）

**Interfaces:**
- Produces:

```js
// ai-config.js —— 存 userData/ai-config.json，绝不写程序目录
read() → { baseUrl: string, apiKey: string, model: string, enabled: boolean }
write(cfg) → boolean
maskKey(key) → string        // 'sk-1234...abcd' → 'sk-****abcd'；空串 → '（没填）'

// brain/cloud.js
configure({ baseUrl, apiKey, model, timeoutMs })   // 只存在内存里，不落盘
isConfigured() → boolean     // baseUrl 和 apiKey 都非空才算配好
respond(text, ctx) → Promise<{ reply, draft } | { error }>   // 绝不抛异常
extractReply(raw) → { reply: string, draft: object | null }  // 纯函数，好测
TIMEOUT_MS === 15000
```

**请求约定**（写进注释）：`POST {baseUrl}/chat/completions`，
`Authorization: Bearer {apiKey}`，body 里 `messages` 第一条是 system prompt，
要求模型**只输出一个 JSON 对象**：

```json
{ "reply": "给主人看的话", "schedule": null }
```
或
```json
{ "reply": "…", "schedule": { "title": "收衣服", "kind": "point",
  "time": "15:42", "endTime": null, "repeat": "once",
  "date": "2026-10-12", "weekdays": [] } }
```

system prompt 里必须写明：**「不知道就 `schedule: null`，绝对不要编时间」**，
并把当前时间、今天的日期、以及主人已有日程的标题清单喂给它。

- [ ] **Step 1: 写失败的测试**

`scripts/test-brain-cloud.js` 用 `node:http` 起一个假服务器（监听 `127.0.0.1:0`，
拿到真实端口后 `configure({ baseUrl: 'http://127.0.0.1:PORT/v1', ... })`）：

```js
// ① 正常：假服务器返回 {"reply":"好呀","schedule":{...}}
//    ★ 断言：reply === '好呀'，draft.title === '收衣服'
// ② ★ 负对照：假服务器返回 HTTP 500 → respond() 返回 { error: ... }，**不抛异常**
// ③ ★ 负对照：假服务器 8 秒不响应，timeoutMs 设成 1000 → 必须在 2 秒内返回 { error }
//    （用 Date.now() 前后差来量，别用「看起来很快」）
// ④ ★ 负对照：假服务器返回不是 JSON（'抱歉我不会'）→ 整段当 reply，draft === null，不抛
// ⑤ ★ 负对照：返回 ```json 包裹的 JSON → 必须能剥掉围栏解析成功
// ⑥ ★ 负对照：返回 {"reply":"…","schedule":{"time":"25:00",...}} →
//    extractReply 照样把 draft 递出来（校验不在这里做），
//    但 respond() 的调用方（Task 10）必须能把它挡掉 —— 这里断言 draft 非 null 即可，
//    真正的拦截测试在 Task 10
// ⑦ ★ 负对照：Key 泄漏 —— 把 apiKey 设成 'sk-SECRET-1234'，
//    然后遍历 respond() 的返回值和终端日志文本，**断言里面不出现 'SECRET'**
//    （做法：临时把 console.error 换成收集器，跑一遍再看收集到的文本）
// ⑧ maskKey('sk-1234567890abcd') === 'sk-****abcd'；maskKey('') === '（没填）'
// ⑨ ai-config：write 之后 read 出来一致；★ 负对照：文件写坏（写进去 '{oops'）时 read() 返回默认值不抛
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-brain-cloud.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/main/ai-config.js`**

`read()` 用 `store.read('ai-config.json', null)`，把结果逐字段校验并补默认值
（`baseUrl: ''`、`apiKey: ''`、`model: ''`、`enabled: false`）。**永远返回一个对象，不返回 null。**

- [ ] **Step 4: 实现 `src/main/brain/cloud.js`**

- `extractReply(raw)`：先 `trim()`，剥掉 ` ```json ` / ` ``` ` 围栏，
  然后从第一个 `{` 到最后一个 `}` 截出来 `JSON.parse`；
  失败就把整段当 `reply`、`draft = null`。
- `respond()`：`AbortSignal.timeout(TIMEOUT_MS)` + `try/catch` 包住一切，
  失败返回 `{ error: '人话原因' }`。
  **错误消息里绝不带 apiKey，也不带完整 URL 的 query**（`Authorization` 头更不能进日志）。
- 成功时把 `schedule` 原样作为 `draft` 返回，**不做任何校验** ——
  校验统一在 `schedules.sanitize`，这是硬性约定。在注释里写明这一点，
  免得以后有人「顺手」在这里加一层。

- [ ] **Step 5: 跑测试确认通过**

Run: `node scripts/test-brain-cloud.js`
Expected: 0 失败（9 组全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/main/ai-config.js src/main/brain/cloud.js scripts/test-brain-cloud.js
git commit -m "聊天大脑·云端：OpenAI 兼容请求 + 回复解析 + Key 掩码（含假服务器对照）"
```

---

### Task 10: 大脑路由器 —— 本地优先、云端兜底、失败降级

**Files:**
- Create: `src/main/brain/index.js`
- Test: `scripts/test-brain-router.js`（新建）

**Interfaces:**
- Consumes: `brain/local.js`、`brain/cloud.js`、`ai-config.js`、`schedules.js`
- Produces:

```js
init({ getItems, getConfig })     // getItems: () => item[]；getConfig: () => 配置对象
respond(text, now = new Date()) → Promise<{
  reply: string,
  draft: null | object,           // ★ 已经过 schedules.sanitize 校验的草案，可直接落盘
  source: 'local' | 'cloud',
  note: null | string,            // 给主人看的提示，如「云端暂时用不了，先用本地模式回你」
  rejected: null | string,        // 草案被校验拒掉的原因（调试用，界面上不显示）
}>
```

**路由顺序**（写死在注释里，这是本 Task 唯一的核心决策）：

1. `nl-time.parseSchedule()` 命中且 `confidence === 'high'`
   → 直接返回本地结果，**不问云端**。
   理由：这是主人最常用的说法（「30分钟后提醒我收衣服」），本地解析比 AI 更准、0 延迟、离线可用。
2. 否则若云端已配置且 `enabled`
   → 问云端（闲聊 + 复杂说法都靠它）。
   拿到 `draft` 后**必须**过 `schedules.sanitize()`：
   - 通过 → 用 `sanitize` 洗过的结果（不是原始草案）
   - 不通过 → `draft = null`、`rejected = sanitize 的原因`，只回文字
3. 云端没配 / 超时 / 报错 / 草案被拒
   → 退回本地大脑；若本地也听不出日程，就给一句台词 + `note`。

- [ ] **Step 1: 写失败的测试**

```js
// ① 本地高置信命中时：source === 'local'，且★ 云端一次都没被调用
//    做法：给 router 注入一个「被调用就抛异常」的假云端
// ② ★ 负对照：本地低置信时**必须**去问云端（同样用假云端，断言它被调用了 1 次）
// ③ 云端返回的草案 time='25:00' → draft === null，reply 里不能出现「25:00」，
//    且 ★ rejected 里带着人话原因（例如「时间格式不对」）
// ④ ★ 负对照：云端返回的草案完全合法 → draft 非 null，且 draft 的字段是
//    sanitize 洗过的（例如 repeat 被补成 'once'、weekdays 被清成 []）
// ⑤ 云端抛异常 → source === 'local'、note 非空、reply 非空（不能把错误抛给界面）
// ⑥ ★ 负对照：note 只在「降级」时出现，正常路径下 note === null
// ⑦ 云端草案 title 为空串 → 被拒，draft === null
// ⑧ 云端草案 kind='span' 但 endTime 早于 time → 被拒
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-brain-router.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/main/brain/index.js`**

注入式设计：`init({ getItems, getConfig, localBrain, cloudBrain })`，
默认用真实实现，测试时传假的。**不要**在文件顶层 `require` 完就固定死。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-brain-router.js`
Expected: 0 失败。

- [ ] **Step 5: Commit**

```bash
git add src/main/brain/index.js scripts/test-brain-router.js
git commit -m "聊天大脑·路由：本地优先、云端兜底、草案一律过校验才放行"
```

---

### Task 11: 聊天条窗口（贴着桌宠的小气泡条）

**Files:**
- Create: `src/main/chat-window.js`
- Create: `src/main/preload-chat.js`
- Create: `src/renderer/chat/index.html`
- Create: `src/renderer/chat/chat.js`
- Modify: `src/main/main.js`（初始化 + 托盘菜单加一项）
- Test: `src/main/selftest-chat.js` 会在 Task 13 写；本任务只做**目视确认**

**Interfaces:**
- Produces:

```js
// chat-window.js
CHAT_W === 320, CHAT_H === 440
init({ getPetWindow, onSend, onConfigGet, onConfigSet, onConfigTest })
open() / close() / toggle() / isOpen() / getWindow() / reposition()
// 窗口配置：frame:false + transparent:true + alwaysOnTop('screen-saver')
//          + skipTaskbar:true + focusable:true（★ 主人要打字，和气泡窗口相反）
// 位置：placeNear(petRect, { w: CHAT_W, h: CHAT_H }, workArea)
// 桌宠移动时跟着走：pet.on('move', reposition)（打开时挂、关闭时摘）

// preload-chat.js 暴露 window.chatAPI
send: (text) => ipcRenderer.invoke('chat:send', text)   // → { reply, created, source, note, error }
history: () => ipcRenderer.invoke('chat:history')        // → [{ role:'me'|'fish', text, at, scheduleId }]
clear: () => ipcRenderer.invoke('chat:clear')
undo: (scheduleId) => ipcRenderer.invoke('chat:undo', scheduleId)
configGet: () => ipcRenderer.invoke('chat:config-get')   // → { baseUrl, model, enabled, keyMask, hasKey }
configSet: (cfg) => ipcRenderer.invoke('chat:config-set', cfg)
configTest: () => ipcRenderer.invoke('chat:config-test')
close: () => ipcRenderer.send('chat:close')
```

- [ ] **Step 1: 实现 `src/main/chat-window.js`**

照 `settings-window.js` 的结构写，但窗口参数照 `reminder.js` 的**透明卡片**那一套
（`frame:false` + `transparent:true` + `roundedCorners:false`），唯一区别是
**`focusable: true`**。在文件顶部用一段注释把「为什么这个窗口能抢焦点、气泡窗口不能」
写清楚（这是最容易照抄错的地方）。

`reposition()` 里用 `setBounds({ x, y, width: CHAT_W, height: CHAT_H })`
（**不要**只 `setPosition`，会踩 `HANDOFF` 第六节第 32 条那个「窗口越拖越大」的坑）。

- [ ] **Step 2: 实现界面 `src/renderer/chat/index.html` + `chat.js`**

- CSP 照气泡窗口那份写紧：`default-src 'none'; style-src 'unsafe-inline'; script-src 'self'`。
  **不需要** `connect-src` —— 所有网络请求都在主进程。
- 结构：顶部一条（`大肥鱼` + `⚙` + `✕`）／中间消息列表（`overflow-y:auto`）／
  底部 `<textarea>` + 「发送」按钮。
- ⚠ **所有消息一律用 `textContent` 渲染**（`document.createTextNode`），
  绝不碰 `innerHTML` —— 主人和 AI 的文本都不当 HTML 解析（Review Focus 第 5 条）。
- 发送流程：先把主人的话上屏 → 立刻显示一条「…」气泡 → `await chatAPI.send(text)`
  → 用回复替换「…」。**期间输入框保持可用**（不要 disable，网络慢的时候主人不至于以为卡死）。
- 回复里若 `created` 有值，在气泡下面挂一个「撤销」小按钮 → `chatAPI.undo(id)`。
- 键盘：`Enter` 发送、`Shift+Enter` 换行。
- `⚙` 面板：`服务地址` / `模型名` / `API Key`（`type="password"`）/
  「启用云端 AI」开关 / 「测试连接」按钮 / 一行小字说明
  「不填也能用，只是闲聊会变成它自己的台词」。

- [ ] **Step 3: 实现 `src/main/main.js` 里的 IPC 与初始化**

```js
// 聊天记录存 userData/chat.json（只留最近 200 条，超了从头部丢）
// chat:send 的流程：
//   ① 把主人的话 push 进历史
//   ② 调 brain.respond(text)
//   ③ 若 result.draft 非空 → schedules.add(result.draft)
//      · 成功 → created = { id, title, time, endTime }
//      · 失败 → 不建，reply 后面补一句「（这条我没记住，你再说一次？）」
//   ④ 把大肥鱼的回复 push 进历史，返回给界面
// chat:undo → schedules.remove(id)，并把历史里那条的 scheduleId 清掉
```

// 云端配置的四个通道（注意 read() 和 configGet() 的形状**故意不一样**）：
//   aiConfig.read()      → { baseUrl, apiKey, model, enabled }   ← 带明文 Key，只在主进程里流转
//   chat:config-get 返回  → { baseUrl, model, enabled, keyMask, hasKey }
//     · keyMask = aiConfig.maskKey(cfg.apiKey)   ← ★ 明文 Key 绝不发给渲染进程
//     · hasKey  = Boolean(cfg.apiKey)
//   chat:config-set 收    → { baseUrl, model, apiKey, enabled }
//     · apiKey 为空串表示「不改 Key」（主人只改模型名时不该把 Key 抹掉）
//     · 落盘前调 cloud.configure(...) 让新配置立刻生效
//   chat:config-test      → 用当前配置发一句「你好」，返回 { ok } 或 { error: '人话原因' }
//     · ★ 错误消息里不能出现 apiKey（复用 cloud.js 里那份已经脱敏的错误处理）
```

托盘菜单加一项 `{ label: '和大肥鱼聊天', click: () => chatWindow.toggle() }`，
放在「日程管理…」下面。

- [ ] **Step 4: 目视确认**

Run: `PET_OPEN_SETTINGS=1 npm start -- --no-gpu`
（临时在 `main.js` 里加 `PET_OPEN_CHAT=1` 时自动开聊天条，方便截图；这个环境变量留在代码里，
和现有的 `PET_OPEN_SETTINGS` 一个套路。）

Expected:
- 聊天条出现在桌宠**右边**、贴着它，卡片圆角、半透明背景不遮挡桌面；
- 在里面打字 → 回车 → 大肥鱼回话；
- 打「30分钟后提醒我收衣服」→ 它复述「好，我 30 分钟后（HH:mm）提醒你收衣服」，
  然后**关掉聊天条、打开日程管理**，列表里真的多了一条；
- 拖动桌宠 → 聊天条跟着走；
- 点 `✕` → 收起，再点托盘菜单 → 又出来。

- [ ] **Step 5: Commit**

```bash
git add src/main/chat-window.js src/main/preload-chat.js src/renderer/chat src/main/main.js
git commit -m "聊天条：贴着桌宠的小气泡条，能聊天、能加日程、能填云端配置"
```

---

### Task 12: 桌宠上的「聊天」按钮 + 层级联动

**Files:**
- Modify: `src/renderer/pet/index.html`
- Modify: `src/renderer/pet/renderer.js`
- Modify: `src/main/preload.js`
- Modify: `src/main/main.js`
- Modify: `src/main/settings-window.js`（打开设置窗口时也把聊天条降层）
- Test: `src/main/main.js`（扩展 `runExitButtonSelfTest`）

**Interfaces:**
- Consumes: `chatWindow.toggle()`（Task 11）
- Produces: `petAPI.openChat()`；桌宠界面新增 `#btn-chat`（**必须挂 `data-ui="1"`**），
  位置在 `#btn-settings` 左边（`right: 84px`）。

- [ ] **Step 1: 写失败的断言**

在 `runExitButtonSelfTest()` 里，紧跟现有「按钮就在它自己的位置上」那组之后插入：

```js
// 断言：★ 桌宠界面上存在 #btn-chat，且 elementFromPoint 在它中心返回的最顶层
//       元素（用 closest('[data-ui]')）就是它本身
//       —— 这条是防 HANDOFF 第六节第 21 条那个「静默点不到」的坑
// 断言：★ 把鼠标移上去，hitState().overUi === true 且 through === false
// 断言：★ 点一下之后 chatWindow.isOpen() === true
// 断言：★ 负对照：聊天条窗口的 focusable === true（主人要打字），
//       而同一时刻气泡窗口的 focusable === false —— 两个值必须**不一样**，
//       否则说明有人把窗口参数照抄串了
// 断言：★ 关掉聊天条之后，桌宠依然是 focusable:false 且 isAlwaysOnTop() === true
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:exit`
Expected: FAIL —— 找不到 `#btn-chat`。

- [ ] **Step 3: 实现**

- `index.html`：在 `#btn-settings` 前加一个同样样式的圆形按钮，图标用一段内联 SVG
  （对话气泡形状），`id="btn-chat"`、`data-ui="1"`、`title="和大肥鱼聊天"`。
- `renderer.js`：`document.getElementById('btn-chat').addEventListener('click', () => window.petAPI.openChat())`
- `preload.js`：`openChat: () => ipcRenderer.send('pet:open-chat')`
- `main.js`：`ipcMain.on('pet:open-chat', () => chatWindow.toggle())`
- `settings-window.js`：`lowerPet()` / `restorePet()` 里顺手把聊天条也降/升层
  （通过新注入的 `getChatWindow`）。**注释里写明**：不这样做的话，设置窗口打开时
  会被聊天条压住一块。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:exit && npm run test:focus && npm run test:sync`
Expected: 三个都 0 失败（`test:focus` 里已经有「设置窗口能抢焦点」的负对照，
新增聊天条后不能被它带红）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pet/index.html src/renderer/pet/renderer.js src/main/preload.js src/main/main.js src/main/settings-window.js
git commit -m "桌宠上加「聊天」按钮，聊天条跟着宠物走、跟着设置窗口降层"
```

---

### Task 13: 聊天端到端自检（独立哨兵）

**Files:**
- Create: `src/main/selftest-chat.js`
- Modify: `src/main/main.js`（加 `PET_SELFTEST === 'chat'` 分支）
- Modify: `package.json`

**Interfaces:**
- Produces: `module.exports = { run(ctx) }`，`ctx` 同 Task 6，另加 `chatWindow`、`brain`、`aiConfig`。

- [ ] **Step 1: 写自检**

```js
// ① 打开聊天条
//    ★ 断言：窗口真的可见（isVisible），尺寸是 CHAT_W×CHAT_H
//    ★ 断言：位置贴着桌宠（用 placeNear 复算一遍和实际位置比对）
// ② 端到端加日程：从**界面 DOM** 里往输入框打字并按回车
//    （做法：executeJavaScript 设置 textarea.value + dispatchEvent(new Event('input'))
//      + 调 document.getElementById('send').click()）
//    ★ 断言：界面消息列表里出现两条（主人的话 + 大肥鱼的回复）
//    ★ 断言：主进程 schedules.list() 里真的多了一条，标题是「收衣服」
//    ★ 断言：这条的 time 和「当前时间 + 30 分钟」对得上（允许 ±1 分钟，因为跨分钟取整）
//    ★ 断言：回复文本里同时出现「收衣服」和那个时刻（复述是需求）
// ③ ★ 负对照：发「今天天气不错」→ 文件里条数**不变**，回复非空
//    （证明它不是「不管听懂没听懂都建一条」）
// ④ ★ 负对照：发「提醒我一下」（有触发词没时刻）→ 条数不变，回复里带「几点」
// ⑤ 撤销：点回复下面那个「撤销」→ 条数变回去，且界面那条的按钮消失
// ⑥ ★ 负对照：Key 不能泄漏 —— 把 apiKey 设成 'sk-SECRET-1234'、
//    服务地址指到一个必然连不上的端口，然后发一句话。
//    断言：聊天记录全文、终端日志全文里都不出现 'SECRET'；
//    且 source === 'local'、note 非空（降级了，但没崩）
// ⑦ ★ 负对照：把输入框里的文本设成 '<img src=x onerror="window.__xss=1">' 发出去，
//    等 600ms，然后断言：
//    · 界面消息列表里那一行的 textContent 就是原样那串字符
//    · 页面里查不到 img 元素（document.querySelectorAll('img').length === 0）
//    · window.__xss === undefined
// ⑧ 清理：删掉自检建的日程 + 清空聊天记录
```

- [ ] **Step 2: 跑自检确认通过**

在 `package.json` 加 `"test:chat-e2e": "node scripts/start-dev.js --no-gpu --selftest=chat --isolated"`，然后：

Run: `npm run test:chat-e2e`
Expected: `===== 聊天自检结束：NN 通过 / 0 失败 =====`

- [ ] **Step 3: 故意改坏，确认自检能红**

把 `main.js` 里 `chat:send` 的那段临时改成「不管 `draft` 是不是 null 都建一条」，
重跑。
Expected: 第 ③ 条断言**变红**。改回去，再跑确认全绿。

- [ ] **Step 4: Commit**

```bash
git add src/main/selftest-chat.js src/main/main.js package.json
git commit -m "聊天端到端自检：加日程/不瞎建/可撤销/不泄密/不执行 HTML"
```

---

### Task 14: 文档、全量回归、收尾

**Files:**
- Modify: `HANDOFF.md`（§3 加两条需求、§4 加命令、§6 加新坑、目录树）
- Modify: `CLAUDE.md`（目录树、命令表、新坑）
- Modify: `.workbuddy-ai/memory/2026-10-12.md`（追加当天记录）

- [ ] **Step 1: 跑全量回归**

```bash
npm run test:schedules && npm run test:scheduler && npm run test:reminder \
 && npm run test:place && npm run test:exit && npm run test:gaze && npm run test:drag \
 && npm run test:focus && npm run test:sync && npm run test:quit \
 && npm run test:week && npm run test:nl-time && npm run test:brain-local \
 && npm run test:brain-cloud && npm run test:brain-router \
 && npm run test:reminder-e2e && npm run test:scheduler-e2e \
 && npm run test:settings-e2e && npm run test:week-e2e && npm run test:chat-e2e
```
Expected: **每一项都是 0 失败**。任何一项红了就停下来修，不要往下走。

- [ ] **Step 2: 更新文档**

`HANDOFF.md` §6 至少补这几条新坑（写清「现象 → 根因 → 怎么躲」）：
1. 时段不允许跨天，`endTime` 必须严格晚于 `time`（否则周视图和提醒语义都会乱）
2. 云端 AI 的输出**必须**过 `schedules.sanitize`，幻觉出来的 `25:00` 不能落盘
3. 聊天条 `focusable:true`、气泡窗口 `focusable:false` —— 两个窗口参数相反，**别照抄**
4. 聊天记录和日程标题一律 `textContent`，绝不用 `innerHTML`
5. API Key 只存 `userData/ai-config.json`，日志里只有掩码形式

- [ ] **Step 3: 目视验收一次（人工）**

Run: `npm start`（或桌面「启动桌宠」）
逐条走一遍主人的原始需求：
1. 日程界面有个「周视图」按钮 → 点了出现周一到周日七列 ✅
2. 不同颜色的圆角长方体 ✅
3. 时段是高的、时间点是扁的 ✅
4. 在周视图上点一下能改 ✅
5. 能和桌宠聊天 ✅
6. 说「30分钟后提醒我收衣服」，日程真的加上了 ✅

- [ ] **Step 4: 追加记忆**

在 `.workbuddy-ai/memory/2026-10-12.md` 末尾追加：做了什么、哪些决定是主人拍板的、
哪些是小安拍的（附理由）、下一步可以做什么。

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md CLAUDE.md .workbuddy-ai/memory
git commit -m "文档：周视图与聊天上线，五条新坑入册"
```

---

## 执行顺序与依赖

```
Task 1 (数据层 span)
   ↓
Task 2 (week.js 纯函数)
   ↓
Task 3 (表单支持时段)  ←── 到这一步主人已经能手动建时段日程了，可以停下来验收
   ↓
Task 4 (周视图骨架+方块)
   ↓
Task 5 (周视图点击修改)
   ↓
Task 6 (周视图 e2e)     ←── 到这一步「周视图」整个需求完成，可以停下来验收
   ↓
Task 7 (nl-time 纯函数)
   ↓
Task 8 (本地大脑)
   ↓
Task 9 (云端大脑 + 配置)
   ↓
Task 10 (路由与降级)     ←── 到这一步「大脑」完成，但还没有界面
   ↓
Task 11 (聊天条窗口)
   ↓
Task 12 (桌宠聊天按钮)
   ↓
Task 13 (聊天 e2e)       ←── 到这一步「聊天」整个需求完成
   ↓
Task 14 (文档+全量回归)
```

**Task 1–6 是一条线（周视图），Task 7–13 是另一条线（聊天），两条线之间只有一个依赖：
Task 11 要用 Task 10 的大脑。** 如果中途想先看效果，Task 6 和 Task 13 都是干净的停靠点。

## 主人需要准备的一件事（可选）

云端 AI 需要一个 API Key。**不填也能用**（纯本地模式，闲聊会变成大肥鱼的台词库）。
想开的话，去任意一家 OpenAI 兼容的服务商申请（DeepSeek、阿里百炼、月之暗面都行），
拿到三样东西填进聊天条里的 `⚙` 面板：

| 填什么 | 长什么样 |
|---|---|
| 服务地址 | `https://api.deepseek.com/v1` |
| 模型名 | `deepseek-chat` |
| API Key | `sk-xxxxxxxx`（只存在您自己的电脑上） |
