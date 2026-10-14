// src/main/selftest-focusmode.js
// 阶段 3 · Task 5 · 专注模式端到端自检（第一段地基的验收）
//
// 和 selftest-week.js / selftest-chat.js 一样自成一体，所以单独一个文件。
//
// ── 这一段测什么 ──
//   从**界面**走一遍完整流程（点按钮、填输入框，不是直接调函数），
//   再回过头问主进程和桌宠渲染进程「你们那边真的变了吗」。
//   只验「界面显示对了」不算证据 —— 界面假装显示对了也能骗过测试。
//
// ── 为什么叫 focusmode 而不是 focus ──
//   `--selftest=focus` 已经被「桌宠不抢焦点」那个自检占了（见 PLAN-V3 命名冲突一节）。
//
// ── ★ 关于「碰系统」这件事 ──
//   自检时 main.js 会把专注模块切到**沙箱模式**：hosts 指向 userData 里的假文件、
//   而且不提权。所以这一段能验到「真的改了 hosts / 真的还原了」这整条链，
//   却**不会弹 UAC、不会碰主人的真实 hosts**。
//   剩下真正只能真机验的就两件事：UAC 弹窗本身、以及网站是不是真的打不开了。
//
// ── ⚠ 为什么整段包在 try 里 ──
//   自检**自己出错也必须有结论**。曾经没包：第 ④⑤ 步故意失败后，第 ⑥ 步读到
//   session 是 null 就抛异常，整个自检卡死 —— 既不打印结论也不退出，
//   只能等外部超时杀掉，现象是「跑了很久什么都没输出」，根本查不出哪儿错了。

const fs = require('fs');
const path = require('path');
const hosts = require('./focus/hosts');

module.exports = {
  async run(ctx) {
    const { win: petWin, log, finish, sleep, settingsWindow, focus, focusNotice, reminder } = ctx;
    log('===== 专注模式自检开始（阶段 3 · Task 5 · 地基版）=====');

    let pass = 0;
    let fail = 0;
    let negPass = 0;
    let negFail = 0;
    // 第 3 个参数是「这是负对照」的标志（不是附加说明文本）
    const ok = (cond, label, isNeg = false) => {
      if (cond) {
        pass++;
        if (isNeg) negPass++;
        log(`  ✓ ${label}`);
      } else {
        fail++;
        if (isNeg) negFail++;
        log(`  ✗ ${label}  ← 失败`);
      }
    };

    // 桌宠渲染进程里的专注状态（读它才是「宠物真的换姿态了」的证据）
    const petFocusState = async () => {
      try {
        return await petWin.webContents.executeJavaScript(
          `(window.__petDebug && window.__petDebug.focus) ? window.__petDebug.focus.state() : null`
        );
      } catch {
        return null;
      }
    };
    const petMode = async () => {
      try {
        return await petWin.webContents.executeJavaScript(
          `window.__petState ? window.__petState.mode : null`
        );
      } catch {
        return null;
      }
    };

    try {
      // ===== ⓪ 干净起点 =====
      // `--isolated` 已经把 userData 指到临时目录，不会碰主人的真实数据。
      focus.stop('selftest-reset');
      focus.setBlacklist({ domains: [], exes: [] });

      // 沙箱用的假 hosts。自检期间「改 hosts / 还原 hosts」这条链就落在它身上。
      const hostsPath = focus.hostsPath();
      const readHosts = () => {
        try { return fs.readFileSync(hostsPath).toString('latin1'); } catch { return null; }
      };
      const hostsBefore = readHosts();
      log(`沙箱 hosts：${hostsPath}`);
      ok(hostsPath !== 'C:\\Windows\\System32\\drivers\\etc\\hosts',
        '★ 自检的 hosts 指向假文件，绝不是系统真实 hosts');
      ok(typeof hostsBefore === 'string' && hostsBefore.length > 0, '沙箱 hosts 有初始内容');

      // ===== ① 打开设置窗口的「专注」页 =====
      log('\n① 打开设置窗口 → 专注页');
      settingsWindow.open('focus');
      await sleep(1000);

      const sw = settingsWindow.getWindow();
      ok(!!sw && !sw.isDestroyed(), '设置窗口开出来了');
      if (!sw || sw.isDestroyed()) {
        log('✗ 窗口没开出来，后面没法测');
        finish(pass, fail + 1, '专注模式');
        return;
      }
      await new Promise((r) => {
        if (!sw.webContents.isLoading()) return r();
        sw.webContents.once('did-finish-load', r);
      });
      await sleep(500);

      const pageOk = await sw.webContents.executeJavaScript(`(() => ({
        pageShown: !document.getElementById('focus-page').classList.contains('hidden'),
        hasStart: !!document.getElementById('btn-focus-start'),
      }))()`);
      ok(pageOk.pageShown === true, '★ 专注页真的打开了');
      ok(pageOk.hasStart === true, '专注页上有「开始专注」按钮');

      // ===== ② ★ 负对照：黑名单空着点「开始专注」→ 被拒 =====
      log('\n② ★ 负对照：黑名单空着点「开始专注」→ 被拒');
      await sw.webContents.executeJavaScript(`(async () => {
        document.getElementById('btn-focus-start').click();
        await new Promise((r) => setTimeout(r, 500));
      })()`);
      ok(focus.state().session === null, '主进程那边没开始（state 还是「未专注」）', true);
      ok((await petMode()) === 'idle', '★ 桌宠也还停在常态（没有「专注了个寂寞」）', true);

      // ===== ③ 走界面开始一次 1 分钟的专注 =====
      log('\n③ 加一个网站 + 选 1 分钟 + 点「开始专注」');
      const started = await sw.webContents.executeJavaScript(`(async () => {
        // 加一条网站（粘的是完整网址，要洗成域名）
        const input = document.getElementById('f-domain-input');
        input.value = 'https://www.bilibili.com/video/xxx';
        document.getElementById('btn-add-domain').click();
        await new Promise((r) => setTimeout(r, 400));

        // 选「自定义」→ 填 1 分钟 → 用这个
        const custom = [...document.querySelectorAll('#focus-presets button')]
          .find((x) => x.dataset.minutes === 'custom');
        if (custom) custom.click();
        await new Promise((r) => setTimeout(r, 150));
        document.getElementById('f-custom-min').value = '1';
        document.getElementById('btn-custom-ok').click();
        await new Promise((r) => setTimeout(r, 400));

        document.getElementById('btn-focus-start').click();
        await new Promise((r) => setTimeout(r, 700));

        return {
          domains: [...document.querySelectorAll('#focus-domains .focus-val')].map((x) => x.textContent),
          runningShown: !document.getElementById('focus-running').classList.contains('hidden'),
          countdown: document.getElementById('focus-countdown').textContent.trim(),
        };
      })()`);

      const st1 = focus.state();
      ok(started.domains.includes('www.bilibili.com'), '界面上黑名单里有洗干净的 www.bilibili.com',
        ` → ${JSON.stringify(started.domains)}`);
      ok(st1.session !== null && st1.session.state === 'running', '★ 主进程那边真的开始了一个会话',
        ` → ${st1.session ? st1.session.state : 'null'}`);
      ok(!!st1.session && st1.session.minutes === 1, '★ 时长就是选的 1 分钟',
        ` → ${st1.session ? st1.session.minutes : '?'} 分钟`);
      ok(started.runningShown === true, '界面上切到了倒计时的样子', ` → “${started.countdown}”`);

      // ★ 桌宠：真的收到并换姿态了（不是「我发了」而是「它收到了」）
      await sleep(500);
      const petFocus = await petFocusState();
      ok((await petMode()) === 'focus', '★ 桌宠的状态变成了「专注中」（__petState.mode === focus）');
      ok(!!petFocus && petFocus.badgeVisible === true, '★ 桌宠身上出现了「专注中」的剩余时间角标',
        petFocus ? ` → 角标“${petFocus.badgeText}”` : '');
      ok(!!petFocus && /^\d{2}:\d{2}$/.test(petFocus.badgeText || ''), '角标上是 MM:SS 的倒计时',
        petFocus ? ` → “${petFocus.badgeText}”` : '');
      ok(!!petFocus && typeof petFocus.sayText === 'string' && petFocus.sayText.includes('陪'),
        '★ 桌宠说了一句陪伴的话', petFocus ? ` → “${petFocus.sayText}”` : '');
      ok(!!petFocus && petFocus.hits >= 1, '桌宠那边确实收到了「专注开始」事件（计数 ≥1）',
        petFocus ? ` → 收到 ${petFocus.hits} 次` : '');

      // ===== ③b 拦截链：hosts 真的被改了（Task 7）=====
      // 这一段验的是「专注到底有没有在挡东西」——之前几轮它只验了「计时 + 陪伴」。
      log('\n③b 拦截链：hosts 里真的写进了屏蔽块吗');
      await sleep(300);
      const hostsDuring = readHosts();
      ok(typeof hostsDuring === 'string' && hosts.hasBlock(hostsDuring),
        '★ hosts 里真的出现了 FocusMode 标记块（不是「以为在挡」）');
      ok(typeof hostsDuring === 'string' && hostsDuring.includes('0.0.0.0 www.bilibili.com'),
        '★ 要挡的域名真的写进去了');
      ok(!!hostsBefore && typeof hostsDuring === 'string' && hostsDuring.includes(hostsBefore),
        '★ 主人原有的 hosts 内容一行没少（我们只往后追加）', true);
      ok(typeof hostsDuring === 'string' && hosts.blockedDomains(hostsDuring).length === 1,
        '★ 块里就一个域名（没把别的也带进去）');

      // ★ 负对照：黑名单里没有的域名不许出现
      ok(typeof hostsDuring === 'string' && !hostsDuring.includes('zhihu.com'),
        '★ 没加进黑名单的域名没有被误挡', true);

      // ===== ④ ★ 负对照：按下 1 秒就松手 → 必须还在专注中 =====
      log('\n④ ★ 负对照：长按不足 3 秒就松手 → 结束不了');
      await sw.webContents.executeJavaScript(`(async () => {
        const btn = document.getElementById('btn-focus-stop');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 1000));   // 只按 1 秒
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
      })()`);
      ok(focus.state().session !== null, '★ 松手太早 → 还在专注中（界面没放行）', true);
      ok((await petMode()) === 'focus', '★ 桌宠也还在陪着她', true);

      // ===== ⑤ ★ 负对照（主进程这一层）：按下 1 秒就要求结束 → 被拒 =====
      // ④ 验的是「界面没放行」，这一条验的是「就算绕过界面，主进程也不认」——
      // 长按规则只有一处（timer.canExit）。
      log('\n⑤ ★ 负对照：直接让主进程结束（只按了 1 秒）→ 被拒');
      const tooEarly = focus.requestStop({ pressedAt: Date.now() - 1000 });
      ok(tooEarly.ok === false, '★ 主进程拒绝了「只按 1 秒」的结束请求', true);
      ok(focus.state().session !== null, '★ 会话还在（没被偷偷结束）', true);
      log(`    （拒绝理由：“${tooEarly.error}”）`);

      // ===== ⑥ ★ 负对照：专注中再点一次「开始专注」→ 不许重置计时 =====
      log('\n⑥ ★ 负对照：专注中再点一次「开始专注」→ 不重置计时');
      // ⚠ 不直接写 `.session.endsAt` —— 前面几步若已把会话结束掉，这里会抛异常把自检卡死。
      //   取不到就当断言失败（这正是负对照该有的表现）。
      const sessBefore = focus.state().session;
      const endsBefore = sessBefore ? sessBefore.endsAt : null;
      await sw.webContents.executeJavaScript(`(async () => {
        document.getElementById('btn-focus-start').click();
        await new Promise((r) => setTimeout(r, 400));
      })()`);
      const sessAfter = focus.state().session;
      ok(!!sessBefore && !!sessAfter && sessAfter.endsAt === endsBefore,
        '★ 结束时刻没被重置（没有「再点一次就重新计时」）', true);

      // ===== ⑦ 长按满 3 秒 → 真的结束 =====
      log('\n⑦ 长按满 3 秒 → 结束');
      await sw.webContents.executeJavaScript(`(async () => {
        const btn = document.getElementById('btn-focus-stop');
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 3400));   // 按够 3 秒（多给 0.4 秒余量）
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
      })()`);
      ok(focus.state().session === null, '★ 按够 3 秒 → 真的结束了（state 回到「未专注」）');
      await sleep(400);
      ok((await petMode()) === 'idle', '★ 桌宠也回到了常态（角标收起来）');
      const petAfter = await petFocusState();
      ok(!!petAfter && petAfter.badgeVisible === false, '★ 桌宠的专注角标确实收起来了',
        petAfter ? ` → badgeVisible=${petAfter.badgeVisible}` : '');

      // ===== ⑦b 拦截链：hosts 真的还原了 =====
      // ★ 这是整段自检里最要紧的一条 —— 如果还原不了，
      //   主人的网站会一直打不开，而且是永久性的。
      log('\n⑦b 拦截链：专注结束后 hosts 还原了吗');
      await sleep(600);
      const hostsAfter = readHosts();
      ok(typeof hostsAfter === 'string' && !hosts.hasBlock(hostsAfter),
        '★ hosts 里的标记块没了（网站能重新打开了）');
      ok(!!hostsBefore && hostsAfter === hostsBefore,
        '★ hosts 和开始之前**逐字节相同**（主人原有内容一字不差）');
      ok(hosts.blockedDomains(hostsAfter || '').length === 0,
        '★ 没有任何残留的屏蔽域名');

      // ===== ⑦c 禁软件：要关掉的程序真的进了计划文件吗（Task 8）=====
      // 前面 ③b/⑦b 验的是「网站」那条链。这一段验「软件」那条链 ——
      // 而它和网站那条链有个根本区别：**网站是改一个文件，软件是杀进程**。
      // 杀错了不可逆（桌面没了、系统崩了），所以「交给助手的名单」必须被真的看一眼。
      //
      // 计划文件（focus-plan.json）是「主进程 → 助手」唯一的契约：
      // 主进程把要关的程序写进去，助手读出来**无条件照杀**。
      // 所以这里不看内存里的变量，直接读那个文件 —— 序列化错了也算数。
      log('\n⑦c 禁软件：交给助手的名单（读真的计划文件）');
      {
        const planPath = focus.planPath();
        const cfgPath = path.join(path.dirname(planPath), 'focus.json');
        const readPlan = () => {
          try { return JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch { return null; }
        };
        const danger = ['electron.exe', 'explorer.exe', 'node.exe', 'csrss.exe', 'lsass.exe'];

        // ---- 第一段：一份正常名单，应该原样进计划文件 ----
        const set1 = focus.setBlacklist({ domains: ['example.com'], exes: ['notepad.exe', 'steam.exe'] });
        ok(set1.ok === true, '设好黑名单（notepad.exe + steam.exe）');
        const r1 = await focus.start({ minutes: 1 });
        ok(r1.ok === true, '★ 专注开始成功', ` → ${r1.error || 'ok'}`);
        await sleep(300);

        const p1 = readPlan();
        ok(!!p1, '★ 计划文件真的被写出来了（主进程和助手的唯一契约）',
          ` → ${planPath}`);
        ok(!!p1 && Array.isArray(p1.exes),
          '★ 计划文件里的 exes 是**数组**（不是字符串 —— 助手侧就靠这个判断）',
          p1 ? ` → ${JSON.stringify(p1.exes)}` : '');
        ok(!!p1 && Array.isArray(p1.exes) && p1.exes.length === 2
          && p1.exes.includes('notepad.exe') && p1.exes.includes('steam.exe'),
          '★ 要关的两个程序都进了计划文件', p1 ? ` → ${JSON.stringify(p1.exes)}` : '');
        ok(!!p1 && p1.mode === 'session', '★ mode 是 session（正常专注，不是一次性清理）',
          p1 ? ` → ${p1.mode}` : '');
        ok(!!p1 && p1.hostsPath === hostsPath,
          '★ 计划文件里的 hosts 路径就是沙箱假文件（没指到系统真实 hosts）', true);

        focus.stop('selftest-task8');
        await sleep(400);

        // ---- 第二段：★ 负对照 —— 直接手改 focus.json，塞进危险项 ----
        // 这才是真正的威胁模型：界面会拒收，但 focus.json 就是磁盘上一个普通文件，
        // 谁都能改（或者某个 bug 写坏了它）。所以这里**绕过界面**，直接把脏数据写进文件。
        //
        // 断言的是最终结果：**不管哪一道闸拦下的，到助手手里的名单里都没有危险项**。
        // （目前 upstream 的 withDefaults 就会筛一遍，killListOf 是再加一道；
        //   这里不假装能分辨是哪一道拦的 —— 要验的就是「结果安全」。）
        log('   ★ 负对照：绕过界面，直接把 electron.exe / explorer.exe 写进 focus.json');
        {
          const dirty = {
            domains: ['example.com'],
            exes: ['notepad.exe', 'electron.exe', 'explorer.exe', 'node.exe', 'csrss.exe'],
            presets: [25],
            lastMinutes: 25,
            session: null,
          };
          fs.writeFileSync(cfgPath, JSON.stringify(dirty, null, 2), 'utf8');
          const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          ok(onDisk.exes.includes('electron.exe'),
            '★ 脏数据确实写进磁盘了（负对照的前提成立，不是「没塞进去所以过了」）', true);

          const r2 = await focus.start({ minutes: 1 });
          ok(r2.ok === true, '★ 脏数据下专注照样能开始（不许因为一个坏条目就起不来）',
            ` → ${r2.error || 'ok'}`);
          await sleep(300);

          const p2 = readPlan();
          ok(!!p2 && Array.isArray(p2.exes) && p2.exes.length === 1 && p2.exes[0] === 'notepad.exe',
            '★★ 计划文件里只剩 notepad.exe（危险项一个都没进）',
            p2 ? ` → ${JSON.stringify(p2.exes)}` : '');
          ok(!!p2 && Array.isArray(p2.exes) && !p2.exes.some((x) => danger.includes(x)),
            '★★ 计划文件里没有任何「碰不得」的程序（助手拿到它就照杀，这是最后一道闸）', true);

          focus.stop('selftest-task8');
          await sleep(400);
        }

        focus.setBlacklist({ domains: [], exes: [] });
        ok(focus.state().session === null, '这一段结束后没有残留会话');
        ok(focus.state().exes.length === 0, '名单也清干净了');
      }

      // ===== ⑧ 拦截提示窗口（Task 9）=====
      // 这个窗口和提醒气泡的**焦点策略正好相反**：
      //   气泡 focusable:false + showInactive()（顺口说一声，不打断打字）；
      //   提示窗口 focusable:true + show()（要主人停下来看一眼、做个选择）。
      // 所以这一段的核心是一条**负对照**：两个窗口的 focusable 必须不一样 ——
      //   防的是「有人把窗口参数照抄串了」，那会让提示被静默吞掉，
      //   主人以为屏蔽生效了、其实压根没看见（比不提示更坏）。
      log('\n⑧ 拦截提示窗口（Task 9）：focusable 必须和气泡相反');
      {
        const r = await focusNotice.notify({
          kind: 'warn',
          head: '专注可能没用',
          title: '自检提示：安全 DNS 开着',
          message: '这是自检造出来的一条提示，用来验证窗口行为。',
          primaryLabel: '仍要开始',
          secondaryLabel: '先去关掉',
        });
        ok(r && r.shown === true, '★ 提示真的弹出来了（notify 返回 shown:true）',
          r ? ` → ${JSON.stringify(r)}` : '');
        await sleep(300);

        const dn = await focusNotice.debugNotice();
        ok(dn.exists === true, '★ 提示窗口真的建出来了');
        ok(dn.visible === true, '★ 提示窗口真的可见（不是建了没显示）');
        ok(dn.focusable === true,
          '★★ 提示窗口 focusable === true（要主人看见并做选择，不能静默）',
          ` → ${dn.focusable}`);
        ok(!!dn.dom && dn.dom.title === '自检提示：安全 DNS 开着',
          '★ 卡片上的标题和传进去的一致（走 textContent，不是 innerHTML）',
          dn.dom ? ` → ${dn.dom.title}` : '');
        ok(!!dn.dom && dn.dom.warn === true, '★ kind=warn → 卡片是警示配色');
        ok(!!dn.dom && dn.dom.secondaryShown === true,
          '★ 两个按钮都在（secondaryLabel 非空时必须显示）');

        // ---- ★ 负对照：气泡窗口的 focusable 必须是 false，且和提示窗口不同 ----
        // 气泡只在桌宠露脸时才冒出来（它贴在桌宠旁边），所以先确认桌宠是可见的。
        if (petWin && !petWin.isDestroyed() && !petWin.isVisible()) petWin.showInactive();
        try {
          await reminder.present({ title: '自检气泡' }, new Date());
          await sleep(400);
        } catch (err) {
          log(`  （气泡没弹出来：${(err && err.message) || err}）`);
        }
        const db = await reminder.debugBubble();
        ok(db && db.exists === true, '★ 气泡窗口真的开出来了（负对照的前提成立）', true);
        ok(db && db.focusable === false,
          '★★ 负对照：气泡窗口 focusable === false（顺口说一声，不打断主人打字）', true);
        ok(dn.focusable !== (db && db.focusable),
          '★★ 负对照：两个窗口的 focusable 必须**不一样**（防参数照抄串了）', true);

        // ---- 收尾：点一下「仍要开始」，验证按钮回调真的把窗口收起来 ----
        // 自检里没有真的鼠标，直接触发渲染进程里的按钮点击（走的还是那条 IPC）。
        try {
          await focusNotice.getNoticeWindow().webContents.executeJavaScript(
            `(() => { const b = document.getElementById('btn-primary'); if (b) b.click(); return true; })()`
          );
          await sleep(300);
        } catch (err) {
          log(`  （点按钮出错：${(err && err.message) || err}）`);
        }
        ok(focusNotice.isShowing() === false, '★ 点了「仍要开始」→ 提示窗口收起来了');
        reminder.hideBubble('selftest');
        await sleep(200);
      }

      // ===== ⑨ 清理 =====
      log('\n⑨ 清理');
      focus.setBlacklist({ domains: [], exes: [] });
      ok(focus.state().session === null, '没有残留的专注会话');
      ok(focus.state().domains.length === 0, '黑名单也清空了');

      settingsWindow.close();
      await sleep(300);
    } catch (err) {
      // 自检自己炸了也要有结论，不然现象就是「跑了很久什么都没输出」
      fail++;
      log(`  ✗ 自检中途出错：${(err && err.message) || err}  ← 失败`);
      if (err && err.stack) log(err.stack);
    }

    log(`\n===== 专注模式自检结束：${pass} 通过 / ${fail} 失败 =====`);
    log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
    finish(pass, fail, '专注模式');
  },
};
