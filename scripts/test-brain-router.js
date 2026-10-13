// scripts/test-brain-router.js
// Task 10 · 大脑路由器自检
//
// 用法：npm run test:brain-router

const router = require('../src/main/brain/index');
const schedules = require('../src/main/schedules');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
let negPass = 0;
let negFail = 0;
function ok(cond, label, isNeg = false) {
  if (cond) {
    pass++;
    if (isNeg) negPass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    if (isNeg) negFail++;
    console.log(`  ✗ ${label}  ← 失败`);
  }
}
function section(t) { console.log(`\n${t}`); }

const NOW = new Date(2026, 9, 12, 15, 12, 0);

// ---------- 假大脑工厂 ----------
function makeLocal(overrides) {
  return {
    respond: () => ({
      reply: '本地回复',
      draft: null,
      intent: 'chat',
      confidence: 'low',
      ...overrides,
    }),
  };
}

function makeCloud(overrides) {
  let callCount = 0;
  const brain = {
    isConfigured: () => true,
    configure: () => {},
    respond: async () => {
      callCount++;
      return { reply: '云端回复', draft: null, ...overrides };
    },
    getCallCount: () => callCount,
  };
  return brain;
}

// ---------- 用例 ----------
async function run() {
  // ① 本地高置信 → 直接本地，不问云端
  section('① 本地高置信 → 本地优先');
  {
    const cloud = makeCloud();
    const local = makeLocal({
      draft: { title: '收衣服', kind: 'point', time: '15:42', repeat: 'once', date: '2026-10-12' },
      confidence: 'high',
    });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('30分钟后提醒我收衣服', NOW);
    ok(r.source === 'local', 'source = local');
    ok(r.draft && r.draft.title === '收衣服', 'draft 存在');
    ok(cloud.getCallCount() === 0, '★ 云端一次都没被调用', true);
    ok(r.note === null, '正常路径 note 为 null', true);
  }

  // ② 本地低置信 → 必须问云端
  section('② 本地低置信 → 去问云端（负对照）');
  {
    const cloud = makeCloud({
      draft: { title: '喝水', kind: 'point', time: '16:00', repeat: 'once', date: '2026-10-12' },
    });
    const local = makeLocal({ draft: { title: '喝水', kind: 'point', time: '16:00', repeat: 'once', date: '2026-10-12' }, confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('喝水', NOW);
    ok(cloud.getCallCount() === 1, '★ 云端被调用了 1 次', true);
    ok(r.source === 'cloud', '最终用了云端结果');
  }

  // ③ 云端返回幻觉草案（time='25:00'）→ draft=null，rejected 带原因
  section('③ 云端幻觉草案 → 被拒（负对照）');
  {
    const cloud = makeCloud({
      draft: { title: 'x', kind: 'point', time: '25:00', repeat: 'once', date: '2026-10-12' },
    });
    const local = makeLocal({ confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('x', NOW);
    ok(r.draft === null, 'draft 为 null', true);
    ok(r.rejected && r.rejected.length > 0, 'rejected 带人话原因');
    ok(!r.reply.includes('25:00'), '回复里不能出现 25:00');
  }

  // ④ 云端返回合法草案 → draft 非 null，且字段是 sanitize 洗过的
  section('④ 云端合法草案 → sanitize 洗过（负对照）');
  {
    const cloud = makeCloud({
      draft: { title: '开会', kind: 'point', time: '14:00', repeat: 'once', date: '2026-10-12' },
    });
    const local = makeLocal({ confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('开会', NOW);
    ok(r.draft !== null, 'draft 非 null', true);
    ok(Array.isArray(r.draft.weekdays), 'sanitize 把 weekdays 规范化成数组');
    ok(r.draft.createdAt > 0, 'sanitize 补了 createdAt');
  }

  // ⑤ 云端抛异常 → 降级本地
  section('⑤ 云端抛异常 → 降级（负对照）');
  {
    const cloud = {
      isConfigured: () => true,
      configure: () => {},
      respond: async () => { throw new Error('boom'); },
    };
    const local = makeLocal({ reply: '本地兜底', confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('x', NOW);
    ok(r.source === 'local', 'source = local（降级）');
    ok(r.note !== null && r.note.length > 0, 'note 非空（告诉主人降级了）', true);
  }

  // ⑥ note 只在降级时出现
  section('⑥ 正常路径 note 为 null（负对照）');
  {
    const cloud = makeCloud({ draft: null });
    const local = makeLocal({ confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('hello', NOW);
    ok(r.note === null, '云端正常返回时 note 为 null', true);
  }

  // ⑦ 云端草案 title 为空串 → 被拒
  section('⑦ 云端草案 title 为空 → 被拒（负对照）');
  {
    const cloud = makeCloud({
      draft: { title: '', kind: 'point', time: '10:00', repeat: 'once', date: '2026-10-12' },
    });
    const local = makeLocal({ confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('x', NOW);
    ok(r.draft === null, 'draft 为 null', true);
    ok(r.rejected && r.rejected.length > 0, 'rejected 有原因');
  }

  // ⑧ 云端草案 span 但 endTime < time → 被拒
  section('⑧ 云端草案时段倒流 → 被拒（负对照）');
  {
    const cloud = makeCloud({
      draft: { title: 'x', kind: 'span', time: '15:00', endTime: '14:00', repeat: 'once', date: '2026-10-12' },
    });
    const local = makeLocal({ confidence: 'low' });
    router.init({
      getItems: () => [],
      getConfig: () => ({ enabled: true, baseUrl: 'http://x', apiKey: 'sk-x', model: 'm' }),
      localBrain: local,
      cloudBrain: cloud,
    });
    const r = await router.respond('x', NOW);
    ok(r.draft === null, 'draft 为 null', true);
    ok(r.rejected && r.rejected.length > 0, 'rejected 有原因');
  }

  // ---------- 收尾 ----------
  console.log(`\n===== 大脑路由自检结束：${pass} 通过 / ${fail} 失败 =====`);
  console.log(`  （负对照：${negPass} 通过 / ${negFail} 失败）`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('自检异常：', err && err.message);
  process.exit(1);
});
