# 桌宠项目 · 实现方案（v1）

> 目标：一个桌面宠物，具备「日程提醒」和「专注模式（禁网站/禁软件）」两个功能。
> 约束：Windows 桌面端，AI 辅助开发（vibe coding），优先交付可用版本。

---

## 一、需求拆解

原始需求一句话：「一个桌宠，能按日程提醒我，专注模式下能禁掉我设好的网站和软件。」

把它拆成 4 个**互相独立**的模块——这是整个方案里最重要的一个决定：

| 模块 | 是什么 | 难度 | 能否单独运行 |
|---|---|---|---|
| A. 桌宠外壳 | 透明无边框窗口、置顶、可拖拽、托盘 | ★☆☆ | 能 |
| B. 日程提醒 | 存日程 → 到点弹提醒 | ★★☆ | 能 |
| C. 专注模式 | 按时段禁用网站 / 软件 | ★★★★ | 能 |
| D. 设置界面 | 加日程、配黑名单、开关 | ★★☆ | 能 |

**为什么要这么拆：**
C 是唯一需要「系统管理员权限」的模块，也是唯一可能做不出来的模块。把它单独隔离，就算它最后卡住了，A + B + D 已经是一个完整可用的桌宠。**先保证交付，再追求完整。**

---

## 二、技术选型（效率优先）

### 结论

**Electron + 原生 HTML/CSS/JS + electron-builder**

### 为什么是它

1. 桌宠的本质 = 透明窗口 + 动图。Electron 三个配置项搞定：
   `transparent: true` / `frame: false` / `alwaysOnTop: true`
2. 日程提醒要定时器、专注模式要调用系统命令（改 hosts、杀进程）——这些全是 Node 的能力，**同一个进程里直接干，不用跨语言通信**
3. 全程只有一种语言（JS）。vibe coding 时 AI 不用在多种语言间切换上下文，**这是效率的核心来源**
4. 生态最成熟，AI 训练语料最多，生成的代码出错率最低

### 为什么不选别的

| 方案 | 放弃原因 |
|---|---|
| Tauri | 体积小性能好，但 Rust 后端编译慢、报错信息劝退，vibe 节奏会被频繁打断 |
| Python + PySide6 | 透明窗口和 PyInstaller 打包都折腾，动画表现力弱 |
| 纯 Python + tkinter | 做得出来，但动图/动效差，桌宠的「萌」出不来 |

### 版本建议

- Node.js 20 或 22 LTS
- Electron 最新稳定版
- electron-builder（打包）

---

## 三、目录结构（一开始就定死，别让 AI 乱放）

```
desktop-pet/
├─ package.json
├─ CLAUDE.md              ← 项目说明书，给 AI 看的（重要）
├─ src/
│  ├─ main/               ← 主进程：Node 世界，能碰系统
│  │  ├─ main.js          窗口创建、托盘、生命周期
│  │  ├─ preload.js       ← 唯一的安全桥梁
│  │  ├─ scheduler.js     日程轮询引擎
│  │  ├─ store.js         本地数据读写
│  │  └─ focus/
│  │     ├─ hosts.js      hosts 文件读写
│  │     ├─ process.js    进程扫描与查杀
│  │     └─ elevate.js    提权调用
│  ├─ renderer/           ← 界面：浏览器世界，碰不到系统
│  │  ├─ pet/             桌宠本体
│  │  └─ settings/        设置窗口
│  └─ assets/             图片、动图、音效
└─ scripts/               需要管理员权限的 PowerShell 脚本
```

**铁律：renderer 绝对不能直接碰系统，所有系统操作都通过 IPC 交给 main。**
这是 Electron 的安全底线，也是 AI 最容易写错的地方。

---

## 四、分阶段路线图

### 阶段 0 · 环境准备（半天）

- 装 Node.js LTS、VSCode、Git
- 装 Claude Code：`npm i -g @anthropic-ai/claude-code`
- 建项目：`npm init -y` → `npm i -D electron electron-builder`
- 让 AI 生成 `CLAUDE.md`（Claude Code 里用 `/init`）

**验收**：`npm start` 能弹出一个白色空窗口。

---

### 阶段 1 · 桌宠外壳（1–2 天）★ 先做这个

- 透明、无边框、置顶窗口
- 拖拽移动（CSS `-webkit-app-region: drag`）
- 托盘图标 + 右键菜单（显示 / 隐藏 / 设置 / 退出）
- 宠物形象：先用一张 PNG 或 GIF，后期再换
- 位置记忆：存本地，下次打开回到原位
- 越界保护：换显示器后如果宠物落在屏幕外，自动拉回可见区域

**验收**：一只猫趴在桌面上，能拖、能藏进托盘、能退出。

> ⚠️ **必须处理的交互细节**：桌宠窗口会挡住桌面图标的点击。
> 要动态切换 `setIgnoreMouseEvents()`：
> - 鼠标不在宠物身上 → 穿透（true），桌面正常使用
> - 鼠标移到宠物身上 → 取消穿透，可以拖拽
> 这个细节不做，用户第一天就会卸载。

---

### 阶段 2 · 日程提醒（2–3 天）

**数据模型**

```js
{
  id: "uuid",
  title: "开会",
  time: "09:30",          // 本地时间 HH:mm
  repeat: "once|daily|weekly",
  enabled: true,
  lastFiredDate: "2026-10-12"   // 用于去重
}
```

- **存储**：electron-store，或自己读写 `app.getPath('userData')` 下的 JSON
- **调度**：**每 30 秒轮询扫描**，不要用 `setTimeout`

  > 为什么？电脑睡眠 / 关机再开机，`setTimeout` 会丢事件。
  > 轮询 + `lastFiredDate` 去重，重启后依然可靠。

- **提醒表现**：宠物头上冒气泡 + 系统通知（`new Notification()`）
- **宠物状态机**：`idle` / `alert` / `focus` 三种姿态切换

**验收**：设一个 2 分钟后的日程，到点宠物冒泡 + 系统弹通知；关掉程序重开，已触发过的不重复提醒。

> ⚠️ 时间一律用**本地时间**。跨天重复规则要处理「昨天没开机，今天要不要补」——MVP 建议不补。

---

### 阶段 3 · 专注模式（4–6 天）★ 最难，单独隔离

#### 3.1 禁网站

**方案：改 hosts 文件，把域名指向 `0.0.0.0`**

- 文件位置：`C:\Windows\System32\drivers\etc\hosts`
- **必须管理员权限**
- 写入必须用标记块包裹，退出时精确删除：

```
# === FocusMode BEGIN ===
0.0.0.0 www.bilibili.com
0.0.0.0 bilibili.com
# === FocusMode END ===
```

- 改完执行 `ipconfig /flushdns`

> 🔴 **致命坑：浏览器的「安全 DNS」(DoH) 会绕过 hosts！**
> Chrome / Edge 可能默认开启，开着的话你改 hosts 完全无效。
> 必须引导用户关掉，或改用浏览器插件方案。

**备选（更稳但要多装东西）**：Chrome/Edge 插件用 `declarativeNetRequest` 拦截，
可靠性 100%，缺点是只覆盖装了插件的浏览器。

#### 3.2 禁软件

- **方案 A（MVP）**：定时轮询进程，发现黑名单里的 exe 就 `taskkill /IM xxx.exe /F`
- **方案 B（更狠）**：改注册表 IFEO（Image File Execution Options），
  把 `Debugger` 指向一个假程序，让软件根本启动不了
  - 优点：启动即被拦，杀不掉
  - 风险：改错注册表可能影响系统，必须能一键还原

MVP 用方案 A，方案 B 作为进阶。

#### 3.3 提权策略（效率关键）

**不要整个 App 常驻管理员**——每次启动弹 UAC、还影响拖拽体验。

正确做法：把需要特权的操作打包成一个 PowerShell 脚本，只在「开始专注」时用

```
Start-Process powershell -Verb RunAs
```

弹一次 UAC，用户点一下，之后整段专注期都不用再弹。

**验收**：开启专注 → 点一次 UAC → 目标网站打不开、目标软件被关掉 → 结束专注 → 全部恢复。

---

### 阶段 4 · 设置界面 + 打磨（2–3 天）

- 加 / 删 / 改日程
- 黑名单管理（网站、exe 都支持）
- 专注时长预设（25 / 45 / 60 分钟，或自定义时段）
- 开机自启：`app.setLoginItemSettings()`
- 宠物换装、待机动画、点击互动音效

---

### 阶段 5 · 打包发布（1 天）

- electron-builder → NSIS 安装包 / 便携版 exe
- 图标、版本号、产品名

---

## 五、必须注意的坑（照着检查）

### 权限类

1. 改 hosts、杀别的进程都需要管理员权限 → **只在需要时提权**，别让 App 常驻管理员
2. **杀毒软件会误报**：一个「改 hosts + 杀进程」的 exe，行为特征和恶意软件高度重合。
   提前把项目目录和输出 exe 加进杀软白名单
3. **别把自己杀了**：黑名单校验时，屏蔽 `electron.exe` / `node.exe` 和自身进程名

### 文件类

4. hosts 写入必须「读 → 拼接 → 写」，用标记块，退出时精确删除标记块内容。
   **绝对不要整个覆盖 hosts**——那是系统文件，覆盖了会出 DNS 故障
5. 意外退出（崩溃 / 断电）会残留 hosts 条目 → 程序启动时要先做一次「残留清理」
6. 用户数据放 `app.getPath('userData')`，不要放程序目录（打包后是只读的）

### Electron 类

7. `contextIsolation: true` + `preload` + `contextBridge`，**别开 `nodeIntegration`**
   —— AI 图省事会这么写，一定要拦住
8. 打包后路径会变（asar 打包），读资源要用 `__dirname` 相对路径或 `process.resourcesPath`
9. 多显示器：记住位置用相对坐标 + 启动时校验是否在可见区域内

### 功能类

10. 提醒调度用轮询，不用 `setTimeout`（睡眠会丢事件）
11. 禁网站要 `flushdns`，且要提醒用户关浏览器 DoH、重启浏览器
12. 有的软件有守护进程 / 多进程，`taskkill` 一次杀不干净 → 循环扫描
13. **专注模式本质是「自律工具」**。用户真想绕过（任务管理器结束进程）永远能绕。
    别把它当「监控软件」设计，也别用来限制别人——那是另一码事

---

## 六、Vibe Coding 工作流（Claude Code + VSCode）

1. 装 Claude Code：`npm i -g @anthropic-ai/claude-code`
2. VSCode 里开终端，在项目根目录运行 `claude`
3. **第一件事**：用 `/init` 生成 `CLAUDE.md`，把上面的技术栈、目录结构、约定写进去。
   这份文件决定了 AI 后面会不会跑偏，值得花 10 分钟写好
4. 每次只派**一个小任务**，做完能跑通再派下一个。别一次说「帮我做个桌宠」
5. 每完成一个阶段 `git commit` 一次，出错能回滚
6. 提需求模板：

```
在 src/main/focus/hosts.js 里实现两个函数：
  addBlockEntries(domains)  和  removeBlockEntries()

要求：
- 用 BEGIN/END 标记块包裹，不要改动文件其他内容
- 写入前先备份 hosts
- 返回操作结果对象 { ok, message }
```

7. 遇到 AI 改乱了：`git diff` 看一眼，不行就 `git checkout` 回滚重说

> 效率提示：如果直接用 WorkBuddy AI，我可以读写文件、跑命令、还能顺手把宠物形象图生成出来，
> 不用来回复制粘贴。

---

## 七、优先级建议（时间紧就按这个砍）

| 优先级 | 内容 |
|---|---|
| 必须 | 阶段 1（外壳）→ 阶段 2（提醒）→ 阶段 4 简版（设置界面） |
| 重要 | 阶段 3.1（禁网站） |
| 可选 | 阶段 3.2（禁软件）、Live2D 形象、使用统计 |

**第一周的目标：一个能拖、能提醒的猫。**
先让它「活着」，再让它「管你」。

---

_本文档会随项目推进持续更新。_
