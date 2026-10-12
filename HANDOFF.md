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
| 1 | 桌宠外壳（透明窗口、拖拽、穿透、托盘、位置记忆 + Live2D 形象） | 1-2 天 | ✅ **已完成（2026-10-12）** |
| 2 | 日程提醒 | 2-3 天 | ⬜ 未开始 ← **下一步** |
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

**阶段 1 已完成（2026-10-12）**，验收细节见第十三、十四节。下一步是**阶段 2：日程提醒**。

阶段 2 要做：
1. 日程数据模型（时间 / 重复规则 / 内容）+ 存 `userData`
2. **30 秒轮询 + `lastFiredDate` 去重**（不用 `setTimeout`，电脑睡眠会丢事件）
3. 到点触发桌宠提醒（气泡 / 表情 / 动作）
4. 一个最简的日程编辑入口（先不做完整设置界面，阶段 4 再美化）

**给主人的提醒**：每次只派一个小任务，跑通了再派下一个。别一次说「帮我做个桌宠」。

---

## 十、阶段 1 形象设计（新对话开工必读）

**✅ 最终拍板：形象 = 「女仆鲸鱼娘」· 走方案 A**（2026-10-12 当天改定）

> ⚠️ **决策变更记录**：当天早些时候曾拍板走「方案 B（自研原创形象）」，并已生成 2 张原创候选
> 定妆照（存档在 `design/archive/`，未删除）。**主人随后改回方案 A**，改用女仆鲸鱼娘。
> 变更前的存档点：`git tag checkpoint-before-stage1`（提交 `5b5bc3b`）。

**这意味着项目永久非商业**，三条必须遵守：

1. **不得商用**——不能卖钱、不能上架、不能内置广告、不能出收费版
2. **必须完整署名**（见 `CREDITS.md`）：溟月（上善无形）→ 女仆鲸鱼娘（ZipZipPipe）→ 三视图（1190fasheqi/dafeiyu-pet）
3. **不算 OSI 开源**（GitHub 会显示 "Other"）；**项目名不使用 "DeepSeek" 商标**

### 素材已就位：`src/assets/pet/`

7 个 PNG，**全部已验证为真透明底**（四角 alpha=0）：

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `正面.png` / `侧面.png` / `背面.png` | 340px 高 | 主素材（大） |
| `正面_306.png` / `侧面_306.png` / `背面_306.png` | 306px 高 | 主素材（小） |
| `icon.png` | 48×64 | 托盘图标 |

- **素材体检工具**：`node scripts/check-assets.js <文件或目录>`（报尺寸 + 是否真透明）
- **授权文件已建**：`LICENSE`（代码 MIT）/ `LICENSE-ASSETS.md`（素材 CC BY-NC-SA 4.0）/ `CREDITS.md`（署名链）

### ⬜ 仍待定

| 待定项 | 选项 | 小安推荐 |
|---|---|---|
| 动画方式 | CSS 动效 / 序列帧 / GIF | **CSS 动效**（素材最省、能跟状态联动） |
| 是否补做动作图 | 只用三视图做位移/缩放/镜像 / 再生成动作图 | 先用三视图跑通 |

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

### 最终决定：方案 A（用女仆鲸鱼娘）

- **主人最终选择方案 A**：直接用女仆鲸鱼娘素材，接受项目永久非商业。
- 已建授权文件：`LICENSE`（代码 MIT）/ `LICENSE-ASSETS.md`（素材 CC BY-NC-SA 4.0）/ `CREDITS.md`（署名链）。
- **方案 B（自研原创）当时已走到生成候选图这一步**，2 张候选存于 `design/archive/`，未删除。
  若将来想转回方案 B，素材可复用，只是要把 `src/assets/pet/` 换掉、协议改回 MIT。

### 补充事实（2026-10-12 查证）

- **官方无拟人形象**：DeepSeek 官方从未发布官方拟人形象，也全程未就此表态。
- **9 月底的"画师隐藏作品"事件**：主角是**男版形象**的创作者**子午**（被舆论压力逼到隐藏作品），
  **与鲸鱼娘无关**。鲸鱼娘这边原作者与授权**未发生变化**。
- **风险提示**：鲸鱼娘目前处在"男版 vs 鲸鱼娘"粉丝争论的中心（投票 300 万 vs 140 万）。
  用它当项目门面，**可能被卷入粉丝战争**。主人已知悉并仍选择方案 A。
- **素材获取渠道**：B 站上善无形（space 4456176）/ ZipZipPipe（space 4168597）为原作者；
  可直接下载的现成素材来自 GitHub `1190fasheqi/dafeiyu-pet` 的 `sprites/`（同授权链下的二创，已抠透明底）。

---

## 十二、Live2D 调研（2026-10-12，主人要求做 L2D 效果）

### 结论：有现成的、可直接用的真 Live2D 大肥鱼模型 ✅

| 来源 | 是什么 | 授权 |
|---|---|---|
| **`Andersen216/dsh-whale-girl-live2d`** ⭐ | **真 Live2D 模型**（Cubism 3/4） | 代码 **MIT** / 素材 **CC BY-NC-SA 4.0** |
| `Pal-AI-Lab/Coopanion` | **自研渲染器**（非 Live2D；分层 PNG + WebGL 网格变形） | 项目 **AGPL-3.0** |

### Andersen216 的模型细节（已实测）

- `c_0120.moc3` —— **2.1 MB**（模型本体）
- `c_0120.2048/texture_00.png` + `texture_01.png` —— 2 张 2048 贴图
- `c_0120.physics3.json`（38 KB 物理）、`c_0120.cdi3.json`（28 KB）
- `expressions/` —— **40+ 个表情**（爱心眼、星星眼、生气、哭、晕晕、吐舌、墨镜、兔兔贴纸…）
- `motions/` —— 待机、自拍、吹泡泡、开盖、番茄酱等
- `model3.json` 的 `"Version": 3` → **Cubism 3/4 格式**

### 兼容性结论（关键）

| 项 | 结论 |
|---|---|
| 渲染方案 | `pixi-live2d-display` + PIXI + Live2D Cubism Core |
| ⚠️ **版本坑** | `pixi-live2d-display` 最新版仍是 **0.4.0**，**只兼容 PIXI 6.x**；PIXI 最新是 **8.22.0**，**不能用**。必须锁 `pixi.js@6.5.10`（Andersen216 正是这么锁的） |
| Electron | ✅ 可行，有多个现成项目验证（`One1turn/Live2D-DesktopPet`；Andersen216 的 Windows 客户端也是 Electron） |
| Cubism Core | 属 Live2D「可再分发代码」，**允许随应用分发** |
| Live2D SDK 发行许可 | 开发阶段无需许可；正式发布需签出版许可协议，但**个人 / 小规模发行商可豁免** |
| 已知风险 | ① Electron **透明窗口 + WebGL** 在部分显卡上会有黑边 / 不透明问题 ② L2D 每帧跑物理 + 变形，**常驻耗电**（Andersen216 专门做了"低性能模式"） ③ 模型 + 贴图约 5-8 MB，打包体积增大 ④ 点击穿透只能按窗口矩形近似，**做不到按模型轮廓穿透** |

### 三条可选路线（待主人决定）

1. **A. 用现成真 Live2D** —— 效果最好；代价是引入 Live2D 授权层 + 性能开销 + 透明窗口风险
2. **B. 自研分层渲染**（参考 Coopanion 思路）—— 绕开 Live2D 授权，但要自己写渲染器；注意 **AGPL 不能直接抄代码**
3. **C. 三视图 + 局部图层**（把眼睛 / 嘴单独抠出来做眨眼张嘴）—— 工作量小，效果介于 CSS 与 L2D 之间

> **未决定前不要动 `src/assets/pet/` 里的三视图素材。**

### 授权文件已同步更新

- `CREDITS.md` 新增：**氵六青**（第三位权利人，署名不能漏）+ Live2D 模型候选素材条目
- `LICENSE-ASSETS.md` 新增第四节：**Live2D 的额外运行时授权层**（Cubism Core / PIXI / pixi-live2d-display + SDK 发行许可）
- 参考范例：Andersen216 的 `NOTICE.md` 是「许可分层」的教科书写法——代码 MIT / 素材 CC / 第三方运行时各算各的

---

## 十三、Live2D 最小验证结果（2026-10-12 已跑通 ✅）

主人选了「先做最小验证」，在 `spike/l2d/` 里搭了个一次性验证页跑实测。**四项全部通过。**

### 怎么跑

```bash
cd desktop-pet
./node_modules/electron/dist/electron.exe spike/l2d/main.js \
  --disable-gpu --enable-unsafe-swiftshader --no-sandbox
```

跑完自动退出，产物在 `spike/l2d/out/`。

### 四项验证结果

| 要验的事 | 结果 | 证据 |
|---|---|---|
| ① 透明窗口有没有黑边/白底 | ✅ **完全没有** | 开窗前拍桌面底图 → 开窗后再拍 → 逐像素比对。**窗口顶部空带色差 0.00（完全一致）**，说明空的地方就是桌面本身；窗口区域**纯黑占比 0.0%** |
| ② 模型能不能加载 | ✅ 47 ms | `c_0120.model3.json`，原始尺寸 4068×4068，缩放 0.109 倍显示为 443×443 |
| ③ 眨眼 / 待机动作 | ✅ 全有 | `eyeBlink` 自带、`physics3` 物理自带；`expression('爱心眼')` 与 `motion('bubble')` 均切换成功 |
| ④ 帧率（耗电代理指标） | ✅ 28.5 fps | 上限锁 30，实测 28.5。**注意：这是无 GPU 沙箱里跑软件渲染（SwiftShader）的成绩，主人真机有独显只会更好** |

### 额外确认的事

- 渲染栈版本：**PIXI 6.5.10** + Cubism Core **5.1.0** + `pixi-live2d-display` 0.4.0 —— 版本组合正确，无报错
- **画布真的是透明的**：导出画布后跑 `scripts/check-assets.js` → 完全透明 **75.5%** / 完全不透明 23.7%，四角为空
- 桌面截图 `out/desktop-after.png` 肉眼可见：角色浮在 IDE 上，**IDE 文字一路贴到角色轮廓边**，没有任何底色方块

### 踩到的坑（已解决，记牢）

1. **`--disable-software-rasterizer` 不能用** —— 无 GPU 环境会直接报 `WebGL unsupported`。正确参数是 `--disable-gpu --enable-unsafe-swiftshader --no-sandbox`
2. **PIXI 6 需要 `'unsafe-eval'`** —— 它用 `new Function()` 生成 shader，被 CSP 挡住会报 `Current environment does not allow unsafe-eval`。spike 里已放开；**正式代码要不要放开需重新权衡**（可改用 `@pixi/unsafe-eval`）
3. **`capturePage()` 抓不到 WebGL 内容** —— 截出来是空图。必须让画布自己 `canvas.toDataURL()` 导出
4. **PowerShell `Add-Type` 被安全策略拦了** —— 想用 .NET 截屏行不通。改用 Electron 自带的 `desktopCapturer.getSources()`
5. **透明窗口 + WebGL 必须 `backgroundThrottling: false`** —— 否则窗口失焦时动画会像卡死

### 顺带发现的优化点（以后做正式版要注意）

- 模型的包围盒是 **4068×4068 的正方形**，但角色本体只占下半部分 —— 导出画布上方约 **35% 是空的**。正式版应该**按实际内容裁窗口**，不然窗口比角色大一大圈，鼠标穿透的判定范围也会虚胖
- 模型 + 贴图约 **5–8 MB**，打包体积会明显变大

### 结论

**路线 A（用现成真 Live2D）技术上完全可行**，之前担心的最大风险（透明窗口黑边）已实测排除。

---

## 十四、阶段 1 完成记录（2026-10-12）

主人选定**路线 A（用现成真 Live2D）**，把第十三节的验证成果正式接进了桌宠外壳。

### 做了什么

| 模块 | 文件 | 说明 |
|---|---|---|
| 窗口 / 托盘 / 位置记忆 | `src/main/main.js` | 透明无边框置顶、不进任务栏、单实例锁、托盘菜单、位置存 `userData` 带越界保护 |
| 安全桥 | `src/main/preload.js` | 拖拽 / 穿透 / 显隐 / 退出 / 右键菜单 / 校准缓存 六组通道 |
| 本地存储 | `src/main/store.js` | 统一写 `userData`，先写临时文件再改名，防写一半断电 |
| Live2D 渲染 | `src/renderer/pet/renderer.js` | 加载模型、实测裁切、30fps 上限、拖拽、动态穿透、点击换表情 |
| 第三方运行时 | `src/renderer/pet/vendor/` | PIXI 6.5.10 + pixi-live2d-display 0.4.0 + Cubism Core |
| 模型素材 | `src/renderer/pet/model/` | 从 spike 搬来，60 个文件 4.2MB |

### 新增的开发工具

| 命令 | 作用 |
|---|---|
| `npm run sync-vendor` | 从 node_modules 同步第三方运行时到 vendor/，打印哈希便于追溯 |
| `npm run check-assets` | 素材体检：验图片是不是真透明（零依赖手写 PNG 解码） |
| `npm run make-tray-icon` | 生成方形托盘图标（原来的 icon.png 是 48×64，直接用会被压扁） |
| `npm run shot` | 截一张桌面图存到 `tmp/`，用来肉眼验收 |
| `scripts/lib/png.js` | 零依赖 PNG 解码 / 编码 / 裁切 / 缩放，上面几个工具共用 |

### 实测验证结果（全部有日志证据）

| 验证项 | 结果 |
|---|---|
| 透明窗口无黑边 | ✅ 桌面截图中 IDE 文字与 bilibili 图片一路贴到角色轮廓边，四周无底色方块 |
| 模型加载 | ✅ 40–48 ms |
| 帧率 | ✅ 软件渲染（SwiftShader）下稳定 30fps 上限 |
| 角色裁切 | ✅ 实测角色本地尺寸 **3690×3172**，而模型方框是 4068×4068 → **方框约 36% 是空的**，不裁窗口会虚胖一大圈 |
| 只量一帧够不够 | ❌ **不够** —— 待机动作让角色比首帧宽出 **8%**（3403 → 3690），实测会顶出窗口 |
| 采样整循环后 | ✅ 边缘检测 **0 次报警**（连盯 15 秒） |
| 命中判定坐标 | ✅ 自检：角色中心 alpha=255 · 头顶 alpha=255 · 左上角 alpha=0 |
| 穿透切换链路 | ✅ 模拟鼠标移到角色上 → 「穿透关」；移到角落 → 「穿透开」 |
| 穿透迟滞 | ✅ 加迟滞前 25 秒抖动 20+ 次，加迟滞后只剩自检本身触发的 5 次 |
| 位置记忆 | ✅ `userData/window-state.json` 正常读写，重启回到原位 |
| 校准缓存 | ✅ `userData/model-bounds.json`，首次校准约 4.3 秒，之后即时贴合 |

### 还没验证的（需要主人亲手试）

- **系统层鼠标穿透**：程序里的链路是通的，但「点在透明区域能不能点到下面的桌面图标」
  只能人手试。这是 Electron 的 `setIgnoreMouseEvents`，用法标准，但值得亲测一次。
- **托盘图标外观**：图标已生成（32×32 方形），但托盘区长什么样需要主人看一眼。
- **拖拽手感**：位置确实变过（从默认位置移到了 764,549），说明拖拽生效，但手感要主人评。

### 已知的小瑕疵

- 窗口内尺寸比请求值大 2–4 px（请求 400×380，实际 `innerWidth` 402×384）。
  加了 `useContentSize: true` 也没完全消掉，怀疑是 Windows 透明窗口的隐形边框。
  因为角色四周本来就有 12px 以上留白，**肉眼无影响**，暂不处理。
- `--disable-gpu` 下每帧读像素会刷 `GPU stall due to ReadPixels` 警告，是软件渲染的正常现象，
  真机有独显不会有。

### 下一步

**阶段 2：日程提醒。** 细节见第九节。

---

_主人 sync 新细节时，记得回来更新这份文件。_
