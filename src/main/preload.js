// src/main/preload.js
// 唯一的安全桥梁：渲染进程碰不到系统，只能用这里显式暴露的接口。
//
// 约定：暴露的每个方法都要在 main.js 里有对应的 ipcMain 处理。
// 阶段 1 用到的通道全部以 pet: 开头。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 仅用于自检：确认 preload 已生效
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // ---- 拖拽 ----
  // 传的是鼠标在屏幕上的坐标（渲染进程拿到的 screenX/screenY）
  dragStart: (p) => ipcRenderer.send('pet:drag-start', { x: p.x, y: p.y }),
  dragMove: (p) => ipcRenderer.send('pet:drag-move', { x: p.x, y: p.y }),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),

  // ---- 动态鼠标穿透 ----
  // true = 让鼠标穿过去点到桌面；false = 桌宠接住鼠标
  setClickThrough: (through) => ipcRenderer.send('pet:set-click-through', Boolean(through)),

  // ---- 托盘相关动作（渲染进程也可能要触发）----
  hide: () => ipcRenderer.send('pet:hide'),
  quit: () => ipcRenderer.send('pet:quit'),

  // ---- 打开日程管理窗口（和托盘菜单「日程管理…」同一个入口）----
  openSettings: () => ipcRenderer.send('pet:open-settings'),

  // ---- 打开聊天条 ----
  openChat: () => ipcRenderer.send('pet:open-chat'),

  // ---- 右键菜单：弹出和托盘一样的菜单 ----
  showMenu: () => ipcRenderer.send('pet:show-menu'),

  // ---- 模型裁切校准的缓存 ----
  // 量一次角色真实范围要采样一整个待机循环（约 4 秒），太慢，
  // 所以量完存起来，下次启动直接用。
  getBounds: (key) => ipcRenderer.invoke('pet:get-bounds', key),
  saveBounds: (key, bounds) => ipcRenderer.send('pet:save-bounds', key, bounds),

  // ---- 日程提醒 ----
  // 日程到点了，主进程推过来，让角色表演一下（切表情 + 放动作）。
  // 返回取消订阅的函数，方便以后热重载 / 多次注册时不重复。
  onReminder: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('reminder:notify', handler);
    return () => ipcRenderer.removeListener('reminder:notify', handler);
  },

  // ---- 专注模式（v3）：宠物陪伴 ----
  // 专注开始 / 进行中 / 结束时主进程推过来，让角色换姿态、说话、显示剩余时间角标。
  onFocus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('focus:notify', handler);
    return () => ipcRenderer.removeListener('focus:notify', handler);
  },
  // 启动时主动问一次：桌宠重开时如果主人还在专注，要接着陪
  getFocusState: () => ipcRenderer.invoke('pet:focus-state'),
});
