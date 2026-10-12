// src/renderer/bubble/bubble.js
// 提醒气泡（浏览器世界，碰不到系统；要操作一律走 window.bubbleAPI → 主进程）。
//
// 它只干三件事：把主进程给的内容画出来、点「知道了」收起来、底部倒计时条走完自动收起。
// 真正「什么时候显示 / 显示多久」由主进程决定 —— 界面只负责画。
//
// 为什么既要 getData() 又要 onUpdate()：
//   getData 是「网页刚加载完，我先问一次」—— 保证第一次显示不白屏；
//   onUpdate 是「同一条气泡窗口复用，主人又收到新提醒」—— 不用重开窗口，推过来就换内容。
//   两条路都留着，任一条挂了另一条还能兜住。

const titleEl = document.getElementById('title');
const timeEl = document.getElementById('time');
const cardEl = document.getElementById('card');
const okBtn = document.getElementById('ok');
const bar = document.getElementById('bar');

let barAnim = null; // 上一次的倒计时动画，换内容时要先取消，否则两个动画会打架

// 倒计时条：用 Web Animations API 从满宽缩到 0。
// 用 CSS animation 也行，但这样能在数据到达后再启动，不会「还没显示就开始倒数」。
function startCountdown(ms) {
  if (barAnim) {
    try { barAnim.cancel(); } catch { /* 已经结束的动画取消会抛，忽略 */ }
    barAnim = null;
  }
  bar.style.display = '';

  if (!ms || ms <= 0) {
    bar.style.display = 'none'; // 不限时（自检会用），别显示一条永远不动的条
    return;
  }
  barAnim = bar.animate(
    [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: ms, fill: 'forwards', easing: 'linear' }
  );
}

function render(data) {
  if (!data) return;

  titleEl.textContent = data.title || '（无标题）';
  titleEl.title = data.title || '';
  timeEl.textContent = data.time || '';
  startCountdown(data.autoHideMs);

  // 换内容时把入场动画重播一次 —— 视觉上「又来了一条新提醒」，而不是内容默默变了
  cardEl.style.animation = 'none';
  void cardEl.offsetWidth; // 强制重排，否则浏览器会跳过重启动画
  cardEl.style.animation = '';
}

// 主进程推新内容过来
if (window.bubbleAPI.onUpdate) window.bubbleAPI.onUpdate(render);

(async () => {
  let data = null;
  try {
    data = await window.bubbleAPI.getData();
  } catch { /* 拿不到就显示默认文案，不至于白屏 */ }

  if (data) render(data);

  okBtn.addEventListener('click', () => {
    window.bubbleAPI.dismiss();
  });
})();
