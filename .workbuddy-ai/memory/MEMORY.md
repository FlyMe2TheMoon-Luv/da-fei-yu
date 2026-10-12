# 项目长期记忆

## 桌宠项目（desktop-pet）
- **接手项目先读：`desktop-pet/HANDOFF.md`**（完整交接文件，含状态、决策、坑、下一步）。
- 位置：`C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`（2026-10-12 从时间戳目录迁来，旧的已弃用）。方案文档 `PLAN.md`，AI 说明书 `CLAUDE.md`。
- 进度：**阶段 0、1、2 全部完成**（2-1 数据层 ✅ / 2-2 调度引擎 ✅ / 2-3 提醒呈现 ✅ / 2-4 编辑入口 ✅）。
  阶段 2 之后又按主人反馈做了三处小修（设置窗口摆位 / 按钮更显眼 / 桌宠不抢焦点），也已完成。
  另加了「桌面双击快捷方式」（主人不依赖小安也能开关桌宠），也已完成。
  **下一步：阶段 3 专注模式**（唯一需要管理员权限的模块）。
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
  `test:schedules`（46）/ `test:scheduler`（39）/ `test:reminder`（14）/ `test:place`（37）/
  `test:exit`（6）/ `test:gaze`（6）/ `test:drag` / `test:focus`（20）/ `test:quit`（8）/
  `test:sync`（10，按钮与桌宠同步）/
  `test:reminder-e2e`（19）/ `test:scheduler-e2e` / `test:settings-e2e`（45）。
- 阶段 2 已拍板：**提醒气泡用独立小窗口**（贴宠物旁，可放按钮）；**错过 5 分钟内补、超过不补**。
- **界面控件约定**：往桌宠界面加任何 DOM 控件（按钮等）**必须挂 `data-ui` 属性**，
  否则穿透判定（只读 WebGL 像素）会把它当空白区域，控件**静默点不到**（HANDOFF 坑 21）。
- 自检写法约定：**必须带负对照**（坏数据必须被拒），否则测试是假的（见 HANDOFF 第六节第 19 条）。
  数据层自检走**独立 Node 脚本**而非 Electron 自检——桌宠是单实例程序，跑着时再启动会直接退出。
  Electron 类自检用 `npm start -- --selftest=<mode> --isolated`（`--isolated` 给独立 user-data-dir）。
- 排查约定（血泪）：**不能靠 `sendInputEvent` 合成拖拽**——Electron 合成鼠标事件的
  `screenX/screenY 恒为 0`；`Add-Type` 被安全策略拦，**无法程序化驱动真实鼠标**。
  拖拽类问题只能靠主进程问系统光标位置，或人工拖一次。
- **三个窗口的焦点策略各不相同**（别照抄）：桌宠 `focusable:false`、气泡 `focusable:false`、
  设置窗口**必须能抢焦点**。桌宠/气泡显示一律用 `showInactive()`，**别写 `show()`**。
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

## 协作方式
- 用户是 AI 小白，讲人话、少术语、多举例。
- 用户会主动 sync 项目细节过来，之后以问答形式推进。
