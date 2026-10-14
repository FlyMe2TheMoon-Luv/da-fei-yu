// src/main/preload-notice.js
// 拦截提示窗口专用的安全桥梁。
//
// 为什么不复用气泡的 preload-bubble.js：两者能力不一样 ——
// 气泡只有「读内容」和「知道了」，提示窗口还要能**做选择**（两个按钮）。
// 安全上「用多少给多少」（硬性约定第 1、2 条），别把用不到的能力顺手暴露出去。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noticeAPI', {
  // 取这次要显示的内容（标题 / 说明 / 两个按钮的文字）。
  getData: () => ipcRenderer.invoke('focus-notice:get-data'),

  // 主进程推新内容过来（同一个窗口复用，换个提示）。
  // 返回「取消订阅」函数，和浏览器习惯保持一致。
  onUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('focus-notice:update', handler);
    return () => ipcRenderer.removeListener('focus-notice:update', handler);
  },

  // 主人点了哪个按钮。id 是这一条提示的编号（防止「窗口已经换了内容、
  // 而按钮是上一条留下的」这种错位）。
  choose: (id, which) => ipcRenderer.send('focus-notice:choose', { id, which }),
});
