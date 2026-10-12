// src/renderer/pet/renderer.js
// 桌宠界面的渲染脚本（浏览器世界，碰不到系统）。
// 阶段 0 仅用于自检：确认 preload 安全桥已生效。

const el = document.getElementById('ver');
if (window.petAPI && el) {
  el.textContent = `Electron ${window.petAPI.versions.electron} · 安全桥已连接`;
} else if (el) {
  el.textContent = '安全桥未连接';
}
