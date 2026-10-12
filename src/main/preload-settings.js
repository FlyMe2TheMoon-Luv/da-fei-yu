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

  // ---- 预览：立刻弹一次提醒，看看效果 ----
  // 主人不用等到点才知道长什么样（也不用干等 30 秒轮询）。
  preview: () => ipcRenderer.invoke('reminder:preview'),
});
