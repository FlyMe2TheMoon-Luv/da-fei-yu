// src/renderer/chat/chat.js
// 聊天条界面逻辑。
//
// 安全：所有文本一律 textContent，绝不用 innerHTML。

const msgsEl = document.getElementById('msgs');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const configEl = document.getElementById('config');
const cfgUrl = document.getElementById('cfg-url');
const cfgModel = document.getElementById('cfg-model');
const cfgKey = document.getElementById('cfg-key');
const cfgEnabled = document.getElementById('cfg-enabled');

// ---------- 消息渲染 ----------

function appendMsg(role, text, meta = null, scheduleId = null) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const txt = document.createElement('div');
  txt.textContent = text; // ★ textContent：绝不把用户/AI 文本当 HTML 解析
  div.appendChild(txt);

  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    div.appendChild(m);
  }

  if (scheduleId) {
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.textContent = '撤销';
    btn.addEventListener('click', async () => {
      await chatAPI.undo(scheduleId);
      btn.remove();
    });
    div.appendChild(btn);
  }

  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

// ---------- 发送 ----------

async function onSend() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.rows = 1;
  appendMsg('me', text);

  // 显示「…」占位
  const pending = appendMsg('fish', '…');

  try {
    const res = await chatAPI.send(text);
    pending.remove();

    if (res.error) {
      appendMsg('fish', res.reply || res.error);
    } else {
      const meta = res.source === 'cloud' ? '云端' : res.note ? '本地' : null;
      appendMsg('fish', res.reply, meta, res.created && res.created.id ? res.created.id : null);
    }
  } catch (err) {
    pending.remove();
    appendMsg('fish', '出了点问题，等下再试吧');
  }
}

sendBtn.addEventListener('click', onSend);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
});

// 自动增高 textarea
inputEl.addEventListener('input', () => {
  inputEl.rows = 1;
  const lines = inputEl.value.split('\n').length;
  inputEl.rows = Math.min(5, Math.max(1, lines));
});

// ---------- 设置面板 ----------

document.getElementById('btn-cfg').addEventListener('click', async () => {
  const cfg = await chatAPI.configGet();
  cfgUrl.value = cfg.baseUrl || '';
  cfgModel.value = cfg.model || '';
  cfgKey.value = cfg.apiKey || ''; // 实际界面上不会拿到明文，但以防万一
  cfgEnabled.checked = cfg.enabled || false;
  configEl.classList.remove('hidden');
});

document.getElementById('cfg-back').addEventListener('click', () => {
  configEl.classList.add('hidden');
});

document.getElementById('btn-close').addEventListener('click', () => {
  chatAPI.close();
});

document.getElementById('cfg-save').addEventListener('click', async () => {
  await chatAPI.configSet({
    baseUrl: cfgUrl.value.trim(),
    model: cfgModel.value.trim(),
    apiKey: cfgKey.value.trim(),
    enabled: cfgEnabled.checked,
  });
  configEl.classList.add('hidden');
  appendMsg('fish', '设置已保存～');
});

document.getElementById('cfg-test').addEventListener('click', async () => {
  const res = await chatAPI.configTest();
  appendMsg('fish', res.ok ? '连接成功！' : `连接失败：${res.error}`);
});

// ---------- 初始化：拉历史 ----------

(async () => {
  try {
    const history = await chatAPI.history();
    for (const h of history) {
      appendMsg(h.role, h.text, null, h.scheduleId);
    }
  } catch { /* 没历史也无所谓 */ }
})();
