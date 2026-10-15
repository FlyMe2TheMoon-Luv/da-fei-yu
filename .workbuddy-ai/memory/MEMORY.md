# 项目长期记忆

## 桌宠项目（desktop-pet）
- **接手先读 `HANDOFF-V4.md`**（当前状态 / 怎么和主人说话 / v4 批次进度 / 命令清单 / artifacts 地图 / 开工指引）。
  深度参考：`PLAN-V4-UI升级.md`（v4 总设计，动手前必读）、`CLAUDE.md`（硬性约定 + 67 条坑）、
  `HANDOFF-V3.md`（阶段 3 专注模式）、`HANDOFF.md`（阶段 0–2 + 38 条坑）、`PLAN.md` 第三节（专注原始设计）。
- 位置 `C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`。平台 Windows。
  技术栈：Electron + 原生 HTML/CSS/JS + electron-builder（**不新增依赖**这条要守）。
- 模块 A 桌宠 / B 日程提醒 / C 专注模式 / D 设置，四者解耦。
  目录：`src/main`（碰系统）/ `src/renderer`（不碰系统）/ `src/assets` / `scripts/`。
- **进度**：阶段 0/1/2/3 全完成（2026-10-15 专注模式真机验收通过）；v2 周视图+聊天完成；
  v4 UI 升级批次 1 / 2 / 2.5 / 2.6 / 2.6⁺ 全完成并提交（最近 `c1c3e08`）；
  **v4 UI 升级三个批次（1 / 2 / 2.5 / 2.6 / 2.6⁺ / 3-a / 3-b / 3-c-1 / 3-c-2 / 3-7）
  全部完成并提交**，批次 3 收尾全量回归 **35 套 / 1396 断言全绿**。
  ★ 主人已确认：拖拽手感（「拖动阻力这部分可以了」）、侧边栏（「可以」）。
  **下一步：等主人真机验收批次 3。** 之后是批次 3 之外的事（见 HANDOFF-V4 §6）：
  ① 阶段 3 专注模式**真机验收第 2 步**（弹 UAC / 网站真打不开 / 记事本真被关，
  沙箱验不了只能主人点）；② 素材 CC BY-NC-SA 4.0，发布前确认署名。
  **做完必须停下等确认，不许连着做下一批。**

## 和主人协作
- 称呼「主人」，我叫「小安」。主人是 AI 小白：讲人话、少术语、多举例。
- **一次只推进一小批**：跑通 + 截图给主人看 + 主人说「可以了」才开下一批。汇报先说结论。
- 每个批次做完单独 `git commit`（中文提交信息，说清「做了什么 + 为什么」）。

## 自检（2026-10-15 起改为分层）
- 内循环 `npm run test:changed`（只跑受影响的套件，秒级）；
  **批次收尾 / 提交前必须 `npm run test:all`** —— 挑着跑只给内循环省时间，不代表整体没坏。
- 映射表在 `scripts/test-changed.js` 顶部 `SUITES`（新套件记得登记）。
  交叉件 `main.js` / `package.json` / `scripts/start-dev.js` 一改**自动升级全量**；
  `src/` 下没登记的源码文件会被点名。挑选器自检 `npm run test:changed-check`（20/0，负对照 10/10）。
- 自检铁律：**必须带负对照**，且每条负对照要能答上「它怎样才能红」；量绝对量不量相对量；
  报错必须带量到的数值；自检崩了也必须打印结论；改了「谁 require 谁」必须跑端到端。

## 硬约定（改错会出真 bug）
- renderer 一律走 IPC，不开 nodeIntegration，保持 contextIsolation。日程调度用轮询不用 setTimeout。
- 改 hosts 必须用 BEGIN/END 标记块，绝不整文件覆盖；hosts 一律 **latin1** 读写（逐字节往返）。
- 提权只在开始专注时弹一次 UAC，不常驻管理员。
- 往桌宠界面加 DOM 控件**必须挂 `data-ui`**（否则穿透判定让它静默点不到），
  且放 `#ui` 容器、由 `syncUiBox()` 对齐画布。
- 布局数学放主进程纯函数（renderer 不能 `require`），界面只拿比例乘像素。
- 移动桌宠**一律 `movePet()`**（内部 `setBounds` 连尺寸写回），别直接 `setPosition()`。
- 四个窗口焦点策略各不相同：桌宠 / 气泡 `focusable:false` + 一律 `showInactive()`；
  专注提示窗口 `focusable:true` + `show()`+`focus()`；设置窗口必须能抢焦点。
- 「停止桌宠」走 `--pet-quit`（第二实例通知第一实例优雅退出），**不是 taskkill**。

## 环境坑
- 无 GPU：`npm start -- --no-gpu`。必须用 `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`，
  **不能用 `--disable-software-rasterizer`**（会让 WebGL 罢工）。
- `ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成 Node 报 `whenReady undefined`（启动器已内置规避）。
- **桌面是 OneDrive 重定向的** → 取桌面路径一律 `app.getPath('desktop')`。
- `.bat` / `.vbs` / `.ps1` **绝对不能写中文**（连注释都不行），文件名也用英文。
- 生成 `.lnk` 用 Electron 的 `shell.writeShortcutLink`，别自己拼 MS-SHLLINK 二进制。
- 主人的 Windows 是**深色模式** —— 界面默认渲染深色是正常的，不是测试环境异常。
- **沙箱里 `spawnSync` 会 `EBUSY`，异步 `spawn` 正常** → 脚本里一律用 `spawn`。
- 不能靠 `sendInputEvent` 合成拖拽（Electron 合成事件的 `screenX/screenY` 恒为 0），
  拖拽类问题只能问主进程要系统光标位置，或人工拖一次。

## 形象 / 素材
- 路线 A：现成真 Live2D 模型（女仆鲸鱼娘 `c_0120`）；素材受 **CC BY-NC-SA 4.0** 约束，发布前确认署名。
- 第三方运行时在 `src/renderer/pet/vendor/`（`npm run sync-vendor` 同步）。
  **版本锁死 `pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`，不要 `npm update`**。
- 渲染进程 CSP 需要 `'unsafe-eval'`（PIXI 6 用 `new Function()` 拼 shader）。

## 开发工具
- `npm run shot`（截图验收）/ `check-assets`（验图片真透明）/ `make-launcher`（桌面快捷方式）/
  `sync-vendor` / `check:hosts`（hosts 体检，只读不写不提权）。
