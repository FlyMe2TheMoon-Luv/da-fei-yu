# vendor/ · 第三方运行时

这里放的是**渲染进程直接引用的第三方库**。本项目不用打包器，所以必须有一份拷出来的产物。

## 文件来源

| 文件 | 来源 | 许可 |
|---|---|---|
| `pixi.min.js` | `pixi.js@6.5.10` → `dist/browser/pixi.min.js` | MIT |
| `cubism4.min.js` | `pixi-live2d-display@0.4.0` → `dist/cubism4.min.js` | MIT |
| `live2dcubismcore.min.js` | **Live2D 官方**，非 npm | Live2D 专有（可再分发） |

前两个由 `npm run sync-vendor` 从 `node_modules` 自动同步，**不要手改**。
第三个不来自 npm，需要手动放进来（见下）。

## ⚠️ 版本必须锁死

`pixi-live2d-display` 最新版仍是 **0.4.0**（2022 年），**只兼容 PIXI 6.x**。
PIXI 现在是 8.x，**升上去会直接跑不起来**。

所以 `package.json` 里锁的是 `pixi.js@6.5.10`。**不要随手 `npm update`。**

## live2dcubismcore.min.js 怎么来

这是 Live2D Cubism 的专有核心库（Cubism Core），官方不通过 npm 分发。获取途径：

1. 从 Live2D 官方 Cubism SDK for Web 包里取 `Core/live2dcubismcore.min.js`
2. 或从任意合法的 Live2D Web 项目里取同名文件

放好后跑 `npm run sync-vendor` 校验，应看到：

```
✓ live2dcubismcore.min.js        202 KB  sha256:913e10e881aa7abe  （外部来源，未改动）
```

当前这份的 sha256 前 16 位是 `913e10e881aa7abe`，与实测通过的版本一致。

## 授权提醒

- Cubism Core 属 Live2D 的「可再分发代码」，**允许随应用分发**
- 但 Live2D SDK 有独立的**出版许可协议**：开发阶段免费，正式发布需签协议，
  **个人 / 小规模发行商可豁免**。详见根目录 `LICENSE-ASSETS.md` 第四节
