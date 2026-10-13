# 桌宠升级 v3 · 专注模式 Implementation Plan

> **执行方式：** 本仓库由「小安」在 WorkBuddy 会话里**逐任务执行**。
> 每个 Task 结束必须：跑该任务的验证命令 → 看到预期输出 → `git commit` 一次。
> **任务之间不要合并提交**，也不要跳过负对照步骤。
>
> （本仓库不使用外部 sub-skill 编排：桌宠是单实例 Electron 程序，
> 自检必须串行跑，并行子代理会互相顶掉进程。）

**Goal:** 让主人能对桌宠说「我要专注了」——预设的网站打不开、预设的软件被关掉，
大肥鱼在旁边陪着；专注结束，一切恢复原样。

**Architecture:**
沿用项目一贯的「**危险操作全隔离、纯逻辑可单测**」套路，把专注模式切成三段：

1. **地基（不碰系统）**：专注计时器 + 黑名单 + 界面 + 宠物陪伴。这一段能独立跑通、
   能纯 Node 单测、能端到端自检，**即使后面拦截做不出来，这一段也是个能用的功能**。
2. **拦截（动系统）**：`hosts.js`（纯字符串操作，可跑上百个测试）算好「新的 hosts 全文」，
   交给**一个被提权的常驻助手**去落盘；禁软件由同一个助手轮询进程 + `taskkill`。
   **整段专注只弹一次 UAC** —— 助手全程活着，结束由它自己收尾。
3. **收尾**：拦截提示窗口 + 宠物反馈 + 结束报告。

**Tech Stack:** Electron 44.7.0 + 原生 HTML/CSS/JS；无框架、无打包器、无 TypeScript；
**不新增任何 npm 依赖**（进程扫描、提权调用都用 Node 内置能力 + 系统自带 PowerShell）；
Live2D 相关版本锁死不动（`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`）。

**Spec:** `PLAN.md` 第三节（专注模式原始设计）+ 主人 2026-10-14 拍板的四条（见下）
+ 小安 2026-10-14 做的市面同类应用调研（Cold Turkey / Freedom / SelfControl / Forest / 番茄ToDo）。

---

## 零、需求原文与已拍板的选择

### 原始需求（`PLAN.md` 第三节）

> 「开启「专注」后，你预设的网站打不开、预设的软件被关掉；结束专注后，一切恢复原样。」

### 已拍板的四个选择（主人 2026-10-14）

| 问题 | 选择 | 为什么这么定（调研结论） |
|---|---|---|
| 先做哪部分 | **先做专注计时器**（倒计时 + 宠物陪伴 + 状态显示，**完全不碰系统**），跑通再接拦截 | 符合「先让它活着，再让它管你」；地基先稳，危险部分最后接 |
| 能否提前退出 | **长按 3 秒才放行** | 调研发现「强制程度」才是灵魂：Cold Turkey 的 Frozen 模式、SelfControl 的「到点才能解」都证明——**能随时一键退出的工具等于没用**；但完全锁死会劝退小白。长按 3 秒是折中：拦掉冲动一下的手，又不至于让人被绑架 |
| DoH 怎么处理 | **检测 + 引导关闭**，暂不做浏览器插件 | 插件要额外装、每个浏览器都要装、还要维护；先不加新负担 |
| 怎么触发专注 | **先手动按钮**，绑定日程时段以后再加 | 手动最简单，跑通后再跟日程系统打通 |

### 小安拍板、主人可随时推翻的细节

| 细节 | 决定 | 理由 |
|---|---|---|
| 禁软件方案 | **方案 A：轮询杀进程**（不改注册表 IFEO） | 方案 B 改错注册表可能影响系统，风险太高；除非主人明确要 |
| 长按时长 | **3 秒**（写死，先不做可调） | 短了拦不住冲动，长了手酸 |
| 时长预设 | **25 / 45 / 60 分钟 + 自定义** | 25 分钟是番茄钟标准，另两个覆盖大块时间 |
| 计时怎么走 | **每 5 秒轮询**，不用 `setTimeout` | 电脑睡眠/关机再开，`setTimeout` 会丢事件（项目硬约定） |
| 提权次数 | **整段专注只弹一次 UAC** | 起一个**常驻的提权助手**，从写入 hosts 一直活到结束；不然结束时还原 hosts 还得再弹一次 |
| 助手由什么执行 | **系统自带 PowerShell**（脚本纯 ASCII，不含中文） | 不依赖 Node 在 PATH 上；`.ps1` 里**绝不能写中文**（照 `.bat` 那条坑） |
| 黑名单屏蔽自身 | **强制**：`electron.exe` / `node.exe` / 桌宠自身进程名 / 系统关键进程一律拒收 | 别把自己杀了，也别把系统搞崩（硬约束 3） |
| 拦截强度定位 | **自律工具，不防任务管理器** | 主人真想绕永远能绕；不做监控软件（硬约束 4） |
| 崩溃残留 | **双保险**：启动时自动清理 + 提权助手到点自愈 | 程序崩了 hosts 里不能留垃圾行（硬约束 5） |
| 宠物反馈 | 进入专注换姿态 + 说话；专注中偷懒被抓包有反应；结束给一句鼓励 | 这是调研里**所有同类工具都没有**的差异化：别人只有冷冰冰的拦截页，我们有会生气/会委屈的鱼 |

---

## Global Constraints

以下每条都是本仓库已有的硬性约定，**每个 Task 都隐含包含**，不要重新发明：

- **渲染进程绝不碰系统**：一律走 IPC；`contextIsolation: true` + preload + `contextBridge`，
  **绝不**开 `nodeIntegration`（`CLAUDE.md` 硬性约定 1、2 条）。
- **不新增 npm 依赖**。进程扫描用 Node 内置；提权走系统自带 PowerShell。
  Live2D 版本锁死（`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`），**不要 `npm update`**。
- **用户数据一律放 `app.getPath('userData')`**，绝不写程序目录（约定第 3 条）。
  专注数据落 `userData/focus.json`，提权计划落 `userData/focus-plan.json`，
  控制文件落 `userData/focus-ctl.json`。
- **校验只有一处**：日程校验仍在 `src/main/schedules.js` 的 `sanitize()`。
  专注黑名单的校验统一在 `src/main/focus/blacklist.js`，界面**不得**自带第二套规则。
- **时间一律本地时间 `HH:mm` / `YYYY-MM-DD`**，绝不碰 UTC，**绝不用 `toISOString()`**。
- **自检必须带负对照**：只验「我调了函数、没报错」不算证据；必须有一条「坏数据必须被拒」
  或者「旧写法必须复现问题」的断言（`HANDOFF.md` 第六节第 19 条）。
- **纯函数刻意不 `require('electron')`**，这样能脱离 Electron 单测（照 `place.js` 的做法）。
- **数据层自检走独立 Node 脚本**；Electron 类自检**串行跑** ——
  桌宠是单实例程序，跑着的时候再启动会直接退出。
- **往桌宠界面加任何 DOM 控件必须挂 `data-ui`**，否则穿透判定看不见它，控件会**静默点不到**。
- **焦点策略各不相同，别照抄**：桌宠/气泡 `focusable:false` + `showInactive()`；
  设置窗口、聊天条必须能抢焦点；**新的拦截提示窗口也必须能抢焦点**（主人要看见并做选择）。
- **摆窗口位置一律用 `src/main/place.js` 的 `placeNear()`**，不要自己算。
- **界面文案全中文、大白话**，不出现「进程」「句柄」「提权」这类词（主人是 AI 小白）；
  必须说「关掉正在运行的软件」而不是「终止进程」。
- **每个 Task 一次 commit**，提交信息用中文，说清「做了什么 + 为什么」。

### ⚠️ 命名冲突（**开工前必读**）

`package.json` 里 **`test:focus` 已经被占用**了 —— 它是「桌宠不抢焦点」的自检
（`--selftest=focus`，`main.js` 里的 `runFocusSelfTest`）。**不要覆盖它、不要改它的名字。**

本计划新增的测试一律带 `focusmode` / `focus-` 前缀区分：

| 新脚本 | 用途 |
|---|---|
| `test:focus-blacklist` | 黑名单规范化纯函数单测 |
| `test:focus-timer` | 计时状态机纯函数单测 |
| `test:focus-hosts` | hosts 文本操作纯函数单测 |
| `test:focusmode-e2e` | 专注模式端到端自检（`--selftest=focusmode`） |

---

## Review Focus

以下是需求里没明说、但一碰到就会让主人骂人的五件事。**每一条都必须在对应 Task 里有测试钉住**：

1. **改 hosts 把主人原有的内容搞丢**（整文件覆盖 = DNS 故障，最严重的后果）。
   合理预期：只增删我们标记块里那几行，主人的内容**一字不少**。→ Task 3
2. **程序崩溃后 hosts 里留垃圾行**，导致某些网站一直打不开。
   合理预期：启动时自动清理；提权助手到点也会自愈。→ Task 3、Task 7
3. **把自己杀了 / 把系统关键进程杀了**（黑名单里混进 `electron.exe`、`explorer.exe`、`csrss.exe`）。
   合理预期：黑名单校验阶段就拒收并给出人话原因。→ Task 1
4. **DoH 开着，主人「以为禁了其实没禁」** —— 主人以为专注生效了，结果照样刷。
   合理预期：开始专注前检测到 DoH 就**明确告诉主人**「这个网站可能还拦不住」，并给出关闭方法。
   → Task 7
5. **提权后弹两次 UAC / 结束不了专注**（还原 hosts 又要一次管理员权限）。
   合理预期：整段专注只弹一次；结束走控制文件通知常驻助手，**不是杀进程**（强杀不给收尾机会）。
   → Task 6、Task 9

---

## 文件结构（先定死，别让执行者乱放）

### 新增

| 文件 | 职责 |
|---|---|
| `src/main/focus/blacklist.js` | 纯函数：域名/exe 名规范化 + 危险项屏蔽。**不 require electron** |
| `src/main/focus/timer.js` | 纯函数：专注计时状态机（开始/剩余/到点/长按退出）。**不 require electron** |
| `src/main/focus/hosts.js` | 纯函数：hosts 文本插入/更新/精确删标记块 + 残留检测。**不 require electron** |
| `src/main/focus/store.js` | 专注数据存取（黑名单 / 预设 / 当前会话），落 `userData/focus.json` |
| `src/main/focus/doh.js` | 检测浏览器「安全 DNS」状态，返回人话结论 |
| `src/main/focus/elevate.js` | 提权执行壳：写计划文件 → `Start-Process -Verb RunAs` 起助手 → 写控制文件 |
| `src/main/focus/index.js` | 专注模式主控：编排 timer / hosts / elevate / 助手状态 |
| `src/main/focus-helper.ps1` | 被提权运行的 PowerShell 助手（**纯 ASCII，不许有中文**） |
| `src/main/selftest-focusmode.js` | 专注模式端到端自检 |
| `scripts/test-focus-blacklist.js` | `blacklist.js` 的 Node 单测 |
| `scripts/test-focus-timer.js` | `timer.js` 的 Node 单测 |
| `scripts/test-focus-hosts.js` | `hosts.js` 的 Node 单测（**重点，负对照最多**） |

### 修改

| 文件 | 改什么 |
|---|---|
| `src/main/settings-window.js` | 新增 `focus:*` 一组 IPC 通道 |
| `src/main/preload-settings.js` | 暴露专注相关 API |
| `src/renderer/settings/index.html` | 工具栏加「专注」按钮；加专注页容器 |
| `src/renderer/settings/settings.js` | 专注页渲染与交互（黑名单、预设、开始/结束、倒计时） |
| `src/main/main.js` | 初始化 focus；**启动时残留自愈**；分发 `--selftest=focusmode` |
| `src/renderer/pet/renderer.js` | 宠物「专注中」姿态与台词（复用现有状态机） |
| `src/renderer/pet/index.html` | 若需专注角标，**必须挂 `data-ui`** |
| `package.json` | 新增测试脚本（见下） |
| `HANDOFF-V3.md` / `CLAUDE.md` | 新坑、新命令、目录树 |

**`package.json` 要新增的脚本（一次加齐，别分散在各 Task 里临时加）：**

```json
"test:focus-blacklist": "node scripts/test-focus-blacklist.js",
"test:focus-timer": "node scripts/test-focus-timer.js",
"test:focus-hosts": "node scripts/test-focus-hosts.js",
"test:focusmode-e2e": "node scripts/start-dev.js --no-gpu --selftest=focusmode --isolated"
```

（放在现有 `test:chat-e2e` 之后。**在每个新测试文件诞生的那个 Task 里，
就把它对应的脚本加进 `package.json` 并一起提交** —— 不要留到最后补。）

### 明确不动的

`src/main/scheduler.js`、`src/main/reminder.js`、`src/main/place.js`、`src/main/week.js`、
`src/main/nl-time.js`、`src/main/brain/*`、`src/renderer/bubble/*`、Live2D 相关全部。

---

## 第一段 · 地基：专注计时器（完全不碰系统）

> 这一段做完，主人已经有一个「专注计时 + 宠物陪伴」的功能可以用了。
> **停靠点：Task 5 之后** —— 即使后面拦截全砍掉，项目也不亏。

---

### Task 1: 专注数据层 + 黑名单校验（纯函数）

**Files:**
- Create: `src/main/focus/blacklist.js`
- Create: `src/main/focus/store.js`
- Test: `scripts/test-focus-blacklist.js`（新建）

**Interfaces:**

```js
// blacklist.js —— 刻意不 require electron，好脱离 Electron 单测
// 把主人随手输的一行，规范化成能用的条目；非法/危险的一律拒收。
normalizeDomain(raw) → { ok: true, value: 'bilibili.com' } | { ok: false, error: '人话原因' }
normalizeExe(raw)    → { ok: true, value: 'steam.exe' }    | { ok: false, error: '人话原因' }
isProtectedExe(name) → boolean   // 自身 / 系统关键进程 → true（必须拒收）
PROTECTED_EXES → string[]        // 只读，供测试和界面提示用
sanitizeBlacklist(raw) → { ok: true, domains: string[], exes: string[] } | { ok: false, error }

// store.js —— 走 store.read/write，落 userData/focus.json
read()  → { domains: [], exes: [], presets: [25, 45, 60], lastMinutes: 25 }
write(cfg) → boolean
```

**必须支持的规范化**（每条都要有测试）：

| 输入 | 期望 |
|---|---|
| `https://www.bilibili.com/video/BV1xx?t=1` | `www.bilibili.com`（去协议、去路径、去查询） |
| `BILIBILI.COM` | `bilibili.com`（转小写） |
| `  bilibili.com  ` | `bilibili.com`（去首尾空格） |
| `bilibili.com:443` | `bilibili.com`（去端口） |
| `C:\Program Files\Steam\steam.exe` | `steam.exe`（exe 只留文件名） |
| `Steam.EXE` | `steam.exe`（转小写） |
| `steam` | `steam.exe`（自动补扩展名） |

**必须拒收的负对照**（这些是「不许瞎猜 / 不许自伤」的证据）：

```js
normalizeDomain('')                  → { ok: false }   // 空
normalizeDomain('http://')           → { ok: false }   // 没有主机名
normalizeDomain('这不是域名')        → { ok: false }   // 无点、非 ASCII 主机名
normalizeDomain('a b.com')           → { ok: false }   // 含空格

normalizeExe('')                     → { ok: false }
normalizeExe('electron.exe')         → { ok: false }   // ★ 别把自己杀了
normalizeExe('node.exe')             → { ok: false }   // ★ 别把自己杀了
normalizeExe('explorer.exe')         → { ok: false }   // ★ 系统外壳，杀了桌面就没了
normalizeExe('csrss.exe')            → { ok: false }   // ★ 系统关键进程
normalizeExe('winlogon.exe')         → { ok: false }
normalizeExe('lsass.exe')            → { ok: false }
normalizeExe('services.exe')         → { ok: false }
normalizeExe('wininit.exe')          → { ok: false }
normalizeExe('smss.exe')             → { ok: false }
normalizeExe('dwm.exe')              → { ok: false }
// ★ 负对照：桌宠自身进程名（启动时用 path.basename(process.execPath) 取）也必须拒收
```

- [ ] **Step 1: 写失败的测试**

新建 `scripts/test-focus-blacklist.js`，骨架照抄 `scripts/test-place.js`
（自带 `ok()` 计数器和 `===== 结束：N 通过 / M 失败 =====` 收尾行）。
把上面两张表逐条写成断言；**末尾单独统计一次「负对照通过数」，负对照一条都不许失败**。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:focus-blacklist`
Expected: FAIL —— `Cannot find module '../src/main/focus/blacklist'`。

- [ ] **Step 3: 实现 `src/main/focus/blacklist.js`**

顶部写清「本文件刻意不 require electron，好脱离 Electron 单测」。
`PROTECTED_EXES` 里必须包含：`electron.exe`、`node.exe`、`explorer.exe`、`csrss.exe`、
`winlogon.exe`、`lsass.exe`、`services.exe`、`wininit.exe`、`smss.exe`、`dwm.exe`、`svchost.exe`。
`isProtectedExe(name)` 还要额外比对**当前进程名**（`path.basename(process.execPath).toLowerCase()`）。

- [ ] **Step 4: 实现 `src/main/focus/store.js`**

照 `src/main/store.js` 的 `read/write` 用，键名 `focus.json`。
`read()` 用 `store.read('focus.json', null)`，把结果逐字段校验并补默认值。
**永远返回一个对象，不返回 null。**

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test:focus-blacklist`
Expected: 全绿，收尾行 0 失败，负对照统计行显示全通过。

- [ ] **Step 6: Commit**

```bash
git add src/main/focus/blacklist.js src/main/focus/store.js scripts/test-focus-blacklist.js package.json
git commit -m "专注模式：黑名单规范化 + 危险进程屏蔽（别把自己杀了）"
```

---

### Task 2: 专注计时器状态机（纯函数）

**Files:**
- Create: `src/main/focus/timer.js`
- Test: `scripts/test-focus-timer.js`（新建）

**Interfaces:**

```js
// timer.js —— 刻意不 require electron。全部同步、无副作用、可注入 now
// 状态机：idle → running → (done | aborted)
// 用「开始时刻 + 时长」算剩余，而不是每秒自减 —— 睡眠/关机后不会算错（见负对照）
create({ minutes, now }) → session
  // session = { startedAt: Date, endsAt: Date, minutes, state: 'running' }
remainingMs(session, now) → number        // 负数一律返回 0
isDone(session, now) → boolean
// 长按退出：从按下那一刻开始算，够了才放行
canExit(pressStartedAt, now, holdMs = 3000) → boolean
HOLD_MS === 3000
progressRatio(session, now) → number      // 0..1，给界面画进度环
```

- [ ] **Step 1: 写失败的测试**

```js
const T0 = new Date(2026, 9, 14, 10, 0, 0);
const s = timer.create({ minutes: 25, now: T0 });

// ① 基本
ok(timer.remainingMs(s, new Date(2026,9,14,10,0,0)) === 25*60*1000, '刚开始时剩余 25 分钟')
ok(timer.remainingMs(s, new Date(2026,9,14,10,10,0)) === 15*60*1000, '过了 10 分钟剩 15 分钟')
ok(timer.isDone(s, new Date(2026,9,14,10,24,59)) === false, '差 1 秒还没到')
ok(timer.isDone(s, new Date(2026,9,14,10,25,0)) === true, '到点算结束')

// ② ★ 负对照：睡眠跳变 —— 中间「跳」过一大段时间，剩余必须按真实时间算
ok(timer.isDone(s, new Date(2026,9,14,11,30,0)) === true, '睡过头了也该是「已结束」，不能卡在运行中')
ok(timer.remainingMs(s, new Date(2026,9,14,11,30,0)) === 0, '过期后剩余一律是 0，不能是负数')

// ③ ★ 负对照：剩余时间不能靠「每次调用自减」实现
//    连续调 100 次 remainingMs(s, 同一个 now)，结果必须完全一样
//    （如果实现里偷偷做了减法，这条会红）

// ④ 长按退出
ok(timer.canExit(new Date(2026,9,14,10,0,0), new Date(2026,9,14,10,0,2,900)) === false, '★ 2.9 秒不许放行')
ok(timer.canExit(new Date(2026,9,14,10,0,0), new Date(2026,9,14,10,0,3,0)) === true, '满 3 秒放行')
// ★ 负对照：没有按下时刻（null）时一律 false —— 不能「没按也能退」
ok(timer.canExit(null, new Date()) === false, '没按下就不许退出')

// ⑤ 进度
ok(timer.progressRatio(s, T0) === 0, '刚开始进度 0')
ok(Math.abs(timer.progressRatio(s, new Date(2026,9,14,10,12,30)) - 0.5) < 1e-6, '过半进度 0.5')
ok(timer.progressRatio(s, new Date(2026,9,14,12,0,0)) === 1, '★ 进度封顶在 1，不能超过')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:focus-timer`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/main/focus/timer.js`**

**核心写法要求（写进注释）：** 剩余时间 = `endsAt - now`，**不是** 每次减 1 秒。
这是为了「电脑睡眠 / 关机再开」时结果依然正确 —— 和项目里调度用轮询、不用 `setTimeout` 同一个道理。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:focus-timer`
Expected: 0 失败。

- [ ] **Step 5: Commit**

```bash
git add src/main/focus/timer.js scripts/test-focus-timer.js package.json
git commit -m "专注模式：计时状态机（睡眠不丢时间）+ 长按 3 秒才放行"
```

---

### Task 3: hosts 文本操作（纯函数 · **重点**）

**Files:**
- Create: `src/main/focus/hosts.js`
- Test: `scripts/test-focus-hosts.js`（新建）

**Interfaces:**

```js
// hosts.js —— 刻意不 require electron。只做「字符串进、字符串出」，绝不碰真文件
BEGIN_MARK === '# === FocusMode BEGIN ==='
END_MARK   === '# === FocusMode END ==='

// 给一段 hosts 原文 + 要屏蔽的域名 → 返回「插入/更新后」的全文
// 已经有我们的标记块就替换里面的内容（不重复插入）
applyBlock(hostsText, domains) → string
// 精确删掉我们的标记块（连同里面的行），其余一字不动
removeBlock(hostsText) → string
// 有没有残留（崩溃后遗留）—— 给启动自愈用
hasBlock(hostsText) → boolean
// 从标记块里读回当前屏蔽了哪些域名（用于「我以为还在专注」的核对）
blockedDomains(hostsText) → string[]
// 换行符风格：原来用 CRLF 就还它 CRLF，用 LF 就还它 LF（别把整个文件的行尾改掉）
detectEol(hostsText) → '\r\n' | '\n'
```

**这一段的负对照是整份计划里最重要的**：

```js
const ORIGINAL = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '',
  '127.0.0.1  localhost',
  '::1        localhost',
  '192.168.1.10  nas.local',
].join('\r\n');

// ① 插入
const a = hosts.applyBlock(ORIGINAL, ['bilibili.com', 'www.bilibili.com']);
ok(a.includes(BEGIN) && a.includes(END), '标记块在')
ok(a.includes('0.0.0.0 bilibili.com'), '域名写进去了')
// ★★ 最重要的负对照：主人的原有内容必须一字不少
ok(ORIGINAL.split('\r\n').every(line => a.includes(line)), '★ 主人原有每一行都还在')
ok(hosts.detectEol(a) === '\r\n', '★ 原来是 CRLF，改完还得是 CRLF')

// ② 重复插入 → 不叠加
const b = hosts.applyBlock(a, ['zhihu.com']);
ok(b.split(BEGIN).length === 2, '★ 只有一个标记块，不能插出第二个')
ok(!b.includes('bilibili.com'), '★ 第二次 apply 是「替换」不是「追加」')
ok(b.includes('0.0.0.0 zhihu.com'), '新域名在')

// ③ 删除 → 精确还原
const c = hosts.removeBlock(a);
ok(c === ORIGINAL, '★ 删完必须和原文逐字节相等（这是还原的唯一证据）')
ok(!hosts.hasBlock(c), '标记块没了')

// ④ ★ 负对照：没有标记块时 removeBlock 必须原样返回，不能「顺手清理」
ok(hosts.removeBlock(ORIGINAL) === ORIGINAL, '★ 没我们的东西就不许动文件')
// ★ 负对照：原文只有 BEGIN 没有 END（上次写到一半崩了）→ 必须能整段清掉
const broken = '127.0.0.1 localhost\r\n' + BEGIN + '\r\n0.0.0.0 x.com\r\n';
ok(!hosts.hasBlock(hosts.removeBlock(broken)), '★ 半截标记块也要能清干净')

// ⑤ 空 / 不存在
ok(hosts.applyBlock('', ['a.com']).includes('0.0.0.0 a.com'), '空文件也能插')
ok(hosts.removeBlock('') === '', '空进空出')
ok(hosts.blockedDomains(a).length === 2, '读回 2 个域名')
// ★ 负对照：域名里带非法字符的不许写进去
ok(hosts.applyBlock(ORIGINAL, ['a b.com']) === hosts.removeBlock(hosts.applyBlock(ORIGINAL, ['a b.com'])) , '非法域名不落盘')
```

- [ ] **Step 1: 写失败的测试**

新建 `scripts/test-focus-hosts.js`，骨架照抄 `scripts/test-place.js`。
上面每一条都要有；**负对照单独统计，一条不许失败**。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:focus-hosts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/main/focus/hosts.js`**

关键要求：
- 一切操作都是**字符串进、字符串出**，函数内**绝不 `fs.readFileSync` / `writeFileSync`**（写文件在 Task 7 的薄壳里）。
- 行尾风格必须保留（`detectEol`）。混用 CRLF/LF 的文件要能处理不炸。
- `applyBlock` 要能容忍「只有 BEGIN 没有 END」的半截块（先清干净再插）。
- 域名先进 `blacklist.normalizeDomain` 洗一遍，非法的直接跳过（**不抛异常**）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test:focus-hosts`
Expected: 全绿，负对照统计行全通过。

- [ ] **Step 5: Commit**

```bash
git add src/main/focus/hosts.js scripts/test-focus-hosts.js package.json
git commit -m "专注模式：hosts 文本操作（标记块增删改 + 残留检测，绝不整文件覆盖）"
```

---

### Task 4: 专注界面（设置窗口加一页）

**Files:**
- Modify: `src/main/settings-window.js`
- Modify: `src/main/preload-settings.js`
- Modify: `src/renderer/settings/index.html`
- Modify: `src/renderer/settings/settings.js`
- Test: `src/main/main.js`（扩展 `runSettingsSelfTest`）

**Interfaces:**

```js
// 新增 IPC
'focus:get'      → { domains, exes, presets, lastMinutes, session }   // session: null | { endsAt, state }
'focus:set-blacklist' ← { domains, exes } → { ok, error? }
'focus:set-preset'    ← { minutes }       → { ok, error? }
'focus:start'    ← { minutes }            → { ok, session } | { ok:false, error }
'focus:stop'     ← {}                     → { ok }
'focus:state'    → 同上 focus:get（供轮询刷新倒计时）

// preload-settings.js 新增
focusGet / focusSetBlacklist / focusSetPreset / focusStart / focusStop
```

**界面要求（大白话）：**
- 工具栏加一个「专注」按钮（和「周视图」并排），点了切到专注页（**不新建窗口**）。
- 专注页三块：
  1. **要挡住的东西**：两栏列表 —— 「网站」（输入框 + 加号）和「软件」（输入框 + 加号）。
     每项右边一个「×」。提示语写「比如 bilibili.com」「比如 steam.exe」。
  2. **专注多久**：四个按钮 `25 分钟 / 45 分钟 / 60 分钟 / 自定义`（自定义弹一个数字输入）。
  3. **开始按钮** + 倒计时显示（大号数字 `24:59`）+ 进度环 + 「结束专注」按钮。
- 「结束专注」按钮上写「**长按 3 秒结束**」——不能一键就退（Review Focus 的前提）。

- [ ] **Step 1: 写失败的断言**

在 `src/main/main.js` 的 `runSettingsSelfTest()` 末尾追加：

```js
// ⑥ 专注页
// 做法：点「#btn-focus」→ 等 600ms
// 断言 1：★ #focus-page 可见，列表容器隐藏
// 断言 2：★ 输入框里填 'https://www.bilibili.com/video/xxx' 点加号 →
//         列表里出现的是 'www.bilibili.com'（规范化生效，不是原样）
// 断言 3：★ 填 'electron.exe' 点加号 → 列表里**没有**它，且出现一行错误提示
//         （负对照：不许把自己加进黑名单）
// 断言 4：★ 点「25 分钟」→ 主进程 focus:get 里 lastMinutes === 25
// 断言 5：★ 点「开始专注」→ session 非空、state === 'running'、endsAt 约等于 now+25min
// 断言 6：★ 负对照：黑名单空着点「开始专注」→ 必须被拒，且 session 仍是 null
//         （不能「专注了个寂寞」）
// 断言 7：★ 负对照：专注中把黑名单改掉 → 主进程里这条改动**不能**立刻生效
//         （专注期间锁定配置，防止「开着专注偷偷把自己放出来」）
// 收尾：结束专注、清空黑名单
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:settings-e2e`
Expected: FAIL —— 找不到 `#btn-focus`。

- [ ] **Step 3: 实现 —— 主进程侧**

`settings-window.js`：照现有 `week:data` 的模式，加一组 `focus:*` 的 `ipcMain.handle`。
所有写操作都要过 `blacklist.sanitizeBlacklist` / `store.write`。
**专注进行中（`state === 'running'`）时，`focus:set-blacklist` 和 `focus:set-preset` 必须拒绝**
（返回 `{ ok:false, error:'专注中不能改，忍一下～' }`）。

`preload-settings.js`：加 5 个方法。

- [ ] **Step 4: 实现 —— 界面侧**

`index.html`：
- 工具栏加 `<button id="btn-focus" class="ghost">专注</button>`，和 `#btn-week` 并排。
- 加 `<div id="focus-page" class="hidden">` 容器，里面按上面三块搭。
- 倒计时用大号数字，进度环用一段内联 SVG（`stroke-dasharray`）。
- 复用现有表单控件的样式类，**不要**另起一套（否则会踩「漏加共享样式掉到左上角」那个坑）。

`settings.js`：
- `renderFocus(data)`：画黑名单列表、预设按钮的选中态、倒计时。
- 倒计时刷新：专注中每 1 秒调一次 `focus:state` 重画（只在专注页可见时跑，切走就停）。
- 「开始专注」：`await api.focusStart(minutes)`，失败就把 `error` 显示成一行提示。
- 「结束专注」：`pointerdown` 记时刻 → 每 100ms 查 `timer.canExit` → 够了才 `focusStop()`；
  中途 `pointerup`/`pointerleave` 就取消（**这是长按 3 秒的界面实现**）。
- 黑名单输入：**一律 `textContent`**，绝不用 `innerHTML`（主人自己输的内容）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test:settings-e2e`
Expected: 80 条 → 约 92 条，0 失败。

- [ ] **Step 6: 目视确认一次**

Run: `PET_OPEN_SETTINGS=1 npm start -- --no-gpu`
Expected: 点「专注」→ 出现专注页；加一条 bilibili.com；选 25 分钟；点开始 → 出现倒计时；
长按「结束专注」3 秒 → 真的结束（**松手早于 3 秒就结束不了**）。

- [ ] **Step 7: Commit**

```bash
git add src/main/settings-window.js src/main/preload-settings.js src/renderer/settings/index.html src/renderer/settings/settings.js src/main/main.js
git commit -m "专注模式：设置窗口加「专注」页（黑名单 + 时长 + 倒计时 + 长按退出）"
```

---

### Task 5: 宠物陪伴 + 专注端到端自检 ← **停靠点**

**Files:**
- Modify: `src/renderer/pet/renderer.js`
- Modify: `src/renderer/pet/index.html`（若要角标，**必须挂 `data-ui`**）
- Create: `src/main/selftest-focusmode.js`
- Modify: `src/main/main.js`（加 `PET_SELFTEST === 'focusmode'` 分支）
- Modify: `package.json`

**Interfaces:**
- Consumes: `focus/index.js` 的会话状态、现有桌宠状态机（`idle` / `alert` / `focus`）
- Produces: 专注开始时宠物切到「专注」姿态并说一句话（如「好，我陪你 25 分钟～」）；
  专注中宠物显示一个小的剩余时间角标；专注结束宠物说一句鼓励。

- [ ] **Step 1: 写自检**

`src/main/selftest-focusmode.js`，`module.exports = { run(ctx) }`，
`ctx = { win, log, ok, finish, settingsWindow, focus, sleep }`。
`main.js` 里加：`if (!app.isPackaged && process.env.PET_SELFTEST === 'focusmode') setTimeout(() => require('./selftest-focusmode').run({...}), 1500);`

```js
// ① 走界面开始一次 1 分钟的专注（用界面的 DOM 操作，不是直接调函数）
//    ★ 断言：主进程 focus:state 的 state === 'running'
//    ★ 断言：宠物窗口里的状态变成了 'focus'（读 renderer 暴露的 __petState）
// ② ★ 负对照：黑名单空着点开始 → 被拒，state 仍是 'idle'
// ③ 长按退出的负对照：模拟按下 1 秒就松 → 必须**还**在专注中
//    ★ 断言：模拟按下满 3 秒 → 才真的结束，state === 'idle'
// ④ ★ 负对照：专注中再点一次「开始专注」→ 不许重置计时（endsAt 不能变）
// ⑤ 清理：结束专注、清空黑名单，断言 focus.json 里没有残留 session
```

- [ ] **Step 2: 跑自检确认通过**

Run: `npm run test:focusmode-e2e`
Expected: `===== 专注模式自检结束：NN 通过 / 0 失败 =====`

- [ ] **Step 3: 故意改坏，确认自检能红**

把长按判定临时改成 `holdMs = 100`，重跑。
Expected: 第 ③ 条**变红**。改回去，再跑确认全绿。
（规矩：不能证明「能抓到问题」的自检等于没写。）

- [ ] **Step 4: Commit**

```bash
git add src/main/selftest-focusmode.js src/main/main.js src/renderer/pet/renderer.js src/renderer/pet/index.html package.json
git commit -m "专注模式：宠物陪伴（换姿态 + 台词）+ 端到端自检（地基版完成）"
```

> ✅ **停靠点**：到这里，主人已经有一个「专注计时器 + 宠物陪伴」的完整功能，
> **完全不碰系统、不需要管理员权限**。可以停下来让主人验收一次再往下走。

---

## 第二段 · 拦截：真要动手（需管理员权限）

> ⚠️ 这一段开始碰系统。**真正动系统的步骤在沙箱里没法安全自测**，
> 最后必须**主人在真机上点一遍验收**（见文末验收清单）。

---

### Task 6: 提权执行壳 + 常驻助手

**Files:**
- Create: `src/main/focus/elevate.js`
- Create: `src/main/focus-helper.ps1`（**纯 ASCII，不许有中文**）
- Modify: `src/main/focus/index.js`

**设计（关键，别改）：** 整段专注**只弹一次 UAC**。做法是起一个**常驻的提权助手**：

```
主进程（普通权限）                          助手（管理员，全程活着）
   │                                          │
   │ 1. 写 focus-plan.json（要写的 hosts 全文、要杀的 exe 列表、结束时间）
   │ 2. Start-Process powershell -Verb RunAs ──▶ 启动
   │      （★ 此刻弹唯一一次 UAC，主人点「是」）  │ 3. 备份 hosts → 写入新内容 → flushdns
   │                                          │ 4. 循环：扫进程杀黑名单 / 看控制文件 / 看结束时间
   │ 5. 结束专注 → 写 focus-ctl.json {stop:true} ▶ 6. 看到 stop → 还原 hosts → flushdns → 退出
   │                                          │ （若主进程崩了 → 到结束时间自己还原）
```

**Interfaces:**

```js
// elevate.js
startHelper(plan) → Promise<{ ok, error? }>   // plan: { hostsText, exes, endsAt }
notifyStop()     → void                        // 写 focus-ctl.json
isHelperAlive()  → boolean                     // 读 focus-ctl.json 里的心跳时间戳
HOSTS_PATH === 'C:\\Windows\\System32\\drivers\\etc\\hosts'
```

**`focus-helper.ps1` 必须做到：**
1. 备份原 hosts 到 `userData/hosts.backup`（**第一次运行时才备份**，别覆盖已有备份）。
2. 把计划文件里的 hosts 全文**原样复制**过去（助手不做任何文本加工 —— 加工逻辑全在 JS 里，可测）。
3. `ipconfig /flushdns`。
4. 循环（每 3 秒）：
   - 读控制文件，若有 `stop:true` → 还原 hosts → flushdns → 退出；
   - 若 `now > endsAt` → 同上，自己还原退出（**主进程崩了也不留垃圾**）；
   - 否则按 exe 列表 `Get-Process | Stop-Process -Force`（**exe 列表由 JS 侧已经过滤掉自身和系统进程**，
     助手无条件信任它，但助手内部**再硬编码一份最小保护名单**，双保险）；
   - 每轮把心跳时间戳写回控制文件。

- [ ] **Step 1: 写 `focus-helper.ps1`**

**硬性要求：**
- **纯 ASCII，一个中文字都不能有**（照 `.bat`/`.vbs` 那条坑：解释器按 GBK 读，UTF-8 中文会乱码并带崩后面几行）。
- 用 `-ExecutionPolicy Bypass` 启动（在 `elevate.js` 里传参）。
- 所有路径从参数传进来，不要写死 `C:\Users\...`。
- 顶部注释里写明「本脚本被提权运行，只做四件事：备份 / 写 hosts / 杀进程 / 还原」。

- [ ] **Step 2: 实现 `src/main/focus/elevate.js`**

- 写 `focus-plan.json`（`store.write`）。
- 起助手：`child_process.spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command', 'Start-Process powershell -Verb RunAs -ArgumentList ...'])`。
  ⚠ 主人拒绝 UAC 时，`Start-Process` 会抛错 —— 必须 `try/catch` 并返回
  `{ ok:false, error:'需要你点一下「是」才能开始专注，刚才被取消了' }`（人话）。
- `notifyStop()`：`store.write('focus-ctl.json', { stop:true, at: Date.now() })`。
- **不提供「杀助手进程」的能力** —— 结束永远走控制文件（强杀不给收尾机会，见 `HANDOFF` 坑 8）。

- [ ] **Step 3: 单元测试（能测的部分）**

在 `scripts/test-focus-timer.js` 或新建里补：`notifyStop()` 之后 `focus-ctl.json` 内容正确；
`startHelper()` 在 `spawn` 抛错时返回 `{ ok:false }` 而不是把异常抛出去。
**真机弹 UAC 的部分只能人工验收**（见 Task 10）。

- [ ] **Step 4: Commit**

```bash
git add src/main/focus/elevate.js src/main/focus-helper.ps1 src/main/focus/index.js scripts/test-focus-timer.js
git commit -m "专注模式：提权执行壳 + 常驻助手（整段专注只弹一次 UAC）"
```

---

### Task 7: 禁网站落地（写 hosts + flushdns + 还原 + 残留自愈 + DoH 检测）

**Files:**
- Create: `src/main/focus/doh.js`
- Modify: `src/main/focus/index.js`
- Modify: `src/main/main.js`（启动时残留自愈）
- Test: `scripts/test-focus-hosts.js`（追加 DoH 解析的纯函数测试）

**Interfaces:**

```js
// doh.js
// 读浏览器配置 + 注册表策略，判断「安全 DNS」有没有开着
detectDoh() → {
  level: 'off' | 'on' | 'unknown',
  browsers: [{ name: 'Chrome' | 'Edge', doh: 'off' | 'on' | 'unknown' }],
  advice: string,        // 给主人看的一句人话
}
// 纯函数：给一份浏览器 Preferences 的 JSON 文本 → 判断 DoH 状态（好测）
parseChromePrefs(text) → 'off' | 'on' | 'unknown'
```

**启动时残留自愈（`main.js`）** —— 双保险的第一道：
```js
// app.whenReady() 之后，读真实 hosts：
//   若有 FocusMode 标记块 → 说明上次崩了没还原 → 调 hosts.removeBlock 算回原文 → 走提权写回
//   （或者更稳：直接告诉主人「检测到上次专注没正常结束，已自动帮你恢复」）
// ★ 这里也要能处理「程序目录里没有 focus-ctl.json 但 hosts 有块」的情况
```

- [ ] **Step 1: 写失败的测试（纯函数部分）**

在 `scripts/test-focus-hosts.js` 追加：

```js
// ① Chrome 没开 DoH
ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"off"}}') === 'off', '显式 off')
// ★ 负对照：默认（没这个字段）必须判 unknown，不能瞎判成 off
ok(doh.parseChromePrefs('{}') === 'unknown', '★ 没配置不许当成关着')
ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"secure"}}') === 'on', '强制安全 DNS')
ok(doh.parseChromePrefs('{"dns_over_https":{"mode":"automatic"}}') === 'on', '自动模式也算开着')
// ★ 负对照：坏 JSON 不许抛异常
ok(doh.parseChromePrefs('{oops') === 'unknown', '★ 坏配置不崩')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:focus-hosts`
Expected: FAIL —— 找不到 `doh.parseChromePrefs`。

- [ ] **Step 3: 实现 `doh.js`**

- Chrome：`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Preferences`（以及 `Profile *`）
- Edge：`%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Preferences`
- 另外查注册表策略：`HKLM\SOFTWARE\Policies\Google\Chrome\DnsOverHttpsMode`（用 `reg query` 读）
- 读不到就返回 `unknown`，**绝不瞎猜**。

- [ ] **Step 4: 接进 `focus/index.js`**

`start()` 的流程：
1. 校验黑名单非空。
2. **先检测 DoH** —— 若 `on`，把 `advice` 带回界面（**不阻塞开始**，但必须让主人看见）。
3. 读真实 hosts → `hosts.applyBlock` 算新全文 → 写 `focus-plan.json` → `elevate.startHelper`。
4. 起轮询（每 5 秒）：查 `timer.isDone` → 到点就 `stop()`。
5. `stop()`：写 `notifyStop()` → 等助手还原 → 清 `focus.json` 里的 session。

- [ ] **Step 5: 实现启动残留自愈**

`main.js` 的 `app.whenReady()` 里加一次 `focus.recoverIfDirty()`：
读真实 hosts，有标记块就提示主人 + 自动清掉（走提权）。**静默失败不报错**（别让桌宠起不来）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run test:focus-hosts && npm run test:focus-timer && npm run test:focusmode-e2e`
Expected: 三个都 0 失败。

- [ ] **Step 7: 目视确认（**需要真机**）**

Run: `npm start`（真机，非沙箱）
Expected:
1. 加 `bilibili.com` → 开始专注 → 弹一次 UAC → 点「是」→ bilibili 打不开；
2. 打开 `C:\Windows\System32\drivers\etc\hosts` 看一眼 —— **原有内容一行没少**，多了一个标记块；
3. 结束专注 → bilibili 恢复 → hosts 里的标记块没了。

- [ ] **Step 8: Commit**

```bash
git add src/main/focus/doh.js src/main/focus/index.js src/main/main.js scripts/test-focus-hosts.js
git commit -m "专注模式：禁网站落地（改 hosts + 清 DNS 缓存 + 还原 + 残留自愈 + DoH 检测）"
```

---

### Task 8: 禁软件落地（进程轮询 + taskkill 排除自身）

**Files:**
- Modify: `src/main/focus/index.js`
- Modify: `src/main/focus-helper.ps1`
- Test: `scripts/test-focus-blacklist.js`（追加「最终要杀的列表」组装测试）

**Interfaces:**
```js
// 组装「真正要杀」的 exe 列表：黑名单 ∩ 通过 isProtectedExe 的项
// ★ 这个函数是 Review Focus 第 3 条的守门员
killListOf(blacklist) → string[]
```

- [ ] **Step 1: 写失败的测试**

```js
// ① 正常：['steam.exe','wechat.exe'] → 原样返回（小写）
// ★ 负对照：['steam.exe','electron.exe','explorer.exe'] → 只剩 ['steam.exe']
//    （即使有人绕过界面直接改了 focus.json，这里也要兜住）
// ★ 负对照：[] → []
// ★ 负对照：['STEAM.EXE'] → ['steam.exe']（大小写归一）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:focus-blacklist`
Expected: FAIL —— 找不到 `killListOf`。

- [ ] **Step 3: 实现**

- JS 侧：`killListOf` 过滤掉保护进程，写进计划文件。
- 助手侧：`Get-Process | Where-Object { $exes -contains $_.ProcessName.ToLower() + '.exe' } | Stop-Process -Force`。
  ⚠ 助手内部**再硬编码一份最小保护名单**（`explorer`、`csrss`、`winlogon`、`lsass`、`services`、
  `wininit`、`smss`、`dwm`、`svchost`）—— 就算 JS 侧算错了也不至于把系统搞崩。

- [ ] **Step 4: 目视确认（**需要真机**）**

Run: `npm start`（真机）
Expected:
1. 加 `notepad.exe` 当靶子 → 开始专注 → 手动开记事本 → **几秒内被关掉**；
2. 桌宠自己**没被杀**、桌面**没崩**；
3. 结束专注 → 再开记事本 → 正常能开。

- [ ] **Step 5: Commit**

```bash
git add src/main/focus/index.js src/main/focus-helper.ps1 scripts/test-focus-blacklist.js
git commit -m "专注模式：禁软件落地（轮询杀进程，双重排除自身与系统进程）"
```

---

## 第三段 · 收尾

---

### Task 9: 拦截提示窗口（抢焦点）

**Files:**
- Modify: `src/main/reminder.js` 或新建 `src/main/focus-notice.js`（复用气泡样式）
- Modify: `src/main/focus/index.js`
- Modify: `src/main/main.js`

**要求：**
- 当主人试图打开被禁的软件（助手杀了它）或访问被禁网站（浏览器打不开）时，
  **不是弹系统错误，而是桌宠说一句人话**，例如「这个我们约好了先不碰～ 还有 12 分钟」。
- 需要主人确认的场景（如 DoH 提示、启动残留自愈提示）用一个**能抢焦点**的小窗口
  （`focusable: true`，**别照抄气泡的 `focusable:false`**）。

- [ ] **Step 1: 实现**

复用 `reminder.js` 的透明卡片窗口那套参数，唯一区别是 `focusable: true` +
`show()`（**不是 `showInactive()`**）。在文件顶部注释里写明「为什么这个窗口要抢焦点」。

- [ ] **Step 2: 自检断言**

在 `selftest-focusmode.js` 里加：
```js
// ★ 断言：拦截提示窗口 focusable === true（要主人看见并做选择）
// ★ 负对照：同一时刻气泡窗口 focusable === false —— 两个值必须不一样
//   （防「有人把窗口参数照抄串了」）
```

- [ ] **Step 3: Commit**

```bash
git add src/main/focus-notice.js src/main/focus/index.js src/main/main.js src/main/selftest-focusmode.js
git commit -m "专注模式：拦截提示（抢焦点的小窗口 + 桌宠说人话）"
```

---

### Task 10: 文档、全量回归、真机验收

**Files:**
- Modify: `HANDOFF-V3.md`（状态改「阶段 3 完成」、测试数字更新、新坑入册）
- Modify: `CLAUDE.md`（目录树、命令表、新坑）
- Modify: `.workbuddy-ai/memory/YYYY-MM-DD.md`（追加当天记录）

- [ ] **Step 1: 跑全量回归**

```bash
npm run test:schedules && npm run test:scheduler && npm run test:reminder \
 && npm run test:place && npm run test:quit && npm run test:week && npm run test:nl-time \
 && npm run test:brain-local && npm run test:brain-cloud && npm run test:brain-router \
 && npm run test:focus-blacklist && npm run test:focus-timer && npm run test:focus-hosts \
 && npm run test:scheduler-e2e && npm run test:reminder-e2e && npm run test:settings-e2e \
 && npm run test:week-e2e && npm run test:chat-e2e && npm run test:focusmode-e2e \
 && npm run test:focus && npm run test:sync && npm run test:gaze && npm run test:exit && npm run test:drag
```
Expected: **每一项都是 0 失败**。任何一项红了就停下来修，不要往下走。

- [ ] **Step 2: 更新文档**

`HANDOFF-V3.md` / `CLAUDE.md` 至少补这几条新坑（写清「现象 → 根因 → 怎么躲」）：
1. `test:focus` 是**窗口焦点**自检，专注模式的测试叫 `test:focusmode-*`，别混
2. 改 hosts **只用标记块增删**，绝不整文件覆盖；行尾风格要保留
3. 提权助手**常驻整段专注**，结束走控制文件，**不是杀进程**
4. `.ps1` / `.bat` / `.vbs` 一律**纯 ASCII**，一个中文都不能有
5. DoH 开着会让 hosts 屏蔽失效 —— 开始专注前必须检测并提示
6. 黑名单**双重排除**自身与系统进程（JS 侧 + 助手侧各一份）

- [ ] **Step 3: 真机验收（人工，逐条走）**

见文末「主人真机验收清单」。

- [ ] **Step 4: 追加记忆**

在 `.workbuddy-ai/memory/YYYY-MM-DD.md` 末尾追加：做了什么、哪些决定是主人拍板的、
哪些是小安拍的（附理由）、下一步可以做什么。

- [ ] **Step 5: Commit**

```bash
git add HANDOFF-V3.md CLAUDE.md .workbuddy-ai/memory
git commit -m "文档：专注模式上线，六条新坑入册"
```

---

## 执行顺序与依赖

```
【第一段 · 地基（不碰系统）】
Task 1 (黑名单纯函数)
   ↓
Task 2 (计时状态机纯函数)
   ↓
Task 3 (hosts 纯函数)        ← 纯函数，先写好、测透，后面直接用
   ↓
Task 4 (专注界面)             ← 到这一步主人已经能手动专注了
   ↓
Task 5 (宠物陪伴 + e2e)  ★停靠点 —— 地基完成，可停下来验收
   ↓
【第二段 · 拦截（动系统）】
Task 6 (提权壳 + 常驻助手)    ← 真机才能验
   ↓
Task 7 (禁网站落地)           ← 真机验收
   ↓
Task 8 (禁软件落地)           ← 真机验收
   ↓
【第三段 · 收尾】
Task 9 (拦截提示窗口)
   ↓
Task 10 (文档 + 全量回归 + 真机验收)
```

**Task 1–3 是纯函数线，可以连着做完再一起看效果；Task 4–5 是「地基的界面」；
Task 6–8 是「动系统」的部分，必须真机验收；Task 9–10 收尾。**
Task 5 和 Task 8 之后都是干净的停靠点。

---

## 主人真机验收清单（**必须人工点，沙箱测不了**）

> 这些步骤会真的改系统文件、真的杀进程，所以只能主人在自己电脑上走一遍。

**准备（可选但推荐）**：把项目目录和输出 exe 加进杀毒软件白名单
（一个「改 hosts + 杀进程」的程序，行为特征太像病毒，容易被误报）。

| # | 步骤 | 期望看到 |
|---|---|---|
| 1 | 打开设置窗口 → 点「专注」 | 出现专注页 |
| 2 | 加 `bilibili.com`，选 25 分钟，点开始 | **弹一次** UAC，点「是」 |
| 3 | 用浏览器开 bilibili | 打不开 |
| 4 | 打开 `C:\Windows\System32\drivers\etc\hosts` | **原有内容一行没少**，多了一个 `# === FocusMode BEGIN ===` 块 |
| 5 | 加 `notepad.exe`，手动开记事本 | 几秒内被关掉；桌宠和桌面都还活着 |
| 6 | 长按「结束专注」不足 3 秒就松手 | **结束不了** |
| 7 | 长按满 3 秒 | 结束；bilibili 能开了；记事本能开了；hosts 里标记块没了 |
| 8 | 专注进行中，直接**强杀桌宠进程**（任务管理器） | 到点后 hosts **自己恢复**（助手到点自愈） |
| 9 | 重新启动桌宠 | 若上次有残留，会提示「已自动帮你恢复」 |
| 10 | 开着浏览器「安全 DNS」再走一遍第 2 步 | 开始前**明确提示**「这个网站可能还拦不住」并给出关闭方法 |

---

## 主人需要知道的一件事（安全提醒）

专注模式是这个项目里**唯一会动系统**的模块。它做两件在安全软件眼里很敏感的事：
**改 hosts 文件** 和 **强制关闭软件**。所以：

- 第一次运行可能被**杀毒软件拦一下**，选择「允许」并把程序加进白名单就好；
- 它**只动自己加的那几行**，绝不碰你 hosts 里原有的任何内容；
- 就算它崩了，**下次启动会自动帮你恢复**，不会留下打不开网站的后遗症；
- 它的定位是「**帮你自己管住自己**」的自律工具，**不是**监控软件 ——
  你真想绕（用任务管理器结束它）永远能绕，我们不做那方面的对抗。
