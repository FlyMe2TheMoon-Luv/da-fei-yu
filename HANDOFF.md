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

## 十、阶段 1 设计待定项 + 动画清单（新对话开工必读）

主人已明确要「敲定外形设计 + 完成 4 个动画」。

**✅ 已拍板：形象路线 = 方案 B「自研原创形象」**（2026-10-12）
- 放弃直接使用「鲸鱼娘 · 大肥鱼」二创素材（上游 CC BY-NC-SA 4.0，禁商用，会把项目永久锁死为非商业）。详见第十一节。
- 形象要「原创」，但气质可以借鉴大肥鱼：圆滚滚、蓝白配色、傲娇但可爱。

**⬜ 仍待定（正在讨论，新对话请先跟主人确认）：**

| 待定项 | 选项 | 小安推荐 |
|---|---|---|
| 具体形象 | 胖鱼（呼应大肥鱼气质）/ 猫 / 其他小动物 | 待讨论后定 |
| 美术风格 | 扁平卡通 / 像素 / Q版手绘 / 3D | **扁平卡通**（好做动画、桌面不刺眼） |
| 素材生产方式 | AI 生成 / 矢量手绘（SVG）/ 主人提供 | 待讨论后定 |
| 动画方式 | CSS 动效 / 序列帧 / GIF | **CSS 动效**（素材最省、能跟状态联动） |

**要做的 4 个动画（做成独立模块，互不干扰）**：

1. **待机动作**（idle）—— 呼吸 / 眨眼 / 摆尾
2. **点击动画**（click）—— 戳一下的反应
3. **日程提醒动画**（alert）—— 到点冒泡 / 跳动
4. **拦截动画**（block）—— 撞到被禁网站 / 软件时的提示

**归属**：1-2 属阶段 1；3 属阶段 2；4 属阶段 3。

**建议实现**：一个状态机（`idle` / `click` / `alert` / `block`）+ 每个状态一段 CSS 动画，用 class 切换。形象未定时先用占位图，先把逻辑跑通。

**新对话开工前 checklist**：
- 先读 `CLAUDE.md`（硬性约定）+ 本文件
- 确认项目目录是 `C:\Users\FlyMe\WorkBuddy AI\desktop-pet\`
- 启动用 `npm start -- --no-gpu`（本机沙箱无 GPU）
- 上下文：本次对话还提到「主人可能在设计上有额外偏好」——新对话记得先问一句

---

## 十一、素材授权调研归档（2026-10-12 已查证，别重复调研）

主人问过「能不能用网上现成的桌宠动画」。调研结论如下，**已决定不用第三方形象素材**，改用自研原创形象。

### 候选方案对比

| 方案 | 授权 | 结论 |
|---|---|---|
| **oneko**（追鼠标的小猫）`adryd325/oneko.js` | 代码 **MIT**（可商用）；但 `oneko.gif` 源自 1989 年 X11 程序 Neko，**无正式协议** | 代码架构值得参考；那张图商用有风险 |
| **beepsid/oneko** | **MIT**，本身就是一个 Electron 桌宠（透明/置顶/穿透/追鼠标） | ⭐ **架构直接参考**，跟我们阶段 1 高度重合 |
| **Shimeji** | 精灵图规范公开（46 张一套）；社区角色包**基本是同人，禁商用** | 不用素材，**抄动作设计**（"被拖起来会挣扎"是桌宠灵魂） |
| **LottieFiles** | Lottie Simple License：可商用，但**禁止把动画单独再分发** | 状态联动别扭，不采用 |
| **Live2D** | SDK 商用需单独申请（年销售额超 2000 万日元另议）；免费模型仅非商用 | 严重超配，排除 |
| **Kenney / OpenGameArt** | CC0，随便用 | 只有游戏素材，没有桌宠行为 |

### 「鲸鱼娘 · 大肥鱼」授权链（重点，别踩坑）

- 原型 **「溟月」** 由 **上善无形** 于 2025-06 创作，以 **CC BY-NC-SA 4.0** 开放二创
- 2026-04-25 B 站用户 **ZipZipPipe** 在溟月基础上加入 DeepSeek 元素 + 女仆装 → 「女仆鲸鱼娘」
- 2026-07-15 DeepSeek V4-Flash GA + 峰谷定价引发不满 → 二创爆发，"蓝色大肥鱼"流行
- 2026-08-15 DeepSeek 官方"收编"（输入特定指令标签会加载鲸鱼娘人格），但**未转正**
- 现成桌宠项目：`1190fasheqi/dafeiyu-pet`（**代码 MIT，但 sprites/ 仍是 NC 素材**）、`RYANFFY/deepseek-dafeiyu-pet`、`sublatesublate-design/deepseek-whale-pet`（Electron 栈）

### CC BY-NC-SA 4.0 三条硬约束（已核对官方协议原文）

1. **署名**：适当署名 + 协议链接 + **说明是否修改过**
2. **非商业**：不得用于商业目的
3. **相同方式共享**：衍生作品必须以相同协议分发

**SA 传染范围**：CC 区分「改编作品（Adapted Material）」与「汇编/合集（Collection）」——
- 把原图改造（抠图/重绘/做精灵图）→ 改造后的图**必须** NC-SA
- 把"别人的图"和"自己的代码"**并列**发布 → 各用各的协议，SA 不传染代码
- 实操关键：**素材与代码保持"并列"，别融合成一个不可分整体**

**NC 是永久的**：一旦用上 NC 素材，项目永久不能商业化（卖钱/上架/广告/收费版都不行，打赏属灰色地带），且**无法反悔**——只能删素材重做形象。

### 另外两条容易忽略的

1. **别人标 MIT ≠ 素材能用**：`1190fasheqi/dafeiyu-pet` 标 MIT 的是**代码**，图片仍是 NC。
2. **严格讲 NC 协议不算"开源"**：不是 OSI 认证协议，GitHub 许可证选择器里没有它（显示为 "Other"）。准确说法是"源码公开、可自由使用（非商业）"。
3. **商标风险**：即使遵守 CC，项目名/Logo 里用 "DeepSeek" 仍可能触及商标。**项目名避开官方商标**。

### 最终决定：方案 B（自研原创形象）

- 代码开源 + 形象自研 → 代码和素材都能用 **MIT**，版权干净，将来想商业化随时可以
- 将来若沿用方案 A，需按此结构建文件：`LICENSE`（代码）/ `LICENSE-ASSETS.md`（素材）/ `CREDITS.md`（署名链）

---

_主人 sync 新细节时，记得回来更新这份文件。_
