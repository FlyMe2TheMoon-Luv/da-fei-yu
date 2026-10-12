# CLAUDE.md · 桌宠项目说明书

> 这份文件是给 AI（Claude / WorkBuddy 等）看的项目说明书。
> **动手写代码前先读它。** 它决定了后续实现会不会跑偏。
> 最后更新：2026-10-12

---

## 一、项目是什么

**桌面宠物（desktop-pet）**，Windows 桌面端，两个核心功能：

1. **日程提醒** —— 按输入的日程安排到点提醒
2. **专注模式** —— 在该模式下禁用用户预设的网站或软件

完整方案见 `PLAN.md`；项目状态与决策见 `HANDOFF.md`。

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
├─ HANDOFF.md             ← 项目交接文件
├─ PLAN.md                ← 完整实现方案
├─ LICENSE                ← 代码：MIT
├─ LICENSE-ASSETS.md      ← 素材：CC BY-NC-SA 4.0
├─ CREDITS.md             ← 素材署名链（三位权利人，不能漏）
├─ src/
│  ├─ main/               ← 主进程：Node 世界，能碰系统
│  │  ├─ main.js          窗口创建、托盘、位置记忆、生命周期
│  │  ├─ preload.js       ← 唯一的安全桥梁
│  │  ├─ store.js         本地 JSON 读写（一律写 userData）
│  │  ├─ scheduler.js     日程轮询引擎（阶段 2）
│  │  └─ focus/           专注模式（阶段 3）
│  ├─ renderer/           ← 界面：浏览器世界，碰不到系统
│  │  ├─ pet/             桌宠本体
│  │  │  ├─ index.html
│  │  │  ├─ renderer.js   Live2D 渲染 + 裁切 + 拖拽 + 鼠标穿透
│  │  │  ├─ vendor/       第三方运行时（PIXI / Cubism Core / pixi-live2d-display）
│  │  │  └─ model/        Live2D 模型（属「素材」，见 LICENSE-ASSETS.md）
│  │  └─ settings/        设置窗口（阶段 4）
│  └─ assets/             静态图片、音效
│     ├─ pet/             三视图 PNG + icon
│     └─ tray.png         托盘图标（由 make-tray-icon 生成）
├─ scripts/               开发工具（都不是运行时依赖）
│  ├─ start-dev.js        启动器：抹平环境坑
│  ├─ sync-vendor.js      同步第三方运行时到 vendor/
│  ├─ check-assets.js     素材体检：验图片是不是真透明
│  ├─ make-tray-icon.js   生成方形托盘图标
│  ├─ shot.js             截屏（验收用）
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
| 2 | 日程提醒 | ⬜ 未开始 ← **下一步** |
| 3 | 专注模式 | ⬜ 未开始 |
| 4 | 设置界面 | ⬜ 未开始 |
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

---

## 七、常用命令

```bash
npm start        # 启动桌宠（开发）
npm run build    # 打包（electron-builder）
```

---

## 八、协作约定

- 每次只派一个小任务，跑通了再派下一个。别一次说「帮我做个桌宠」。
- 每完成一个阶段 `git commit` 一次，出错能回滚。
- 提需求时写清文件路径、函数名、返回值约定。
