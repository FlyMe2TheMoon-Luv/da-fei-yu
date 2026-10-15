// src/main/selftest-reduced-motion.js
// v4 批次 3-c-2 · 「减少动态效果」的通用检查（提醒气泡 / 拦截提示共用）
//
// ── 为什么不读 CSSOM 就完事 ──
//   只查「样式表里有没有那条规则」，只能证明**写了**，不能证明**生效**。
//   项目里为这事返工过一次（批次 2.5：断言写松了，等于没断言）。
//   这里用 CDP 的 `Emulation.setEmulatedMedia` 把系统设置**真的模拟成 reduce**，
//   再读**最终算出来的关键帧**。
//
// ── 要验的语义 ──
//   「减少动效」不是「干脆不出现」，而是换个温和的等价物：
//   **取消位移和缩放，保留透明度变化**。
//   所以断言必须分两半，缺一不可：
//     · 关键帧里**不许有 transform**（位移/缩放是让人晕的那部分）
//     · 关键帧里**必须有 opacity**（一点反馈都不给，等于把信息也删了）
//   ★ 只验前一半的话，「把动画整个删掉」也能过 —— 那正是我们要避免的。
//
// ── 为什么要先把动画重启一次 ──
//   动画播完之后 `getAnimations()` 就把它移除了（默认 fill 是 none），
//   于是读不到关键帧。把 animation 临时设成 none 再放开，就能拿到刚启动的那条。

module.exports = {
  // 返回 { reduced, normal } 两份读数；调用方自己判、自己报
  async read(webContents) {
    const dbg = webContents.debugger;
    let attachedHere = false;
    const readCard = () => webContents.executeJavaScript(`(() => {
      const c = document.getElementById('card');
      if (!c) return { missing: true };
      c.style.animation = 'none';
      void c.offsetWidth;          // 强制重排，让下一次赋值真的重启动画
      c.style.animation = '';
      const anims = c.getAnimations ? c.getAnimations() : [];
      const kf = anims.length && anims[0].effect ? anims[0].effect.getKeyframes() : [];
      return {
        name: getComputedStyle(c).animationName,
        frames: kf.length,
        hasTransform: kf.some((k) => k.transform !== undefined && k.transform !== 'none'),
        hasOpacity: kf.some((k) => k.opacity !== undefined && String(k.opacity) !== '1'),
        liveTransform: getComputedStyle(c).transform,
      };
    })()`);

    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
      await dbg.sendCommand('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      const reduced = await readCard();
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      const normal = await readCard();
      return { reduced, normal };
    } finally {
      try { await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } catch { /* 收尾失败无所谓 */ }
      if (attachedHere) { try { dbg.detach(); } catch { /* 已经断了 */ } }
    }
  },
};
