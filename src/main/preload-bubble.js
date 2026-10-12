// src/main/preload-bubble.js
// 提醒气泡窗口专用的安全桥梁。
//
// 为什么不复用 pet 的 preload.js：气泡窗口只需要「读内容」和「点知道了」两件事，
// 给它暴露拖拽 / 穿透 / 托盘菜单那些接口纯属多余。安全上「用多少给多少」，
// 以后气泡出问题也波及不到主功能（硬性约定第 1、2 条）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  // 取这次要显示的提醒内容（标题 / 时间 / 多久后自动收起）。
  // 网页刚加载完时会主动问一次，保证不白屏。
  getData: () => ipcRenderer.invoke('bubble:get-data'),

  // 主进程推新内容过来（同一条日程二次提醒、或换了别的日程）。
  // 返回一个「取消订阅」函数，和浏览器的 addEventListener 习惯保持一致。
  onUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('bubble:update', handler);
    return () => ipcRenderer.removeListener('bubble:update', handler);
  },

  // 「知道了」：让主进程把气泡收起来
  dismiss: () => ipcRenderer.send('bubble:dismiss'),
});
