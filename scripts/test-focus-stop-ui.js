// scripts/test-focus-stop-ui.js
// v4 批次 3 · 「退出专注」长按进度条自检
//
// 用法：npm run test:focus-stop-ui
//
// ── 为什么单独开一套 ──
//   进度条这类东西是**纯视觉**的，最容易变成「看起来会动，其实没在按规则动」：
//     · 进度涨得好看，但按下 1 秒就放行了（专注形同虚设）
//     · 松手了条还挂在那儿（下次进来就是半满的，像坏掉了）
//     · reduced-motion 一开，进度整条消失（那是**信息**，不是装饰，不能没了）
//   这几条肉眼全都看不出问题，所以必须靠真渲染进程量**实际算出来的值**。
//
// ── ⚠ 这一套刻意不碰系统 ──
//   用的是真的 `index.html` + 真的 `settings.js` + 真的 preload，
//   但 IPC 全是内存里的假数据：不写 hosts、不杀进程、不弹 UAC。
//   「够没够 3 秒」到底谁说了算 —— 这里是问主进程层的假实现，同时另有一条
//   断言钉住「真规则只有 timer.canExit 一处」。
//
// ── ★ 断言原则（本项目的血泪）──
//   ① 每条负对照都要能答上「它怎样才能红」。答不上来的删掉，不要留着凑数。
//   ② 量**绝对量**，别量相对量（相对量可能恒等于常数，负对照永远不失败）。
//   ③ 报错必须带着量到的数值，否则失败信息等于没说。

const path = require('path');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('child_process').spawn(require('electron'), [__filename,
    '--disable-gpu', '--enable-unsafe-swiftshader', '--no-sandbox', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', path.join(root, 'tmp', 'focus-stop-test-' + Date.now()));

  let pass = 0, fail = 0, neg = 0, negFail = 0, win;
  const errors = [];
  const check = (cond, label, negative = false, detail = '') => {
    if (negative) { neg++; if (!cond) negFail++; }
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${negative ? '[negative] ' : ''}${label}${detail}`);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);

  // ---- 假主进程状态 ----
  // holdMs 由这里给，界面必须听它的（不是自己写死 3000）。
  const state = {
    domains: ['example.com'], exes: [], running: false,
    presets: [25, 45], lastMinutes: 25, session: null, holdMs: 3000,
  };
  let stopCalls = [];        // 每次 focus:stop 都记下传来的 pressedAt（要验「界面真的报了按下时刻」）
  let stopResult = { ok: true };

  const startSession = (remainingMs = 60000, minutes = 1) => {
    const now = Date.now();
    state.running = true;
    state.session = { state: 'running', minutes, startedAt: now, endsAt: now + remainingMs };
  };

  // ⚠ 必须和真主进程 `focus/index.js` 的 `state()` 长得一样。
  //   第一版只塞了 session、漏了 progressRatio 和 remainingMs →
  //   圆环算成 0、倒计时画成「NaN:NaN」，两条断言/截图双双翻车。
  //   ★ **夹具比真货少字段，测的就是假货。**
  const snapshot = () => {
    const now = Date.now();
    const s = state.session;
    const total = s ? s.endsAt - s.startedAt : 0;
    const remainingMs = s ? Math.max(0, s.endsAt - now) : 0;
    const progressRatio = s && total > 0
      ? Math.max(0, Math.min(1, (now - s.startedAt) / total)) : 0;
    return { ...structuredClone(state), running: !!s, remainingMs, progressRatio };
  };

  app.whenReady().then(async () => {
    ipcMain.handle('schedules:list', () => []);
    ipcMain.handle('focus:get', () => snapshot());
    ipcMain.handle('focus:state', () => snapshot());
    ipcMain.handle('focus:doh', () => null);
    ipcMain.handle('focus:normalize', (_, kind, raw) => ({ ok: true, value: String(raw).trim().toLowerCase() }));
    ipcMain.handle('focus:set-blacklist', () => ({ ok: true, domains: state.domains, exes: state.exes }));
    ipcMain.handle('week:set-mode', (_, mode) => mode);
    ipcMain.handle('apps:list', () => ({ ok: true, apps: [] }));
    ipcMain.handle('focus:stop', (_, payload) => {
      stopCalls.push(payload);
      return structuredClone(stopResult);
    });
    ipcMain.handle('focus:start', () => { startSession(); return { ok: true }; });

    win = new BrowserWindow({ width: 460, height: 640, show: false,
      webPreferences: { preload: path.join(root, 'src/main/preload-settings.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_, level, message) => {
      if (level === 3 && !/Content Security Policy/.test(message || '')) errors.push(message);
    });
    await win.loadFile(path.join(root, 'src/renderer/settings/index.html'));
    win.show();

    // 进专注页并处在「专注中」
    startSession();
    await js("mode='focus'; applyMode(); loadFocus()");
    await wait(400);

    // ================= 1. 结构：进度条真的在建出来的按钮里 =================
    console.log('\n1. 结构：按钮上有「轨道 + 填充 + 文字」三层');
    {
      const dom = await js(`(() => {
        const b = document.getElementById('btn-focus-stop');
        const f = document.getElementById('focus-stop-fill');
        const l = document.getElementById('focus-stop-label');
        return { hasBtn: !!b, hasFill: !!f, hasLabel: !!l,
          fillInside: !!f && !!b && b.contains(f),
          labelInside: !!l && !!b && b.contains(l),
          fillHidden: !!f && f.getAttribute('aria-hidden') === 'true',
          described: !!b && b.getAttribute('aria-describedby') === 'focus-stop-hint',
          hintLive: document.getElementById('focus-stop-hint').getAttribute('aria-live'),
          runningShown: !document.getElementById('focus-running').classList.contains('hidden') };
      })()`);
      check(dom.hasBtn && dom.hasFill && dom.hasLabel, '★ 长按按钮、填充条、文字三层都在');
      check(dom.fillInside && dom.labelInside, '★ 填充和文字确实在按钮内部（不然定位会飘）');
      check(dom.fillHidden, '★ 填充条 aria-hidden（它是装饰，别让读屏器念一遍）', true);
      check(dom.described && dom.hintLive === 'polite',
        '★ 按钮用 aria-describedby 指向状态行，状态行 aria-live=polite（读屏能听到「松手太早」）',
        ` → described=${dom.described} live=${dom.hintLive}`);
      check(dom.runningShown, '专注中 → 倒计时那块是显示着的');
    }

    // ================= 2. 初始状态：进度 0、不在按住 =================
    console.log('\n2. 初始状态');
    {
      const st = await js(`(() => ({ p: window.__focusHoldDebug.progress(), h: window.__focusHoldDebug.holding(),
        need: window.__focusHoldDebug.needMs(),
        label: document.getElementById('focus-stop-label').textContent }))()`);
      check(st.p === 0, '★ 没按的时候进度是 0（不会残留上次的半截）', false, ` → --hold=${st.p}`);
      check(st.h === false, '没按的时候「按住中」是假');
      check(st.need === 3000, '★ 界面认的时长就是主进程给的 holdMs', false, ` → ${st.need}ms`);
      check(st.label === '长按 3 秒结束', '★ 按钮文字里的秒数跟 holdMs 对上', false, ` → “${st.label}”`);
    }

    // ================= 3. ★ 按住的整段：进度单调涨、且不乱跳 =================
    console.log('\n3. ★ 按住：进度单调上涨（不是「跳一下就到 1」）');
    {
      // 用真的 pointerdown 事件开始按住
      await js(`(() => {
        const b = document.getElementById('btn-focus-stop');
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
        return true;
      })()`);
      const samples = [];
      for (let i = 0; i < 6; i++) {
        await wait(300);
        samples.push(await js('window.__focusHoldDebug.progress()'));
      }
      const monotonic = samples.every((v, i) => i === 0 || v >= samples[i - 1] - 1e-6);
      check(monotonic, '★ 进度一路不回头（单调不减，不是抖动的）', true,
        ` → ${samples.map((v) => v.toFixed(3)).join(' → ')}`);
      // 到这一步应该按住约 1.8 秒 = 0.6 左右。允许宽范围，但必须「涨了、又没满」
      const last = samples[samples.length - 1];
      check(last > 0.2 && last < 1, '★ 按到一半左右 → 进度在中间，没有提前满格',
        false, ` → ${last.toFixed(3)}（按住约 1.8s / 需 3s）`);
      // 真的按住不放，进度到 1 之后主进程才被问 —— 但这里还没到
      check(stopCalls.length === 0, '★ 还没按够 → 一次都没去问主进程（界面不许自己放行）', true,
        ` → 已调用 ${stopCalls.length} 次`);
    }

    // ================= 4. ★ 负对照：按到一半松手 → 归零、且不去结束 =================
    console.log('\n4. ★ 负对照：按到一半松手');
    {
      const before = stopCalls.length;
      await js(`(() => {
        const b = document.getElementById('btn-focus-stop');
        b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        return true;
      })()`);
      await wait(250); // 等 160ms 的回退过渡
      const st = await js(`(() => ({ p: window.__focusHoldDebug.progress(), h: window.__focusHoldDebug.holding(),
        label: document.getElementById('focus-stop-label').textContent,
        hint: document.getElementById('focus-stop-hint').textContent }))()`);
      check(st.p === 0, '★ 松手后进度归零（不残留半截）', false, ` → --hold=${st.p}`);
      check(st.h === false, '★ 「按住中」也清掉了');
      check(stopCalls.length === before, '★ 松手太早 → 没有去问主进程（界面没放行）', true,
        ` → 从 ${before} 变成 ${stopCalls.length}`);
      check(/按住\s*3\s*秒/.test(st.hint), '★ 状态行明说了「还得按住 3 秒」（给得出下一步）',
        false, ` → “${st.hint}”`);
      check(st.label === '长按 3 秒结束', '★ 按钮文字回到「没按」时的样子', false, ` → “${st.label}”`);
      check(await js('window.__focusHoldDebug.holding() === false'), '状态也确实不是按住中了');
    }

    // ================= 5. ★ 可打断：松手后能立刻重按，进度重新从 0 涨 =================
    console.log('\n5. ★ 可打断（apple-design 第 3 节）：松手能重来');
    {
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:2 }))`);
      await wait(200);
      const p1 = await js('window.__focusHoldDebug.progress()');
      check(p1 > 0 && p1 < 1, '★ 重按之后进度从 0 重新开始涨', false, ` → ${p1.toFixed(3)}`);
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:2 }))`);
      await wait(250);
      check(await js('window.__focusHoldDebug.progress() === 0'), '再松开 → 又归零');
    }

    // ================= 6. ★ 负对照：按住中途被 pointercancel（系统手势）→ 必须回退 =================
    console.log('\n6. ★ 负对照：系统手势打断（pointercancel）');
    {
      const before = stopCalls.length;
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:3 }))`);
      await wait(400);
      const mid = await js('window.__focusHoldDebug.progress()');
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointercancel', { bubbles:true, pointerId:3 }))`);
      await wait(250);
      check(mid > 0, '打断之前进度确实涨起来了（负对照的前提成立）', true, ` → ${mid.toFixed(3)}`);
      check(await js('window.__focusHoldDebug.progress() === 0'), '★ 被打断 → 进度回退到 0', true);
      check(stopCalls.length === before, '★ 被打断 → 没有放行', true, ` → ${stopCalls.length} 次`);
    }

    // ================= 7. ★ 按满 → 才去问主进程，而且报的是「按下那一刻」 =================
    console.log('\n7. ★ 按满：才去问主进程，并且把「按下时刻」报上去');
    {
      const before = stopCalls.length;
      const t0 = Date.now();
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:4 }))`);
      // 等它自己涨满（需要 3 秒），多给 1.2 秒余量
      let fired = false;
      for (let i = 0; i < 50; i++) {
        await wait(100);
        if (stopCalls.length > before) { fired = true; break; }
      }
      const elapsed = Date.now() - t0;
      check(fired, '★ 按满之后真的去问主进程了（否则永远退不出专注）', false,
        ` → 从 ${before} 变成 ${stopCalls.length}，耗时 ${elapsed}ms`);
      // ★ 关键：**不能提前**。轮询是 100ms 一跳，所以实测只会比真实阈值大、不会小；
      //   因此这里用 2900ms（给 100ms 的轮询粒度留一点位置），真正的下限是 3000。
      check(elapsed >= 2900, '★★ 必须真的按够 3 秒才放行（不许提前放行）', true,
        ` → 实测 ${elapsed}ms（真阈值 3000ms，轮询粒度 100ms）`);
      const call = stopCalls[stopCalls.length - 1] || {};
      const lag = Math.abs((call.pressedAt || 0) - t0);
      check(typeof call.pressedAt === 'number' && lag < 250,
        '★ 报给主进程的是「按下那一刻」，不是「放手那一刻」（规则靠这个算时长）',
        false, ` → pressedAt 与按下时刻差 ${lag}ms`);
      // 结束之后进度要清干净
      await wait(300);
      const after = await js(`(() => ({ p: window.__focusHoldDebug.progress(), h: window.__focusHoldDebug.holding() }))()`);
      check(after.p === 0 && after.h === false, '★ 放行之后进度清空，不会卡在满格', false,
        ` → --hold=${after.p} holding=${after.h}`);
    }

    // ================= 8. ★ 负对照：主进程拒绝时，界面不许装作成功 =================
    console.log('\n8. ★ 负对照：主进程拒绝结束请求');
    {
      stopResult = { ok: false, error: '专注中不能这样结束' };
      const before = stopCalls.length;
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:5 }))`);
      for (let i = 0; i < 50; i++) { await wait(100); if (stopCalls.length > before) break; }
      await wait(400);
      const st = await js(`(() => ({
        errShown: !document.getElementById('focus-error').classList.contains('hidden'),
        err: document.getElementById('focus-error').textContent,
        runningShown: !document.getElementById('focus-running').classList.contains('hidden'),
        hint: document.getElementById('focus-stop-hint').textContent,
      }))()`);
      check(st.errShown && /不能这样结束/.test(st.err), '★ 主进程拒绝 → 界面上有明说的错误',
        false, ` → “${st.err}”`);
      check(st.runningShown, '★ 拒绝之后仍然停在「专注中」（没有假装已经结束）', true);
      check(st.hint === '', '★ 拒绝之后不留「按住别松手…」（那是在说一个已经结束的动作）',
        false, ` → “${st.hint}”`);
      stopResult = { ok: true };
    }

    // ================= 9. ★ 键盘：空格/回车按住也能退 =================
    console.log('\n9. ★ 键盘长按');
    {
      // 先把上一段残留清干净（按住状态、键盘标志都要是「没按」）
      await js(`(() => {
        const b = document.getElementById('btn-focus-stop');
        b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99 }));
        b.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
        return true; })()`);
      await wait(200);
      startSession();
      await js('loadFocus()');
      await wait(300);
      // 负对照的前提：确实处在「专注中」，否则 beginHold 会直接 return
      const pre = await js(`(() => ({ running: !!(focusData && focusData.running),
        holding: window.__focusHoldDebug.holding(), p: window.__focusHoldDebug.progress() }))()`);
      check(pre.running && !pre.holding && pre.p === 0,
        '前提：进入键盘测试时确实在专注中、且没有残留的按住状态', true,
        ` → running=${pre.running} holding=${pre.holding} p=${pre.p}`);

      const keyDown = () => js(`(() => {
        document.getElementById('btn-focus-stop').focus();
        document.getElementById('btn-focus-stop').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        return true; })()`);
      const keyUp = () => js(`(() => {
        document.getElementById('btn-focus-stop').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
        return true; })()`);

      const before = stopCalls.length;
      await keyDown();
      await wait(300);
      const mid = await js('window.__focusHoldDebug.progress()');
      check(mid > 0, '★ 按住空格 → 进度也在涨（键盘不是二等公民）', false,
        ` → ${mid.toFixed(3)}（按下 300ms / 需 3000ms）`);
      await keyUp();
      await wait(250);
      check(await js('window.__focusHoldDebug.progress() === 0'), '★ 抬起空格 → 进度归零');
      check(stopCalls.length === before, '★ 只按 0.3 秒 → 没有放行', true);

      // ★ 负对照：keydown 连发（真实键盘按住会一直发）不许把计时重置
      await keyDown();
      await wait(500);
      const a = await js('window.__focusHoldDebug.progress()');
      // 连发 4 次 keydown
      for (let i = 0; i < 4; i++) {
        await js(`document.getElementById('btn-focus-stop').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))`);
        await wait(60);
      }
      const b = await js('window.__focusHoldDebug.progress()');
      check(b > a, '★ 连发的 keydown 不会重置计时（进度继续往前走，没被拽回 0）', true,
        ` → ${a.toFixed(3)} → ${b.toFixed(3)}（若被重置，第二个数会明显变小）`);
      await keyUp();
      await wait(250);
    }

    // ================= 10. ★ 减少动效：进度仍然看得见（那是信息，不是装饰） =================
    console.log('\n10. ★ reduced-motion 下进度仍可见');
    {
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await wait(200);
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:6 }))`);
      await wait(500);
      const rm = await js(`(() => {
        const fill = getComputedStyle(document.getElementById('focus-stop-fill'));
        const p = window.__focusHoldDebug.progress();
        return { p, transform: fill.transform, duration: fill.transitionDuration, bg: fill.backgroundColor };
      })()`);
      check(rm.p > 0, '★ reduced-motion 下进度照样在涨（不是「没有反馈」）', true,
        ` → --hold=${rm.p.toFixed(3)}`);
      // scaleX 必须有实际位移（不等于 1 的水平缩放）
      const scale = await js(`(() => {
        const m = new DOMMatrix(getComputedStyle(document.getElementById('focus-stop-fill')).transform);
        return m.a;
      })()`);
      check(scale > 0.02 && scale < 1, '★ 填充真的被缩放出来了（不是只改了变量）', false,
        ` → scaleX=${scale.toFixed(3)}`);
      // ★ 「过渡时长≈0」要按**数量级**判，不能按字面判：
      //   全局那条 `transition-duration: .01ms !important` 算出来是 "1e-05s"，
      //   字面写成 /^0s/ 会假失败（第一版就栽在这）。
      //   真正要守的是「不存在可见的缓动」→ 时长必须 < 1ms。
      const durMs = parseFloat(rm.duration) * (rm.duration.includes('ms') ? 1 : 1000);
      check(durMs < 1, '★ reduced-motion 下填充的过渡时长 <1ms（不靠动画制造变化）', false,
        ` → transition-duration=${rm.duration}（≈${durMs.toFixed(3)}ms）`);
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:6 }))`);
      await wait(150);

      // 提高对比度：轨道要有实边
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
      await wait(150);
      const hc = await js(`(() => {
        const t = getComputedStyle(document.getElementById('btn-focus-stop'), '::before');
        return { border: t.borderTopWidth, opacity: t.opacity, fill: getComputedStyle(document.getElementById('focus-stop-fill')).backgroundColor };
      })()`);
      check(parseFloat(hc.border) >= 2, '★ 提高对比度时轨道有 2px 实边', false, ` → ${hc.border}`);
      check(parseFloat(hc.opacity) === 1, '★ 提高对比度时轨道不再半透明', false, ` → ${hc.opacity}`);
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      dbg.detach();
      await wait(150);
    }

    // ================= 11. ★ 负对照：进度条 ≠ 剩余时间（两个数不能是同一个东西） =================
    console.log('\n11. ★ 负对照：进度条和圆环是两件事');
    {
      // 圆环的语义（见 refreshCountdownFrom）：strokeDashoffset = 周长 × progressRatio，
      //   progressRatio = 已过时间 / 总时长 —— **0 = 满环（刚开始），1 = 空环（到点了）**。
      //
      // 把会话调成「已经过了一大半」（剩 1 秒 / 共 25 分钟 → ratio ≈ 0.999）：
      //   如果实现里图省事把圆环的 ratio 接到进度条上，那么**没按**的时候
      //   进度条就会显示 0.999（看起来像已经按住要退出了）—— 这正是要抓的错。
      const now = Date.now();
      state.running = true;
      state.session = { state: 'running', minutes: 25, startedAt: now - 25 * 60 * 1000 + 1000, endsAt: now + 1000 };
      await js('loadFocus()');
      await wait(300);

      const ring = await js(`(() => {
        const c = document.getElementById('focus-ring-fg');
        const C = 2 * Math.PI * 52;
        return { dash: parseFloat(c.style.strokeDashoffset) || 0, C,
          p: window.__focusHoldDebug.progress() };
      })()`);
      const ringRatio = ring.dash / ring.C;   // 0 = 满环（刚开始），1 = 空环（到点了）
      check(ringRatio > 0.9, '前提：会话快到点了 → 圆环几乎是空的（剩余时间很少）', true,
        ` → ringRatio=${ringRatio.toFixed(3)}（1=空环）`);
      check(ring.p === 0, '★★ 但退出进度条仍然是 0（它只管「退出动作按到哪」，不是剩余时间）', true,
        ` → --hold=${ring.p}（若被绑到圆环上，这里会是 ≈${ringRatio.toFixed(2)}）`);

      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:7 }))`);
      await wait(600);
      const p2 = await js('window.__focusHoldDebug.progress()');
      const ring2 = await js(`(() => {
        const c = document.getElementById('focus-ring-fg');
        const C = 2 * Math.PI * 52;
        return (parseFloat(c.style.strokeDashoffset) || 0) / C;
      })()`);
      check(p2 > 0 && p2 < 1, '★ 按住之后进度条开始涨（这是它唯一的数据来源）', false,
        ` → --hold=${p2.toFixed(3)}`);
      // 圆环这时候只被倒计时每秒刷一次，和按钮进度没有因果关系 ——
      // 600ms 内它最多自然前进 0.6/1500 ≈ 0.0004，所以「基本没动」是硬要求。
      check(Math.abs(ring2 - ringRatio) < 0.05,
        '★ 按住期间圆环基本没动（两件事各管各的，没被绑在一起）', true,
        ` → 环 ${ringRatio.toFixed(3)} → ${ring2.toFixed(3)}，条 ${p2.toFixed(3)}`);
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:7 }))`);
      await wait(200);
    }

    // ================= 12. ★ 真规则只有一处：timer.canExit =================
    //   这一条防的是「界面自己算时长」——如果哪天有人图省事在界面里写
    //   `if (elapsed >= 3000)`，主进程和界面就会各有一套规则，迟早长歪。
    console.log('\n12. ★ 规则只有一处（主进程 timer.canExit）');
    {
      const fs = require('fs');
      const src = fs.readFileSync(path.join(root, 'src/renderer/settings/settings.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // 负面：界面里不许出现「自己判断够不够」的写法
      const selfJudge = /elapsed\s*>=\s*need|elapsed\s*>=\s*3000|Date\.now\(\)\s*-\s*holdStart\s*>=/;
      check(!selfJudge.test(src),
        '★ 界面里没有「自己判断按够了没有」的代码（规则只有主进程一处）', true);
      // 正面：必须把按下时刻报上去
      check(/api\.focusStop\(\s*\{\s*pressedAt/.test(src),
        '★ 界面的做法是把 pressedAt 报给主进程，由它裁定');
      // 负对照：上面那条正则得真能抓到
      check(selfJudge.test('const ok = elapsed >= 3000;'),
        '★ 负对照：错误写法确实能被这个正则抓到（否则上面那条是装饰）', true);
    }

    // ================= 13. ★ 坏数据不许把界面画成 NaN =================
    //   这条是**从截图里看出来的**：截图时夹具少给了 remainingMs，
    //   倒计时就真的画成了「NaN:NaN」。一眼看去像整个专注模式坏了。
    //   界面必须对任何坏载荷都给出「看起来正常」的兜底。
    console.log('\n13. ★ 坏数据：不许出现 NaN');
    {
      const bad = await js(`(() => {
        const out = {};
        // 直接问这个纯函数（它是页面里所有时间显示的唯一出口）
        out.undefinedMs = fmtClock(undefined);
        out.nullMs = fmtClock(null);
        out.nanMs = fmtClock(NaN);
        out.stringMs = fmtClock('abc');
        out.negativeMs = fmtClock(-5000);
        out.zeroMs = fmtClock(0);
        return out;
      })()`);
      const allClean = Object.values(bad).every((v) => typeof v === 'string' && !/NaN/.test(v));
      check(allClean, '★ 任何坏输入都画不出 NaN（先让 fmtClock 自己扛住）', true,
        ` → ${JSON.stringify(bad)}`);
      check(bad.zeroMs === '00:00' && bad.undefinedMs === '00:00',
        '★ undefined / 0 一律显示 00:00（宁可显示零，也不要 NaN）', false,
        ` → undefined=${bad.undefinedMs} 0=${bad.zeroMs}`);
      check(bad.negativeMs === '00:00', '★ 负数（时钟往回拨）夹到 00:00，不出现 -0:05', false,
        ` → ${bad.negativeMs}`);

      // ★ 负对照：把「脏值」真的喂进刷新函数，看页面上写出来的是什么
      const rendered = await js(`(() => {
        const before = document.getElementById('focus-countdown').textContent;
        // 临时换一份坏数据走完整条渲染路径
        const saved = focusData;
        focusData = { running: true, holdMs: 3000, session: { state: 'running' },
          presets: [25], lastMinutes: 25, domains: [], exes: [] /* 故意不给 remainingMs */ };
        renderFocusRun();
        const shown = document.getElementById('focus-countdown').textContent;
        focusData = saved;
        renderFocusRun();
        return { before, shown, restored: document.getElementById('focus-countdown').textContent };
      })()`);
      check(!/NaN/.test(rendered.shown), '★ 走完整条渲染路径也画不出 NaN', true,
        ` → 坏数据下显示 “${rendered.shown}”`);
      check(!/NaN/.test(rendered.restored), '恢复好数据后显示正常', false,
        ` → “${rendered.restored}”`);
      // 负对照：证明这个断言真的能红 —— 用旧的写法算一遍
      const oldStyle = String(Math.ceil(undefined / 1000));
      check(oldStyle.includes('NaN'),
        '★ 负对照：旧写法（直接 Math.ceil(ms/1000)）确实会产出 NaN（说明这条断言不是装饰）', true,
        ` → Math.ceil(undefined/1000) = “${oldStyle}”`);
    }

    // ================= 14. 收尾 =================
    console.log('\n14. 收尾');
    check(errors.length === 0, '没有意外的渲染进程报错：' + errors.join(';'));

    if (process.argv.includes('--screenshots') && fail === 0) {
      const fs = require('fs');
      const out = path.join(root, 'outputs');
      // ★ 截图前把状态摆成「正常专注中」的干净样子：
      //   ① 清掉前面测试留下的错误横幅（不然截图里永远挂着一条红字）
      //   ② 会话必须有真实的 startedAt/endsAt（否则倒计时会显示 NaN:NaN）
      await js(`(() => {
        document.getElementById('focus-error').classList.add('hidden');
        document.getElementById('focus-error').textContent = '';
        document.getElementById('focus-stop-hint').textContent = '';
        return true; })()`);
      stopResult = { ok: true };
      state.running = true;
      state.session = {
        state: 'running', minutes: 25,
        startedAt: Date.now(), endsAt: Date.now() + 25 * 60 * 1000,
      };
      await js('loadFocus()');
      await wait(500);
      const capture = async (file) => {
        await wait(300);
        fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG());
      };
      await capture('v4-stop-idle.png');
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:9 }))`);
      await wait(1800);
      await capture('v4-stop-half.png');
      await js(`document.getElementById('btn-focus-stop').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:9 }))`);
      await wait(500);
      await capture('v4-stop-released.png');
      // 顺带出一张「整页顶部」的图，让主人看到专注页整体的打磨效果
      await js(`document.getElementById('focus-page').scrollTop = 0`);
      await js(`(() => { document.getElementById('focus-stop-hint').textContent = ''; return true; })()`);
      await wait(400);
      fs.writeFileSync(path.join(out, 'v4-focus-page-top.png'), (await win.webContents.capturePage()).toPNG());
      console.log('PREVIEWS: outputs/v4-stop-{idle,half,released}.png + outputs/v4-focus-page-top.png');
    }
  }).catch((err) => { fail++; console.error(err.stack); }).finally(() => {
    console.log(`Negative controls: ${neg - negFail}/${neg}`);
    console.log(`FOCUS-STOP RESULT: ${pass} passed / ${fail} failed`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(fail ? 1 : 0);
  });
}
