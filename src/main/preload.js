// src/preload.js
// 唯一的安全桥梁：渲染进程碰不到系统，只能用这里显式暴露的接口。
// 阶段 0 先放一个空壳，后续所有 IPC 通道都从这里挂出去。

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 仅用于自检：确认 preload 已生效
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
