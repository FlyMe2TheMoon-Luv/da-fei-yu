# HANDOFF.md · 桌宠项目交接文件

> **给新对话里的我（小安）：**
> 读到这份文件说明主人要继续桌宠项目。下面是完整状态，读完就能接着干，不用主人重新解释。
> 最后更新时间：2026-10-12 15:40

---

## 一、主人是谁

- 称呼：**主人**（硬性要求，不要改）
- 我的名字：**小安**
- 特点：**AI 小白**。讲人话、少术语、多举例子。别堆专业名词。
- 协作方式：主人会主动 sync 项目细节，之后以问答形式推进。

---

## 二、项目是什么

**桌面宠物（桌宠）**，Windows 桌面端，两个核心功能：

1. **日程提醒** —— 按输入的日程安排到点提醒
2. **专注模式** —— 在该模式下禁用用户预设的网站或软件

---

## 三、已定的关键决策（不要推翻，除非主人要求）

### 技术栈

**Electron + 原生 HTML/CSS/JS + electron-builder**

选它的理由：桌宠本质是「透明窗口 + 动图」，Electron 三个配置项搞定；定时提醒和调用系统命令（改 hosts、杀进程）都是 Node 自带能力，不用跨语言；**全程一种语言，AI 不用切换上下文，出错最少**。

已排除：Tauri（Rust 报错劝退）、Python + PySide6（透明窗口和打包都折腾）、tkinter（动图效果差）。

**已落地版本**：Electron **44.7.0**（内置 Node 24.x / Chromium 152）。

### 模块划分（四者解耦）

| 模块 | 内容 | 难度 |
|---|---|---|
| A. 桌宠外壳 | 透明无边框窗口、置顶、拖拽、托盘 | ★☆☆ |
| B. 日程提醒 | 存日程 → 到点弹提醒 | ★★☆ |
| C. 专注模式 | 按时段禁用网站/软件 | ★★★★ |
| D. 设置界面 | 加日程、配黑名单、开关 | ★★☆ |

**C 单独隔离是保交付策略**：它是唯一需要管理员权限、也是唯一可能做不出来的模块。隔离掉它，A+B+D 已经是个能用的桌宠。

### 目录约定（已落地）

> ⚠️ **项目位置已变更**：代码和文档现在统一放在
> `C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`
> （旧的时间戳目录 `2026-10-12-15-01-06\desktop-pet\` 已弃用，只是历史副本）

```
desktop-pet/
├─ package.json           ✅ 已建（main=src/main/main.js, scripts.start/start:raw/build）
├─ CLAUDE.md              ✅ 已写（给 AI 看的项目说明书）
├─ HANDOFF.md             ✅ 本文件
├─ PLAN.md                ✅ 完整实现方案
├─ .gitignore             ✅ 已建
├─ src/
│  ├─ main/
│  │  ├─ main.js          ✅ 已写（阶段 0：普通窗口）
│  │  ├─ preload.js       ✅ 已写（安全桥空壳）
│  │  ├─ scheduler.js     ⬜ 阶段 2
│  │  ├─ store.js         ⬜ 阶段 2
│  │  └─ focus/           ⬜ 阶段 3
│  ├─ renderer/
│  │  ├─ pet/             ✅ index.html + renderer.js（占位验收页）
│  │  └─ settings/        ⬜ 阶段 4
│  └─ assets/             ✅ 空目录（待放宠物图）
└─ scripts/
   ├─ start-dev.js        ✅ 已写（开发启动器，见下）
   └─ *.ps1               ⬜ 阶段 3（需管理员权限的脚本）
```

### 硬性约定（写代码时必须遵守）

1. renderer **绝对不能**直接碰系统，全部通过 IPC 交给 main
2. `contextIsolation: true` + preload + contextBridge，**绝不开 `nodeIntegration`**
3. 日程调度用 **30 秒轮询 + `lastFiredDate` 去重**，不用 `setTimeout`（电脑睡眠会丢事件）
4. 改 hosts 必须用 `# === FocusMode BEGIN/END ===` **标记块包裹**，退出时精确删除，**绝不整文件覆盖**
5. 提权只在「开始专注」时弹一次 UAC，**App 不常驻管理员**
6. 用户数据放 `app.getPath('userData')`，不放程序目录（打包后只读）

---

## 四、路线图（六阶段）

| 阶段 | 内容 | 工时 | 状态 |
|---|---|---|---|
| 0 | 环境准备（项目骨架 + CLAUDE.md） | 半天 | ✅ **已完成（2026-10-12）** |
| 1 | 桌宠外壳 | 1-2 天 | ⬜ 未开始 ← **下一步** |
| 2 | 日程提醒 | 2-3 天 | ⬜ 未开始 |
| 3 | 专注模式 | 4-6 天 | ⬜ 未开始 |
| 4 | 设置界面 | 2-3 天 | ⬜ 未开始 |
| 5 | 打包发布 | 1 天 | ⬜ 未开始 |

**第一周目标：一只会拖、会提醒的猫。先让它活着，再让它管你。**

---

## 五、最容易踩的坑（提前记牢）

### 业务坑

1. **浏览器「安全 DNS」(DoH) 会绕过 hosts** —— 改完 hosts 发现网站照样能开，八成是这个。必须先关掉 Chrome/Edge 的安全 DNS
2. **hosts 绝不能整个覆盖** —— 那是系统文件。程序崩溃残留了，下次启动要先自动清理
3. **桌宠窗口会挡住桌面图标点击** —— 要动态切换 `setIgnoreMouseEvents()`，鼠标在宠物身上才取消穿透。不做这个，用户第一天就卸载
4. **杀毒软件会误报** —— "改 hosts + 杀进程"的 exe 行为特征和恶意软件高度重合，提前加白名单
5. **别把自己杀了** —— 黑名单校验要屏蔽 `electron.exe` / `node.exe` 和自身进程名
6. **专注模式是自律工具** —— 任务管理器照样能绕，别往"监控软件"方向做，也别用来限制别人

### 🔧 开发环境坑（2026-10-12 实测踩到，已用启动器解决）

7. **`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成普通 Node**
   - 现象：`npm start` 报 `TypeError: Cannot read properties of undefined (reading 'whenReady')`，
     日志末尾出现 `Node.js v24.x`（说明跑的是 Node 不是 Electron）
   - 原因：VS Code / 部分 IDE 集成终端会预设这个环境变量，子进程继承后就废了
   - 解决：`scripts/start-dev.js` 启动前把它从子进程环境删掉（已内置）

8. **没有可用 GPU 时 Chromium 的 GPU 进程会崩溃**
   - 现象：刷屏 `GPU process exited unexpectedly`，最后 `GPU process isn't usable. Goodbye.`
   - 原因：虚拟机 / 远程桌面 / 无显卡驱动
   - 解决：`npm start -- --no-gpu`（已内置，等价 `--disable-gpu --disable-software-rasterizer --no-sandbox`）

> 这两条**真实桌面机通常都不需要**，是沙箱/虚拟机环境才触发。但知道了不慌。

---

## 六、启动方式（记住这几条）

```bash
npm start                 # 标准启动（经启动器，自动处理 ELECTRON_RUN_AS_NODE）
npm start -- --no-gpu     # 无 GPU 环境（虚拟机/远程桌面）启动
npm run start:raw         # 裸 electron .（不经启动器，排查用）
npm run build             # 打包（electron-builder，阶段 5 才用）
```

启动器位置：`scripts/start-dev.js`。它只干两件事：删掉 `ELECTRON_RUN_AS_NODE`、按需追加无 GPU 参数，其余参数原样透传给 electron。

---

## 七、已安装的技能（2026-10-12）

装在 `C:\Users\FlyMe\.workbuddy-ai\skills\`，全部通过安全审计（0 个 P0 / 0 个 P1）：

| 技能 | 用途 |
|---|---|
| `frontend-design` | 桌宠 UI + 设置界面的视觉设计 |
| `webapp-testing` | Playwright 测界面（需另装 playwright 包） |
| `systematic-debugging` | 强制先找根因再改代码 |
| `writing-plans` | 把需求拆成可执行计划 |
| `verification-before-completion` | 说"做完了"之前先跑验证拿证据 |

**安装原则（重要）**：只复制技能文件夹本身，**绝不带仓库根目录的 `hooks/` 和插件配置**。
任何新技能安装前，**必须先跑安全审计**（规范见 `C:\Users\FlyMe\.workbuddy-ai\plugins\marketplaces\codebuddy-plugins-official\plugins\skills-security-check\skills\skills-security-check\SKILL.md`）。

**明确决定不装的**：
- `agent-sprite-forge` —— 依赖太重（Python 3.10+ / ffmpeg 5.1+ / numpy·Pillow·scipy + 图像视频生成后端），对桌宠超配
- `full-stack-skills/electron-skills` —— 仅 6 星，当参考资料读即可

---

## 八、相关文档

| 文件 | 内容 |
|---|---|
| `desktop-pet/PLAN.md` | 完整实现方案（需求拆解、选型理由、分阶段细节、风险清单、vibe coding 工作流） |
| `desktop-pet/CLAUDE.md` | 给 AI 看的项目说明书（技术栈、目录、硬性约定） |
| `desktop-pet/SKILLS-推荐与安装指南.md` | GitHub 技能调研 + 三种安装方式教程 |
| `desktop-pet/SKILLS-安全审计报告.md` | 5 个技能的完整审计记录 |

---

## 九、下一步该做什么

**阶段 1：桌宠外壳。** 阶段 0 已验收（`npm start` 能弹出窗口，页面 + 安全桥验证通过）。

阶段 1 要做：
1. 窗口改透明、无边框、置顶（`transparent: true` / `frame: false` / `alwaysOnTop: true`）
2. 拖拽移动（CSS `-webkit-app-region: drag`）
3. **动态鼠标穿透**：鼠标不在宠物身上 → `setIgnoreMouseEvents(true)`，移上去再取消（不做这条用户第一天就卸载）
4. 托盘图标 + 右键菜单（显示 / 隐藏 / 设置 / 退出）
5. 宠物形象先放一张 PNG/GIF 占位
6. 位置记忆（存 `userData`，下次回到原位）+ 换显示器越界保护

**验收**：一只猫趴在桌面上，能拖、能藏进托盘、能退出。

**给主人的提醒**：每次只派一个小任务，跑通了再派下一个。别一次说「帮我做个桌宠」。

---

_主人 sync 新细节时，记得回来更新这份文件。_
