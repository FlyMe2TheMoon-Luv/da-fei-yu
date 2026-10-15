# CLAUDE.md · 桌宠项目说明书

> 这份文件是给 AI（Claude / WorkBuddy 等）看的项目说明书。
> **动手写代码前先读它。** 它决定了后续实现会不会跑偏。
> 最后更新：2026-10-14（阶段 3 专注模式 Task 1–9 完成 · 自检全绿 · 就差主人真机验收）

---

## 一、项目是什么

**桌面宠物（desktop-pet）**，Windows 桌面端，两个核心功能：

1. **日程提醒** —— 按输入的日程安排到点提醒
2. **专注模式** —— 在该模式下禁用用户预设的网站或软件

完整方案见 `PLAN.md`；**当前状态与下一步见 `HANDOFF-V3.md`**（阶段 0–2 全过程见 `HANDOFF.md`，
历史调研归档在 `HANDOFF-ARCHIVE.md`，阶段 3 的 Task 拆解见 `PLAN-V3-专注模式.md`）。

---

## 二、技术栈（已定，不要随意更换）

**Electron + 原生 HTML/CSS/JS + electron-builder**

- 不用任何前端框架（React/Vue 等），就是原生 HTML/CSS/JS
- 不用 TypeScript
- 打包用 electron-builder

**为什么**：桌宠本质是「透明窗口 + 动图」，Electron 几个配置项就能搞定；定时提醒、调用系统命令（改 hosts、杀进程）全是 Node 自带能力，不用跨语言；全程一种语言，AI 不用切换上下文，出错最少。

**已排除**：Tauri（Rust 报错劝退）、Python + PySide6（透明窗口和打包都折腾）、tkinter（动图效果差）。

---

## 三、目录结构（一开始就定死，别乱放）

```
desktop-pet/
├─ package.json
├─ CLAUDE.md              ← 本文件，项目说明书
├─ HANDOFF.md             ← 项目交接文件（开工手册，先读这个）
├─ HANDOFF-ARCHIVE.md     ← 历史归档（调研 / 决策史 / 验收记录）
├─ PLAN.md                ← 完整实现方案
├─ LICENSE                ← 代码：MIT
├─ LICENSE-ASSETS.md      ← 素材：CC BY-NC-SA 4.0
├─ CREDITS.md             ← 素材署名链（三位权利人，不能漏）
├─ src/
│  ├─ main/               ← 主进程：Node 世界，能碰系统
│  │  ├─ main.js          窗口创建、托盘、位置记忆、生命周期
│  │  ├─ preload.js       ← 桌宠窗口的安全桥梁
│  │  ├─ preload-bubble.js ← 气泡窗口的安全桥梁（只暴露「读内容 / 点知道了」）
│  │  ├─ preload-settings.js ← 设置窗口的安全桥梁（只暴露日程增删改查 + 预览）
│  │  ├─ store.js         本地 JSON 读写（一律写 userData）
│  │  ├─ schedules.js     日程数据层：增删改查 + 校验 + 存盘（阶段 2-1）
│  │  ├─ scheduler.js     日程轮询引擎：30 秒轮询 + 去重 + 5 分钟宽限（阶段 2-2）
│  │  ├─ reminder.js      提醒呈现：气泡窗口 + 桌宠表演 + 系统通知兜底（阶段 2-3）
│  │  ├─ settings-window.js 日程管理窗口：加 / 改 / 删日程（阶段 2-4）
│  │  ├─ place.js         纯函数：把小窗口摆在桌宠旁边（**刻意不 require electron**，好单测）
│  │  ├─ week.js          周视图布局纯函数（v2）
│  │  ├─ nl-time.js       中文大白话 → 时间/日程解析（v2）
│  │  ├─ brain/           聊天大脑（v2）：local.js / cloud.js / index.js（路由）
│  │  ├─ chat-window.js   聊天条窗口（v2，focusable:true）
│  │  ├─ ai-config.js     云端 AI 配置存取（Key 只存 userData，界面只见掩码）
│  │  ├─ focus-notice.js  专注·拦截提示窗口（Task 9，**focusable:true**，和气泡相反）
│  │  ├─ preload-notice.js ← 拦截提示窗口的安全桥梁
│  │  ├─ focus-helper.ps1 ← 提权常驻助手（**纯 ASCII**）：备份/写 hosts/杀进程/还原
│  │  ├─ selftest-focusmode.js ← 专注模式端到端自检（--selftest=focusmode）
│  │  └─ focus/           专注模式（阶段 3）
│  │     ├─ index.js      主控：配置 + 会话 + 编排（require electron，别拿它单测）
│  │     ├─ blacklist.js  黑名单校验 + killListOf（纯函数）
│  │     ├─ timer.js      计时状态机 + 长按 3 秒规则（纯函数）
│  │     ├─ hosts.js      hosts 文本增删改（纯函数，绝不 fs）
│  │     ├─ intercept.js  系统薄壳：读/写 hosts、算块、组装计划
│  │     ├─ doh.js        安全 DNS（DoH）检测（纯函数探测层，可注入）
│  │     └─ elevate.js    提权壳 + 计划文件（碰 electron 的依赖延迟 require，可单测）
│  ├─ renderer/           ← 界面：浏览器世界，碰不到系统
│  │  ├─ pet/             桌宠本体
│  │  │  ├─ index.html
│  │  │  ├─ renderer.js   Live2D 渲染 + 裁切 + 拖拽 + 鼠标穿透 + 提醒表演
│  │  │  ├─ vendor/       第三方运行时（PIXI / Cubism Core / pixi-live2d-display）
│  │  │  └─ model/        Live2D 模型（属「素材」，见 LICENSE-ASSETS.md）
│  │  ├─ bubble/          提醒气泡（阶段 2-3）：透明小窗口 268×112
│  │  └─ settings/        日程管理（阶段 2-4）：普通窗口，列表 + 表单
│  └─ assets/             静态图片、音效
│     ├─ pet/             三视图 PNG + icon + 桌宠.ico（多尺寸图标，由 make-launcher 生成）
│     └─ tray.png         托盘图标（由 make-tray-icon 生成）
├─ launcher/              桌面快捷方式的「备胎」（**必须纯 ASCII**，见第六节）
│  ├─ start-pet.bat       双击启动（.lnk 坏了时用）
│  ├─ stop-pet.bat        双击停止
│  └─ start-pet.vbs / stop-pet.vbs  把上面两个 .bat 藏起来跑（不闪黑框）
├─ scripts/               开发工具（都不是运行时依赖）
│  ├─ start-dev.js        启动器：抹平环境坑
│  ├─ sync-vendor.js      同步第三方运行时到 vendor/
│  ├─ check-assets.js     素材体检：验图片是不是真透明
│  ├─ make-tray-icon.js   生成方形托盘图标
│  ├─ make-launcher.js    生成图标 + 桌面双击快捷方式（**两种身份**，见第六节）
│  ├─ shot.js             截屏（验收用）
│  ├─ test-place.js       窗口摆放位置自检（纯 Node，不依赖 Electron）
│  ├─ test-quit.js        「停止桌宠」端到端自检（纯 Node，含负对照）
│  └─ lib/png.js          零依赖 PNG 解码/编码
└─ spike/                 一次性验证台，可随时删（见 spike/README.md）
```

---

## 四、硬性约定（写代码时必须遵守）

1. **renderer 绝对不能直接碰系统**，所有系统操作都通过 IPC 交给 main。
2. **`contextIsolation: true` + preload + contextBridge，绝不开 `nodeIntegration`。**
   —— AI 图省事会这么写，一定要拦住。
3. 日程调度用 **30 秒轮询 + `lastFiredDate` 去重**，**不用 `setTimeout`**（电脑睡眠会丢事件）。
4. 改 hosts 必须用 `# === FocusMode BEGIN/END ===` **标记块包裹**，退出时精确删除，
   **绝不整文件覆盖**（那是系统文件，覆盖会出 DNS 故障）。
5. 提权只在「开始专注」时弹一次 UAC，**App 不常驻管理员**。
6. 用户数据放 `app.getPath('userData')`，**不放程序目录**（打包后只读）。

---

## 五、路线图（六阶段）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 环境准备（项目骨架 + CLAUDE.md） | ✅ 已完成 |
| 1 | 桌宠外壳（透明窗口、拖拽、穿透、托盘、位置记忆、Live2D 形象） | ✅ 已完成 |
| 2 | 日程提醒 | ✅ 已完成（2-1 数据层 · 2-2 调度引擎 · 2-3 提醒呈现 · 2-4 编辑入口） |
| 3 | 专注模式 | ✅ 代码+自检完成（Task 1–9）· ⚠ 真机验收待做 |
| 4 | 设置界面 | ✅ 已完成（`settings-window.js`，含专注页） |
| 5 | 打包发布 | ⬜ 未开始 |

**第一周目标：一只会拖、会提醒的猫。先让它活着，再让它管你。**

---

## 六、最容易踩的坑

1. **浏览器「安全 DNS」(DoH) 会绕过 hosts** —— 改完 hosts 发现网站照样能开，八成是这个。必须先关掉 Chrome/Edge 的安全 DNS。
2. **hosts 绝不能整个覆盖** —— 程序崩溃残留了，下次启动要先自动清理。
3. **桌宠窗口会挡住桌面图标点击** —— 要动态切换 `setIgnoreMouseEvents()`，鼠标在宠物身上才取消穿透。不做这个，用户第一天就卸载。
4. **杀毒软件会误报** —— "改 hosts + 杀进程"的 exe 行为特征和恶意软件高度重合，提前加白名单。
5. **别把自己杀了** —— 黑名单校验要屏蔽 `electron.exe` / `node.exe` 和自身进程名。
6. **专注模式是自律工具** —— 任务管理器照样能绕，别往"监控软件"方向做，也别用来限制别人。

### Live2D / 渲染相关的坑（2026-10-12 阶段 1 实测）

7. **`pixi-live2d-display` 只兼容 PIXI 6.x** —— 它最新版停在 0.4.0（2022 年），
   而 PIXI 已经到 8.x。**不要 `npm update`**，锁死在 `pixi.js@6.5.10`。
8. **PIXI 6 需要 CSP 放开 `'unsafe-eval'`** —— 它用 `new Function()` 现场拼 shader。
   渲染进程不加载远程内容，风险可控；想收紧可改用 `@pixi/unsafe-eval`。
9. **`--disable-software-rasterizer` 会让 WebGL 直接罢工** —— 无 GPU 环境要用
   `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`（启动器已内置）。
10. **`capturePage()` 抓不到 WebGL 内容** —— 截出来是空白。要拿画面只能
    `canvas.toDataURL()`；要抓整个桌面用 `desktopCapturer`。
11. **透明窗口 + WebGL 必须 `backgroundThrottling: false`** —— 否则窗口失焦后动画像卡死。
12. **鼠标穿透要配 `{ forward: true }`** —— 否则穿透期间渲染进程收不到 mousemove，
    就永远判定不出该不该恢复穿透。
13. **命中判定要用迟滞** —— 角色一直在动（呼吸、甩尾巴），鼠标停在轮廓边不动时，
    单阈值会让穿透疯狂开关。所以「进要够实、出要够空」，中间地带维持原状。
14. **Live2D 模型自带的是正方形空画布** —— `c_0120` 是 4068×4068，角色只占约 64%，
    照方框摆窗口会虚胖一大圈。必须实测角色边界再裁（见 `renderer.js` 的 `setupFit`）。
15. **只量一帧不够** —— 待机动作会让角色比首帧宽出 8%，实测能超出 20+ 像素。
    要采样一整个动作循环取并集，结果缓存到 `userData/model-bounds.json`。
16. **拖拽时角色「抽搐」的元凶是视线跟随，不是掉帧** —— `pixi-live2d-display` 会把
    「鼠标在画布内的位置」直接喂给 `model.focus()`；拖拽时鼠标不动、窗口在追它，
    这个相对位置一直在抖，头就抽。修法是拖拽期间停掉视线跟随。
    ⚠ `model.autoInteract = false` 单独用无效（它只管点击监听，视线跟随挂在
    `_render()` 每帧调用的 `registerInteraction()` 上），必须**先设标志再手动
    `unregisterInteraction()`**。详见 `HANDOFF.md` 第六节第 20 条。
17. **往界面上加 DOM 控件必须挂 `data-ui` 属性，否则点不到** —— 动态穿透的命中判定
    是读 WebGL 画布像素（`alphaAt`），DOM 控件不在画布上，会被当成「空白区域」，
    窗口继续保持穿透，鼠标事件直接穿到桌面。`refreshHit()` 里用
    `elementFromPoint` + `[data-ui]` 兜底；另外压在控件上时不能进入拖拽。
    详见 `HANDOFF.md` 第六节第 21 条。
18. **提醒气泡窗口：`focusable: false` 必须配 `showInactive()`，两个都要** ——
    否则每次提醒都会把主人正在打字的窗口顶掉。代价是拿不到 focus 事件，
    「气泡还在不在」得自己用状态变量管。
    另一个坑：**网页加载完之前 `webContents.send()` 会丢**，必须先 await
    `did-finish-load`；加载失败要**销毁重建**，否则那个 Promise 永远是 false，
    以后气泡静默不弹且不报错。详见 `HANDOFF.md` 第六节第 22 条。
19. **桌宠「表演」完必须恢复视线跟随** —— 提醒时切表情 + 放动作，期间要摘掉视线跟随，
    但必须定时恢复（`autoInteract = true` + `resetExpression()`），
    否则「眼睛跟着鼠标转」的招牌动作永久丢失且不报错。详见 `HANDOFF.md` 第六节第 23 条。
20. **三个窗口的焦点策略各不相同，别照抄** ——
    - 桌宠窗口：`focusable: false` + `showInactive()`（主人打字时点它不能抢焦点）
    - 提醒气泡：`focusable: false` + `showInactive()`（提醒不能打断打字）
    - 日程管理窗口：**必须能抢焦点**（主人是主动来填表的），照抄前两个就没法打字了
    ⚠ 负对照怎么选：**不能拿桌宠窗口当「不抢焦点」的负对照**（它现在确实不抢了，
    但如果哪天有人改回去，用设置窗口做对照才能同时发现「两边都抢」和「两边都不抢」）。
    详见 `HANDOFF.md` 第六节第 24、26 条。
21. **桌宠窗口的显示一律用 `showInactive()`，别写 `show()`** ——
    `focusable: false` 的窗口在某些 Windows 版本上，`show()` 仍可能顺手把焦点挪过去。
    `ready-to-show` / `showPet()` / `togglePet()` / 自检里恢复显示，共 4 处，
    改一处漏一处就会偶发抢焦点。回归哨兵：`npm run test:focus`。
    详见 `HANDOFF.md` 第六节第 26 条。
22. **⚠ 带标题栏的窗口在 1.5 倍缩放下「外框尺寸会自己飘」** ——
    `new BrowserWindow({width:480,height:640})` → `getBounds()` 报 481×641；
    一次 `setPosition()` 后变 482×642；`setAlwaysOnTop()` 后还会**顺带挪位置**。
    所以摆位置时**别拿 `getBounds()` 现读尺寸**，要用固定的标称尺寸算，
    再用 `setBounds()` 把位置和尺寸一起写回去（`settings-window.js` 的
    `positionNearPet()` 就是这么做的）。详见 `HANDOFF.md` 第六节第 28 条。
23. **摆窗口位置：不能只按「超出最少」挑方位** —— 主人这台机器上它会选中
    `up-left`，窗口跑到离宠物 490px 的地方。正确做法是「以夹进工作区后的
    `up-right` 为靶心，挑代价最小的」，代价 = 距离 + **压住宠物的面积/100**
    （按面积算，不是一票否决 —— 宠物停在默认位置时只差 9 像素放不下，
    一票否决会把窗口甩到 440px 外的屏幕左边）。
    逻辑在 `src/main/place.js`（纯函数，`npm run test:place` 穷举 797 种位置验证）。
    详见 `HANDOFF.md` 第六节第 29 条。
24. **⚠ 生成 `.bat` / `.vbs` 时绝对不能写中文，连注释都不行** ——
    cmd.exe 按**系统 ANSI 代码页**（中文系统 = GBK）读 `.bat`，而文件通常是 UTF-8，
    中文变乱码后可能带出引号/重定向符号，**把后面几行命令一起带崩**
    （症状：报一堆「'xx' 不是内部或外部命令」然后啥也没执行）。
    → `launcher/` 里的文件全部纯 ASCII，**连文件名都用英文**
      （因为 `.vbs` 里要写 `.bat` 的文件名，WSH 同样按 ANSI 读）。
      桌面上的图标名是中文没问题 —— NTFS 文件名走 Unicode。
    → `make-launcher.js` 生成后会逐字符自检，出现非 ASCII 直接抛错。
25. **⚠ 桌面可能是 OneDrive 重定向的，别自己拼路径** ——
    这台机器上 `%USERPROFILE%\Desktop` **根本不存在**，真实桌面在
    `C:\Users\FlyMe\OneDrive\Desktop`。一律用 `app.getPath('desktop')`。
26. **生成 `.lnk` 用 Electron 的 `shell.writeShortcutLink`，别自己拼 MS-SHLLINK 二进制**。
    它必须跑在 Electron 里，所以 `scripts/make-launcher.js` 有「两种身份」：
    普通 Node 先做图标和备胎脚本，再 `spawn` electron 把自己跑第二遍写 `.lnk`。
    spawn 之前**必须删掉 `ELECTRON_RUN_AS_NODE`**。
    写完用 `shell.readShortcutLink()` 读回来对参数（比肉眼检查靠谱）。
27. **「停止桌宠」不要用 `taskkill /IM electron.exe`** ——
    会误杀机器上所有 Electron 程序，而且强杀不给程序收尾机会
    （专注模式改过 hosts 就还原不回来）。
    正确做法：再启动一次自己 + `--pet-quit`，已运行的实例在 `second-instance`
    里收到后 `app.quit()`（见 `src/main/main.js` 的 `QUIT_FLAG`）。
    回归哨兵：`npm run test:quit`（8 项，含 2 组负对照）。
28. **⚠ 桌宠窗口的外框尺寸会变，所以界面按钮不能贴窗口定位** ——
    1.5 倍缩放下 `setPosition()` 会让窗口**越调越大**（拖 40 步：404×384 → 443×424），
    而渲染进程的画布是启动时定死的、不跟着变；按钮原来是 `right:46px`
    贴窗口右边，窗口一宽就往右跑（主人报的「拖拽时设置按钮自动右移」）。
    **移动桌宠一律用 `movePet()`**（`setBounds` 把尺寸一起写回，
    尺寸用启动时记的 `petSize`，别用 `getSize()` 现读）。
    界面按钮放在 `#ui` 容器里、由 `syncUiBox()` 对齐到画布 —— 双保险。
    另外：窗口外框尺寸**跟位置有关**（1259,639 → 404×384；1087,618 → 404×382），
    是 Windows 的 DPI 取整，渲染进程每次都按当时的 innerWidth 建画布，不会裁到角色。
    回归哨兵：`npm run test:sync`（10 项，含负对照）。
    详见 `HANDOFF.md` 第六节第 32 条。
29. **写自检别量「相对量」** —— 第一版 `test:sync` 量的是「按钮中心离窗口右边界的
    距离」，结果负对照怎么都不失败：按钮是 `right:46px` 定位的，
    「窗口宽 − 按钮中心 x」恒等于常数。必须量**绝对坐标**。
    这是第六节第 19 条「验证方式本身也可能是假的」的又一例。
30. **`--isolated` 的临时目录每次必须清空** —— 自检会拖动桌宠并保存位置，
    复用旧目录会让下次自检的桌宠停在上次遗留的位置上，
    而窗口尺寸/重叠面积都跟位置有关，结果变得不可复现
    （实测：`test:settings-e2e` 因此报「压住桌宠 5.3%」失败，清空后 2.3% 通过）。
    现在改成**带时间戳的目录名**，顺带躲开「Cache 文件被锁住导致 rmSync 抛 EBUSY」。
31. **⚠️ `executeJavaScript` 在同一个全局作用域求值，`const` 会重复声明** ——
    第一次注入成功、第二次抛 `Script failed to execute`，且报在主进程的
    UnhandledPromiseRejection 里，看不出跟脚本有关。**每段注入脚本都要包 IIFE**：
    `(() => { const x = ...; return ...; })()`。
32. **⚠️ 断言别用 `!== null` 判「量到了没有」** —— 注入脚本 early-return 时字段是
    `undefined`，而 `undefined !== null` 是 `true` → 断言假通过。要用 `typeof x === 'number'`。
33. **⚠️ 中文短标题取色不能用「字符码累加模 N」** —— CJK 码点集中，会扎堆
    （`吃药/买菜/健身` 全同色）。用 FNV-1a；断言要严（「6 个常见名 ≥ 4 色」）。
34. **⚠️「窗口形态变了」≠「内容重画了」** —— 主进程切模式时，界面除了切 DOM 显示，
    还要真的去拉数据重渲染，否则是个空框。
35. **v2 新增目录** —— `src/main/week.js`（周视图布局纯函数）、`src/main/nl-time.js`
    （中文大白话解析）、`src/main/brain/`（`local.js` / `cloud.js` / `index.js` 三件套）、
    `src/main/chat-window.js` + `preload-chat.js` + `renderer/chat/`（聊天条）、
    `src/main/ai-config.js`（云端 Key 存取）。
36. **v2 新增硬性约定** —— 任何大脑产出的日程草案**必须过 `schedules.sanitize()` 才能落盘**；
    聊天条 `focusable: true`（和气泡相反）；聊天文本一律 `textContent`；
    API Key 只存 `userData/ai-config.json`，界面只拿掩码，日志绝不出现明文。

### 专注模式相关的坑（阶段 3 · 2026-10-14 实测）

37. **`test:focus` 是「窗口焦点」自检，专注模式的测试叫 `test:focusmode-*`** ——
    名字撞了会跑错套件（`--selftest=focus` 早被占用，专注模式用 `--selftest=focusmode`）。
38. **改 hosts 只用标记块增删、保留行尾、用 latin1 读写** ——
    绝不整文件覆盖（会搞坏主人原有 DNS 配置）；行尾不保留会「逐字节比对」失败；
    latin1 保证 GBK/UTF-8 中文注释逐字节不变。`hosts.js` 是纯函数，已测透。
39. **提权助手常驻整段专注，结束走控制文件，不是杀进程** ——
    强杀助手 = 它没机会还原 hosts，网站会一直打不开。助手另有**到点自愈**兜底。
    控制文件 `focus-ctl.json`（只主进程写）和心跳 `focus-hb.json`（只助手写）**必须分开**，
    同一文件两个写入者会互相覆盖 → 专注结束不了。
40. **`.ps1` / `.bat` / `.vbs` 一律纯 ASCII，一个中文都不能有**（`.ps1` 也不例外）——
    解释器按系统 ANSI（GBK）读，UTF-8 中文会乱码并带崩后面几行。
    `focus-helper.ps1` 全文 0 个非 ASCII 字符（自检会验）。
41. **DoH（安全 DNS）开着会让 hosts 屏蔽整个失效** —— 开始专注前必须检测并提示；
    但**只在确认 `'on'` 时弹窗**（`'unknown'` 是真机常态，每次都弹会训练主人闭眼点掉，
    被闭眼点掉的警告比没警告更坏）。`doh.shouldPopupForDoh()` 就是这条策略。
42. **黑名单双重排除自身与系统进程**（JS 侧 `killListOf()` + 助手侧硬编码 guard 名单）——
    链子尽头是助手「无条件照杀」，所以每一道都要挡。清理残留要用 `mode:'restore'`
    （不能拿 `session` 模式清残留，那会把脏文件当原文件备份）。
43. **验证手段本身是危险操作时，先把它变成「只记录、不动手」** ——
    助手加了 `dryRun`（只记 `would kill`），于是「保护名单生效」这条以前没法验的闸，
    现在能在**不杀任何进程**的前提下验掉。思路可推广。
44. **写完负对照要问一句「这条到底怎样才能红」** —— 答不上来的就是装饰
    （`killListOf` 里那句 `isProtectedExe` 目前纯冗余、自检照样全绿，已如实标注，不假装能测）。
45. **四个窗口焦点策略各不相同** —— 桌宠 `false` / 提醒气泡 `false` / **专注提示窗口 `true`** /
    设置窗口 + 聊天条 `true`。提示窗口要主人**看见并点按钮**，所以 `show()`+`focus()`，别照抄气泡的
    `showInactive()`。自检钉了负对照：提示窗口 `true` 且气泡 `false`，两个值必须不一样。
46. **常量从模块取，方法从实例取** —— `elevate.js` 的 `HOSTS_PATH` 等常量**只在模块导出上**，
    `createElevator()` 的返回对象里**没有**。写成 `实例.HOSTS_PATH` 会静默得到 `undefined`
    （JS 读不存在的属性不报错），一直等到 `fs.readFileSync(undefined)` 才炸成
    `ERR_INVALID_ARG_TYPE` —— **真机踩到过**（主人一点「开始专注」就报这个）。
    正确写法：`const elevatorMod = require('./elevate'); const elevator = elevatorMod.createElevator();`
    然后 **`elevatorMod.HOSTS_PATH` / `elevator.startHelper(...)`**。
    ★ 守门员：`npm run test:focus-wiring`。
47. **「默认值」本身也要被检查，尤其当它会被别处覆盖时** —— 上面那个 bug **所有自检都是绿的**，
    因为沙箱时 `main.js` 用 `init({hostsPath})` 把错值覆盖了，之后每个断言看到的都是正确值。
    **覆盖之后测再多，都不代表默认值是对的。** 所以 `test:focus-wiring` 会**静态查源码**
    并用 electron **不调 init** 加载 `index.js`，直接看模块级默认值。
    ★ 同类：写自检时先想「我这条断言，在当前环境下可能红吗」——
    不可能红的断言是装饰（第一版 e2e 里「默认路径形如 …\\hosts」就是这种假失败）。
48. **`catch` 完只返回兜底值 = 把诊断信息丢了** —— 真机踩到：读 hosts 失败时
    `readHostsText` 直接 `catch { return null }`，界面只能说「可能是杀毒软件，也可能权限不够」，
    主人拿着这句话既没法确认、也不知道下一步点哪里。凡是**动系统**的操作，失败时都必须留下
    系统给的原因（错误码 + 原话）并翻成一句**能照做**的人话。
    ★ 排查顺序：① 先证明文件本身能不能读（换 PowerShell / node / 用程序自己的模块各试一遍）
    ② 排除环境变量残留（`PET_*`）③ 再看杀软（本机是**火绒**，HIPS 会拦敏感动作）
    ④ 都不行就把错误码带出来让主人复现 —— **错误码往往直接指向真相**
    （这次 `ERR_INVALID_ARG_TYPE` 一眼就把「文件读不到」翻案成「参数是 undefined」）。
    ★ 相关工具：`npm run check:hosts`（只读体检，报能不能读 / 错误码 / 有没有残留标记块）。
56. **⚠️ 缓存的列表 + 异步刷新 = 脏绑定** —— v4 批次 2.5 踩到：选择器关掉再打开时，
    如果此时正好有一次「重新扫描」在飞，重新打开会**立刻用旧的软件对象**画出格子
    （`if (!installedApps)` 判断通过，因为缓存还在），而那次扫描稍后会把
    `installedApps` 整个换掉；旧格子的 `click` 闭包仍然指着**旧对象**。
    后果很隐蔽：保存后新对象带上了 `added`，旧格子以为「还没加过」，
    于是「再点一下取消」变成了「再点一次添加」—— **已挡的软件取消不掉**。
    ★ 修法两条：① `loadInstalledApps()` 返回的 Promise 覆盖**整趟刷新**（把
    `appsRescan()` 也包进去），这样重开时 `await` 到的一定是刷新完的新数据；
    ② 重开时改成 `if (!installedApps || appsLoadPromise) await loadInstalledApps()` ——
    有在飞的刷新就必须等它，别拿缓存凑合。
    ★ 负对照写法：**单测「加一次再删一次」是不够的**，必须复现「刷新途中重开」这个时序，
    而且要把两种时机都跑（服务端已作废 vs 已回列表）。守门员：`npm run test:picker-ui`。
57. **⚠️ 底栏用 `flex: 1 1 <固定值>` 会在窄窗口换行，把内容挤到窗口外** ——
    v4 批次 2.5 踩到：`.picker-foot` 里计数是 `flex: 1 1 180px`，400px 宽的窗口下
    连按钮放不下，计数被挤到第二行、**直接掉出窗口底部被裁掉**（截图上像「页脚没了」）。
    ★ 修法：计数 `flex: 1 1 0` + `min-width: 0` + `white-space: nowrap` + 省略号，
    按钮侧 `flex-shrink: 0`，整条**不许换行**。
    ★ 断言别只量「有没有横向溢出」——**纵向被裁是另一回事**，要单独量
    「计数与按钮在同一行」且「两者都没超出底栏底边」。
    ★ 量对齐时**比中心点，别比上边缘**：计数是纯文字（行盒矮）、按钮高，
    上边缘天然差几个像素，拿它当「换行」判据会误报。
58. **⚠️ `document.body` 上的浮层（toast）会压在模态框上** —— v4 批次 2.5 踩到：
    `toast()` 把提示条挂在 `document.body`、`z-index: 99`，而选择面板开着时
    提示条正好盖在面板底栏上，截图里一直有一条「未保存的选择已取消」压在计数和保存键上。
    ★ 修法：**面板开着时把消息路由进面板自己的状态行**（`pickerMessage`），别在模态框上再叠一层浮层。
    ★ 这条也顺带解决「截图不干净」：自检现在会等提示条淡出（并确认 `opacity === '0'`）再截。
59. **⚠️ 断言打印不出「量到的数值」= 失败时无从下手** —— v4 批次 2.5 踩到：
    `check(cond, label)` 只在**通过**时才打 detail，一旦失败就只剩一句结论，
    根本不知道量到的是 52px 还是 4096px，只能靠改代码重跑猜。
    ★ 修法：`check(cond, label, negative, detail)` **无论通过失败都打印 detail**。
    和「要量绝对数值」是同一个教训的两面：**先让它能说出数字，再让它能说错**。
60. **「异步自检」必须 await 到底再打印结论** —— v4 批次 1 踩到：`test-apps.js` 第 9 节
    （扫软件 + 缓存）是 `async` 的，但汇总行是**同步**打印的，于是那几条断言**一条都没执行**，
    而汇总数字看着完全正常（只是悄悄少了几条）。凡是自检里有 `await` / Promise，
    整段必须包在一个 `async main()` 里、`await` 完再打印「结果：」。
    ★ 自查办法：数一下「实际打印出来的断言条数」和「你写的断言条数」对不对得上。
61. **★ 按住类交互要用 `setPointerCapture`，别用 `pointerleave` 取消** —— v4 批次 3 踩到：
    「退出专注」做成「按住 3 秒」的进度条，第一版在 `pointerleave` 里 `endHold()`。
    结果是：主人好不容易按到 2.9 秒、手指偏一个像素出界，进度**当场归零**。
    ★ 正解：`pointerdown` 时 `setPointerCapture(e.pointerId)` —— 捕获之后指针事件
    一直送到这个元素，`pointerleave` 根本不会触发；真正的松手只有 `pointerup` /
    `pointercancel`（系统手势）两种。多手指/丢焦点要 `try/catch`（指针可能已被回收）。
    ★ 顺带一条：`blur` 里取消按住**只对键盘那一路生效** —— 鼠标按住期间窗口失焦
    不属于「松手」，在那里提前回退同样是坑人。
62. **★ 「进度条」和「剩余时间」是两件事，绝不许共用一个 ratio** —— v4 批次 3：
    专注页上圆环是「专注还剩多久」，退出按钮是「这个退出动作按到哪」。
    两者一旦接在一起，主人会看到「专注只剩 3 秒」的假象（其实是按退出的进度）。
    ★ 自检钉法：把会话调成「快到点」（圆环 ratio ≈ 1），断言**没按的时候进度条必须是 0**；
    再按住，断言圆环在那个时间窗里**基本没动**。这两条一起才说明「各管各的」。
63. **★ 「找第一个就 return」的检查，会在别人加同选择器时烂掉** —— v4 批次 3 踩到：
    `settings-e2e` 里验「`prefers-reduced-motion` 块里有 `transform:none`」，
    写法是遍历 `document.styleSheets`，**遇到第一个就 `return`**。
    这一批给进度条加了第二个 `prefers-reduced-motion` 块（只管 `transition`），
    排在文档靠前的位置 → 那条断言当场假失败（三条一起红）。
    ★ 正解：把所有命中的块 `join('\n')` 拼起来再判，并顺带打印「找到几块」。
    ★ 教训泛化：**凡是要断言「样式表/配置里存在某条规则」，都要检查全集，不能抽样第一条。**
64. **★ 夹具比真货少字段，测的就是假货** —— v4 批次 3 踩到：写 `test-focus-stop-ui.js` 时，
    假主进程的 `snapshot()` 只塞了 `session`，漏了真 `focus/index.js` 会一起给的
    `remainingMs` 和 `progressRatio`。后果：
      · 圆环算成 0（满环）→ 「圆环快空了」的**前提**断言假失败；
      · 倒计时画成 **`NaN:NaN`**（从截图里才看出来）。
    ★ 两条教训：① 夹具要么**从真实现抄一份**，要么在注释里写明「必须和 X 的 state() 一致」；
    ② 界面永远不能把坏载荷画成 `NaN` —— 见第 65 条。
65. **★ 界面绝不许把坏输入画成 `NaN`** —— 和第 64 条是同一个事故的两面。
    `fmtClock(undefined)` 原来算出来是 `NaN:NaN`，一眼看去像整个专注模式坏了。
    ★ 修法：所有「数字 → 显示文本」的出口先做一次兜底 ——
    `const raw = Number(ms); Number.isFinite(raw) ? raw : 0`，负数夹到 0。
    ★ 自检要钉**负对照**：`fmtClock(undefined/null/NaN/'abc'/-5000)` 全部不许含 `NaN`，
    并且用旧写法算一遍证明「这条断言真的能红」。
66. **★ 量「带过渡的样式」必须等过渡走完，不能在同一个 tick 里读** —— v4 批次 2.6⁺：
    把退出按钮的填充从红改蓝后，自检里加了一条「按住时按钮本身也是蓝底」。
    写法是「加 `.holding` 类 → 立刻 `getComputedStyle` 读背景」——
    读到的是**过渡的起点**（还是常态的灰），看起来像「改了颜色没生效」，
    其实只是 `transition: background 110ms` 还没开始走。
    ★ 教训：**读 computedStyle 前先问一句「这个属性有没有过渡/动画」**。
    有 → 加完状态要 `await` 一个大于过渡时长的时间再读；
    或者临时 `transition: none` 再读（但那样就测不到「真实观感」了，优先前者）。
    ★ 顺带：判某个颜色时**色相和彩度要一起判** ——
    当时那个灰恰好带一点蓝调（hue≈222°，sat≈15%），只判色相会放过它。
67. **★ 按钮别借通用类的样式（`.danger` 这种），尤其当你要改它的颜色时** ——
    同一事故的根因：退出按钮同时挂了 `.danger` 和我自己的 `.focus-stop`，
    而 `.danger:hover` 也设 `background`。改颜色时两边就开始抢，
    谁赢取决于权重和书写顺序 —— 这种 bug 极难从截图上看出来。
    ★ 做法：这颗按钮需要的底色/边框/文字**自己一套写清**，不再挂通用语义类；
    自检里钉一条「按钮的 class 里不许出现 `danger`」。
68. **★ 数值积分必须固定子步长，否则掉帧那一帧会「飞出去」** —— v4 批次 3-a：
    手写弹簧第一版打算「外面给多少 dt 就走多大步」。这是**显式/半隐式欧拉**的经典陷阱：
    稳定性要求 `dt < 2/ω0`。`response=0.35s` 时 `ω0≈17.95`，也就是 `dt` 必须小于 **0.11 秒**。
    一旦掉帧到 5fps（`dt=0.2`），两步就飞到 **-22007**（实测值），窗口会直接消失。
    ★ 做法：外面给多少 dt 都行，**内部一律拆成不超过 1/240 秒的小步**走。
    好处是双份的 —— 既稳，结果还**和帧率无关**（30/50/60/120fps 跑 1 秒后位置极差 0.0000px）。
    ★ 自检里要拿**朴素写法算一遍**当负对照，证明「拆子步」不是白写的
    （`test-spring.js` 第 6 节：朴素欧拉两步 → x=-22007，断言当场能红）。
    ★ 推广：凡是「按时间推进数值」的地方（弹簧、惯性、衰减、缓动），都要问一句
    「**掉帧时会怎样**」；能被外面传进来的 dt 直接影响的东西，都得自己夹住。
69. **★ 跨模块传「点」的时候，字段名对不上会静默变成 undefined** —— v4 批次 3-b：
    弹簧的状态是 `{ x, v }`（位置 + 速度），**它不分横竖**。竖直那一路我写成了
    `const sy = stepSpring(...); ... y: sy.y` —— `sy` 上根本没有 `y` 这个字段。
    JS 读不存在的属性**不报错**，只给 `undefined`，于是位置变成 `undefined`、
    速度算成 NaN、`isSettled` 永远 false（动画跑满 3 秒兜底才停），
    而 `JSON.stringify` 还会把 `undefined` 字段**直接省掉** —— 打印出来看着「少了一列」，
    很容易当成显示问题而不是数据问题。
    ★ 教训：**两个模块各自命名「位置」时，要么字段名完全对齐，要么一进来就断言**
    （`if (!Number.isFinite(p.x)) throw ...`）。这类错纯靠眼睛看代码是看不出来的。
    ★ 是 `test-pet-drag` 第 3 节（「最后停在落点上」印出了 `x=580.00 目标=580.00` 却判定失败）
    把它揪出来的 —— **断言必须把量到的值印出来**（第 59 条）又一次救了命。
70. **★ 估「手势速度」必须问一句：最后一笔样本有多旧** —— v4 批次 3-b：
    `estimateVelocity` 原来只看「最后一笔样本往前 100ms」的窗口，**不看那笔样本本身有多旧**。
    可鼠标**不动就不发 mousemove** —— 于是「快拖一下 → 按住不动半秒 → 松手」
    会被算成「还在以刚才那个速度飞」，桌宠莫名其妙窜出去。
    ★ 修法：传 `now` 进去，`now - 最后一笔时间 > 窗口` 就直接返回 0。
    ★ 推广：**凡是拿「事件流」推状态的，都要问「事件停了之后这个状态还成立吗」**。
    鼠标、键盘、滚动、心跳 —— 停下来的那一刻不会有人通知你。
71. **★ 负对照「时灵时不灵」，八成是它偷偷依赖了环境状态** —— v4 批次 3-b：
    `test:sync` 的负对照（「旧的 setPosition 写法确实会把窗口撑大」）原来是**从窗口当前所在位置**
    开始搬 40 次的。加了松手惯性之后，桌宠每轮会多滑一段、位置不再固定，
    这条负对照就**不红了**（实测 404 → 404，而固定起点后是 404 → 444）。
    原因：窗口外框尺寸跟**绝对位置**有关（1.5 倍缩放按 DPI 取整，见第 32 条）。
    ★ 修法：**先把窗口摆回一个确定的起点再演示**。
    ★ 推广：负对照不该依赖「上一次操作把状态留在哪儿」。要么自己把状态摆好，
    要么就承认它不是负对照。
72. **★ 侧边栏宽度写在两个地方，改一个必须改另一个** —— v4 批次 3-c：
    设置窗口改成侧边栏之后，宽度被拆成两半：
    `index.html` 的 `.sidebar { width: 168px }`（界面）和
    `settings-window.js` 的 `SIDEBAR_W`（主进程算窗口尺寸）。
    这两个**必须相等**，否则要么内容区被挤扁、要么侧边栏右边多出一条空白。
    改法：`SIZES = 内容区宽 + SIDEBAR_W`，只改 `SIDEBAR_W` 一处；
    自检里钉了「内容区宽 = 窗口宽 − 侧边栏宽」（读真实 DOM 宽度比，不是比常量）。
    ★ 推广：**同一个尺寸/颜色/时长被两套东西各写一份时，留一条会红的断言**，
    光靠注释写「要和 X 保持一致」是拦不住人的。
73. **★ 删掉「唯一的出口」之前，先想清楚新的出口在哪** —— v4 批次 3-c：
    专注页原来靠页内那个「← 返回日程」当出口。改侧边栏时把它删了，出口只剩侧边栏。
    而侧边栏在专注页上**差点被 `body.focus-mode` 一起藏掉**（原来那条规则里就有 `header`）——
    真藏了的话，用户进专注页就**再也出不来**（窗口连关闭按钮都没有）。
    ★ 修法：`body.focus-mode` 只藏内容区里「日程那一套」，侧边栏不在名单里；
    并加断言「专注页上侧边栏可见 + 「日程」仍然点得到」。
    ★ 推广：**删 UI 元素前，先问「它是不是某条动线唯一的出口」**；
    是的话，新出口必须先立起来、并被自检钉住。
74. **★ 靠「当前布局」算出来的值，布局一变就失效** —— v4 批次 3-c-2：
    做「面板从触发按钮长出来」时，把 `transform-origin` 按**打开那一刻**的面板矩形
    算出来。可选择器面板一打开是空的、1 秒后才填满图标 —— 面板被撑高了，
    那个 origin 就**不再指向触发按钮**（自检量出来 Y 差 175px）。
    ★ 修法有两条，通常要一起用：
      ① **让布局稳定**：给面板一个固定高度（`height: min(100%, 560px)`），
         内容在里面滚动。顺带还消掉了「小面板跳成大面板」的抖动。
      ② **把「量 → 用」的顺序排好**：动画不要挂在元素本身上，挂在一个后加的类上
         （`.is-open`），流程变成「显示 → 量 → 下一帧加类起动画」。
         挂元素上的话，元素一显示动画就跑了，量出来的值永远慢一帧。
    ★ 推广：**凡是「量一次、之后一直用」的几何量（原点、尺寸、位置、比例），
    都要问一句「这中间它会变吗」**。会变的话，要么固定它，要么每次重算。
75. **★ 「减少动效」不能只验「动画没了」** —— v4 批次 3-c-2：
    气泡和拦截提示的降级如果写成「`animation: none`」，看着是「尊重了设置」，
    其实是**把反馈也一起删了** —— 拦截提示不出现，主人就不知道网站为什么打不开。
    ★ 正确的语义是：**取消位移和缩放（让人晕的那部分），保留透明度变化（帮人理解的那部分）**。
    ★ 所以断言必须**分两半**：关键帧里**不许有 transform**，**且必须有 opacity**。
      只写前一半的话，「干脆把动画删掉」照样能过 —— 那正是要防的。
    ★ 验法要用 CDP `Emulation.setEmulatedMedia` **真的把系统设置模拟出来**
      （见 `src/main/selftest-reduced-motion.js`），别只查样式表里有没有那条规则。
50. **中文过滤规则不能照抄英文那套「词边界」** —— v4 踩到：过滤卸载项时写了
    `(^|[\s\-_])(uninstall|卸载)([\s\-_.]|$)`，英文的 `Uninstall` 能匹配，
    可中文的「卸载微信」「卸载火绒」**一条都匹配不上**（中文没有空格当分隔符）。
    反过来也不能「见到关键词就丢」——`文档编辑器` / `帮助中心` 这种真软件名会被误伤。
    ★ 所以中文分两档：`卸载` 这种**出现在开头就丢**；`帮助/文档/说明` 这种**只有名字基本就是这几个字**时才丢。
51. **并发提图标：顺序不能乱、单个失败不能连累整批** —— v4 批次 1：41 个软件串行提图标要 5.3 秒，
    改成 8 路并发后 1.2 秒（扫 + 解析本来只要 46ms，99% 时间耗在提图标）。
    ★ 但并发实现里**必须按下标写回数组**，不能按「谁先回来谁先进」——否则列表顺序会随机变。
    ★ 单个 `getFileIcon` 抛异常只能让那一条 `icon = null`（落到界面色块兜底），不能炸掉整批。
    ★ 相关工具：`npm run test:apps`（纯函数 + 并发顺序 + 负对照）。
52. **自检里拿到的 DOM 节点，重画之后就失效了** —— v4 批次 1 踩到：e2e 点了一个软件格子后，
    去看「那一格有没有变成已加入」，用的是**点击前抓到的那份节点引用**；
    可点完整个网格会重画，旧节点已经脱离文档，`classList` 自然没变 → 假失败。
    ★ 规则：凡是「操作后 DOM 会被重画」的地方，断言必须**按标识（如 exe 名）重新查一遍**，
    不能用旧的节点引用。
53. **量「过渡中的属性」必须等它走完，否则断言是装饰** —— v4 批次 2 踩到：验「按下按钮会缩小」，
    发完 `pointerdown` 立刻读 `getComputedStyle().transform`，读到的是
    `matrix(1,0,0,1,0,0)`（= scale 1，**根本没变**），因为 transform 有 110ms 过渡。
    而我的断言写的是 `transform !== 'none'` —— **「什么都没变」照样绿**。
    ★ 修法：等过渡落地再量（`setTimeout(260)`），并且**量绝对数值**（`scale < 1`），
    输出的对比值很能说明问题：`立刻 matrix(1,…) → 稳定后 matrix(0.97,…)（scale=0.97）`。
    ★ 一般规律：**断言「不为空 / 不为 none」≈ 没断言**。要量出具体数字。
54. **截图工具「三张图字节数一模一样」= 模式根本没切过去** —— v4 批次 2 踩到：
    连着三次 `settingsWindow.open(mode)` 再 `capturePage()`，三张 PNG 都是 23130 字节，
    因为 `open()` 在窗口已存在时**直接 `return win`，压根不看 `startMode`** → 三张都是首页。
    ★ 修法：走真正的切换通道（`setMode()`，和用户点按钮同一条路），
    然后**轮询确认界面真换了**（读对应容器的 `hidden` 类）再截，别死等固定毫秒数。
    ★ 加自检：三张图字节数若有重复就**明确报错**，别让主人对着一张假图做验收。
55. **窗口 `backgroundColor` 必须跟着系统主题** —— v4 批次 2 踩到：界面 CSS 有
    `prefers-color-scheme: dark` 分支，但窗口底色写死浅色 `#f7f8fa`；
    主人的 Windows 是深色模式 → **开窗先闪一下白再变黑**。
    ★ 修法：主进程 `nativeTheme.shouldUseDarkColors` 决定底色（它和渲染进程 media query 同源）。
    ★ 这条也解释了为什么 e2e 里会读到「深色」的 token 值（`--sh-1` 是 `rgba(0,0,0,.40)`）——
    不是测试环境异常，是主人的真机就是深色。
    ★ 顺手钉一条负对照：**界面认的深色状态 == 主进程认的深色状态**，否则将来又会飘回去。

---

## 第七节 · v4 UI 升级（批次 2 · 视觉层）写下来的约定

- **只换皮，不动结构**：批次 2 的纪律是「token 化 + 材质 + 排版 + 按压反馈」，
  **不改任何 DOM 结构和交互流程**。这样一批没得到主人确认也不会把地基动坏。
- **旧变量名一律保留成别名**（`--bg` / `--card` / `--line` / `--text` / `--muted` /
  `--primary` / `--danger` / `--ok` 都还指向新 token）——否则下游几百行样式要全改。
- **设计 token 层**（`index.html` 的 `:root`）：
  中性色 `--n-0…--n-10` / 强调色 `--a-500 --a-600 --a-050 --a-ring` /
  材质 `--mat-chrome --mat-blur --mat-sat --mat-edge` / 阴影 `--sh-1…--sh-4` /
  圆角 `--r-xs…--r-xl --r-pill` / 间距 `--s-1…--s-6` /
  **排版三元组** `--fs-*  +  --lh-*  +  --ls-*`（字号必须连行高、字距一起给，
  单给字号会让大字挤在一起）/ 动效 `--t-fast --t-base --ease-out`。
  ★ **字距按字号分级**（apple-design）：大标题负字距、正文接近 0、小字正字距。
- **深色主题只换 token 的值**，其它样式一行都不用改 —— 这是 token 化的最大收益。
- **按压时立即给反馈，松手才执行动作**：原生 `:active` 本来就从按下时生效。
  JS 的 `.pressing` 仅统一指针取消/失焦清理，不宣称它比原生反馈更早；
  `pointerdown` 加类，`pointerup/pointercancel/pointerleave` 摘掉。
  ★ 只改**视觉效果**，真正的动作仍走 `click` —— 这样「按下后拖走取消」「键盘 Enter 触发」
  这些原生行为一个都没丢。
  ★ 用**事件委托**挂在 `document` 上（捕获阶段），动态生成的按钮（列表项、软件格子）自动生效。
- **三条无障碍降级都要写**（`prefers-reduced-motion` / `prefers-reduced-transparency` /
  `prefers-contrast`）：
  ★ 「减少动态效果」**不是「没有反馈」，而是换个温和的等价物** ——
  取消所有位移/缩放（`transform: none`），但保留透明度变化。
  ★ 本机这三个设置默认都不开；仅查 CSSOM 只能证明规则存在，不能证明最终生效。
  `test:picker-ui` 用浏览器媒体模拟实际启用设置，读取最终缩放、模糊与边框进行验证。
  ★ 取消 `transform` 时，**JS 加的 `.pressing` 也要在名单里** —— 否则 JS 那条路会漏网。
- **批次 3 才会用到的 token**（`--sh-3` / `--r-pill`）现在挂在「定义了没被用」的清单里，
  这是**故意的**，别当成死代码删掉。

---

## 七、常用命令

```bash
npm start                    # 启动桌宠（开发）
npm start -- --no-gpu        # 无 GPU 沙箱环境用这条
npm run make-launcher        # 生成桌面上的「启动桌宠 / 停止桌宠」双击快捷方式

# 纯 Node 单测（快，先跑这些）
npm run test:schedules       # 日程数据层 63
npm run test:scheduler       # 调度引擎 39
npm run test:reminder        # 气泡位置 14
npm run test:place           # 窗口摆放位置 37
npm run test:quit            # 「停止桌宠」端到端 8
npm run test:week            # 周视图布局纯函数 53
npm run test:nl-time         # 中文大白话解析 23
npm run test:spring          # v4·手写弹簧（可打断/速度衔接/帧率无关）40
npm run test:rubberband      # v4·橡皮筋边界（渐进阻力）21
npm run test:pet-drag        # v4·拖拽手感（越界阻力/松手落点/滑行状态机）48
npm run test:brain-local     # 本地大脑 19
npm run test:brain-cloud     # 云端大脑 18
npm run test:brain-router    # 大脑路由 19
npm run test:focus-blacklist # 专注·黑名单校验 76
npm run test:focus-timer     # 专注·计时状态机 34
npm run test:focus-hosts     # 专注·hosts 文本 + DoH 99
npm run test:focus-elevate   # 专注·提权壳 81
npm run test:focus-helper    # 专注·真跑 focus-helper.ps1（不提权）51
npm run test:focus-intercept # 专注·系统薄壳 56
npm run test:focus-wiring    # 专注·接线/默认值（专抓「自检全绿真机挂」）17
npm run test:apps            # v4·已安装软件扫描（解析 lnk / 过滤 / 并发图标）105
npm run test:picker-ui       # v4·软件选择器（真渲染进程 + 真 preload + 内存 IPC）49
npm run test:focus-stop-ui   # v4·退出专注的长按进度条（真渲染进程 + 内存 IPC）65
                             # 含「填充是蓝色不是红色」一节（色相 + 彩度一起判）
npm run check:hosts          # hosts 体检（能不能读 / 错误码 / 有无残留块；只读）

# Electron 端到端自检（慢，串行跑）
npm run test:settings-e2e    # 设置窗口（周视图 + 专注页 + 选择器 + 视觉层 + 侧边栏 + 空间一致）181
npm run test:focusmode-e2e   # 专注模式端到端（含拦截提示的减少动效）63
npm run test:week-e2e        # 周视图端到端 19
npm run test:chat-e2e        # 聊天端到端 17
npm run test:reminder-e2e    # 提醒呈现端到端（含气泡的减少动效；⚠ 会真的弹一条系统通知）22
npm run test:sync            # 按钮与桌宠同步（拖拽时按钮不许飘）10
npm run test:glide           # v4·松手惯性 + 橡皮筋（真跑主进程动画）13
npm run test:focus           # 桌宠不抢焦点（⚠ 和专注模式无关，专注模式是 focusmode）20
npm run test:gaze            # 拖拽时视线跟随开关（回归哨兵）6
npm run test:exit            # 退出按钮（回归哨兵；会真的退出）
npm run build                # 打包（electron-builder）

# 收尾一把梭：纯 Node 全部 + 端到端全部，统一汇总（约 4 分 40 秒）
npm run test:all             # 35 套 / 1396 断言
npm run test:changed         # 内循环：只跑跟这次改动有关的套件（秒级）
```

⚠️ **各套件收尾格式不统一**（中文「结果：/结束：」、英文「N passed / M failed」、
以及 `scheduler-e2e` 那种「结束：通过」无计数的），`test:all` 四种都认。
★ 无计数的那种最容易变成假绿通道 —— 「结束：不通过」必须判红，`--selfcheck` 里有负对照钉它。

⚠️ **专注模式真正动系统的那几步（弹 UAC / 改真实 hosts / 关软件）沙箱里测不了**，
必须主人照 `HANDOFF-V3.md` 第三节 3.7 的 10 条清单真机验收。

开发便利：
- `PET_OPEN_SETTINGS=1 npm start -- --no-gpu` 启动时自动打开日程管理窗口（`=focus` / `=week` 指定页）
- `PET_OPEN_PICKER=1 npm start -- --no-gpu` 启动时打开「已安装软件选择器」并**自己截一张图**存到 `tmp/v4-picker.png`（视觉验收用；比抓整个桌面可靠，不会被前台锁定挡住）
- `PET_SHOT_PAGES=1 npm start -- --no-gpu` 把设置窗口的**列表 / 周视图 / 专注页各截一张**存到 `tmp/v4-pages-{list,week,focus}.png`（v4 视觉验收用）。
  ★ 它走的是真正的 `setMode()` 通道并**轮询确认界面真换了**才截；三张图字节数若有重复会明确报错
  （踩过「`open(mode)` 不看 startMode，三张图一模一样」的坑，见第 54 条）。
- `PET_OPEN_CHAT=1 npm start -- --no-gpu` 启动时自动打开聊天条
- `PET_OPEN_NOTICE=1 npm start -- --no-gpu` 启动时自动弹一张「拦截提示」卡片
（都是做视觉验收 / 截图用）

---

## 八、协作约定

- 每次只派一个小任务，跑通了再派下一个。别一次说「帮我做个桌宠」。
- 每完成一个阶段 `git commit` 一次，出错能回滚。
- 提需求时写清文件路径、函数名、返回值约定。
