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
npm run test:brain-local     # 本地大脑 19
npm run test:brain-cloud     # 云端大脑 18
npm run test:brain-router    # 大脑路由 19
npm run test:focus-blacklist # 专注·黑名单校验 76
npm run test:focus-timer     # 专注·计时状态机 34
npm run test:focus-hosts     # 专注·hosts 文本 + DoH 99
npm run test:focus-elevate   # 专注·提权壳 81
npm run test:focus-helper    # 专注·真跑 focus-helper.ps1（不提权）51
npm run test:focus-intercept # 专注·系统薄壳 47

# Electron 端到端自检（慢，串行跑）
npm run test:settings-e2e    # 设置窗口（含周视图 + 专注页）113
npm run test:focusmode-e2e   # 专注模式端到端 58
npm run test:week-e2e        # 周视图端到端 19
npm run test:chat-e2e        # 聊天端到端 17
npm run test:reminder-e2e    # 提醒呈现端到端（⚠ 会真的弹一条系统通知）
npm run test:sync            # 按钮与桌宠同步（拖拽时按钮不许飘）
npm run test:focus           # 桌宠不抢焦点（⚠ 和专注模式无关，专注模式是 focusmode）20
npm run test:gaze            # 拖拽时视线跟随开关（回归哨兵）
npm run test:exit            # 退出按钮（回归哨兵）
npm run build                # 打包（electron-builder）
```

⚠️ **专注模式真正动系统的那几步（弹 UAC / 改真实 hosts / 关软件）沙箱里测不了**，
必须主人照 `HANDOFF-V3.md` 第三节 3.7 的 10 条清单真机验收。

开发便利：
- `PET_OPEN_SETTINGS=1 npm start -- --no-gpu` 启动时自动打开日程管理窗口（`=focus` / `=week` 指定页）
- `PET_OPEN_CHAT=1 npm start -- --no-gpu` 启动时自动打开聊天条
- `PET_OPEN_NOTICE=1 npm start -- --no-gpu` 启动时自动弹一张「拦截提示」卡片
（都是做视觉验收 / 截图用）

---

## 八、协作约定

- 每次只派一个小任务，跑通了再派下一个。别一次说「帮我做个桌宠」。
- 每完成一个阶段 `git commit` 一次，出错能回滚。
- 提需求时写清文件路径、函数名、返回值约定。
