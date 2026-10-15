// src/main/selftest-chat.js
// Task 13 · 聊天端到端自检

const chatWindow = require('./chat-window');
const schedules = require('./schedules');
const aiConfig = require('./ai-config');
const { placeNear } = require('./place');

module.exports = {
  async run(ctx) {
    const { win: petWin, log, ok, finish, sleep, settingsWindow } = ctx;
    log('===== 聊天自检开始 =====');

    let pass = 0;
    let fail = 0;
    let negPass = 0;
    let negFail = 0;
    // 第 3 个参数是「这是负对照」的标志（不是附加说明文本）
    const localOk = (cond, label, isNeg = false) => {
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

    // 说明：`--isolated` 已经把整个 userData 指到临时目录，
    // 所以自检写进去的聊天记录和日程都不会碰主人的真实数据，这里不用额外处理。

    // ① 打开聊天条
    log('\n① 打开聊天条');
    chatWindow.open();
    await sleep(900);
    const cw = chatWindow.getWindow();
    localOk(!!cw && cw.isVisible(), '聊天条窗口真的可见');
    if (cw) {
      const b = cw.getBounds();
      localOk(b.width >= 318 && b.width <= 322, `窗口宽度 ≈ 320（实际 ${b.width}）`);
      localOk(b.height >= 438 && b.height <= 442, `窗口高度 ≈ 440（实际 ${b.height}）`);

      // 位置贴着桌宠
      const petRect = petWin.getBounds();
      const display = require('electron').screen.getDisplayMatching(petRect);
      const expected = placeNear(petRect, { w: 320, h: 440 }, display.workArea);
      const dx = Math.abs(b.x - expected.x);
      const dy = Math.abs(b.y - expected.y);
      localOk(dx <= 8 && dy <= 8, `位置贴着桌宠（偏差 ${dx},${dy}）`);
    }

    if (!cw || cw.isDestroyed()) {
      log('✗ 聊天条没开出来，后面没法测');
      return finish(pass, fail + 1, '聊天');
    }

    const web = cw.webContents;

    // ⚠ 所有 executeJavaScript 都必须包在 IIFE 里。
    //   原因：Electron 的 executeJavaScript 是在**同一个全局作用域**里求值的，
    //   第二次写 `const ta = ...` 会报「Identifier 'ta' has already been declared」，
    //   脚本直接失败。第一次能过、第二次就炸，非常隐蔽。
    // 辅助：在输入框里打字并发送
    async function send(text) {
      await web.executeJavaScript(`(() => {
        const ta = document.getElementById('input');
        ta.value = ${JSON.stringify(text)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send').click();
        return true;
      })()`);
    }

    // 辅助：读消息列表
    async function msgCount() {
      return web.executeJavaScript(`document.querySelectorAll('.msg').length`);
    }

    // 辅助：读最后一条某类消息的文本
    async function lastText(sel) {
      return web.executeJavaScript(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(sel)});
        return el.length ? el[el.length - 1].textContent : '';
      })()`);
    }

    // ② 端到端加日程
    log('\n② 端到端加日程');
    const beforeCount = schedules.list().length;
    await send('30分钟后提醒我收衣服');
    await sleep(900);

    const msgs = await msgCount();
    localOk(msgs >= 2, `消息列表至少 2 条（实际 ${msgs} 条）`);

    const afterItems = schedules.list();
    const added = afterItems.find((it) => it.title === '收衣服');
    localOk(!!added, '主进程 schedules.list() 里真的多了「收衣服」');
    if (added) {
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const tMin = parseInt(added.time.split(':')[0], 10) * 60 + parseInt(added.time.split(':')[1], 10);
      const diff = Math.abs(tMin - ((nowMin + 30) % 1440));
      localOk(diff <= 2, `时间 ≈ 当前+30 分钟（偏差 ${diff} 分钟）`);
    }

    // 回复里带复述
    const replyText = await lastText('.msg.fish');
    localOk(replyText.includes('收衣服'), '回复文本里带「收衣服」');

    // ③ 负对照：今天天气不错 → 条数不变
    log('\n③ 负对照：听不出日程时不瞎建');
    const beforeNoOp = schedules.list().length;
    await send('今天天气不错');
    await sleep(700);
    const afterNoOp = schedules.list().length;
    localOk(afterNoOp === beforeNoOp, '条数没变（没瞎建）', true);

    // ④ 负对照：有触发词没时刻 → 反问
    log('\n④ 负对照：有触发词没时刻 → 反问');
    const beforeAsk = schedules.list().length;
    await send('提醒我一下');
    await sleep(700);
    const afterAsk = schedules.list().length;
    localOk(afterAsk === beforeAsk, '条数没变', true);
    const askReply = await lastText('.msg.fish');
    localOk(askReply.includes('几点'), '回复里带「几点」反问', true);

    // ⑤ 撤销
    log('\n⑤ 撤销');
    if (added) {
      // 点「撤销」按钮
      await web.executeJavaScript(`(() => {
        const btn = document.querySelector('.undo-btn');
        if (btn) btn.click();
        return true;
      })()`);
      await sleep(400);
      const afterUndo = schedules.list().length;
      localOk(afterUndo === beforeCount, '撤销后条数变回原来');
    } else {
      log('  （跳过撤销：前面没建成功）');
    }

    // ⑥ 负对照：Key 不泄漏 + 降级
    log('\n⑥ 负对照：Key 不泄漏 + 降级');
    const origKey = aiConfig.read().apiKey;
    aiConfig.write({ baseUrl: 'http://127.0.0.1:59999', apiKey: 'sk-SECRET-1234', model: 'x', enabled: true });
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    await send('测试泄漏');
    await sleep(700);
    console.log = origLog;
    const leakText = (await web.executeJavaScript(`document.body.innerText`)) + '\n' + logs.join('\n');
    localOk(!leakText.includes('SECRET'), '聊天记录和日志里都不出现 SECRET', true);
    // 恢复配置
    aiConfig.write({ baseUrl: '', apiKey: origKey, model: '', enabled: false });

    // ⑦ 负对照：XSS
    log('\n⑦ 负对照：XSS 不执行');
    const xssPayload = '<img src=x onerror="window.__xss=1">';
    await send(xssPayload);
    await sleep(700);
    const lastMsg = await lastText('.msg.me');
    localOk(lastMsg === xssPayload, '消息 textContent 是原样字符', true);
    const hasImg = await web.executeJavaScript(`document.querySelectorAll('img').length`);
    localOk(hasImg === 0, '页面里找不到 img 元素', true);
    const xssTriggered = await web.executeJavaScript(`typeof window.__xss === 'undefined'`);
    localOk(xssTriggered, 'window.__xss 未定义（onerror 没执行）', true);

    // ⑧ 清理
    log('\n⑧ 清理自检数据');
    const titles = ['收衣服'];
    for (const t of titles) {
      const it = schedules.list().find((x) => x.title === t);
      if (it) schedules.remove(it.id);
    }
    const remain = schedules.list().filter((it) => titles.includes(it.title));
    localOk(remain.length === 0, '自检日程已清掉');

    chatWindow.close();

    log(`\n===== 聊天自检结束：${pass} 通过 / ${fail} 失败 =====`);
    log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
    // ⚠ 必须传 label：`finish` 就是 finishExitTest，不传就默认写「退出按钮自检结束」——
    //   于是聊天/专注模式跑完，日志上却写着「退出按钮」，查问题时会看错套件。
    finish(pass, fail, '聊天');
  },
};
