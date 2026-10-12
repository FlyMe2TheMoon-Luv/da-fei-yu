# HANDOFF.md · 桌宠项目交接文件

> **给新对话里的我（小安）：**
> 读到这份文件说明主人要继续桌宠项目。**从头读一遍就能接着干，不用主人重新解释。**
> 最后更新：2026-10-12 18:10

---

## 零、三十秒速览

| 项 | 内容 |
|---|---|
| **项目** | Windows 桌面宠物：日程提醒 + 专注模式 |
| **进度** | 阶段 0 ✅ · 阶段 1 ✅ · **阶段 2：2-1 ✅ 2-2 ✅ 2-3 ✅ · 下一步 2-4 编辑入口** |
| **形象** | 女仆鲸鱼娘，真 Live2D 模型（`c_0120`） |
| **技术栈** | Electron 44 + 原生 HTML/CSS/JS，无框架无打包器 |
| **跑起来** | `npm start -- --no-gpu`（本机无 GPU） |
| **先读** | 本文件 → `CLAUDE.md`（硬性约定）→ 第七节（阶段 2 计划） |
| **历史调研** | 都在 `HANDOFF-ARCHIVE.md`，**别重复调研** |

---

## 一、主人是谁

- 称呼：**主人**（硬性要求，不要改）
- 我的名字：**小安**
- 特点：**AI 小白**。讲人话、少术语、多举例子。别堆专业名词。
- 协作方式：**每次只派一个小任务，跑通了再派下一个。**别一次说「帮我做个桌宠」。
- 主人会主动 sync 项目细节过来，之后以问答形式推进。

---

## 二、项目是什么

**桌面宠物（桌宠）**，Windows 桌面端，两个核心功能：

1. **日程提醒** —— 按输入的日程安排到点提醒
2. **专注模式** —— 在该模式下禁用用户预设的网站或软件

模块划分（四者解耦，**C 单独隔离是保交付策略**）：

| 模块 | 内容 | 难度 | 状态 |
|---|---|---|---|
| A. 桌宠外壳 | 透明无边框窗口、置顶、拖拽、穿透、托盘 | ★☆☆ | ✅ 完成 |
| B. 日程提醒 | 存日程 → 到点弹提醒 | ★★☆ | ✅ 完成（数据层 / 调度 / 呈现 都好了，只剩「界面上加日程」） |
| C. 专注模式 | 按时段禁用网站/软件 | ★★★★ | ⬜ 未开始 |
| D. 设置界面 | 加日程、配黑名单、开关 | ★★☆ | ⬜ 未开始 |

> C 是唯一需要管理员权限、也是唯一可能做不出来的模块。隔离掉它，A+B+D 已经是个能用的桌宠。

---

## 三、现在到哪了

### 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 环境准备（项目骨架 + CLAUDE.md） | ✅ 已完成（2026-10-12） |
| 1 | 桌宠外壳（透明窗口、拖拽、穿透、托盘、位置记忆 + Live2D 形象） | ✅ 已完成（2026-10-12） |
| 2 | 日程提醒 | 🚧 **进行中**（2-1 数据层 ✅ · 2-2 调度引擎 ✅ · 2-3 提醒呈现 ✅ · 下一步 2-4 编辑入口） |
| 3 | 专注模式 | ⬜ 未开始 |
| 4 | 设置界面 + 打磨 | ⬜ 未开始 |
| 5 | 打包发布 | ⬜ 未开始 |

**第一周目标：一只会拖、会提醒的猫。先让它活着，再让它管你。**

### 真实目录结构（截至 2026-10-12，✅ = 已存在）

```
desktop-pet/
├─ package.json            ✅ main=src/main/main.js
├─ CLAUDE.md               ✅ 给 AI 看的项目说明书（硬性约定在里面）
├─ HANDOFF.md              ✅ 本文件（开工手册）
├─ HANDOFF-ARCHIVE.md      ✅ 历史归档（调研 / 决策史 / 验收记录）
├─ PLAN.md                 ✅ 完整实现方案（分阶段规格）
├─ LICENSE                 ✅ 代码 MIT
├─ LICENSE-ASSETS.md       ✅ 素材 CC BY-NC-SA 4.0
├─ CREDITS.md              ✅ 署名链（三位权利人，不能漏）
├─ .gitignore              ✅ 已含 node_modules / tmp / out
├─ src/
│  ├─ main/                ← 主进程：Node 世界，能碰系统
│  │  ├─ main.js           ✅ 窗口 / 托盘 / 位置记忆 / 生命周期 / 各开发自检
│  │  ├─ preload.js        ✅ 桌宠窗口的安全桥梁
│  │  ├─ preload-bubble.js ✅ 气泡窗口的安全桥梁（只给「读内容 / 点知道了」）
│  │  ├─ store.js          ✅ 本地 JSON 读写（统一写 userData）
│  │  ├─ schedules.js      ✅ 阶段 2-1：日程数据层（增删改查 + 校验 + 存盘）
│  │  ├─ scheduler.js      ✅ 阶段 2-2：日程轮询引擎（30 秒轮询 + 去重 + 5 分钟宽限）
│  │  ├─ reminder.js       ✅ 阶段 2-3：提醒呈现（气泡窗口 + 桌宠表演 + 系统通知兜底）
│  │  └─ focus/            ⬜ 阶段 3：hosts / 进程 / 提权
│  ├─ renderer/            ← 界面：浏览器世界，碰不到系统
│  │  ├─ pet/
│  │  │  ├─ index.html     ✅
│  │  │  ├─ renderer.js    ✅ Live2D 渲染 + 裁切 + 拖拽 + 穿透 + 提醒表演
│  │  │  ├─ vendor/        ✅ PIXI 6.5.10 + pixi-live2d-display 0.4.0 + Cubism Core
│  │  │  └─ model/         ✅ Live2D 模型（60 文件 4.2MB，属「素材」）
│  │  ├─ bubble/           ✅ 阶段 2-3：提醒气泡（透明小窗口，268×112）
│  │  │  ├─ index.html     ✅ 卡片样式 + 倒计时条
│  │  │  └─ bubble.js      ✅ 画内容 / 点知道了 / 倒计时
│  │  └─ settings/         ⬜ 阶段 4
│  └─ assets/
│     ├─ pet/              ✅ 三视图 PNG ×6 + icon.png（**当前没用到**，备用）
│     └─ tray.png          ✅ 32×32 托盘图标（由 make-tray-icon 生成）
├─ scripts/                ← 开发工具，都不是运行时依赖
│  ├─ start-dev.js         ✅ 启动器：抹平环境坑
│  ├─ sync-vendor.js       ✅ 同步第三方运行时到 vendor/
│  ├─ patch-model-expressions.js  ✅ 补登记模型表情（见第六节第 19 条）
│  ├─ check-assets.js      ✅ 素材体检：验图片是不是真透明
│  ├─ make-tray-icon.js    ✅ 生成方形托盘图标
│  ├─ shot.js              ✅ 截屏（验收用）
│  ├─ test-schedules.js    ✅ 阶段 2-1 数据层自检（46 项，含负对照）
│  ├─ test-scheduler.js    ✅ 阶段 2-2 调度引擎自检（39 项，含负对照）
│  ├─ test-reminder.js     ✅ 阶段 2-3 气泡位置自检（14 项，含负对照）
│  └─ lib/png.js           ✅ 零依赖 PNG 解码/编码/裁切/缩放
└─ spike/                  ← 一次性验证台，可随时删（见 spike/README.md）
```

---

## 四、怎么跑起来

```bash
npm start                    # 标准启动（经启动器，自动处理 ELECTRON_RUN_AS_NODE）
npm start -- --no-gpu        # ★ 本机沙箱无 GPU，用这条
npm run start:raw            # 裸 electron .（不经启动器，排查用）
npm run shot                 # 截一张桌面图存到 tmp/，肉眼验收用
npm run build                # 打包（electron-builder，阶段 5 才用）
```

**其他开发命令**：

```bash
npm run sync-vendor          # 换/升级第三方库后重新同步
npm run patch-model          # 补登记模型表情（换模型后要跑，见第六节第 19 条）
npm run test:schedules       # 日程数据层自检（阶段 2-1，46 项，随时能跑）
npm run test:scheduler       # 调度引擎自检（阶段 2-2，39 项，纯逻辑、秒出结果）
npm run test:scheduler-e2e   # 调度引擎端到端（真的塞一条日程，等 30 秒轮询扫到它）
npm run test:reminder        # 气泡位置自检（阶段 2-3，14 项，纯数学、秒出结果）
npm run test:reminder-e2e    # 提醒呈现端到端（19 项；⚠ 会真的弹一条系统通知）
npm run test:gaze            # 拖拽时「视线跟随」开关自检（6 项，见第六节第 20 条）
npm run test:exit            # 退出按钮自检（6 项，见第六节第 21 条）
npm run test:drag            # 拖拽性能自检：搬窗口频率 / 帧间隔 / 跟踪误差
npm run check-assets <路径>   # 素材体检
npm run make-tray-icon       # 换形象后重新生成托盘图标
```

> `test:schedules` 用的是**独立脚本**，不是 Electron 自检 —— 因为桌宠是单实例程序，
> 托盘里跑着的时候再启动一次会直接退出，自检根本不会执行（容易误判成"通过"）。
> 这个脚本把 userData 指到临时目录，**不会碰主人真实的日程数据**。
>
> `test:gaze` / `test:drag` 也是 Electron 自检，靠 `--isolated` 参数拿到独立的
> user-data-dir，所以**桌宠开着的时候也能跑**，跑完自动退出。

**开发自检**：`PET_SELFTEST=1 npm start -- --no-gpu`
会自动验一遍「鼠标穿透切换」和「表情能不能用」，结果打在终端日志里。

**关掉桌宠**：它常驻托盘，`Ctrl+C` 终端或任务管理器结束 `electron.exe` 都行；
正规退出走托盘右键菜单的「退出桌宠」。

---

## 五、硬性约定（写代码时必须遵守）

1. renderer **绝对不能**直接碰系统，全部通过 IPC 交给 main
2. `contextIsolation: true` + preload + contextBridge，**绝不开 `nodeIntegration`**
3. 日程调度用 **30 秒轮询 + `lastFiredDate` 去重**，**不用 `setTimeout`**（电脑睡眠会丢事件）
4. 改 hosts 必须用 `# === FocusMode BEGIN/END ===` **标记块包裹**，退出时精确删除，**绝不整文件覆盖**
5. 提权只在「开始专注」时弹一次 UAC，**App 不常驻管理员**
6. 用户数据放 `app.getPath('userData')`，**不放程序目录**（打包后只读）
7. **每次只派一个小任务**，跑通了再派下一个
8. **每完成一个阶段 `git commit` 一次**，出错能回滚

---

## 六、踩过的坑（照着躲，别再踩一遍）

### 业务坑

1. **浏览器「安全 DNS」(DoH) 会绕过 hosts** —— 改完 hosts 发现网站照样能开，八成是这个。必须先关掉 Chrome/Edge 的安全 DNS
2. **hosts 绝不能整个覆盖** —— 那是系统文件。程序崩溃残留了，下次启动要先自动清理
3. **桌宠窗口会挡住桌面图标点击** —— 要动态切换 `setIgnoreMouseEvents()`。**不做这条用户第一天就卸载**（阶段 1 已做）
4. **杀毒软件会误报** —— "改 hosts + 杀进程"的 exe 行为特征和恶意软件高度重合，提前加白名单
5. **别把自己杀了** —— 黑名单校验要屏蔽 `electron.exe` / `node.exe` 和自身进程名
6. **专注模式是自律工具** —— 任务管理器照样能绕，别往"监控软件"方向做，也别用来限制别人

### 开发环境坑

7. **`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成普通 Node**
   - 现象：报 `Cannot read properties of undefined (reading 'whenReady')`，日志末尾出现 `Node.js v24.x`
   - 原因：VS Code / 部分 IDE 集成终端会预设这个变量，子进程继承后就废了
   - 解决：`scripts/start-dev.js` 启动前删掉它（已内置）

8. **没有可用 GPU 时 Chromium 的 GPU 进程会崩溃**
   - 现象：刷屏 `GPU process exited unexpectedly`，最后 `GPU process isn't usable. Goodbye.`
   - 解决：`npm start -- --no-gpu`（已内置）

9. **⚠️ `--disable-software-rasterizer` 是错的** —— 它会把软件光栅化也关掉，无 GPU 环境下 WebGL 直接不可用，桌宠白屏报 `WebGL unsupported`。
   正确参数是 **`--disable-gpu --enable-unsafe-swiftshader --no-sandbox`**（启动器已改对）

> 7-9 这几条**真实桌面机通常都不需要**，是沙箱 / 虚拟机环境才触发。

### Live2D / 渲染坑（阶段 1 实测踩到）

10. **`pixi-live2d-display` 只兼容 PIXI 6.x** —— 它最新版停在 0.4.0（2022 年），而 PIXI 已到 8.x。
    **不要 `npm update`**，锁死在 `pixi.js@6.5.10`
11. **PIXI 6 需要 CSP 放开 `'unsafe-eval'`** —— 它用 `new Function()` 现场拼 shader。
    渲染进程不加载远程内容，风险可控；想收紧可改用 `@pixi/unsafe-eval`
12. **`capturePage()` 抓不到 WebGL 内容** —— 截出来是空白。要拿画面只能 `canvas.toDataURL()`；
    要抓整个桌面用 `desktopCapturer`（`npm run shot` 已封装）
13. **透明窗口 + WebGL 必须 `backgroundThrottling: false`** —— 否则窗口失焦后动画像卡死
14. **鼠标穿透要配 `{ forward: true }`** —— 否则穿透期间渲染进程收不到 mousemove，永远判定不出该不该恢复穿透
15. **命中判定要用迟滞** —— 角色一直在动（呼吸、甩尾巴），鼠标停在轮廓边不动时，单阈值会让穿透疯狂开关
16. **Live2D 模型自带的是正方形空画布** —— `c_0120` 是 4068×4068，角色只占约 64%，照方框摆窗口会虚胖一大圈
17. **裁切只量一帧不够** —— 待机动作会让角色比首帧宽出 **8%**，实测会顶出窗口。
    要采样一整个动作循环取并集，结果缓存到 `userData/model-bounds.json`
18. **PowerShell `Add-Type` 会被安全策略拦** —— 想用 .NET 截屏行不通，用 Electron 的 `desktopCapturer`

19. **⚠️ 最阴的一个：`model.expression()` 会静默失败**
    - 现象：调用不报错、`await` 正常返回，**但角色表情毫无变化**。肉眼和日志都看不出来
    - 原因：这个模型的 `c_0120.model3.json` **漏了 `FileReferences.Expressions` 字段**。
      44 个表情文件都在 `expressions/` 目录里，就是没登记，于是渲染库一个都加载不到
    - 解决：跑 `npm run patch-model` 补登记（脚本按目录扫描，幂等）
    - **教训**：验证「调用了某个 API」不等于「产生了效果」。必须**加负对照** ——
      用一个不存在的名字再调一次，如果它和正例返回一样，说明这个检测本身是假的。
      （自检里已经这么做了：正例应返回 `true`，反例应返回 `false`）
    - 顺带记牢：库内部找表情用的是 **`.Name`（大写）**，
      见 `getExpressionIndex(t){return this.definitions.findIndex((e=>e.Name===t))}`

20. **⚠️ 拖拽时角色「抽搐」不是掉帧，是视线跟随被喂了在抖的位置**（2026-10-12 修复）
    - 现象：拖动桌宠时，**角色的头/眼睛一抽一抽的**（窗口本身跟手是正常的）
    - 排查结论（**都实测过，别重复走**）：
      - **不是**「搬窗口太频繁把渲染挤爆」—— 实测把窗口搬到 **600 次/秒**，
        帧间隔中位 4.1ms、掉帧 0，和安静时一模一样（`npm run test:drag`）
      - **不是**主进程算错位置 —— 目标位置误差 0px、落地误差 0px
      - **不是**窗口没跟上鼠标（主人确认窗口跟手正常）
    - 真因：`pixi-live2d-display` 的 `onPointerMove` 把「鼠标在**画布内**的位置」
      直接喂给 `model.focus()`（`dist/index.es.js:1177`）。
      拖拽时鼠标在屏幕上基本不动、窗口却在追它 → 这个相对位置一直在抖 →
      focus 目标跟着抖 → 头就抽。
    - 修法：`renderer.js` 的 `setGazeFollowing()` —— 拖拽期间关掉视线跟随，松手恢复。
    - **⚠ 坑中坑**：`model.autoInteract = false` **单独用是不够的**。
      那个 setter 只管 `pointertap`（点击）监听；视线跟随挂在 `registerInteraction()` 上，
      而它是在 `_render()` 里**每帧**被调用的（`index.es.js:1305`）。
      必须「**先设 `autoInteract = false`，再手动 `unregisterInteraction()`**」——
      顺序反了的话下一帧就被挂回来，等于白做。恢复只需设回 `true`，下一帧自动挂回。
    - 回归哨兵：`npm run test:gaze`（直接问库 `interactionManager` 在不在，6 项）

21. **⚠️ 往界面上加 DOM 控件（退出按钮）会点不到 —— 鼠标穿透判定只认 WebGL 像素**
    - 现象：界面上加个按钮，看着好好的，**鼠标点上去毫无反应**，而且**不报任何错**
    - 原因：动态穿透的命中判定是「读画布 alpha 值」（`alphaAt`）。按钮是 DOM 元素、
      根本不在画布上 → 那个位置永远是「空白」→ 窗口继续保持穿透 →
      鼠标事件直接穿到桌面去了，按钮压根收不到。
    - 修法：`refreshHit()` 里先 `document.elementFromPoint()` 找有没有 `[data-ui]` 元素，
      有就无条件「接住鼠标」。
      **⚠ 以后往界面上加任何控件（阶段 4 的设置按钮等），都必须挂 `data-ui` 属性**，
      否则一样点不到。
    - 连带的坑：判定为「压在控件上」时**不能进入拖拽**（否则点按钮会变成拖窗口），
      所以 mousedown 里要加 `overUi` 判断。
    - 已落地：右上角一个淡显的 `✕` 退出按钮（走 `pet:quit`，和托盘菜单同一条通道）。
    - 回归哨兵：`npm run test:exit`（验「压在按钮上时窗口有没有接住鼠标」+ 最后真点一下）

22. **⚠️ 提醒气泡：`focusable: false` 必须配 `showInactive()`，两个都要**（2026-10-12 落地）
    - 气泡窗口是**独立窗口**（主人拍板的方案 A），配置抄桌宠窗口 + 三处改动：
      `focusable: false`（不抢焦点）、`skipTaskbar: true`（提醒不是「一个程序」）、
      `movable: false`（位置由程序算，不让用户拖走）
    - **不抢焦点是为了不打断主人正在打的字**。代价：窗口拿不到 focus 事件，
      所以「它还在不在」得自己用状态变量管（`isShowing()`），别指望事件。
    - 另一个坑：**窗口加载完之前 `webContents.send()` 会丢**（窗口在，但没人听）。
      必须先 `await` 一个 `did-finish-load` 的 Promise 再推内容。
      加载失败时**必须销毁重建** —— 否则那个 Promise 永远是 false，
      以后每次提醒都静默不弹气泡，且没有任何报错。
    - 气泡贴哪：优先宠物右边，右边顶到屏幕边就翻左边，左右都放不下就贴右边缘，
      竖直方向对齐宠物头部。**全程夹在工作区内**（多显示器用 `getDisplayNearestPoint`）。
      这段是纯函数 `computeBubblePosition()`，单独有 14 项穷举单测。
    - 气泡里画的内容**必须在自检里问网页自己**（`debugBubble()` 读 DOM），
      不能只看「我调了 present() 没报错」—— 又一条第 19 条的教训。
    - 回归哨兵：`npm run test:reminder`（14 项位置）· `npm run test:reminder-e2e`（19 项端到端）

23. **⚠️ 桌宠「表演」完必须把视线跟随恢复回去**（2026-10-12 落地）
    - 提醒时角色切表情 + 放动作，期间要先摘掉视线跟随（`autoInteract = false` +
      `unregisterInteraction()`），否则放动作时头还在追鼠标，看着很精神分裂。
    - **但必须设个定时器恢复**（`autoInteract = true` + `resetExpression()`），
      否则「眼睛跟着鼠标转」这个招牌动作就**永久丢了**，而且不报错。
    - 和拖拽（第 20 条）是同一招，可以互相参照。

---

## 七、阶段 2 计划（2-1 / 2-2 / 2-3 已完成，下一步 2-4）

### 目标

**到点，宠物主动来找你。**

### 验收标准（来自 PLAN.md）

> 设一个 2 分钟后的日程，到点宠物冒泡 + 系统弹通知；
> 关掉程序重开，已触发过的不重复提醒。

### 数据模型

存 `userData/schedules.json`：

```js
{
  version: 1,
  items: [
    {
      id: "s_1728712345678",   // 用时间戳生成，不用引 uuid 库
      title: "开会",
      time: "09:30",           // 本地时间 HH:mm
      repeat: "once",          // once | daily | weekdays | weekly
      date: "2026-10-13",      // repeat=once 时用
      weekdays: [1, 3, 5],     // repeat=weekly 时用（0=周日）
      enabled: true,
      lastFiredDate: "2026-10-12",  // ★ 去重关键
      createdAt: 1728712345678
    }
  ]
}
```

> ⚠️ 时间一律用**本地时间**。别引 dayjs / moment，用原生 `Date` 够用。

### 调度引擎（`src/main/scheduler.js`）

```
每 30 秒 tick 一次：
  对每个 enabled 的日程：
    算出「今天该触发的时刻」
    判断是否命中：目标时刻 <= 现在 < 目标时刻 + 宽限窗口（建议 5 分钟）
    且 lastFiredDate !== 今天
    → 触发，并把 lastFiredDate 写成今天
```

**为什么不用 `setTimeout`**：电脑睡眠 / 关机再开机，`setTimeout` 会丢事件。
轮询 + `lastFiredDate` 去重，重启后依然可靠。

**为什么要有「宽限窗口」**：轮询是 30 秒一次，目标时刻 09:30:00 可能落在 09:30:12 才被扫到。
窗口太小会漏，太大则晚开机时会炸出一堆过期提醒。**5 分钟是个折中**。

**跨天重复规则**：PLAN.md 明确 **MVP 不补**（昨天没开机，今天不补昨天的）。

### 提醒怎么呈现 ✅ 已完成（`src/main/reminder.js`）

三层，从主到备，按情况自动挑：

1. **桌宠表演** —— 推 `reminder:notify` 给渲染进程，角色切表情「星星眼」+ 放动作「splash」，
   4 秒后恢复常态。理由：气泡是安静的，主人埋头干活时容易错过；角色动一下眼角余光就能扫到。
2. **宠物旁边冒气泡** —— 独立的透明小窗口（268×112），显示「日程标题 + 几点到点」，
   底部一条倒计时条。点「知道了」收起，30 秒没人理也自己收。
   贴在宠物旁边（右优先，放不下翻左边），**宠物挪窝时气泡跟着走**。
3. **系统通知兜底** —— 宠物被收进托盘、看不见时用 Electron `Notification`，
   别让提醒被静默吞掉（气泡贴在宠物旁边，宠物都不在就没意义了）。

> 复用点：`renderer.js` 里的 `playReminderReaction()` 和 `reactToClick()`（点击换表情）
> 是同一套「切表情」调用。以后阶段 3 专注模式的拦截提示可以复用气泡窗口这套。

### 建议拆成 4 小步（每步跑通再下一步）

| 小步 | 做什么 | 跑通的标志 |
|---|---|---|
| **2-1 数据层** ✅ | `src/main/schedules.js`：日程的增删改查 + 校验 + 存盘 | ✅ `npm run test:schedules` 46 项全过 |
| **2-2 调度引擎** ✅ | `src/main/scheduler.js`：30 秒轮询 + 去重 + 宽限窗口 | ✅ `npm run test:scheduler` 39 项全过；端到端 `test:scheduler-e2e` 实测 29 秒后打印「该提醒了」 |
| **2-3 提醒呈现** ✅ | `src/main/reminder.js` + `renderer/bubble/`：气泡 + 表情动作 + 系统通知 | ✅ `npm run test:reminder` 14 项 + `test:reminder-e2e` 19 项全过；实测气泡贴宠物弹出、点「知道了」能收、0.9 秒自动收起、藏起宠物时走系统通知 |
| **2-4 编辑入口** | 最简表单窗口（先不做美观，阶段 4 再美化） | 能在界面上加/删日程，不用手改 JSON |

> 建议**先把 2-1 + 2-2 做完跑通**（纯主进程，好测），再动界面。

### 已拍板的两件事（2026-10-12，主人拍板）

1. **气泡放哪？→ A. 单独的小气泡窗口**，贴在宠物旁边。
   - 好处：不挤压宠物窗口（宠物窗口只有 400×380）；能做成「知道了 / 稍后提醒」按钮；
     阶段 3 专注模式的拦截提示也能复用这套窗口。
   - 实现要点：透明 + 置顶 + 点击穿透，可抄 `main.js` 里宠物窗口的配置；
     **别抢焦点**（`focusable: false` + `showInactive()`），否则会打断主人正在打的字。
2. **错过要不要补？→ 5 分钟内补，超过不补。**
   - 09:30 的提醒，09:34 开机还能看到；11:00 才开机就算了，不补。
   - 落地方式：调度引擎的「宽限窗口」取 **5 分钟**（见上方调度引擎说明）。

> 这两条已经写进 2-2 / 2-3 的实现里，不用再问。

### 这一步的坑（2-4 会碰到）

- 表单窗口是**第三个窗口**了（桌宠 / 气泡 / 设置）。它和前两个不一样：
  **要能输入、要能抢焦点**（主人是在填表，不是在被打扰）→ **不要** `focusable: false`
- 表单窗口里的控件**不受桌宠那套穿透判定影响**（那是桌宠窗口独有的），
  但**如果以后往桌宠界面上加「打开设置」的按钮，那个按钮必须挂 `data-ui`**（见第六节第 21 条）
- 日程的校验逻辑**已经在 `schedules.js` 里了**（`add()` 会返回 `{error}`），
  表单只管把错误显示出来，**别在界面里再写一套校验**（两套迟早不一致）
- 日程文件读坏了要有兜底（`store.read` 已返回 fallback，`schedules.js` 也会自愈）

---

## 八、已定的关键决策（不要推翻，除非主人要求）

### 技术栈

**Electron + 原生 HTML/CSS/JS + electron-builder**

选它的理由：桌宠本质是「透明窗口 + 动图」，Electron 三个配置项搞定；
定时提醒和调用系统命令（改 hosts、杀进程）都是 Node 自带能力，不用跨语言；
**全程一种语言，AI 不用切换上下文，出错最少**。

已排除：Tauri（Rust 报错劝退）、Python + PySide6（透明窗口和打包都折腾）、tkinter（动图效果差）。

已落地版本：Electron **44.7.0**（内置 Node 24.x / Chromium 152）。

### 形象方案

**女仆鲸鱼娘 · 真 Live2D 模型**（路线 A）。

⚠️ **这意味着项目永久非商业**，三条必须遵守：

1. **不得商用** —— 不能卖钱、不能上架、不能内置广告、不能出收费版
2. **必须完整署名**（见 `CREDITS.md`）：溟月（上善无形）→ 女仆鲸鱼娘（ZipZipPipe）→ 三视图（1190fasheqi/dafeiyu-pet）→ **氵六青**
3. **不算 OSI 开源**（GitHub 显示 "Other"）；**项目名不使用 "DeepSeek" 商标**

决策过程（方案 B 原创 → 改回方案 A）见 `HANDOFF-ARCHIVE.md` 附录 A。

### 已锁死的版本（别乱升）

| 包 | 版本 | 为什么锁 |
|---|---|---|
| `pixi.js` | **6.5.10** | `pixi-live2d-display` 只兼容 PIXI 6.x |
| `pixi-live2d-display` | **0.4.0** | 它就是最新版，没有更新的 |

---

## 九、相关文档

| 文件 | 内容 |
|---|---|
| `HANDOFF.md` | 本文件 —— 开工手册，读这个就够 |
| `HANDOFF-ARCHIVE.md` | 历史归档：调研过程、决策史、阶段 1 验收记录 |
| `CLAUDE.md` | 给 AI 看的项目说明书（技术栈、目录、硬性约定） |
| `PLAN.md` | 完整实现方案（需求拆解、选型理由、分阶段规格、风险清单） |
| `CREDITS.md` | 素材署名链 |
| `LICENSE` / `LICENSE-ASSETS.md` | 代码 / 素材的许可协议 |
| `SKILLS-推荐与安装指南.md` | GitHub 技能调研 + 三种安装方式教程 |
| `SKILLS-安全审计报告.md` | 5 个技能的完整审计记录 |

---

## 十、已装技能（2026-10-12）

装在 `C:\Users\FlyMe\.workbuddy-ai\skills\`，全部通过安全审计（0 个 P0 / 0 个 P1）：

| 技能 | 用途 |
|---|---|
| `frontend-design` | 桌宠 UI + 设置界面的视觉设计 |
| `webapp-testing` | Playwright 测界面（需另装 playwright 包） |
| `systematic-debugging` | 强制先找根因再改代码 |
| `writing-plans` | 把需求拆成可执行计划 |
| `verification-before-completion` | 说"做完了"之前先跑验证拿证据 |

**安装原则（重要）**：只复制技能文件夹本身，**绝不带仓库根目录的 `hooks/` 和插件配置**。
任何新技能安装前，**必须先跑安全审计**（规范见 `C:\Users\FlyMe\.workbuddy-ai\plugins\marketplaces\codebuddy-plugins-official\plugins\skills\skills-security-check\skills\skills-security-check\SKILL.md`）。

**明确决定不装的**：
- `agent-sprite-forge` —— 依赖太重（Python 3.10+ / ffmpeg 5.1+ / numpy·Pillow·scipy + 图像视频生成后端），对桌宠超配
- `full-stack-skills/electron-skills` —— 仅 6 星，当参考资料读即可

---

## 开工前 checklist（新对话照做）

- [ ] 读 `CLAUDE.md`（硬性约定）+ 本文件
- [ ] 确认项目目录是 `C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`
- [ ] 启动用 `npm start -- --no-gpu`（本机沙箱无 GPU）
- [x] 第七节「待拍板的两件事」已定：**气泡 = 独立小窗口** / **错过 = 5 分钟内补**
- [ ] 从 **2-4 编辑入口**接着做（2-1 / 2-2 / 2-3 都已完成），别一口气把阶段 2 全做完

---

_主人 sync 新细节时，记得回来更新这份文件。_
