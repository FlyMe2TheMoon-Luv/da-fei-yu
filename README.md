# 大肥鱼

一个 Windows 桌面宠物。不是那种只会爬来爬去的挂件 —— 它会做四件事：

| 模块 | 干什么 |
|------|--------|
| **A · 桌宠** | 一只 Live2D 女仆鲸鱼娘，能拖动、有惯性、会甩尾、眼睛跟着鼠标走 |
| **B · 日程提醒** | 到点提醒你。三级升级：先动表情 → 再弹气泡 → 最后弹 Windows 通知 |
| **C · 专注模式** | 一键进入专注，期间帮你挡住分心的网站和软件，倒计时结束自动解除 |
| **D · 设置界面** | 日程列表 / 周视图 / 专注设置，全在一个窗口里，侧边栏切换 |

四个模块互相解耦：A 不知道 B 的存在，B 也不依赖 C。这样任何一个坏了都不会拖垮其他的。

---

## 快速开始

### 我只想用

`dist/` 里有两个 exe，随便挑一个：

| 文件 | 是什么 | 适合谁 |
|------|--------|--------|
| `大肥鱼 Setup 0.1.0.exe` | **安装版**。一路下一步，装完有桌面快捷方式和开始菜单项 | 想长期用的 |
| `大肥鱼 0.1.0.exe` | **免安装版**。双击直接跑，不写注册表 | 想先试试的 |

> ⚠️ **Windows 会弹「未知发布者」警告。** 这是正常的 —— 这个项目没有买代码签名证书。
> 点「**更多信息**」→「**仍要运行**」即可。

安装版装完桌面上会有「大肥鱼」快捷方式。右键托盘图标可以看到全部功能。

安装版可以选择安装目录（`allowToChangeInstallationDirectory: true`，`perMachine: false` 所以不用管理员权限）。

### 我要改代码

```bash
npm install          # 装依赖（首次）
npm start            # 启动
npm start -- --no-gpu   # 这台机器没有 GPU，必须加这个
```

无 GPU 环境下 `--no-gpu` 会展开成 `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`。
注意**不能**用 `--disable-software-rasterizer`，那会让 WebGL 直接罢工（Live2D 需要 WebGL）。

---

## 命令清单

全部命令都在 `package.json` 里，没有隐藏的。

### 开发

| 命令 | 作用 |
|------|------|
| `npm start` | 启动桌宠 |
| `npm start -- --no-gpu` | 无 GPU 环境启动（本机需要） |
| `npm start -- --isolated` | 用全新的临时 user-data-dir 启动，不碰你的真实数据 |
| `npm run shot` | 截一张桌面图到 `tmp/shot.png`（验收用） |

### 自检

| 命令 | 作用 |
|------|------|
| `npm run test:changed` | **内循环**：只跑受本次改动影响的套件，秒级 |
| `npm run test:all` | **全量**：37 套 / 1450 断言，约 4 分半 |
| `npm run test:changed-check` | 验证挑选器本身没坏（24/0，负对照 14/14） |

另外还有一批**开发自检**，直接挂在启动命令上（跑真窗口，不是纯 Node）：

```bash
npm start -- --no-gpu --isolated --selftest=gaze       # 视线跟随
npm start -- --no-gpu --isolated --selftest=drag       # 拖拽性能
npm start -- --no-gpu --isolated --selftest=exit       # 退出按钮（含「控件能不能点到」）
npm start -- --no-gpu --isolated --selftest=scheduler  # 调度引擎端到端（要等 30 秒轮询）
npm start -- --no-gpu --isolated --selftest=reminder   # 提醒呈现（会真弹一条系统通知）
npm start -- --no-gpu --isolated --selftest=settings   # 日程窗口（会真开窗口、写一条再删掉）
```

支持的值：`1`（穿透 + 表情）、`drag`、`gaze`、`glide`、`exit`、`scheduler`、`reminder`、
`settings`、`week`、`chat`、`focusmode`、`focus`、`sync`。

> ⚠️ **跑自检务必带 `--isolated`。** 桌宠是单实例程序，你要是已经开着一个，
> 新的会被直接顶掉，**自检根本不会跑 —— 然后就很容易被误判成「通过」**。
> `--isolated` 会用一个每次启动前清空的临时数据目录，把这个坑堵死。
> （所以你也别指望在 `--isolated` 目录里看到自己的真实数据。）

全量跑完最后会打印一行总结，长这样：

```
套件：37 绿 / 0 红  ·  断言：1450 通过 / 0 失败
```

**记住这个数**：改动前后对比，断言数变了就说明有套件没跑或漏登记。

> 小细节：不是每套都报数字 —— 有的套件打印的是「通过（无计数）」或「基准」。
> 这是历史遗留的四种汇总格式，不影响判定，但别以为它没跑。

**规矩**：
- 平时改代码用 `test:changed` 省时间；
- **批次收尾、提交之前必须 `test:all`** —— 挑着跑只代表内循环省时间，不代表整体没坏。

### 体检与工具

| 命令 | 作用 |
|------|------|
| `npm run check:hosts` | 查 hosts 文件现状（**只读**，不写、不提权） |
| `npm run check:package` | 打包体检（**只读，不真打包**）：查一堆「构建照样成功但产物不对」的配置错误，比如 appId 与代码不一致、files 白名单漏了许可文件（那等于署名违约）、图标缺 256×256、`deleteAppDataOnUninstall` 被改成 true（卸载会删掉日程） |
| `npm run check-assets` | 验图片是不是真透明（防止把白底图当透明图用） |
| `npm run build` | 出安装包到 `dist/` |
| `npm run make-launcher` | 在桌面生成快捷方式 |
| `npm run sync-vendor` | 同步第三方运行时到 `src/renderer/pet/vendor/` |

---

## 代码都放哪了

```
src/
├── main/          ← 碰系统的部分（Node 环境，有全部权限）
│   ├── main.js            入口：窗口、托盘、菜单、IPC 分发、自检分发
│   ├── store.js           数据层：userData 下 JSON 的读写
│   ├── schedules.js       日程数据结构与校验（坏数据不许带崩主进程）
│   ├── scheduler.js       轮询调度器（30 秒一跳，扛得住睡眠/重启）
│   ├── reminder.js        三级提醒升级（表情 → 气泡 → 系统通知）
│   ├── nl-time.js         把「明天下午三点」这种话解析成时间
│   ├── week.js            周视图的布局计算
│   ├── apps.js            扫描本机已安装的软件（读 .lnk 二进制找 exe 路径）
│   ├── ai-config.js       AI 接口配置读写（绝不写程序目录）
│   │
│   ├── spring.js          弹簧物理（手写积分，不引库）
│   ├── rubberband.js      iOS 式橡皮筋阻尼
│   ├── pet-drag.js        拖拽手感参数与移动逻辑
│   ├── place.js           窗口摆位计算
│   ├── settings-window.js / chat-window.js / focus-notice.js   各窗口的创建
│   ├── preload*.js        各窗口的 IPC 桥（contextBridge）
│   │
│   ├── brain/             聊天意图路由（本地高置信 → 云端兜底 → 回落本地）
│   └── focus/             专注模式
│       ├── index.js           编排，唯一管「会话中不许改配置」的地方
│       ├── blacklist.js       黑名单（网站 + 进程）
│       ├── timer.js           计时，`canExit` 是唯一的放行判断
│       ├── store.js           focus.json 的读写
│       └── elevate.js         提权改 hosts（BEGIN/END 标记块）
│
├── renderer/      ← 不碰系统的部分（浏览器环境，contextIsolation 开着）
│   ├── pet/               桌宠画布 + Live2D 运行时（model/ 与 vendor/）
│   ├── settings/          设置窗口（列表 / 周视图 / 专注）
│   ├── chat/              聊天条
│   ├── bubble/            提醒气泡
│   └── notice/            专注提示窗口
│
└── assets/        ← 图标、静态图
```

仓库里还有这几块：

| 目录 | 内容 |
|------|------|
| `scripts/` | **所有自检套件** + 工具脚本（`test-*.js`、`check-*.js`、`start-dev.js`、`shot.js` 等） |
| `launcher/` | 桌面用的启动 / 停止 `.bat` 与 `.vbs` |
| `spike/` | Live2D 可行性验证台。**现在跑不起来了**（模型已搬走），留着当历史记录 |

**核心分界线**：`src/main` 可以碰系统，`src/renderer` 一律走 IPC。
renderer 里 `require` 是不可用的 —— 所以任何布局数学（`spring.js`、`rubberband.js`、`place.js`）
都必须放在主进程的纯函数里，界面只拿比例乘像素。

顺带一提：把这些数学抽出来放主进程的另一个好处是**它们能脱离 Electron 单测**
（`test:spring` / `test:rubberband` / `test:pet-drag` 就是这么来的）。

---

## 数据存在哪

全部在 `%APPDATA%\desktop-pet\`（即 `app.getPath('userData')`）。
除此之外这个文件夹里还塞满了 Electron 自己产生的一堆缓存目录（`Cache`、`GPUCache`、`Local Storage` 等），那些不用管。

**本项目自己写的文件**：

| 文件 | 存什么 | 什么时候才出现 |
|------|--------|--------------|
| `window-state.json` | 桌宠上一次的位置和大小 | 移动过桌宠之后 |
| `model-bounds.json` | 模型边界 | 首次渲染后 |
| `schedules.json` | 所有日程 | 添加过日程之后 |
| `chat.json` | 聊天记录 | 聊过天之后 |
| `ai-config.json` | AI 接口配置（**API Key 只存在本机，不上传**） | 保存过 AI 配置之后 |
| `focus.json` | 专注模式配置（黑名单 / 时长预设） | 改过专注设置之后 |
| `focus-plan.json` / `focus-ctl.json` / `focus-hb.json` | 专注会话的计划、控制、心跳 | 开始过专注之后 |
| `focus-helper.run.ps1` / `focus-helper.log` | 提权助手脚本与日志 | 开始过专注之后 |
| `hosts.backup` | 改 hosts 之前的字节级原始备份 | 第一次改 hosts 之前 |

也就是说：**你如果没用过某个功能，对应的文件就不会出现**，这是正常的，不是丢了东西。

**卸载不会删这些数据**（`deleteAppDataOnUninstall: false`），重装还在。要清干净就手动删这个文件夹。

---

## 硬约定（改错会出真 bug）

这几条是踩过坑总结出来的，改代码前务必看一眼。`CLAUDE.md` 里编号的踩坑记录有 80 多条，
这里是最高频的九条。

1. **renderer 一律走 IPC**，不开 `nodeIntegration`，保持 `contextIsolation`。
2. **日程调度用轮询不用 `setTimeout`** —— 电脑睡眠/重启之后 `setTimeout` 就废了，30 秒一次轮询才稳。
3. **改 hosts 必须用 BEGIN/END 标记块**，绝不整文件覆盖；读写一律 **latin1**（逐字节往返，否则中文路径或特殊字符会炸）。
4. **提权只在开始专注时弹一次 UAC**，不常驻管理员。
5. **往桌宠界面加 DOM 控件必须挂 `data-ui`** —— 否则穿透判定会让它静默点不到（最难查的一类 bug）。控件要放 `#ui` 容器里，由 `syncUiBox()` 对齐画布。
6. **移动桌宠一律用 `movePet()`**（内部 `setBounds` 会连着尺寸一起写回），别直接 `setPosition()`。
7. **四个窗口的焦点策略各不相同**，不能统一处理：
   - 桌宠 / 气泡：`focusable: false` + 一律 `showInactive()`
   - 专注提示窗口：`focusable: true` + `show()` + `focus()`
   - 设置窗口：必须能抢焦点
8. **停止桌宠走 `--pet-quit`**（第二实例通知第一实例优雅退出），**不是 `taskkill`**。
9. **不新增依赖。** 技术栈锁死在 Electron + 原生 HTML/CSS/JS。

---

## 几个环境坑

| 现象 | 原因 / 解法 |
|------|------------|
| `whenReady undefined` | `ELECTRON_RUN_AS_NODE=1` 让 electron 退化成 Node 了。启动器已内置规避，但如果你手动跑 electron 要注意。 |
| 沙箱里 `spawnSync` 报 `EBUSY` | 沙箱限制。脚本里一律用异步 `spawn`。 |
| 取桌面路径 | 一律用 `app.getPath('desktop')` —— **桌面是被 OneDrive 重定向的**，硬拼路径会错。 |
| `.bat` / `.vbs` / `.ps1` 不能写中文 | 连注释都不行，文件名也用英文。WSH 按 ANSI 代码页读文件。 |
| 生成 `.lnk` | 用 Electron 的 `shell.writeShortcutLink`，别自己拼 MS-SHLLINK 二进制。 |
| 界面默认是深色 | 正常，不是测试异常 —— 主人的 Windows 就是深色模式。 |
| 合成拖拽测不了 | Electron 合成事件的 `screenX/screenY` 恒为 0。拖拽类问题要么问主进程要系统光标位置，要么人工拖一次。 |
| 想用 `sendInputEvent` 造点击 | 同理，合成事件在穿透判定那层就不可靠，别指望它。 |

---

## 自检怎么写

这是这个项目最较真的一部分。**每条断言都必须能答上「它怎样才能红」** —— 答不上来的断言等于没写。

- 必须带**负对照**（故意造一个错，看它是否真的报错）。
- **量绝对量，不量相对量**（"变快了"不算，要说"从 12px 变成 30px"）。
- **报错必须带量到的数值**，不然没法判断偏了多少。
- **自检自己崩了也必须打印结论**，不能静默退出。
- 改了「谁 require 谁」的关系，必须跑端到端。

新增套件记得在 `scripts/test-changed.js` 顶部的 `SUITES` 表里登记，否则挑选器不认识它。

---

## 素材与许可

代码是 **MIT**，素材**不是**。两者分开：

- **素材**（Live2D 模型、立绘、角色形象）：**CC BY-NC-SA 4.0** —— 署名、**禁止商用**、相同方式共享。
  原作者：**上善无形**（「溟月」原形象，2025-06）· **ZipZipPipe**（女仆装二创，2026-04-25）· **氵六青**。
  完整署名链见 `CREDITS.md`。
- **Live2D 运行时**：Cubism Core 是专有软件；另有 Live2D SDK 发行许可层（个人 / 小规模发行者免费，
  年销售额超过 2000 万日元需付费）。详见 `LICENSE-ASSETS.md` §4。
- **PIXI / pixi-live2d-display**：MIT，但 `pixi-live2d-display@0.4.0` **只兼容 PIXI 6.x**。

> ⚠️ **本项目无法把素材重新授权为可商用。** 你要拿这个形象去卖，得自己去找上面三位作者谈。

代码部分版权归 **FlyMe2TheMoon**（MIT）。

### 版本锁定

`src/renderer/pet/vendor/` 里的东西是锁死的：

```
pixi.js             @6.5.10
pixi-live2d-display @0.4.0
live2dcubismcore    （专有，不从 npm 来）
```

**不要 `npm update`。** 升了 PIXI 7 之后 `pixi-live2d-display` 直接不工作，且改起来不是小工程。
渲染进程的 CSP 需要 `'unsafe-eval'`，因为 PIXI 6 用 `new Function()` 拼 shader。

---

## 现在做到哪了

阶段 0 / 1 / 2 / 3 全部完成，v4 UI 升级全部批次完成，发布前准备（打包 + 应用内署名 + 打包体检）也完成了。
全量回归 **37 套 / 1450 断言全绿**，`npm run build` 能出安装包。

还没做的：

- **代码签名**（所以才有「未知发布者」警告）
- **Live2D SDK 发行许可**那一层要单独处理（要不要钱取决于销量）

想知道每一步为什么这么做、踩过哪些坑，看这几份文档：

| 文档 | 内容 |
|------|------|
| `HANDOFF-V4.md` | **当前状态**，接手先读这份 |
| `PLAN-V4-UI升级.md` | v4 总设计 |
| `CLAUDE.md` | 硬性约定 + 80 多条踩坑记录（**改代码前必读**） |
| `HANDOFF-V3.md` | 阶段 3（专注模式） |
| `HANDOFF.md` | 阶段 0–2 + 38 条坑 |
| `PLAN.md` | 最早的四模块拆解与路线图 |

---

## 环境

- **平台**：Windows。专注模式依赖 Windows 的 hosts 与提权机制（UAC），**Linux / macOS 上跑不起来**。
- **Electron**：44.7.0（自带 Node 24，所以装 Electron 就等于装好了运行时）
- **打包**：electron-builder 26.15.3

> `package.json` 里**没有** `engines` 字段，所以没写死 Node 版本要求。
> 实际开发时用的是 Node 22 与 24，这两个都跑得通。
