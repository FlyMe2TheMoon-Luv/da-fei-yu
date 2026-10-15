// scripts/test-spring.js
// v4 批次 3-1 · 手写弹簧自检（纯 Node，不 require electron）
//
// 用法：npm run test:spring
//
// ── 为什么这套必须存在 ──
//   弹簧这种东西**看截图看不出来**：一张静止的图，既看不出「弹不弹」，
//   也看不出「是不是从当前速度接着走的」。而这些恰恰是主人会一眼感觉到的
//   （「手感不对」）。所以只能靠量数字。
//
// ── 断言原则（本项目血泪，见 HANDOFF 第八节）──
//   ① 每条负对照都要能答上「它怎样才能红」。答不上来的删掉，别留着凑数。
//   ② 量**绝对量**，别量相对量（相对量可能恒等于常数，负对照永远不失败）。
//   ③ 报错必须带着量到的数值，否则失败信息等于没说。
//   ④ 断言别写「不为空 / 不为 none」—— 那约等于没断言。

const {
  createSpring, stepSpring, isSettled, estimateVelocity, paramsOf,
  DEFAULT_DAMPING, DEFAULT_RESPONSE,
} = require('../src/main/spring');

// ---------- 迷你测试框架 ----------
let pass = 0, fail = 0, negPass = 0, negTotal = 0;
function ok(cond, label, detail = '') {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}
// 负对照：这一条必须「成立」，因为它是在证明「坏实现会被抓住」
function okNeg(cond, label, detail = '') {
  negTotal++; if (cond) negPass++;
  ok(cond, `★ 负对照：${label}`, detail);
}
function section(t) { console.log(`\n${t}`); }

const FPS60 = 1 / 60;
const FDT = FPS60;
const NOBOUNCE = { damping: 1.0, response: 0.35 };
const BOUNCE = { damping: 0.8, response: 0.35 };

// 跑一条完整轨迹，返回采样点
function run(from, v0, target, opts, seconds, dt = FPS60) {
  let s = createSpring(from, v0);
  const pts = [{ t: 0, x: s.x, v: s.v }];
  const steps = Math.round(seconds / dt);
  for (let i = 1; i <= steps; i++) {
    s = stepSpring(s, target, dt, opts);
    pts.push({ t: i * dt, x: s.x, v: s.v });
  }
  return pts;
}

// ---------- 1. 坏输入不许变成 NaN ----------
section('1. 坏输入兜底（界面绝不许把坏输入画成 NaN —— CLAUDE.md 第 65 条）');
{
  const p = paramsOf({ damping: NaN, response: -1 });
  ok(p.damping === DEFAULT_DAMPING && p.response === DEFAULT_RESPONSE,
    '坏参数退回默认值', `damping=${p.damping} response=${p.response}`);
  ok(Number.isFinite(p.k) && p.k > 0, 'k 是有限正数', `k=${p.k.toFixed(1)}`);

  const s0 = createSpring(NaN, 'abc');
  ok(s0.x === 0 && s0.v === 0, 'createSpring 收坏值 → 0/0', `x=${s0.x} v=${s0.v}`);

  const base = createSpring(10, 5);
  const a = stepSpring(base, NaN, FDT, NOBOUNCE);
  ok(a.x === 10 && a.v === 5, '目标是 NaN → 原地不动（不是 NaN）', `x=${a.x} v=${a.v}`);
  const b = stepSpring(base, 100, NaN, NOBOUNCE);
  ok(b.x === 10 && b.v === 5, 'dt 是 NaN → 原地不动', `x=${b.x} v=${b.v}`);
  const c = stepSpring(base, 100, -1, NOBOUNCE);
  ok(c.x === 10 && c.v === 5, 'dt 是负数 → 原地不动', `x=${c.x} v=${c.v}`);
  const d = stepSpring(base, 100, 0, NOBOUNCE);
  ok(d.x === 10 && d.v === 5, 'dt = 0 → 原地不动（可打断时要靠它「不跳变」）', `x=${d.x} v=${d.v}`);

  // 长跑一遍，中途一个 NaN 都不许出现
  let s = createSpring(0, 0);
  let bad = 0;
  for (let i = 0; i < 600; i++) {
    s = stepSpring(s, 100, i === 300 ? NaN : FDT, i === 200 ? { damping: NaN } : NOBOUNCE);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) bad++;
  }
  ok(bad === 0, '600 帧（中途掺坏参数）全程无 NaN/Infinity', `坏帧数=${bad} 末态 x=${s.x.toFixed(2)}`);
}

// ---------- 2. damping 1.0：不许弹 ----------
section('2. damping 1.0（临界阻尼）→ 不弹（默认值就是它）');
{
  const pts = run(0, 0, 100, NOBOUNCE, 2);
  const maxX = Math.max(...pts.map((p) => p.x));
  const overshoot = maxX - 100;
  ok(overshoot <= 0.5, '★ 全程不过冲（不弹）', `最大 ${maxX.toFixed(3)}px，过冲 ${overshoot.toFixed(3)}px`);

  let mono = true;
  for (let i = 1; i < pts.length; i++) if (pts[i].x < pts[i - 1].x - 1e-9) mono = false;
  ok(mono, '单调逼近目标（不会先冲过头再回来）');

  // ★ 负对照：过冲判定本身能红吗？把 damping 调成 0.5 就该红
  const bouncy = run(0, 0, 100, { damping: 0.5, response: 0.35 }, 2);
  const bMax = Math.max(...bouncy.map((p) => p.x)) - 100;
  okNeg(bMax > 0.5, '同一套「不过冲」判定在 damping 0.5 下确实会红',
    `damping 0.5 的过冲 ${bMax.toFixed(3)}px`);
}

// ---------- 3. damping 0.8：会弹，但要收敛 ----------
section('3. damping 0.8（欠阻尼）→ 会弹一下，且最终收敛');
{
  const pts = run(0, 0, 100, BOUNCE, 3);
  const maxX = Math.max(...pts.map((p) => p.x));
  ok(maxX > 101, '★ 确实会弹（过冲可见）', `最大 ${maxX.toFixed(3)}px，过冲 ${(maxX - 100).toFixed(3)}px`);

  // 弹一下就该停 —— 数「**有幅度**的过冲峰值」，不该无限抖。
  // ★ 阈值 0.05px 是必要的：收敛前的数值抖动也会造出局部极大值，
  //   不设阈值的话「峰值次数」会随跑多久而变化，这条断言就成了掷骰子。
  let peaks = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i].x > 100.05 && pts[i].x >= pts[i - 1].x && pts[i].x > pts[i + 1].x) peaks++;
  }
  ok(peaks >= 1 && peaks <= 3, '有幅度的过冲峰值在 1–3 次之间（弹一下就该停）', `峰值 ${peaks} 次`);

  const last = pts[pts.length - 1];
  ok(isSettled(last, 100), '3 秒后已收敛', `末态 x=${last.x.toFixed(3)} v=${last.v.toFixed(3)}`);
}

// ---------- 4. 无阻尼不许被判「收敛」 ----------
section('4. damping 0（无阻尼）→ 永远在振荡，不许被判「收敛」');
{
  const pts = run(0, 0, 100, { damping: 0, response: 0.35 }, 5);
  const last = pts[pts.length - 1];
  okNeg(!isSettled(last, 100), 'damping 0 跑 5 秒后仍未收敛（证明「收敛」不是白写的）',
    `末态 x=${last.x.toFixed(2)} v=${last.v.toFixed(2)}`);

  const range = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  ok(range > 150, '振荡幅度仍然很大（确实在来回飞）', `振幅跨度 ${range.toFixed(1)}px`);
}

// ---------- 5. 帧率无关 ----------
section('5. 帧率无关（内部固定子步长的意义）');
{
  const at = (dt) => {
    const pts = run(0, 0, 100, NOBOUNCE, 1, dt);
    return pts[pts.length - 1].x;
  };
  const x60 = at(1 / 60), x120 = at(1 / 120), x30 = at(1 / 30), x50 = at(1 / 50);
  const spread = Math.max(x60, x120, x30, x50) - Math.min(x60, x120, x30, x50);
  ok(spread < 1, '30/50/60/120fps 跑 1 秒后位置几乎一致',
    `60fps=${x60.toFixed(3)} 120fps=${x120.toFixed(3)} 30fps=${x30.toFixed(3)} 50fps=${x50.toFixed(3)} · 极差=${spread.toFixed(4)}px`);
}

// ---------- 6. 大 dt 不炸 ----------
section('6. 大 dt（掉帧）不许发散');
{
  // 我们的实现：外面给 0.2 秒，内部拆成 48 个小步
  const s = stepSpring(createSpring(0, 0), 100, 0.2, NOBOUNCE);
  ok(Number.isFinite(s.x) && s.x >= 0 && s.x <= 100.5,
    '★ dt=0.2（相当于 5fps）仍然稳稳落在 [0, 100]', `x=${s.x.toFixed(3)} v=${s.v.toFixed(3)}`);

  // ★ 负对照：同一个公式，如果不拆子步（朴素半隐式欧拉一步走完）会发散
  //   —— 这条就是「固定子步长不是白写的」的证据
  const { k, c } = paramsOf(NOBOUNCE);
  let nx = 0, nv = 0;
  const h = 0.2;
  for (let i = 0; i < 2; i++) {
    const a = -k * (nx - 100) - c * nv;
    nv += a * h;
    nx += nv * h;
  }
  okNeg(!(Math.abs(nx) <= 100.5), '朴素欧拉（不拆子步）确实会飞出去',
    `两步之后 x=${nx.toFixed(1)}（已经爆了）`);
}

// ---------- 7. 可打断性 ----------
section('7. 可打断性（苹果设计原则排第一）');
{
  // 走到一半，把目标从 100 改成 0（手又往回拉了）
  let s = createSpring(0, 0);
  for (let i = 0; i < 9; i++) s = stepSpring(s, 100, FDT, NOBOUNCE); // 0.15s
  const before = { ...s };

  // dt=0 的「打断帧」：位置和速度都必须原样带过去（不跳变）
  const cut = stepSpring(before, 0, 0, NOBOUNCE);
  ok(cut.x === before.x && cut.v === before.v, '打断瞬间：位置和速度都不跳变',
    `x ${before.x.toFixed(3)}→${cut.x.toFixed(3)} · v ${before.v.toFixed(3)}→${cut.v.toFixed(3)}`);

  // 打断后第一帧：位置只能动一点点（不能瞬移）
  const next = stepSpring(cut, 0, FDT, NOBOUNCE);
  const jump = Math.abs(next.x - cut.x);
  ok(jump < 10, '打断后第一帧位置连续（没有瞬移）', `单帧位移 ${jump.toFixed(3)}px`);

  // 而且真的掉头了：位置还在目标右边，速度已经变成负的
  let t = next;
  for (let i = 0; i < 30; i++) t = stepSpring(t, 0, FDT, NOBOUNCE);
  ok(t.v < 0 && t.x > 0, '★ 确实掉头往回走了（没有「先停一下」）',
    `0.5s 后 x=${t.x.toFixed(3)} v=${t.v.toFixed(3)}`);

  // ★ 负对照：如果打断时把速度清零（很多「重启动画」的写法就是这样），
  //   接缝处速度会从 +v 突变成 0 —— 用手感说就是「顿一下」。
  const dropV = stepSpring({ x: before.x, v: 0 }, 0, FDT, NOBOUNCE);
  okNeg(Math.abs(dropV.v - next.v) > 1, '「把速度清零」的写法会明显改变轨迹（这条能红）',
    `清零后 v=${dropV.v.toFixed(3)} vs 正确 v=${next.v.toFixed(3)}`);
}

// ---------- 8. 速度衔接（松手把手指速度交给弹簧） ----------
section('8. 速度衔接：松手那一帧的初速必须被保留');
{
  const handoff = stepSpring(createSpring(0, 2000), 100, FDT, NOBOUNCE); // 手指速度 2000 px/s
  const fromRest = stepSpring(createSpring(0, 0), 100, FDT, NOBOUNCE);
  ok(handoff.x > 20, '★ 带着初速走 → 第一帧就冲出去一段', `单帧位移 ${handoff.x.toFixed(2)}px`);
  okNeg(fromRest.x < 10 && handoff.x - fromRest.x > 15,
    '丢掉初速（从 0 起步）第一帧只挪一点点 —— 两条差距明显，说明这条断言能红',
    `带初速 ${handoff.x.toFixed(2)}px vs 静止起步 ${fromRest.x.toFixed(2)}px`);
}

// ---------- 9. estimateVelocity ----------
section('9. estimateVelocity（把指针采样变成速度）');
{
  const linear = [{ x: 0, t: 0 }, { x: 10, t: 10 }, { x: 20, t: 20 }, { x: 30, t: 30 }];
  ok(Math.abs(estimateVelocity(linear) - 1000) < 1e-6, '匀速直线 → 精确 1000 px/s',
    `算出 ${estimateVelocity(linear)}`);

  // 只在「最近窗口」内取样本：手已经停了，速度就该是 0
  const stopped = [
    { x: 0, t: 0 }, { x: 100, t: 50 }, { x: 200, t: 100 },
    { x: 200, t: 200 }, { x: 200, t: 300 },
  ];
  ok(estimateVelocity(stopped) === 0, '★ 最近 100ms 没动 → 速度 0（不许拿半秒前的移动当「还在飞」）',
    `算出 ${estimateVelocity(stopped)}`);

  ok(estimateVelocity([{ x: 5, t: 1000 }]) === 0, '只有一个样本 → 0');
  ok(estimateVelocity([]) === 0, '空数组 → 0');
  ok(estimateVelocity(null) === 0, 'null → 0');
  ok(estimateVelocity([{ x: 'a', t: 1 }, { x: 2, t: 2 }]) === 0, '坏样本被过滤掉 → 0');

  // ★ 负对照：两笔同一时刻 → 时间没走。不挡住的话这里会算出 Infinity/NaN
  const sameT = estimateVelocity([{ x: 0, t: 500 }, { x: 50, t: 500 }]);
  okNeg(sameT === 0 && Number.isFinite(sameT), '同一时刻的两笔 → 0，而不是 Infinity/NaN',
    `算出 ${sameT}`);

  const fast = estimateVelocity([{ x: 0, t: 0 }, { x: 1000, t: 10 }], { maxAbs: 3000 });
  ok(fast === 3000, 'maxAbs 生效（速度被夹住）', `算出 ${fast}`);

  // ★ 最后一笔样本已经很久了 = 手停了（鼠标不动就不发 mousemove）。
  //   不挡住的话，「快拖一下 → 按住不动半秒 → 松手」会被当成还在飞，桌宠会窜出去。
  const stale = [{ x: 0, t: 0 }, { x: 100, t: 10 }, { x: 200, t: 20 }];
  ok(estimateVelocity(stale, { now: 500 }) === 0,
    '★ 最后一笔样本过去 480ms 了（手早就停了）→ 速度 0',
    `算出 ${estimateVelocity(stale, { now: 500 })}`);
  okNeg(estimateVelocity(stale) !== 0,
    '不传 now 时仍会按最后一笔窗口算出速度（说明上面那条不是恒 0 的假断言）',
    `不传 now 算出 ${estimateVelocity(stale)}`);
  ok(estimateVelocity(stale, { now: 60 }) !== 0, '样本还新鲜（过去 40ms）→ 正常给出速度',
    `算出 ${estimateVelocity(stale, { now: 60 })}`);
}

// ---------- 10. isSettled ----------
section('10. isSettled（只看位置会在「路过目标」时误判）');
{
  ok(isSettled({ x: 100, v: 0 }, 100), '静止在目标上 → 到位');
  okNeg(!isSettled({ x: 0, v: 0 }, 100), '一开始（离得远）绝不算到位', 'x=0 vs target=100');
  okNeg(!isSettled({ x: 100.1, v: 5000 }, 100),
    '★ 位置贴着目标但速度很大（正路过）→ 不算到位', 'x=100.1 v=5000');
  ok(!isSettled({ x: 100, v: 0 }, NaN), '目标不是数 → 不算到位（保守）');
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
