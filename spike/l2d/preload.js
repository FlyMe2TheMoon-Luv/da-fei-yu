// spike/l2d/preload.js —— 验证用安全桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spikeAPI', {
  capture: (name) => ipcRenderer.invoke('spike:capture', name),
  saveCanvas: (dataUrl, name) => ipcRenderer.invoke('spike:save-canvas', dataUrl, name),
  captureDesktop: () => ipcRenderer.invoke('spike:capture-desktop'),
  done: () => ipcRenderer.send('spike:done'),
});
