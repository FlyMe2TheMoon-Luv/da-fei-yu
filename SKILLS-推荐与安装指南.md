# 桌宠项目 · 技能（Skill）推荐与安装指南

> 查证时间：2026-10-12
> 星数为当日 GitHub API 实际返回数据。

---

## 〇、先说结论：星数高 ≠ 适合你

这是新手最容易踩的坑。查下来星数最高的两个仓库，**都不是给桌宠用的**：

| 仓库 | 星数 | 它其实是 | 对桌宠 |
|---|---:|---|---|
| `obra/superpowers` | 297,870 | 一套「AI 工程方法论」框架 | 太重，杀鸡用牛刀 |
| `anthropics/skills` | 180,589 | 官方技能样例集 | 挑 2–3 个能用 |
| `VoltAgent/awesome-agent-skills` | 35,540 | 技能**索引目录** | 是"找东西的"，不是技能 |
| `vercel-labs/skills` | 33,871 | 安装**工具**（npx skills） | 是渠道，不是技能 |
| `0x0funky/agent-sprite-forge` | 4,393 | 2D 精灵图 + 动图生成 | 最对口，但很重 |
| `full-stack-skills/electron-skills` | 6 | Electron 开发技能（3 个） | 对口，但星数极低 |

**真正对口桌宠的 `electron-skills` 只有 6 星，而 29 万星的 `superpowers` 压根不写代码。**
所以选技能要看「内容对不对口」，不是看星数。

---

## 一、逐个评估

### 1. `anthropics/skills` — 官方技能集 ★ 推荐挑着装

180,589 星。仓库里有 19 个技能，其中和桌宠相关的：

| 技能 | 用途 | 值不值得装 |
|---|---|---|
| `frontend-design` | 前端界面设计 | ✅ 强烈推荐（桌宠 UI + 设置界面） |
| `webapp-testing` | 网页应用测试 | ✅ 推荐（自动化验证界面） |
| `canvas-design` | 画布/图形设计 | ⭕ 可选 |
| `algorithmic-art` | 算法生成艺术 | ⭕ 可选 |
| `slack-gif-creator` | 生成 GIF 动图 | ⭕ 名字虽叫 slack，但能做 GIF |
| `docx` / `pdf` / `pptx` / `xlsx` | 办公文档 | ❌ 和本项目无关 |
| `skill-creator` | 造新技能 | ⭕ 以后想自己写技能时用 |
| `mcp-builder` | 造 MCP 服务器 | ❌ 暂时用不上 |

> ⚠️ 注意：`docx`/`pdf`/`pptx`/`xlsx` 这 4 个是 **source-available（源码可见但非开源）**，
> 其余多数是 Apache 2.0。商用要注意。

---

### 2. `obra/superpowers` — 方法论框架 ⚠️ 别整套装

297,870 星，是这类仓库里星数最高的。它包含 15 个技能：

```
brainstorming · writing-plans · executing-plans · systematic-debugging
test-driven-development · verification-before-completion · requesting-code-review
receiving-code-review · subagent-driven-development · using-git-worktrees
dispatching-parallel-agents · finishing-a-development-branch
writing-skills · diagnosing-superpowers · using-superpowers
```

**它改变的是 AI 的「工作方式」，不是「知识」。** 装了它，AI 会强制走
「头脑风暴 → 写计划 → TDD → 验证」这套流程，还会挂 hooks。

**判断：** 对桌宠这种个人小项目，整套装上去是负担——你会被流程拖慢。
但如果挑单个用，有 3 个是真有价值的：

| 技能 | 为什么有用 |
|---|---|
| `writing-plans` | 把需求拆成可执行计划（正好对应我们做的 PLAN.md） |
| `systematic-debugging` | 桌宠的 IPC / 权限问题会很折磨人，这个能救命 |
| `verification-before-completion` | 逼 AI 在说「做完了」之前先自己验证一遍 |

**建议：只装这 3 个，不要整套。**

---

### 3. `0x0funky/agent-sprite-forge` — 动图生成 ★ 最对口，但先别装

4,393 星。**这是唯一一个专门做「角色动图」的**，功能确实强：
一张定稿图 → 自动生成 idle / walk / run / attack 等全套动作，
输出透明 PNG 帧、动画 GIF、VP9-alpha WebM、Godot/Aseprite 工程文件。

包含 5 个技能：
`generate2dsprite` · `video2dsprite` · `generate2dmap` · `generate2dmedia` · `codeart2d`

**但它的成本你要知道：**

| 依赖 | 要求 |
|---|---|
| Python | 3.10+，还要装 numpy / Pillow / scipy |
| ffmpeg | 5.1+，且要带 libvpx-vp9 |
| **图像/视频生成后端** | 需要 OpenAI / Gemini / xAI / fal.ai 的 API Key，或本地 Codex / Grok CLI |
| 复杂度 | 它是为**游戏引擎**设计的完整流水线 |

**判断：桌宠只需要「一个循环待机动画」+ 也许「一个提醒动画」。
用这套流水线属于超配。** 而且它必须接图像/视频生成后端，等于多一层成本和配置。

**建议：现在别装。** 桌宠的动图，用 WorkBuddy 自带的图片/视频生成能力
做一张定稿图 + 一段循环动画就够了。等你想要「多动作精灵图切换」时再回头装它。

---

### 4. `full-stack-skills/electron-skills` — Electron 开发 ⭕ 当参考

只有 **6 星**，是 `partme-ai/full-stack-skills`（690 星）生态下的一个子仓库。
含 3 个技能：`electron`、`electron-egg`、`upgrade-link`。
Apache 2.0 协议，最近更新 2026-10-03，还在维护。

内容是对口的（Electron 主/渲染进程、IPC 通信），但**星数太低、生态太小**，
质量没法保证。**建议当参考资料读一读，不必装。**

---

### 5. 不是技能、但你要知道的三个

| 仓库 | 是什么 | 怎么用 |
|---|---|---|
| `VoltAgent/awesome-agent-skills` | 1000+ 技能的**目录** | 以后想找某类技能，来这里翻 |
| `vercel-labs/skills` | 官方安装**工具** | `npx skills` 命令就是它 |
| `agentskills.io` | 技能**标准规范** | 想自己写技能时看这个 |

---

## 二、给这个项目的最终建议

| 装什么 | 数量 | 理由 |
|---|---|---|
| `anthropics/skills` → `frontend-design`、`webapp-testing` | 2 个 | 直接提升桌宠界面质量 |
| `obra/superpowers` → `writing-plans`、`systematic-debugging`、`verification-before-completion` | 3 个 | 解决 AI 写代码跑偏、调试难的问题 |
| `agent-sprite-forge` | 先不装 | 超配，等要精灵图再说 |
| `electron-skills` | 不装 | 星数太低，当参考读 |

**先装 2–3 个，别一次装一堆。** 技能多了会互相干扰，而且会占用 AI 的注意力。

---

## 三、怎么给我装技能（重点）

### 技能存在哪

WorkBuddy AI 的技能有两个位置：

| 级别 | 路径 | 作用范围 |
|---|---|---|
| **用户级** | `C:\Users\FlyMe\.workbuddy-ai\skills\` | 所有项目都能用（推荐） |
| **项目级** | `<项目目录>\.workbuddy-ai\skills\` | 只在这个项目生效 |

> 已确认：你的用户级目录存在但**目前是空的**，项目级目录还没建。

一个技能 = 一个文件夹，里面必须有 `SKILL.md`。
文件夹名就是技能名，例如 `~/.workbuddy-ai/skills/frontend-design/SKILL.md`。

---

### 方式 A · 让我帮你装（推荐给你）

最省事。你只需要说一句：

> 「小安，帮我装 anthropics/skills 里的 frontend-design」

我会自动做这几步：

1. `git clone --depth 1` 把仓库拉到临时目录（不污染你的项目）
2. **安全审计** —— 逐个检查 SKILL.md 和所有脚本：
   - 有没有偷偷执行命令、外发数据、删文件
   - 有没有读取敏感路径、联网下载可执行文件
   - 风险分级（P0 严重 / P1 警告 / P2 安全）
3. **把审计报告给你看**，你确认了我才继续
4. 复制到 `~/.workbuddy-ai/skills/`
5. 清理临时文件，告诉你新开对话后生效

> 🔒 **这一步不能省。** 技能本质是"给 AI 的指令 + 可执行脚本"，
> 一个恶意技能能让我在你机器上做任何事。所以**任何技能我都会先审计再装**。

---

### 方式 B · 手动安装（你自己动手，最可控）

适合你想亲眼看着每一步的情况。Git Bash 里执行：

```bash
# 1. 拉仓库到临时目录
git clone --depth 1 https://github.com/anthropics/skills.git /tmp/anth-skills

# 2. 看一眼有哪些技能
ls /tmp/anth-skills/skills

# 3. 复制你想要的（注意：是复制 skills 目录下的子文件夹）
mkdir -p ~/.workbuddy-ai/skills
cp -r /tmp/anth-skills/skills/frontend-design ~/.workbuddy-ai/skills/

# 4. 确认 SKILL.md 到位
ls ~/.workbuddy-ai/skills/frontend-design/SKILL.md

# 5. 清理
rm -rf /tmp/anth-skills
```

> Windows 下 `~` 就是 `C:\Users\FlyMe`。
> **`rm -rf /tmp/anth-skills` 只删临时克隆目录**，别手滑写成 `rm -rf ~`。

---

### 方式 C · 官方 CLI（`npx skills`）

`vercel-labs/skills` 提供的官方安装器。**但它不认识 WorkBuddy AI**，
默认往 `.claude/skills`、`.codex/skills` 这类目录装，所以要多一步搬运。

```bash
# 只看不装，先列出仓库里有哪些技能
npx skills add anthropics/skills --list

# 装指定的技能到用户级（--copy 用复制而不是软链接）
npx skills add anthropics/skills --skill frontend-design --global --copy

# 默认会落到 ~/.claude/skills/ 之类的目录，检查一下
ls ~/.claude/skills

# 再搬到 WorkBuddy 的目录
mkdir -p ~/.workbuddy-ai/skills
cp -r ~/.claude/skills/frontend-design ~/.workbuddy-ai/skills/
```

常用参数：

| 参数 | 作用 |
|---|---|
| `-l, --list` | 列出仓库里的技能，不安装 |
| `-s, --skill <名字>` | 只装指定技能 |
| `-g, --global` | 装到用户目录（否则装到当前项目） |
| `-a, --agent <名字>` | 指定目标 agent（claude-code / codex 等） |
| `--copy` | 复制文件，不用软链接（Windows 上建议加） |
| `-y, --yes` | 跳过确认 |

**判断：** 方式 C 比方式 B 多一层"落点不对"的麻烦。
除非你要装很多技能，否则**方式 A 最省事，方式 B 最透明**。

---

### 装完之后

1. **必须新开一个对话**，技能才会被加载
2. 想确认装没装上，直接问我：「我装了哪些技能？」
3. 不想要了：直接删掉 `~/.workbuddy-ai/skills/<技能名>` 文件夹即可

---

## 四、一句话总结

- **星数最高的不是最有用的**，`electron-skills` 6 星但最对口，`superpowers` 29 万星但不写代码
- **先装 2–3 个**：`frontend-design`、`webapp-testing` + `systematic-debugging`
- **动图那个先别装**，桌宠用不上那套游戏级流水线
- **装之前一定先做安全审计**，技能能让我执行任意命令
- **你只要说"帮我装 xxx"，剩下的我来**
