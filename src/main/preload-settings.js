// src/main/preload-settings.js
// 日程管理窗口专用的安全桥梁。
//
// 和桌宠 / 气泡一样「用多少给多少」：这个窗口只需要读写日程 + 预览一下提醒效果，
// 别的（拖拽、穿透、托盘菜单、退出）一律不给。这样即使设置窗口将来出问题，
// 也波及不到桌宠本体（硬性约定第 1、2 条）。
//
// ⚠ 校验不在这里做。界面只管把主人填的东西原样送上来，
//   合不合法由 schedules.js 说了算 —— 免得两处规则不一致。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  // ---- 日程的增删改查 ----
  // 全部返回 Promise。失败不抛异常，而是返回 { error: '人话原因' }，
  // 这样界面直接把 error 显示给主人就行，不用区分「网络错误」还是「校验错误」。
  list: () => ipcRenderer.invoke('schedules:list'),
  add: (input) => ipcRenderer.invoke('schedules:add', input),
  update: (id, patch) => ipcRenderer.invoke('schedules:update', id, patch),
  remove: (id) => ipcRenderer.invoke('schedules:remove', id),
  toggle: (id) => ipcRenderer.invoke('schedules:toggle', id),

  // ---- 周视图 ----
  // weekData() 拿回来的已经是「算好的布局」：哪天有哪些方块、每个方块的比例和颜色。
  // 界面不做任何日期运算 —— 渲染进程拿不到屏幕信息，也算不准星期。
  weekData: () => ipcRenderer.invoke('week:data'),
  // 切「列表 / 周视图」：主进程负责换窗口尺寸并重新摆位，返回确认后的模式
  setMode: (mode) => ipcRenderer.invoke('week:set-mode', mode),
  // 主进程换完尺寸后的回执（界面据此同步按钮文案）
  onMode: (cb) => ipcRenderer.on('week:mode', (_e, m) => cb(m)),

  // ---- 预览：立刻弹一次提醒，看看效果 ----
  // 主人不用等到点才知道长什么样（也不用干等 30 秒轮询）。
  preview: () => ipcRenderer.invoke('reminder:preview'),

  // ---- 专注模式（v3）----
  // 配置和会话状态全部由主进程说了算，界面只负责画。
  // 校验（哪条网址 / 程序名能加）也在主进程，界面不许自带第二套规则。
  focusGet: () => ipcRenderer.invoke('focus:get'),
  focusState: () => ipcRenderer.invoke('focus:state'),
  // 「这条行不行」——加一条之前先问一句，立刻拿到人话原因
  focusNormalize: (kind, raw) => ipcRenderer.invoke('focus:normalize', { kind, raw }),
  focusSetBlacklist: (list) => ipcRenderer.invoke('focus:set-blacklist', list),
  focusSetPreset: (minutes) => ipcRenderer.invoke('focus:set-preset', minutes),
  // 查一遍浏览器的「安全 DNS」——开着的话 hosts 屏蔽会被绕过，得提前告诉主人
  focusDoh: () => ipcRenderer.invoke('focus:doh'),
  focusStart: (opts) => ipcRenderer.invoke('focus:start', opts),
  // payload = { pressedAt }：按下「结束专注」那一刻的时间戳（主进程据此判断够没够 3 秒）
  focusStop: (payload) => ipcRenderer.invoke('focus:stop', payload),
});
