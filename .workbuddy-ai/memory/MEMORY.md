# 项目长期记忆

## 桌宠项目（desktop-pet）
- **接手项目先读：`desktop-pet/HANDOFF.md`**（完整交接文件，含状态、决策、坑、下一步）。
- 位置：`C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`（2026-10-12 从时间戳目录迁来，旧的已弃用）。方案文档 `PLAN.md`，AI 说明书 `CLAUDE.md`。
- 进度：**阶段 0、1 已完成**；下一步**阶段 2 日程提醒**。
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
- 开发工具：`npm run shot`（截图验收）/ `check-assets`（验图片真透明）/ `make-tray-icon` / `sync-vendor`。
- 硬性约定：
  - renderer 一律通过 IPC 找 main，不开 nodeIntegration，保持 contextIsolation。
  - 日程调度用轮询不用 setTimeout。
  - 改 hosts 必须用 BEGIN/END 标记块，绝不整文件覆盖。
  - 提权只在开始专注时弹一次 UAC，不常驻管理员。

## 协作方式
- 用户是 AI 小白，讲人话、少术语、多举例。
- 用户会主动 sync 项目细节过来，之后以问答形式推进。
