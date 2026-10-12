# 项目长期记忆

## 桌宠项目（desktop-pet）
- **接手项目先读：`desktop-pet/HANDOFF.md`**（完整交接文件，含状态、决策、坑、下一步）。
- 位置：`C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`（2026-10-12 从时间戳目录迁来，旧的已弃用）。方案文档 `PLAN.md`，AI 说明书 `CLAUDE.md`。
- 进度：**阶段 0、1 已完成；阶段 2 进行中（2-1 数据层 ✅、2-2 调度引擎 ✅）**；下一步 **2-3 提醒呈现**。
- 启动：统一 `npm start`（经 `scripts/start-dev.js` 启动器）。无 GPU 环境用 `npm start -- --no-gpu`。
- 开发环境坑（启动器已内置规避）：`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成 Node 报 `whenReady undefined`；无 GPU 时 GPU 进程会崩溃。
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
- 开发工具：`npm run shot`（截图验收）/ `check-assets`（验图片真透明）/ `make-tray-icon` / `sync-vendor` / `test:schedules`（日程数据层自检）。
- 阶段 2 已拍板：**提醒气泡用独立小窗口**（贴宠物旁，可放按钮）；**错过 5 分钟内补、超过不补**。
- **界面控件约定**：往桌宠界面加任何 DOM 控件（按钮等）**必须挂 `data-ui` 属性**，
  否则穿透判定（只读 WebGL 像素）会把它当空白区域，控件**静默点不到**（HANDOFF 坑 21）。
- 自检写法约定：**必须带负对照**（坏数据必须被拒），否则测试是假的（见 HANDOFF 第六节第 19 条）。
  数据层自检走**独立 Node 脚本**而非 Electron 自检——桌宠是单实例程序，跑着时再启动会直接退出。
  Electron 类自检用 `npm start -- --selftest=<mode> --isolated`（`--isolated` 给独立 user-data-dir）。
- 排查约定（血泪）：**不能靠 `sendInputEvent` 合成拖拽**——Electron 合成鼠标事件的
  `screenX/screenY 恒为 0`；`Add-Type` 被安全策略拦，**无法程序化驱动真实鼠标**。
  拖拽类问题只能靠主进程问系统光标位置，或人工拖一次。
- 硬性约定：
  - renderer 一律通过 IPC 找 main，不开 nodeIntegration，保持 contextIsolation。
  - 日程调度用轮询不用 setTimeout。
  - 改 hosts 必须用 BEGIN/END 标记块，绝不整文件覆盖。
  - 提权只在开始专注时弹一次 UAC，不常驻管理员。

## 协作方式
- 用户是 AI 小白，讲人话、少术语、多举例。
- 用户会主动 sync 项目细节过来，之后以问答形式推进。
