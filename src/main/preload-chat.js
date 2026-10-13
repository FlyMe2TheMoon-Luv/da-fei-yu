// src/main/preload-chat.js
// 聊天条窗口的安全桥梁。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatAPI', {
  send: (text) => ipcRenderer.invoke('chat:send', text),
  history: () => ipcRenderer.invoke('chat:history'),
  clear: () => ipcRenderer.invoke('chat:clear'),
  undo: (scheduleId) => ipcRenderer.invoke('chat:undo', scheduleId),
  configGet: () => ipcRenderer.invoke('chat:config-get'),
  configSet: (cfg) => ipcRenderer.invoke('chat:config-set', cfg),
  configTest: () => ipcRenderer.invoke('chat:config-test'),
  close: () => ipcRenderer.send('chat:close'),
});
