// src/main/chat-window.js
// Task 11 · 聊天条窗口
//
// 一个贴着桌宠的小气泡条，主人能在里面跟大肥鱼打字聊天。
//
// ⚠ 和气泡窗口最大的区别：这个窗口 **focusable: true**。
// 气泡是「看一眼就懂的提醒」，不能抢焦点；聊天条是「主人主动来打字」，
// 必须能抢焦点。两个窗口参数相反，别照抄。
//
// 位置跟着桌宠走：桌宠挪动时，聊天条 reposition() 跟着挪。
// 打开设置窗口时，聊天条也要跟着降层（否则设置窗口会被聊天条压住一块）。

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { placeNear } = require('./place');

const HTML = path.join(__dirname, '..', 'renderer', 'chat', 'index.html');
const PRELOAD = path.join(__dirname, 'preload-chat.js');

const CHAT_W = 320;
const CHAT_H = 440;

let chat = null;
let inited = false;
let getPetWindow = () => null;
let petMoveHandler = null;

// ---------- 窗口 ----------

function open() {
  if (chat && !chat.isDestroyed()) {
    chat.show();
    chat.focus();
    reposition();
    return;
  }

  chat = new BrowserWindow({
    width: CHAT_W,
    height: CHAT_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,        // ★ 主人要打字，必须能抢焦点
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chat.loadFile(HTML);

  chat.once('ready-to-show', () => {
    reposition();
    chat.show();
    chat.focus();
  });

  chat.on('closed', () => {
    chat = null;
    detachPetMove();
  });

  attachPetMove();
}

function close() {
  if (chat && !chat.isDestroyed()) {
    chat.close();
  }
  chat = null;
  detachPetMove();
}

function toggle() {
  if (isOpen()) close();
  else open();
}

function isOpen() {
  return chat && !chat.isDestroyed() && chat.isVisible();
}

function getWindow() {
  return chat;
}

// ---------- 摆位置 ----------

function reposition() {
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed() || !chat || chat.isDestroyed()) return;

  try {
    const petRect = pet.getBounds();
    const display = screen.getDisplayMatching(petRect);
    const { x, y } = placeNear(
      petRect,
      { w: CHAT_W, h: CHAT_H },
      display.workArea,
    );
    chat.setBounds({ x, y, width: CHAT_W, height: CHAT_H });
  } catch (err) {
    console.error('[chat]  reposition 失败', err && err.message);
  }
}

// ---------- 跟着宠物走 ----------

function attachPetMove() {
  detachPetMove();
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed()) return;
  petMoveHandler = () => reposition();
  pet.on('move', petMoveHandler);
}

function detachPetMove() {
  if (!petMoveHandler) return;
  const pet = getPetWindow();
  if (pet && !pet.isDestroyed()) {
    pet.removeListener('move', petMoveHandler);
  }
  petMoveHandler = null;
}

// ---------- 初始化 ----------

function init({ getPetWindow: fn }) {
  if (inited) return;
  inited = true;
  getPetWindow = fn || getPetWindow;
}

// ---------- 导出 ----------

module.exports = {
  init,
  open,
  close,
  toggle,
  isOpen,
  getWindow,
  reposition,
  CHAT_W,
  CHAT_H,
};
