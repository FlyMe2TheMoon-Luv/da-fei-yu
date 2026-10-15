# 项目长期记忆

## 桌宠项目（desktop-pet）
- **接手项目先读：`desktop-pet/HANDOFF-V3.md`**（当前状态 + 怎么和主人说话 + 下一步阶段 3 + 开工第一句话）。
  要查阶段 0–2 的全过程或那 38 条坑，再翻 `desktop-pet/HANDOFF.md`（完整交接文件）；
  专注模式的原始设计在 `PLAN.md` 第三节；v2 的 14 个 Task 在 `PLAN-V2-周视图与聊天.md`（已落地存档）。
  （旧交接 `HANDOFF-V2.md` 已存档。）
- 位置：`C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`（2026-10-12 从时间戳目录迁来，旧的已弃用）。方案文档 `PLAN.md`，AI 说明书 `CLAUDE.md`。
- 进度：**阶段 0、1、2、3 全部完成**（3-1 数据层 ✅ / … / 3-9 拦截提示 ✅ / 3-10 文档+回归 ✅）。
  **2026-10-15 真机验收通过**（专注模式跑通：改 hosts 挡网站 + 杀进程挡软件 + 还原）。
  **v4 UI 升级进行中**（见 `PLAN-V4-UI升级.md`，三批：① 选择器 ② 视觉 ③ 动效）。
  **批次 1（软件图标选择器）已完成，等主人确认**：
  专注页多了「🔍 浏览已安装软件」→ 面板里点图标即加进黑名单。
  真机扫出 **41 条真软件**（106 个 .lnk 过滤后），微信/QQ/Steam/WeGame 等都在，exe 名正确。
  ★ 主人 2026-10-15 的三个决策：只做「已安装软件（开始菜单）」/ C 档分 3 批每批截图确认 / 先做选择器。
  ★ **确认批次 1 之后才开工批次 2（视觉，只换皮），不许自己往下走。**
  阶段 2 之后又按主人反馈做了三处小修（设置窗口摆位 / 按钮更显眼 / 桌宠不抢焦点），也已完成。
  另加了「桌面双击快捷方式」（主人不依赖小安也能开关桌宠），也已完成。
  **v2（周视图 + 聊天）也已完成**（2026-10-13，14 个 Task，全量回归全绿）。
  **阶段 3 专注模式也已完成**（设计见 `PLAN-V3-专注模式.md`，10 个 Task 全部落地）。
  **2026-10-15：真机验收第 2 步卡在「读不到 hosts」→ 已定位并修好**（详见 `memory/2026-10-15.md`）。
  ★ 真凶不是杀软（火绒退出后照样报），是**自己的接线 bug**：
  `focus/index.js` 写了 `elevator.HOSTS_PATH` —— **`HOSTS_PATH` 只在模块上、实例上没有**，
  于是 `hostsPath` 静默变成 `undefined`，一点「开始专注」就 `ERR_INVALID_ARG_TYPE`。
  ★ **为什么全部自检都绿**：沙箱时 `main.js` 用 `init({hostsPath})` 把它覆盖了，
  那个错值从没被检查过 —— 典型的「自检全绿、真机必挂」。
  已修（常量从模块取、实例从工厂取），并新增 **`npm run test:focus-wiring`** 专抓这类错
  （静态查源码 + 真用 electron 加载 index.js 看模块级默认值，**不调 init**）。
  ★ 教训升级版：**「默认值」本身也要被检查**，尤其当它会被别处覆盖时 ——
  覆盖之后测再多，都不代表默认值是对的。
- **阶段 3 专注模式的关键约定**（别改错）：
  - 拦截分两段：**改 hosts 挡网站** + **轮询杀进程挡软件**。整段专注**只弹一次 UAC** ——
    起一个**常驻提权助手**（`src/main/focus-helper.ps1`，**纯 ASCII**），从写 hosts 活到结束。
  - **结束走控制文件，绝不杀助手进程**（强杀它就没机会还原 hosts，网站会一直打不开）。
    助手还有**到点自愈**兜底：主进程崩了，它到点自己还原。
  - **控制文件 `focus-ctl.json`（只主进程写）和心跳 `focus-hb.json`（只助手写）必须分开** ——
    同一个文件会互相覆盖，导致专注结束不了。
  - **计划文件带 `mode` 字段**：`'session'` = 正常专注（备份→写→循环→还原）；
    `'restore'` = 一次性清理（只写干净文本，不备份、不循环、不杀进程）。
    ★ 拿 `session` 模式去清残留，会把**脏文件当成原文件备份下来**再原样写回 = 等于没清。
  - **hosts 一律用 latin1（代码页 28591）读写**，做到**逐字节往返**（`hosts.js` 的承诺是
    「删完 == 原文逐字节相等」，GBK/UTF-8 中文注释都不能被改）。助手侧用 `GetEncoding(28591)`。
    ★ `writeHostsText` 有守卫：出现任何 **> U+00FF 的字符直接抛错拒写** ——
    因为 `Buffer.from(s,'latin1')` 会把汉字截成任意字节，其中可能有 `0x0D`，
    还原时凭空多一个换行，把「逐字节相同」搞坏（真抓到过）。
  - **黑名单双重排除**自身与系统进程：JS 侧 `isProtectedExe` + 助手侧硬编码 guard 名单。
    ★ `killListOf()` 是交给助手前的最后一遍过滤。但它那句 `isProtectedExe` **目前是纯冗余**
    （`normalizeExe` 已拒收），注释掉自检照样全绿 —— 留着是防「将来 normalizeExe 放宽」。
  - **助手有 `dryRun`**（只记 "would kill"、不动手）：真机永不写这个字段，
    只为自检存在 —— 否则「验证保护名单生效」就得拿 explorer.exe 去试，桌面会没。
    ★ 思路可推广：验证手段本身是危险操作时，先把它变成「只记录、不动手」。
  - **写完负对照要问「这条到底怎样才能红」**。答不上来的就是装饰
    （`killListOf` 第一版负对照就是这种，等于没写）。
  - 提权壳 `src/main/focus/elevate.js`：碰 electron 的依赖**延迟 require**，所以能脱离 Electron 单测；
    实例要 `createElevator()` 拿，**`require` 回来的是模块不是实例**（踩过这个坑）。
    ★ **反过来也成立、而且更隐蔽**：**常量（`HOSTS_PATH` 等）只在模块上，实例上没有**。
    写成 `实例.HOSTS_PATH` 会得到 `undefined` 而**不报错**（JS 读不存在的属性合法），
    一直等到 `fs.readFileSync(undefined)` 才炸成 `ERR_INVALID_ARG_TYPE`（2026-10-15 真机踩到）。
    所以 index.js 里是 `const elevatorMod = require('./elevate')` + `const elevator = elevatorMod.createElevator()`，
    **常量走模块、方法走实例**。守门员：`npm run test:focus-wiring`。
  - **不提权也能验拦截**：给助手一份**假 hosts 副本**（临时目录），它只认计划文件里的路径，
    所以 `test:focus-helper` 全程不提权、不碰真实文件就能验完「备份/写入/还原/自愈」。
  - **沙箱里能验完整条链**：有 `--selftest` 环境变量时 `focus.init({elevate:false,
    hostsPath:<userData>/selftest-hosts})`，e2e 就能真写假 hosts、不弹 UAC、不碰真文件。
  - **DoH（安全 DNS）是唯一「我们全对、功能全废」的坑**：浏览器开了安全 DNS 就绕过 hosts。
    做法是**检测 + 引导关闭**，且**三态 `off/on/unknown`，绝不把 unknown 当 off**。
    ★「unknown」还得再分两种说清：装了浏览器但配置里**没这一项**（= 你没改过）vs
    **有这一项但值不认识**（= 版本太新）。真机上 Chrome/Edge 都装了却没这一项，
    第一版提示语说「没检测到浏览器」——**是句错话，已修**。
  - **读 hosts 失败必须把「为什么」带出来**：`readHostsText` 原来是 `catch { return null }`，
    把原因吞了，界面只能说「可能是杀毒软件挡住了，或者权限不够」—— 那是**猜**，主人没法照做。
    现在 `intercept.readError()` 记 code / message / path，`explainReadError()` 翻成人话
    （ENOENT / EACCES|EPERM / EBUSY / 其它 → **四句必须不同**），并往控制台打一行
    `[focus] 读 hosts 失败：path=… code=… msg=…`。
    ★ 读成功必须把旧原因清掉，否则会拿上次的错解释这次（自检钉了这条）。
    ★ 教训：**凡是 `catch` 完只返回兜底值的地方，都在丢诊断信息**。动系统的操作尤其要留原因 ——
    出问题时主人手里得有一句**能照做**的话，而不是一句猜测。
  - **一键体检 `npm run check:hosts`**（`scripts/check-hosts.js`，只读 / 不写 / 不提权）：
    能读 → 报字符数 + 有没有残留标记块；读不到 → 报错误码 + 人话 + 「怎么办」。
- **v2 四条已拍板**：聊天**本地规则 + 云端 AI 两套都做**（没网退回本地）/ 周视图上**点方块弹表单**改 /
  聊天框是**贴着桌宠的小气泡条** / 周视图**不翻页**（固定周一到周日）。
- **v2 新架构约定**（别改错）：布局数学放主进程 `src/main/week.js`（纯函数、Node 可单测），
  界面只拿 `topRatio/heightRatio` 比例去乘像素（避开「渲染进程不能 require」）；
  大脑放 `src/main/brain/`（`local.js` / `cloud.js` / `index.js`），顺序是**本地高置信命中优先 →
  否则问云端 → 失败降级回本地**；**任何大脑产出的日程草案必须过 `schedules.sanitize()` 才能落盘**；
  时段**不许跨天**（`endTime` 严格晚于 `time`），且只在开始时刻提醒一次（`scheduler.js` 不用改）；
  颜色按**标题**稳定哈希分配（不做手动挑色）；
  聊天条 `focusable:true`（和气泡窗口相反）；聊天文本一律 `textContent`；
  云端用 Node 内置 `fetch`（**不新增依赖**），Key 存 `userData/ai-config.json` 且界面只见掩码。
- 启动：统一 `npm start`（经 `scripts/start-dev.js` 启动器）。无 GPU 环境用 `npm start -- --no-gpu`。
  **主人自己用**：双击桌面上的「启动桌宠」/「停止桌宠」（由 `npm run make-launcher` 生成，
  生成器是 `scripts/make-launcher.js`）。备胎在 `launcher/`。
  「停止」走 `--pet-quit`（第二实例通知第一实例优雅退出），**不是 taskkill**。
- 开发环境坑（启动器已内置规避）：`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成 Node 报 `whenReady undefined`；无 GPU 时 GPU 进程会崩溃。
- **Windows 脚本编码坑**：`.bat` / `.vbs` 里**绝对不能写中文，连注释都不行**
  （解释器按 GBK 读，UTF-8 中文会乱码并把后面几行命令带崩），连文件名都用英文。
- **桌面是 OneDrive 重定向的**：`%USERPROFILE%\Desktop` 不存在，真实桌面在
  `C:\Users\FlyMe\OneDrive\Desktop`。取桌面路径一律用 `app.getPath('desktop')`。
- **生成 `.lnk` 用 Electron 的 `shell.writeShortcutLink`**，别自己拼 MS-SHLLINK 二进制。
- 技术栈（已定，不要随意更换）：Electron + 原生 HTML/CSS/JS + electron-builder。
- **形象方案已定：路线 A —— 现成真 Live2D 模型**（女仆鲸鱼娘 `c_0120`）。
  - 模型在 `src/renderer/pet/model/`（属「素材」，受 CC BY-NC-SA 4.0 约束）。
  - 第三方运行时在 `src/renderer/pet/vendor/`，由 `npm run sync-vendor` 同步。
  - **版本锁死：`pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`**（后者只兼容 PIXI 6.x，不要 `npm update`）。
  - 渲染进程 CSP 需要 `'unsafe-eval'`（PIXI 6 用 `new Function()` 拼 shader）。
  - 无 GPU 环境参数必须是 `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`，
    **不能用 `--disable-software-rasterizer`**（会让 WebGL 罢工）。
- 平台：Windows 桌面端。
- 模块划分：A 桌宠外壳 / B 日程提醒 / C 专注模式 / D 设置界面，四者解耦。
- 目录约定：`src/main`（主进程，碰系统）、`src/renderer`（界面，不碰系统）、`src/assets`（静态图片）、`scripts/`（开发工具）。
- 开发工具：`npm run shot`（截图验收）/ `check-assets`（验图片真透明）/ `make-tray-icon` / `sync-vendor` /
  `make-launcher`（生成桌面双击快捷方式 + 图标）/
  **`check:hosts`（hosts 体检：能不能读 / 错误码 / 有没有残留标记块；只读不写不提权）** /
  **纯 Node 自检**：`test:schedules`（63）/ `test:scheduler`（39）/ `test:reminder`（14）/ `test:place`（37）/
  `test:quit`（8）/ `test:week`（53）/ `test:nl-time`（23）/ `test:brain-local`（19）/ `test:brain-cloud`（18）/
  `test:brain-router`（19）/ `test:focus-blacklist`（76）/ `test:focus-timer`（34）/ `test:focus-hosts`（99）/
  `test:focus-elevate`（81）/ `test:focus-helper`（51，**真跑 .ps1，不提权**）/ `test:focus-intercept`（56）/
  **`test:focus-wiring`（17，接线/默认值：静态查源码 + 真加载 index.js，专抓「自检全绿真机挂」）** /
  **`test:apps`（105，v4 已安装软件扫描：解析 lnk / 过滤 / 并发图标 / 负对照 28）** /
  **Electron 端到端**：`test:settings-e2e`（125）/ `test:focusmode-e2e`（60）/ `test:reminder-e2e`（19）/
  `test:chat-e2e`（17）/ `test:week-e2e`（19）/ `test:focus`（20，**窗口焦点**自检，别和专注模式搞混）/
  `test:sync`（10）/ `test:gaze`（6）/ `test:exit` / `test:drag` / `test:scheduler-e2e`。
  ⚠ 各套件收尾格式不统一（有的印「结果：」有的印「结束：」），批量统计要用 `grep -E "(结果|结束)："`。
- 阶段 2 已拍板：**提醒气泡用独立小窗口**（贴宠物旁，可放按钮）；**错过 5 分钟内补、超过不补**。
- **界面控件约定**：往桌宠界面加任何 DOM 控件（按钮等）**必须挂 `data-ui` 属性**，
  否则穿透判定（只读 WebGL 像素）会把它当空白区域，控件**静默点不到**（HANDOFF 坑 21）。
- 自检写法约定：**必须带负对照**（坏数据必须被拒），否则测试是假的（见 HANDOFF 第六节第 19 条）。
  数据层自检走**独立 Node 脚本**而非 Electron 自检——桌宠是单实例程序，跑着时再启动会直接退出。
  Electron 类自检用 `npm start -- --selftest=<mode> --isolated`（`--isolated` 给独立 user-data-dir）。
- 排查约定（血泪）：**不能靠 `sendInputEvent` 合成拖拽**——Electron 合成鼠标事件的
  `screenX/screenY 恒为 0`；`Add-Type` 被安全策略拦，**无法程序化驱动真实鼠标**。
  拖拽类问题只能靠主进程问系统光标位置，或人工拖一次。
- **四个窗口的焦点策略各不相同**（别照抄）：桌宠 `focusable:false`、提醒气泡 `focusable:false`、
  **专注提示窗口 `focusable:true`**、设置窗口**必须能抢焦点**。
  桌宠/气泡显示一律用 `showInactive()`（**别写 `show()`**）；
  专注提示窗口（`src/main/focus-notice.js`）反过来：`show()`+`focus()`，因为要主人**看见并点按钮**。
  ★ 自检钉了负对照：提示窗口 `focusable===true` **且** 气泡 `focusable===false`，**两个值必须不一样**
  （防参数照抄串了，会让提示被静默吞掉）。
- **弹窗策略 `doh.shouldPopupForDoh(level)`：只在 `'on'` 时弹** —— `'unknown'` 不弹。
  真机上（装了浏览器但配置没这一项）永远 unknown，每次都弹会训练主人「闭眼点掉」，
  被闭眼点掉的警告比没警告更坏。设置页那条常驻横幅已经够了。
- **摆窗口位置**用 `src/main/place.js`（纯函数，刻意不 require electron 好单测）。
  别用「超出最少」兜底（会把窗口甩到离宠物几百像素外），要用「夹进工作区的 up-right 当靶心 + 优先不压住桌宠」。
- **带标题栏的窗口在 1.5 倍缩放下「外框尺寸会自己飘」**：`new BrowserWindow(480×640)` →
  `getBounds()` 报 481×641；一次 `setPosition()` 后变 482×642；`setAlwaysOnTop()` 还会顺带挪位置。
  所以要用**固定标称尺寸**算位置，再用 `setBounds()` 把位置和尺寸一起写回去。
- **桌宠窗口（无边框 + useContentSize）更严重：`setPosition()` 会让它越调越大**
  （拖 40 步 404×384 → 443×424，一路累积不饱和）。所以移动桌宠**一律用 `movePet()`**
  （内部 `setBounds` 连尺寸一起写回，尺寸用启动时记的 `petSize`，别 `getSize()` 现读）。
  另外窗口外框尺寸**跟位置有关**（1259,639 → 404×384；1087,618 → 404×382，DPI 取整）。
- **界面控件（按钮等）必须放在 `#ui` 容器里、由 `syncUiBox()` 对齐到画布**，
  不能贴窗口边定位 —— 否则窗口尺寸一变控件就跟角色错位（主人报过这个 bug）。
  回归哨兵：`npm run test:sync`。
- **写自检别量「相对量」**：`test:sync` 第一版量「按钮中心离窗口右边界的距离」，
  因为按钮是 `right:46px` 定位的，这个值恒等于常数，负对照永远不失败。
  必须量绝对坐标。这是「验证方式本身也可能是假的」的又一例。
- **`--isolated` 的临时目录每次必须清空**（start-dev.js 已做）：自检会拖动桌宠并存位置，
  复用旧目录会让下次自检停在上次遗留的位置上，结果不可复现。
- 硬性约定：
  - renderer 一律通过 IPC 找 main，不开 nodeIntegration，保持 contextIsolation。
  - 日程调度用轮询不用 setTimeout。
  - 改 hosts 必须用 BEGIN/END 标记块，绝不整文件覆盖。
  - 提权只在开始专注时弹一次 UAC，不常驻管理员。
- **「默认值」本身也要被检查，尤其当它会被别处覆盖时** ——
  2026-10-15 真机踩到：`focus/index.js` 的默认 `hostsPath` 是 `undefined`，
  但**所有自检都是绿的**，因为沙箱时 `main.js` 会 `init({hostsPath})` 把它覆盖掉，
  之后每一个断言看到的都是被覆盖后的正确值。**覆盖之后测再多，都不代表默认值是对的。**
  守门员：`npm run test:focus-wiring`（静态查源码 + 真加载 index.js、**不调 init**）。
- **改了「谁 require 谁」这类接线，纯函数自检永远是绿的，必须跑端到端** ——
  Task 6 里 `require('./elevate')` 当成实例用，纯函数自检全绿，是端到端抓到的；
  2026-10-15 又踩到它的**反面**（从实例取常量 → `undefined`），
  这次纯函数**和**端到端都抓不到（端到端被 init 覆盖），是新加的 wiring 自检抓到的。
- **自检崩了也必须打印结论**：整段包 `try/catch`，catch 里 `fail++` 并打印
  「自检自身抛异常」+ 负对照计数 + 结果行。卡死过一次（Task 5），别再来第二次。

## 协作方式
- 用户是 AI 小白，讲人话、少术语、多举例。
- 用户会主动 sync 项目细节过来，之后以问答形式推进。
