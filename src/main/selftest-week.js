// src/main/selftest-week.js
// v2 · 周视图端到端自检（独立哨兵）
//
// 用法：npm run test:week-e2e
//       （= node scripts/start-dev.js --no-gpu --selftest=week --isolated）
//
// 要验的是「主人真的能看见一周的安排」，不是「我写了几个函数」：
//   七天对不对、每种重复规则摊到哪几天、时段是不是真的比时间点高、
//   来回切模式会不会越切越多。
//
// 判定原则（HANDOFF 第六节第 19 条的教训）：
//   ① 问主进程：weekData() 算出来的七天和方块
//   ② 问界面：DOM 里真的画出来了几块、多高
//   两边对得上才算数 —— 只看一边，界面假装画了也能骗过测试。
//
// ⚠ 桌宠是单实例程序，必须串行跑（start-dev.js 已经保证）。

// 复算「本周一」。刻意不 require week.js 之外的日期逻辑 —— 但这里为了
// 让断言里的期望值**独立于被测代码**，故意自己算一遍（不用 week.weekStartOf）。
function mondayOf(now) {
  const back = (now.getDay() + 6) % 7; // 周一 → 0，周日 → 6
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

function dayAt(monday, offset) {
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset);
}

async function run(ctx) {
  const { log, sleep, finish, settingsWindow, week, schedules } = ctx;

  log('===== 周视图自检开始（v2）=====');
  if (!ctx.win || ctx.win.isDestroyed()) { log('✗ 没有桌宠窗口'); return finish(0, 1, '周视图'); }

  let pass = 0;
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (cond) { pass++; log(`  ✓ ${label}${extra}`); }
    else { fail++; log(`  ✗ ${label}${extra}  ← 失败`); }
  };

  // ---------- ① 准备数据 ----------
  const now = new Date();
  const monday = mondayOf(now);
  const wedKey = schedules.localDateKey(dayAt(monday, 2));        // 本周三
  const nextWedKey = schedules.localDateKey(dayAt(monday, 9));    // 下周三
  const lastMonthKey = schedules.localDateKey(
    new Date(now.getFullYear(), now.getMonth() - 1, 16)           // 上个月某天
  );

  log('① 塞几条不同重复规则的日程');
  log(`   （本周一 ${schedules.localDateKey(monday)} · 本周三 ${wedKey} · 下周三 ${nextWedKey} · 上月 ${lastMonthKey}）`);

  // 先清掉可能残留的自检数据
  for (const it of schedules.list()) {
    if (it.title.startsWith('自检·')) schedules.remove(it.id);
  }

  const seeds = [
    { title: '自检·每天', kind: 'point', time: '08:00', repeat: 'daily' },
    { title: '自检·每周三', kind: 'point', time: '10:00', repeat: 'weekly', weekdays: [3] },
    { title: '自检·下周三', kind: 'point', time: '09:00', repeat: 'once', date: nextWedKey },
    { title: '自检·时段', kind: 'span', time: '14:00', endTime: '16:00', repeat: 'daily' },
    // ★ 负对照：上个月的一次性日程 —— 它在周视图上必须**一条都不出现**
    { title: '自检·上个月', kind: 'point', time: '11:00', repeat: 'once', date: lastMonthKey },
  ];
  let seedFailed = null;
  for (const s of seeds) {
    const r = schedules.add(s);
    if (r && r.error) seedFailed = `${s.title}: ${r.error}`;
  }
  ok(!seedFailed, '五条自检日程都塞进去了', seedFailed ? ` → ${seedFailed}` : '');

  // ---------- ② 打开设置窗口 → 切到周视图 ----------
  log('② 打开日程管理窗口，点「周视图」');
  const sw = settingsWindow.open();
  if (!sw) { log('✗ 设置窗口没开出来'); return finish(pass, fail + 1, '周视图'); }

  await new Promise((r) => {
    if (!sw.webContents.isLoading()) return r();
    sw.webContents.once('did-finish-load', r);
  });
  await sleep(400);

  const toggled = await sw.webContents.executeJavaScript(`(async () => {
    const btn = document.getElementById('btn-week');
    if (!btn) return { missingBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      weekShown: !document.getElementById('week').classList.contains('hidden'),
      listHidden: document.querySelector('.list-wrap').classList.contains('hidden'),
    };
  })()`);
  ok(!toggled.missingBtn, '工具栏上有「周视图」按钮');
  ok(toggled.weekShown === true && toggled.listHidden === true, '周视图展开了、列表收起来了');

  // ---------- ③ 主进程算出来的七天对不对 ----------
  log('③ 问主进程：这一周怎么摊');
  const data = settingsWindow.weekData();
  ok(!!data && Array.isArray(data.days), '主进程算出了周视图数据');

  if (!data || !Array.isArray(data.days)) {
    log('✗ 拿不到周视图数据，后面没法测');
    for (const it of schedules.list()) if (it.title.startsWith('自检·')) schedules.remove(it.id);
    return finish(pass, fail + 1, '周视图');
  }

  // 交叉验证：我自己算的「本周一」和 week.js 算的对不对得上。
  // 两套是独立写的，对不上就说明其中一套错了（也防止自检的期望值本身算错）。
  ok(schedules.localDateKey(week.weekStartOf(now)) === schedules.localDateKey(monday),
    '★ 两套独立算法对「本周一是哪天」的判断一致',
    ` → week.js ${schedules.localDateKey(week.weekStartOf(now))} / 自检 ${schedules.localDateKey(monday)}`);

  ok(data.days.length === 7, `★ 正好七天（实际 ${data.days.length} 天）`);
  ok(data.days[0].label === '周一' && data.days[6].label === '周日',
    '★ 第一天是周一、最后一天是周日（周日不能被算成下一周的开头）',
    ` → ${data.days.map((d) => d.label).join(' / ')}`);

  // 某条日程这一周出现了几天
  const daysWith = (title) => data.days.filter((d) => d.blocks.some((b) => b.title === title)).length;

  ok(daysWith('自检·每天') === 7, `★ 「每天」那条七天都在（实际 ${daysWith('自检·每天')} 天，不能只有 1 天）`);
  ok(daysWith('自检·每周三') === 1, `★ 「每周三」那条只出现 1 天（实际 ${daysWith('自检·每周三')} 天）`);
  ok(data.days[2].blocks.some((b) => b.title === '自检·每周三'),
    '★ 而且正好落在第 3 列（周三）',
    ` → 第 3 列是 ${data.days[2].label}`);
  ok(daysWith('自检·下周三') === 0, `★ 下周三的一次性日程，本周一天都不该出现（实际 ${daysWith('自检·下周三')} 天）`);
  ok(daysWith('自检·上个月') === 0, `★ 负对照：上个月的一次性日程，也不能凭空冒出来（实际 ${daysWith('自检·上个月')} 天）`);

  // ---------- ④ 界面上真的画出来了吗 ----------
  log('④ 问界面：DOM 里画了几块、多高');
  const dom = await sw.webContents.executeJavaScript(`(() => {
    const cols = [...document.querySelectorAll('#week-grid .day-col')];
    const blks = [...document.querySelectorAll('#week-grid .blk')];
    const boxOf = (title) => {
      const b = blks.find((x) => {
        const t = x.querySelector('.blk-title');
        return t && t.textContent === title;
      });
      return b ? { h: Math.round(b.offsetHeight), top: Math.round(b.offsetTop) } : null;
    };
    return {
      colCount: cols.length,
      blkCount: blks.length,
      span: boxOf('自检·时段'),
      point: boxOf('自检·每天'),
    };
  })()`);

  const mainTotal = data.days.reduce((n, d) => n + d.blocks.length, 0);
  ok(dom.colCount === 7, `★ 界面上就是七列（实际 ${dom.colCount} 列）`);
  ok(dom.blkCount === mainTotal,
    `★ 界面上的方块数 === 主进程算出来的方块数（两边对得上才算数）`,
    ` → 界面 ${dom.blkCount} 块 / 主进程 ${mainTotal} 块`);

  // ★ 这条是「时段用高的长方体、时间点用扁的」这条需求的唯一证据
  ok(!!dom.span && !!dom.point, '界面上找得到「自检·时段」和「自检·每天」两块',
    ` → ${JSON.stringify(dom.span)} / ${JSON.stringify(dom.point)}`);
  ok(!!dom.span && !!dom.point && dom.span.h > dom.point.h,
    '★ 时段那一块比时间点那一块高（时段是长方体、时间点是扁条）',
    ` → ${dom.span && dom.span.h}px vs ${dom.point && dom.point.h}px`);

  // ---------- ⑤ 负对照：来回切模式不能越切越多 ----------
  log('⑤ ★ 负对照：切回列表再切回周视图，方块不能越切越多');
  const snapshot = () => sw.webContents.executeJavaScript(`(() => {
    const cols = [...document.querySelectorAll('#week-grid .day-col')];
    return cols.flatMap((col, ci) => [...col.querySelectorAll('.blk')].map((b) => {
      const t = b.querySelector('.blk-title');
      return ci + '|' + (t ? t.textContent : '?') + '|' + Math.round(b.offsetTop) + '|' + Math.round(b.offsetHeight);
    })).sort().join(' ;; ');
  })()`);

  const before = await snapshot();
  await sw.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-week').click();
    await new Promise((r) => setTimeout(r, 800));
    document.getElementById('btn-week').click();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  const after = await snapshot();
  const afterCount = after ? after.split(' ;; ').filter(Boolean).length : 0;

  ok(afterCount === dom.blkCount,
    '★ 负对照：切回列表再切回周视图，方块数量没变（不是越切越多）',
    ` → ${dom.blkCount} 块 → ${afterCount} 块`);
  ok(after === before,
    '★ 负对照：每个方块的位置和高度都一模一样（重画是幂等的）');

  // ---------- ⑥ 清理 ----------
  log('⑥ 清理自检数据');
  for (const it of schedules.list()) {
    if (it.title.startsWith('自检·')) schedules.remove(it.id);
  }
  ok(schedules.list().every((it) => !it.title.startsWith('自检·')),
    '★ 文件里没有 title 以「自检·」开头的记录了');

  finish(pass, fail, '周视图');
}

module.exports = { run };
