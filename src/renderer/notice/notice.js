// src/renderer/notice/notice.js
// 拦截提示窗口（专注模式专用）的网页逻辑。
//
// ── 它和提醒气泡有什么不一样 ──
//   提醒气泡是「顺口告诉你一声」——不该打断你，所以它 focusable:false、
//   30 秒没人理就自己收。
//   这个窗口是「**你得先看一眼、做个选择**」——比如「安全 DNS 开着，
//   网站可能还拦不住」。所以它 focusable:true、不自动收。
//   （窗口能不能抢焦点是**主进程**那边定的，这里只管画面和按钮。）
//
// ── 安全 ──
//   所有文字一律 textContent，绝不 innerHTML —— 内容里有域名、程序名，
//   都是主人自己输入的。用 innerHTML 就等于把主人输入的内容当代码执行。

const el = {
  card: document.getElementById('card'),
  head: document.getElementById('head'),
  title: document.getElementById('title'),
  msg: document.getElementById('msg'),
  primary: document.getElementById('btn-primary'),
  secondary: document.getElementById('btn-secondary'),
};

// 记住「这一条现在显示的是哪个 id」，按钮点下去时好告诉主进程是哪一条。
let currentId = null;

function render(payload) {
  if (!payload || typeof payload !== 'object') return;
  currentId = typeof payload.id === 'string' ? payload.id : null;

  el.head.textContent = typeof payload.head === 'string' && payload.head ? payload.head : '专注模式';
  el.title.textContent = typeof payload.title === 'string' ? payload.title : '';
  el.msg.textContent = typeof payload.message === 'string' ? payload.message : '';

  // 警告 / 普通：换配色。除了 'warn' 一律当普通，不猜。
  el.card.classList.toggle('warn', payload.kind === 'warn');

  const primary = typeof payload.primaryLabel === 'string' && payload.primaryLabel
    ? payload.primaryLabel : '我知道了';
  el.primary.textContent = primary;

  const secondary = typeof payload.secondaryLabel === 'string' && payload.secondaryLabel
    ? payload.secondaryLabel : '';
  el.secondary.textContent = secondary;
  el.secondary.classList.toggle('hidden', !secondary);
}

el.primary.addEventListener('click', () => {
  window.noticeAPI.choose(currentId, 'primary');
});

el.secondary.addEventListener('click', () => {
  window.noticeAPI.choose(currentId, 'secondary');
});

// 主进程推新内容过来
window.noticeAPI.onUpdate((payload) => render(payload));

// 网页刚加载完主动问一次，避免白屏
(async () => {
  try {
    render(await window.noticeAPI.getData());
  } catch {
    /* 拿不到就先空着，主进程紧接着会推一次 */
  }
})();
