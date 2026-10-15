# HANDOFF-V4.md · 桌宠项目交接（v4 UI 升级进行中 · 下一步：批次 3）

> **给新对话里的小安：读完这一份就能直接开工，不用主人再解释一遍。**
>
> 最后更新：2026-10-15 17:00 · **v4 批次 1 / 2 / 2.5 / 2.6 / 2.6⁺ 全部完成并提交** ·
> **自检流程已改成分层（内循环只跑受影响的，收尾才全量）—— 见 §3.2** ·
> **下一步：批次 3（动效 + 侧边栏结构）—— 主人已明确授权开工**
>
> **深度参考（需要时再翻，别一上来全读）：**
> - `PLAN-V4-UI升级.md` —— **v4 的总设计 + 每批任务表 + 停靠点**（动手前必读）
> - `CLAUDE.md` —— 硬性约定原文 + **67 条坑**（写完代码前扫一眼相关段落）
> - `HANDOFF-V3.md` —— 阶段 3 专注模式的交接（已被本文件取代，留作存档）
> - `HANDOFF.md` —— 阶段 0–2 全过程 + 38 条坑（查古早资料用）
> - `PLAN-V3-专注模式.md` —— 专注模式原始设计（要做专注相关改动时看）

---

## 零、三十秒速览

| 项 | 内容 |
|---|---|
| **项目** | Windows 桌面宠物「大肥鱼」（真 Live2D 女仆鲸鱼娘 `c_0120`） |
| **位置** | `C:\Users\FlyMe\WorkBuddy AI\desktop-pet\` |
| **技术栈** | Electron + 原生 HTML/CSS/JS + electron-builder（**不新增依赖**这条要守） |
| **已完成** | 阶段 0/1/2 ✅ · v2 周视图+聊天 ✅ · 阶段 3 专注模式 ✅（真机验收第 2 步卡住，见 §6）· **v4 批次 1/2/2.5/2.6/2.6⁺ ✅** |
| **下一步** | **v4 批次 3：动效（可打断弹簧 / 速度衔接 / 橡皮筋）+ 设置窗口改侧边栏** |
| **跑起来** | `npm start -- --no-gpu`（本机无 GPU，必须带这个参数） |
| **直接看设置窗口** | `PET_OPEN_SETTINGS=1 npm start -- --no-gpu` |
| **看专注页** | `PET_OPEN_SETTINGS=focus npm start -- --no-gpu` |
| **最近提交** | `4afa448` v4 批次 2.6⁺：退出进度条改蓝色 |

### 主人最近说过什么（原话）

1. 「把退出专注模式做成进度条 按照苹果的设计原则」 → **批次 2.6**（已完成）
2. 「把推出进度条颜色改为蓝色 然后继续批次3」 → **批次 2.6⁺**（已完成）+ **授权批次 3**
3. 「做一份 handoff 整理一下所有 artifacts 提高效率」 → **就是这份文件**
4. 「优化自检流程，已经验证过的功能不用自检」 → **分层自检（§3.2）**：
   内循环只跑受影响的套件，收尾才全量；映射表 + 安全阀在 `scripts/test-changed.js`

---

## 一、怎么和主人说话（比技术更重要，先看这条）

- 称呼「**主人**」（硬性要求，别改成别的）；我的名字是「**小安**」。
- 主人是 **AI 小白**：讲人话、少术语、多举例子。
- **一次只推进一小批，跑通了、截图给主人看了、主人说「可以了」再开下一批。**
- **主人没点头，绝不擅自开下一批。** 批次之间的停靠点是硬规矩。
- 每个批次做完就 `git commit` 一次（中文提交信息，说清「做了什么 + 为什么」）。
- 汇报**先说结论**，再说细节；别堆一大段过程。
- 要动系统 / 有风险的操作，先讲清楚风险，别自作主张。

---

## 二、v4 UI 升级：批次进度一览

| 批次 | 内容 | 状态 | 提交 |
|---|---|---|---|
| 1 | 安装软件选择器（从开始菜单列软件，不列进程） | ✅ | 已提交 |
| 2 | 视觉改造：设计 token 层 + 材质 + 排版 + 按压反馈 | ✅ | `32aa8e1` |
| 2.5 | 选择器改「先勾后存」+ 划过放大 + 无障碍 | ✅ | `fd8757d` |
| 2.6 | 退出专注改「按住进度条」+ 专注页整体打磨 | ✅ | `9a1f95f` |
| 2.6⁺ | 进度条改**蓝色** + 修掉按钮被 `.danger` 盖住的 bug | ✅ | `4afa448` |
| 3-a | 动效**纯函数**：`spring.js` + `rubberband.js` + 自检 | ✅ 代码+自检全绿 | 已提交 |
| **3-b** | **接进桌宠拖拽**：松手速度衔接 + 拖出边界橡皮筋 | ⏳ **下一步** | — |
| 3-c | 设置窗口改**侧边栏** + 面板空间一致 + 减少动效 | ⏳ | — |

> ⚠ 3-a 只是**纯数学**，界面行为一点没变 —— 所以它不需要真机验收，
> 看曲线图和自检数字就够。**3-b 才动界面**，那一步必须主人亲手拖一次才算完
> （拖拽手感合成事件测不了，见 §7）。

### 批次 3-a 做了什么（2026-10-15）

- `src/main/spring.js`：手写弹簧。语义参数是 apple-design 的
  **damping（阻尼比）+ response（响应时间）**，不是 mass/stiffness/damping。
  默认 `damping 1.0`（不弹）；只在手势带惯性时才给 ~0.8。
  · `stepSpring(state, target, dt, opts)` —— state 就是 `{x, v}`，所以**天然可打断**
    （打断时把当下的位置和速度喂进去即可，两者都不跳变）。
  · **内部固定 1/240 秒子步长** —— 掉帧给个大 dt 也不会发散，结果还和帧率无关。
  · `estimateVelocity(samples)` —— 松手时把指针速度算出来（只取最近 100ms）。
  · 坏输入一律兜底成 0 / 原样返回，**绝不产出 NaN**。
- `src/main/rubberband.js`：iOS 渐进阻力 `(1 - 1/(d·c/dim + 1))·dim`。
  越拖越沉、永远不超上界、左右对称；系数夹在 `(0, 1]`。
- 自检：`npm run test:spring`（37/0，负对照 8/8）、`npm run test:rubberband`（21/0，负对照 5/5）。
  ★ 负对照里有两条是「**拿朴素写法算一遍证明这条断言真的能红**」：
  不拆子步的朴素欧拉两步就飞到 -22007；打断时把速度清零会让轨迹明显不同。
- 回归：纯 Node **19 套全绿，862 断言 0 失败**。

### 批次 3 要做什么（`PLAN-V4-UI升级.md` 第 271 行起有完整版）

来自 apple-design 的核心原则，逐条落到本项目：

1. **可打断的弹簧** —— 手写的 rAF 弹簧（不引依赖），任何动画都能中途抓住反向。
2. **速度衔接** —— 拖拽松手时，把手指速度交给弹簧，接缝处不能「顿一下」。
3. **空间一致** —— `transform-origin` 打在触发点上；从哪进就从哪出。
4. **橡皮筋边缘** —— 拖到边界是渐进抵抗，不是硬停。
5. **减少动效** —— `prefers-reduced-motion` 换成淡入淡出，不是干脆没有反馈。
6. **结构** —— 设置窗口改成**侧边栏布局**（左边分页，右边内容）。

**硬性要求（每批都适用，别忘）：**
- 纯逻辑放主进程 / 独立文件，**能脱离 Electron 用纯 Node 单测**。
- 自检**必须带负对照**，且每条负对照都要能答上「它怎样才能红」。
- **分层自检**：写的过程中只跑「这次碰到的东西」对应的套件（`npm run test:changed`，秒级）；
  **批次收尾 / 提交前必须全量**（`npm run test:all`）。详见 §3.2。
- 新批次改动**单独一次 commit**。
- 桌宠窗口加任何 DOM 控件**必须挂 `data-ui`**，否则穿透判定会让它点不到。
- `.ps1` / `.bat` / `.vbs` **必须纯 ASCII**，连注释都不能有中文。

---

## 三、命令清单（照抄就行）

### 3.1 跑起来

```bash
npm start -- --no-gpu                 # 正常启动（本机无 GPU，必须带 --no-gpu）
PET_OPEN_SETTINGS=1 npm start -- --no-gpu        # 直接开设置窗口
PET_OPEN_SETTINGS=focus npm start -- --no-gpu    # 直接开设置窗口的专注页
PET_OPEN_CHAT=1 npm start -- --no-gpu            # 直接开聊天条
```

主人自己用：双击桌面「启动桌宠」/「停止桌宠」（由 `npm run make-launcher` 生成）。

### 3.2 分层自检（先看这条 —— 已经验过的功能不用重验）

以前每改一行就全量跑，20 多套、其中好几套要真开 Electron，一轮好几分钟。
现在分两层：**写的时候只跑碰到的，收尾才全量。**

```bash
# ① 内循环（秒级）：看这次改了什么，只跑受影响的套件
npm run test:changed

#    先看一眼会跑哪些，不真跑
npm run test:changed -- --list

#    只跑纯 Node 的（跳过真渲染进程 / 端到端，最快）
npm run test:changed -- --pure

#    跟某个提交比（默认 HEAD = 未提交的改动）
npm run test:changed -- --base=4afa448

#    预演：不改 git，直接问「改了这些会跑哪些」
npm run test:changed -- --list --files=src/main/focus/hosts.js

# ② 批次收尾 / 提交前（必跑）：全量
npm run test:all
```

挑选用的是**影响映射表**（写死在 `scripts/test-changed.js` 顶部的 `SUITES`）：
每个套件声明它「管」哪些源码文件，脚本读 `git diff` 反查出该跑哪几套。
映射表里没登记的新源码文件**会被点名报出来**，不会静默漏掉。

**三条安全阀（别绕过）：**
1. 碰到**交叉件**（`src/main/main.js` / `package.json` / `scripts/start-dev.js`）→
   自动升级为**全量**。这几个被谁 require 太多，挑着跑就是自欺欺人。
2. 出现**没登记的源码新文件** → 点名 + 建议全量。
3. 新加套件**记得回映射表登记**，否则它只能被 `test:all` 跑到。

挑选器自己也有自检（纯内存，带 8 条负对照）：

```bash
npm run test:changed-check     # 17 通过 / 0 失败 · 负对照 8/8
```

**⚠ 常见改动 → 会跑哪几套（速查）**

| 改了什么 | 会跑 |
|---|---|
| `spring.js` | spring |
| `rubberband.js` | rubberband |
| `focus/hosts.js` | focus-hosts · focus-helper · focus-intercept · focusmode-e2e |
| `focus/timer.js` | focus-timer · focus-stop-ui · focusmode-e2e |
| `focus/blacklist.js` | focus-blacklist · apps · picker-ui · focusmode-e2e |
| `renderer/settings/index.html` | picker-ui · focus-stop-ui · settings-e2e |
| `renderer/pet/renderer.js` | sync · gaze · exit · drag |
| `brain/*` | brain-local / brain-cloud / brain-router · chat-e2e |
| 只改 `*.md` | 一套都不跑 |
| `main.js` / `package.json` | **全部** |

### 3.3 单套命令清单（想单独跑某一套时）

```bash
# 数据 / 调度层
npm run test:schedules        # 63
npm run test:scheduler        # 39
npm run test:reminder         # 14
npm run test:place            # 37
npm run test:quit             # 8
npm run test:week             # 53
npm run test:nl-time          # 23

# 动效纯函数（v4 批次 3-a）
npm run test:spring           # 37（可打断 / 速度衔接 / 帧率无关 / 大 dt 不炸，负对照 8/8）
npm run test:rubberband       # 21（渐进阻力 / 不超上界 / 对称，负对照 5/5）

# 聊天大脑
npm run test:brain-local      # 19
npm run test:brain-cloud      # 18
npm run test:brain-router     # 19

# 专注模式（纯函数部分）
npm run test:focus-blacklist  # 76
npm run test:focus-timer      # 34
npm run test:focus-hosts      # 99
npm run test:focus-elevate    # 81
npm run test:focus-helper     # 51（真跑 .ps1，不提权）
npm run test:focus-intercept  # 56
npm run test:focus-wiring     # 接线自检

# 界面（真渲染进程 + 内存 IPC，不碰系统）
npm run test:picker-ui        # 49
npm run test:focus-stop-ui    # 65（含「填充是蓝色不是红色」一节，负对照 27/27）
```

### 3.4 Electron 端到端（慢，改到窗口/接线时必跑）

```bash
npm run test:settings-e2e     # 160
npm run test:focusmode-e2e    # 60
npm run test:reminder-e2e     # 19
npm run test:chat-e2e         # 17
npm run test:week-e2e         # 19
npm run test:scheduler-e2e
npm run test:focus            # 20（窗口**焦点**自检，别和专注模式搞混）
npm run test:sync             # 10
npm run test:gaze             # 6
npm run test:exit             # 点真退出按钮，会真的退出（正常）
npm run test:drag             # 性能基准，只印测量值、不印通过数（正常）
```

### 3.5 工具

```bash
npm run check:hosts           # hosts 体检：能不能读 / 错误码 / 有没有残留标记块（只读，不提权）
npm run check-assets          # 验图片真透明
npm run shot                  # 截图验收
npm run make-launcher         # 生成桌面双击快捷方式
npm run sync-vendor           # 同步 Live2D 第三方运行时
```

### 3.6 ⚠ 统计全套结果时的坑

**各套件收尾格式不统一**（有的印「结果：」有的印「结束：」）。
`npm run test:all` 已经统一收好了（两种都认），**收尾统计直接看它的汇总表就行**，不用自己 grep。

`test:exit` 和 `test:drag` **不会印「N 通过 / M 失败」**：
- `exit` 会**真的点退出按钮退出**（前半段会印 `前半段结果：9 通过 / 0 失败`）—— 这是设计如此，不是坏。
- `drag` 是**性能基准**，只印测量值；`test:all` 里它显示为「基准」而不是通过/失败。

真要自己批量 grep 时用：

```bash
npm run test:xxx --silent 2>&1 | grep -E "(结果|结束)："
```

---

## 四、artifacts 地图（哪份文件管什么）

### 4.1 设计 / 计划文档（根目录）

| 文件 | 作用 | 什么时候读 |
|---|---|---|
| **`PLAN-V4-UI升级.md`** | **v4 总设计 + 每批任务表 + 停靠点** | **动手前必读** |
| `CLAUDE.md` | 硬性约定原文 + **67 条坑** | 写代码前扫相关段落 |
| `HANDOFF-V4.md` | **本文件** | 刚接手时 |
| `HANDOFF-V3.md` | 阶段 3 专注模式交接（存档） | 查专注模式 |
| `HANDOFF.md` | 阶段 0–2 + 38 条坑（存档） | 查古早资料 |
| `PLAN-V3-专注模式.md` | 专注模式原始设计 | 改专注功能时 |
| `PLAN-V2-周视图与聊天.md` | v2 设计（存档） | 改周视图/聊天时 |
| `PLAN.md` | 最早的总方案（第三节是专注模式） | 查历史设计 |
| `CREDITS.md` / `LICENSE-ASSETS.md` | 素材署名与许可（CC BY-NC-SA 4.0） | 发布前 |
| `SKILLS-*.md` | Skill 安全审计 / 推荐记录 | 装 Skill 时 |

### 4.2 源码结构

```
src/
  main/            ← 主进程（碰系统的都在这里）
    main.js                 入口 + 各窗口 + 自检分发
    place.js                窗口摆位（纯函数，刻意不 require electron 好单测）
    week.js                 周视图布局数学（纯函数）
    focus/                  专注模式
      index.js              状态 + 规则（timer.canExit 是唯一裁定处）
      timer.js              计时状态机（纯函数）
      hosts.js              hosts 文本操作（纯函数，latin1 逐字节往返）
      blacklist.js          黑名单纯函数
      elevate.js            提权壳（依赖延迟 require，能脱离 Electron 单测）
      focus-helper.ps1      常驻提权助手（**纯 ASCII**）
    brain/                  聊天大脑
      local.js              本地规则
      cloud.js              云端（Node 内置 fetch，不新增依赖）
      index.js              路由：本地高置信 → 云端 → 失败退回本地
    focus-notice.js         专注提示窗口（focusable:true，抢焦点）
    preload-settings.js     设置窗口的窄 IPC 桥
  renderer/          ← 界面（不碰系统，一律走 IPC）
    settings/
      index.html            设置窗口（设计 token 全在这里）
      settings.js           设置窗口逻辑
    pet/
      model/                Live2D 模型（素材，受 CC BY-NC-SA 4.0 约束）
      vendor/               第三方运行时（sync-vendor 同步）
  assets/            ← 静态图片
scripts/             ← 开发工具 + 自检（见 §3）
  test-changed.js          ★ 按改动挑自检（映射表 SUITES + 安全阀 + --selfcheck）
outputs/             ← 截图产物（v4-*.png）
launcher/            ← 桌面快捷方式备胎
```

### 4.3 关键约定（别改错，改错会出真 bug）

**窗口焦点策略**（四个窗口各不相同，别照抄）
- 桌宠 `focusable:false`、提醒气泡 `focusable:false` → 显示一律 `showInactive()`（**别写 `show()`**）
- **专注提示窗口 `focusable:true`** → 反过来用 `show()` + `focus()`（要主人看见并点按钮）
- 设置窗口**必须能抢焦点**

**专注模式的核心约定**
- 拦截分两段：改 hosts 挡网站 + 轮询杀进程挡软件；**整段专注只弹一次 UAC**（起常驻助手）。
- **结束走控制文件，绝不杀助手进程**（强杀就没机会还原 hosts）。助手有到点自愈兜底。
- **`focus-ctl.json`（只主进程写）和 `focus-hb.json`（只助手写）必须分开**（同文件会互相覆盖）。
- 计划文件带 `mode` 字段：`'session'` = 正常专注，`'restore'` = 一次性清理。
  ★ 拿 `session` 去清残留，会把**脏文件当原文件备份**再写回 = 等于没清。
- **hosts 一律用 latin1 读写**，做到逐字节往返。`writeHostsText` 有守卫：出现 `> U+00FF` 直接抛错拒写。
- **读 hosts 失败必须把原因带出来**（code/message/path）→ `intercept.readError()` + `explainReadError()`。
  ★ 教训：凡是 `catch` 完只返回兜底值的地方，都在丢诊断信息。

**界面约定**
- 往桌宠界面加 DOM 控件**必须挂 `data-ui`**（否则穿透判定会让它静默点不到）。
- 界面控件必须放 `#ui` 容器、由 `syncUiBox()` 对齐画布（不能贴窗口边定位）。
- 布局数学放主进程纯函数（渲染进程不能 `require`），界面只拿比例乘像素。
- 提到桌宠时**一律 `movePet()`**（内部 `setBounds` 连尺寸写回），别直接 `setPosition()`。
- **带标题栏的窗口在 1.5 倍缩放下外框尺寸会自己飘** → 用固定标称尺寸算位置，再用 `setBounds()` 一起写回。

**刚学的两条（批次 2.6⁺，CLAUDE.md 66/67）**
- **量带过渡的样式，不能在同一个 tick 里读** —— 读到的是过渡**起点**。加完状态要等过渡走完再读。
- **判「是不是某个颜色」要色相 + 彩度一起判** —— 深灰带一点蓝调（hue≈222°/sat≈15%）会骗过只判色相的检查。
- **按钮别借通用类（`.danger`）的样式** —— 两边都会设 `background` 时会互相抢，抢输了极难从截图看出来。

---

## 五、v4 批次 3 开工指引（下一步做这个）

### 5.1 开始前

1. 读 `PLAN-V4-UI升级.md` 第 271 行起的「批次 3」完整设计。
2. 读 `CLAUDE.md` 第 61–67 条（都是 v4 期间新增的坑）。
3. 确认工作区干净：`git status --short` 应该没有未提交改动。

### 5.2 建议的拆法（跟前面几批一个节奏）

| # | 做什么 | 落点 | 可测性 |
|---|---|---|---|
| 3-1 | 手写弹簧（rAF，无依赖）：`spring.js` 纯函数 | 新 `src/main/spring.js` 或 renderer 侧纯模块 | **纯 Node 可单测**（喂初速、看收敛/过冲） |
| 3-2 | 速度衔接：松手把指针速度交给弹簧 | 拖拽相关（桌宠移动 / 周视图） | 纯函数测「算出的初速对不对」 |
| 3-3 | 空间一致：`transform-origin` 打在触发点 | 设置窗口弹层 | 端到端量计算值 |
| 3-4 | 橡皮筋边缘 | 拖拽边界 | **纯函数 `rubberband()` 可单测**（带负对照） |
| 3-5 | `prefers-reduced-motion` 降级 | 全窗口 | 用 CDP `Emulation.setEmulatedMedia` 量 |
| 3-6 | 设置窗口改侧边栏结构 | `index.html` + `settings.js` | 端到端 + 截图 |
| 3-7 | 全量回归 + 截图 + 文档 + 提交 | — | 见 §3 |

### 5.3 注意

- 弹簧参数用 apple-design 给的语义参数（**damping ratio** + **response**），不是 mass/stiffness/damping。
- 默认 `damping 1.0`（不弹），**只在手势本身带惯性时**才给 `~0.8` 的弹。
- 侧边栏改造是**结构变更**，容易碰坏现有的模式切换逻辑（`mode` / `applyMode()`）——
  改完务必跑 `test:settings-e2e` 和 `test:picker-ui`。
- 结构变了**要重出截图**，因为主人是靠截图验收的。

---

## 六、遗留事项（批次 3 之外，别忘了）

### 6.1 阶段 3 专注模式：真机验收卡在第 2 步 ⚠

- **代码和自检都完成了**，但**真机验收没做完**。沙箱里验不了这三件事，只能主人点：
  UAC 弹窗、网站真打不开、记事本真被关。
- **2026-10-15 实测记录：** 卡在「读不到 hosts」。
  hosts 文件本身没问题（PowerShell / node / Electron 都能读，ACL 正常），
  机器上装了**火绒安全软件**；结论是「代码路径没问题，运行那一刻被外部挡了」。
- 已加诊断（把系统错误码带出来）+ 一键体检 `npm run check:hosts`，**等主人回报错误码**。

### 6.2 其他

- `CREDITS.md` / `LICENSE-ASSETS.md`：模型素材受 **CC BY-NC-SA 4.0** 约束，发布前要确认署名。
- 版本锁死：`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`（后者只兼容 PIXI 6.x，**别 `npm update`**）。

---

## 七、环境坑（本机特有，撞上了照这个办）

- **`ELECTRON_RUN_AS_NODE=1`** 会让 electron 退化成 Node 报 `whenReady undefined`。
  自检脚本头部已内置规避（`delete env.ELECTRON_RUN_AS_NODE`）。
- **无 GPU 参数必须是** `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`，
  **不能用 `--disable-software-rasterizer`**（会让 WebGL 罢工）。
- **桌面是 OneDrive 重定向的**：`%USERPROFILE%\Desktop` 不存在，
  真实桌面在 `C:\Users\FlyMe\OneDrive\Desktop`。取桌面路径**一律用 `app.getPath('desktop')`**。
- **`.bat` / `.vbs` 里绝对不能写中文**，连注释都不行（解释器按 GBK 读，会乱码并把后面命令带崩），
  连文件名都用英文。
- **生成 `.lnk` 用 Electron 的 `shell.writeShortlink`**，别自己拼 MS-SHLLINK 二进制。
- **`--isolated` 的临时目录每次必须清空**（`start-dev.js` 已做）：自检会拖动桌宠并存位置，
  复用旧目录会让下次自检停在上次遗留的位置上，结果不可复现。
- **不能靠 `sendInputEvent` 合成拖拽**：Electron 合成鼠标事件的 `screenX/screenY` 恒为 0。
  `Add-Type` 被安全策略拦，**无法程序化驱动真实鼠标**。拖拽类问题只能问主进程要系统光标位置，或人工拖一次。

---

## 八、写自检的铁律（本项目血泪，违反就会做出「假绿」的测试）

1. **必须带负对照**，否则测试是假的。
2. **每条负对照都要能答上「它怎样才能红」** —— 答不上来的就是装饰，删掉。
3. **量绝对量，别量相对量** —— 相对量可能恒等于常数，负对照永远不失败。
4. **报错必须带量到的数值**，否则失败信息等于没说。
5. **「找第一条就 return」会烂掉** —— 别人加一条同选择器的规则，检查就悄悄失效。要**全部收齐再判**。
6. **夹具要比真货一样全** —— 少字段测的就是假货（漏 `remainingMs` 曾把倒计时画成 `NaN:NaN`）。
7. **自检崩了也必须打印结论** —— 整段包 `try/catch`，catch 里 `fail++` 并印「自检自身抛异常」。
8. **改了「谁 require 谁」这类接线，纯函数自检永远是绿的，必须跑端到端**。
9. **量带过渡的样式要等过渡走完**（同 tick 读到的是起点）。
10. **判颜色要色相 + 彩度一起判**。
11. **「挑着跑」不能替代「收尾全量」** —— 内循环用 `test:changed` 省时间，
    提交前必须 `test:all`。挑着跑跑绿了只说明「这次碰到的那几块没事」，
    不代表整体没坏（交叉件已被自动升级为全量，但新登记的映射漏了就得靠全量兜底）。

---

## 九、快速自检：我准备好了吗？

开工前对着这几条过一遍：

- [ ] 我知道主人是谁（称呼「主人」）、我是谁（小安）、主人是 AI 小白。
- [ ] 我读了 `PLAN-V4-UI升级.md` 的批次 3 部分。
- [ ] 我知道**当前下一步 = 批次 3**，且主人已授权。
- [ ] 我知道批次做完要**停下来等主人确认**，不能连着做下一批。
- [ ] 我知道改完要跑**相关套件**（内循环 `npm run test:changed`）、
      收尾要跑**全量**（`npm run test:all`），并**重出截图**。
- [ ] 我知道新批次改动要**单独 commit**（中文提交信息）。
- [ ] 我记得：不新增依赖 / 纯逻辑脱离 Electron / `.ps1` 纯 ASCII / 新控件挂 `data-ui`。
- [ ] `git status --short` 是干净的（或我知道那些改动是什么）。

**开工第一句话（可以直接用）：**

> 主人好，我是小安。我看了 v4 的进度：批次 1 / 2 / 2.5 / 2.6 / 2.6⁺ 都做完提交了，
> 退出进度条也已经改成蓝色。**下一步是批次 3：让界面「动」起来（弹簧、拖拽衔接、橡皮筋）
> 加上把设置窗口改成侧边栏。** 我打算先做最基础的那块（手写弹簧 + 橡皮筋，都是纯函数、能单测），
> 跑通了截图给您看，可以吗？
