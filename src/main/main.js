// src/main/main.js
// 主进程入口：创建窗口、管理生命周期。
// 阶段 0 先做「普通白窗口」，透明/无边框/置顶等特效留到阶段 1。

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 360,
    height: 360,
    show: true,
    webPreferences: {
      // 安全底线：渲染进程与 Node 隔离，只通过 preload 暴露的接口通信
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 加载桌宠界面
  win.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
