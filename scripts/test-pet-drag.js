// scripts/test-pet-drag.js
// v4 批次 3-b · 桌宠拖拽手感自检（纯 Node，不 require electron）
//
// 用法：npm run test:pet-drag
//
// ── 为什么「手感」也要自检 ──
//   拖拽这件事**合成鼠标事件测不了**（`sendInputEvent` 的 screenX/screenY 恒为 0），
//   所以「手感对不对」最后只能靠主人亲手拖。但**手感背后的算术是对的**这件事
//   完全可以量：松手后滑了多远、会不会滑出屏幕、停不停得下来。
//   算术错了，主人拖一万次也只是「觉得怪」，说不出哪不对。
//
// ── 断言原则 ──
//   ① 每条负对照都要能答上「它怎样才能红」。
//   ② 量绝对量。③ 报错带数值。

const {
  rubberbandAxis, releasePlan, createGlide, stepGlide,
  PROJECT_SECONDS, MAX_SPEED, MAX_GLIDE_SECONDS,
} = require('../src/main/pet-drag');

let pass = 0, fail = 0, negPass = 0, negTotal = 0;
function ok(cond, label, detail = '') {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}
function okNeg(cond, label, detail = '') {
  negTotal++; if (cond) negPass++;
  ok(cond, `★ 负对照：${label}`, detail);
}
function section(t) { console.log(`\n${t}`); }

// 模拟主人这台机器：1920×1040 工作区，桌宠 400×380
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = { w: 400, h: 380 };
const BOUNDS = { minX: WA.x, maxX: WA.x + WA.width - SIZE.w, minY: WA.y, maxY: WA.y + WA.height - SIZE.h };

const inBounds = (x, y, b = BOUNDS) => x >= b.minX - 1e-6 && x <= b.maxX + 1e-6 && y >= b.minY - 1e-6 && y <= b.maxY + 1e-6;

// 跑完一整次滑行，返回轨迹。
// ★ 结束时**对齐到落点** —— 主进程在 done 那一帧就是这么做的（movePet(target)），
//   因为弹簧的「到位」判定留了 0.5px 余量，不对齐的话窗口可能停在边界外零点几像素。
function glide(plan, dt = 1 / 60, maxSteps = 600) {
  let g = createGlide(plan);
  const pts = [{ x: g.x, y: g.y, t: 0 }];
  let i = 0;
  while (!g.done && i < maxSteps) {
    g = stepGlide(g, dt);
    i++;
    if (g.done) g = { ...g, x: g.targetX, y: g.targetY, vx: 0, vy: 0 };
    pts.push({ x: g.x, y: g.y, t: i * dt });
  }
  return { g, pts };
}

// ---------- 1. 拖拽中：越界阻力 ----------
section('1. rubberbandAxis（拖出边界时的渐进阻力）');
{
  ok(rubberbandAxis(500, BOUNDS.minX, BOUNDS.maxX, SIZE.w) === 500, '界内 → 原样不动', '500');
  ok(rubberbandAxis(BOUNDS.minX, BOUNDS.minX, BOUNDS.maxX, SIZE.w) === BOUNDS.minX, '正好在边界上 → 不动');

  const over = 200;
  const out = rubberbandAxis(BOUNDS.maxX + over, BOUNDS.minX, BOUNDS.maxX, SIZE.w);
  ok(out > BOUNDS.maxX, '★ 越界时还能往外挪一点（不是硬停）', `超出边界 ${(out - BOUNDS.maxX).toFixed(1)}px`);
  ok(out - BOUNDS.maxX < over, '★ 但挪得比手指少（这就是「阻力」）',
    `手指超出 ${over}px，实际只挪了 ${(out - BOUNDS.maxX).toFixed(1)}px`);

  // 拖得越远，超出越多但增长越慢
  const o1 = rubberbandAxis(BOUNDS.maxX + 50, BOUNDS.minX, BOUNDS.maxX, SIZE.w) - BOUNDS.maxX;
  const o2 = rubberbandAxis(BOUNDS.maxX + 500, BOUNDS.minX, BOUNDS.maxX, SIZE.w) - BOUNDS.maxX;
  ok(o2 > o1 && o2 - o1 < 450, '越拖越沉（增量递减）', `+50px→${o1.toFixed(1)} · +500px→${o2.toFixed(1)}`);
  ok(o2 < SIZE.w, '★ 越界位移永远不到一个窗口宽（拖不飞）', `${o2.toFixed(1)} < ${SIZE.w}`);

  // 左边同理，且对称
  const left = rubberbandAxis(BOUNDS.minX - 200, BOUNDS.minX, BOUNDS.maxX, SIZE.w);
  ok(Math.abs((BOUNDS.minX - left) - (out - BOUNDS.maxX)) < 1e-9, '左右对称', `${(BOUNDS.minX - left).toFixed(1)} vs ${(out - BOUNDS.maxX).toFixed(1)}`);

  // ★ 负对照：直接硬夹（很多实现的写法）→ 越界时一点都不动
  const hard = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  okNeg(!(hard(BOUNDS.maxX + over, BOUNDS.minX, BOUNDS.maxX) > BOUNDS.maxX),
    '硬夹写法（越界位移恒 0）会被第 1 节抓住', `硬夹给出 ${hard(BOUNDS.maxX + over, BOUNDS.minX, BOUNDS.maxX)}`);

  // 坏输入
  ok(Number.isFinite(rubberbandAxis(NaN, BOUNDS.minX, BOUNDS.maxX, SIZE.w)), 'desired=NaN → 有限数');
  ok(Number.isFinite(rubberbandAxis(500, NaN, NaN, SIZE.w)), '边界是 NaN → 有限数');
}

// ---------- 2. 松手决策 ----------
section('2. releasePlan（松手那一刻往哪去、弹不弹）');
{
  // 界内 + 往右甩 → 惯性滑行，不弹（主人 2026-10-15 要「更跟手」，所以不再给弹）
  const flick = releasePlan({ x: 400, y: 300, vx: 1200, vy: 0, bounds: BOUNDS });
  ok(flick.reason === 'flick' && flick.damping === 1.0, '界内甩手 → 惯性滑行 + 不弹（damping 1.0）',
    `${flick.reason} damping=${flick.damping}`);
  ok(flick.targetX > 400, '★ 落点在甩的方向上（会继续往前走）',
    `x=400 → 落点 ${flick.targetX.toFixed(1)}（+${(flick.targetX - 400).toFixed(1)}px）`);
  ok(Math.abs(flick.targetX - (400 + 1200 * PROJECT_SECONDS)) < 1e-6, '落点 = 当前位置 + 速度 × 投影时长',
    `期望 ${400 + 1200 * PROJECT_SECONDS}`);
  ok(flick.targetY === 300, '竖直方向没速度 → 落点不动', `y 落点 ${flick.targetY}`);
  // ★ 主人反馈「滑太远」之后钉一条上限：常见甩速下，落点不许离手太远
  ok(flick.targetX - 400 <= 60, '★ 1200px/s 甩一下，落点离松手处不超过 60px（别滑太远）',
    `实际 ${(flick.targetX - 400).toFixed(1)}px`);

  // ★ 负对照：把速度丢掉（「松手就停」的老写法）→ 落点等于当前位置，滑行距离 0
  const noVel = releasePlan({ x: 400, y: 300, vx: 0, vy: 0, bounds: BOUNDS });
  okNeg(Math.abs(noVel.targetX - 400) < 1e-9, '丢掉速度的写法落点 = 原地（说明第 2 节能红）',
    `落点 ${noVel.targetX}`);

  // 落点必须夹在界内：贴着右边界往右甩，不能把落点甩到屏幕外
  const edge = releasePlan({ x: BOUNDS.maxX - 5, y: 300, vx: 3000, vy: 0, bounds: BOUNDS });
  ok(edge.targetX <= BOUNDS.maxX, '★ 落点被夹在界内（不会「滑出屏幕」）',
    `落点 ${edge.targetX.toFixed(1)} ≤ ${BOUNDS.maxX}`);
  okNeg(edge.x + 3000 * PROJECT_SECONDS > BOUNDS.maxX,
    '不夹的话落点确实会跑出界（说明这条夹紧是必要的）',
    `不夹会到 ${(edge.x + 3000 * PROJECT_SECONDS).toFixed(0)} > ${BOUNDS.maxX}`);

  // 越界 → 弹回，且不弹（damping 1.0）
  const back = releasePlan({ x: BOUNDS.maxX + 80, y: 300, vx: 0, vy: 0, bounds: BOUNDS });
  ok(back.reason === 'rubberback' && back.damping === 1.0, '拖出界 → 弹回边界内，且不弹',
    `${back.reason} damping=${back.damping}`);
  ok(back.targetX === BOUNDS.maxX, '目标就是边界', `${back.targetX}`);

  // 减少动态效果 → 一步落位
  const rm = releasePlan({ x: 400, y: 300, vx: 1200, vy: 800, bounds: BOUNDS, reducedMotion: true });
  ok(rm.instant === true && rm.vx === 0 && rm.vy === 0, '★ 开了「减少动态效果」→ 直接落位、速度清零',
    `instant=${rm.instant} v=${rm.vx},${rm.vy}`);
  ok(rm.targetX === 400 && rm.targetY === 300, '落位就是原地（不滑行）', `${rm.targetX},${rm.targetY}`);
  // 而且越界时仍然会被夹回界内 —— 减少动效不等于允许把宠物丢在屏幕外
  const rm2 = releasePlan({ x: BOUNDS.maxX + 500, y: 300, vx: 0, vy: 0, bounds: BOUNDS, reducedMotion: true });
  ok(inBounds(rm2.targetX, rm2.targetY), '★ 减少动效下越界也照样夹回屏幕内（不是「什么都不管」）',
    `${rm2.targetX.toFixed(0)},${rm2.targetY}`);

  // 坏输入
  const bad = releasePlan({ x: NaN, y: NaN, vx: NaN, vy: NaN, bounds: BOUNDS });
  ok(Number.isFinite(bad.targetX) && Number.isFinite(bad.targetY) && Number.isFinite(bad.vx),
    '坏输入 → 全是有限数（不许 NaN）', `${bad.targetX},${bad.targetY} v=${bad.vx}`);
  const huge = releasePlan({ x: 400, y: 300, vx: 999999, vy: 0, bounds: BOUNDS });
  ok(Math.abs(huge.vx) <= MAX_SPEED, '速度被夹到上限', `v=${huge.vx} ≤ ${MAX_SPEED}`);
}

// ---------- 3. 滑行状态机 ----------
section('3. createGlide / stepGlide（松手之后的动画）');
{
  // 已经在目标上 → 立刻结束（「点一下没拖动」不该起动画）
  const idle = createGlide(releasePlan({ x: 400, y: 300, vx: 0, vy: 0, bounds: BOUNDS }));
  ok(idle.done === true, '★ 没速度、没位移 → 直接 done（不起动画）', `done=${idle.done}`);

  const plan = releasePlan({ x: 400, y: 300, vx: 1200, vy: 0, bounds: BOUNDS });
  const { g, pts } = glide(plan);
  ok(g.done === true, '滑行会自己结束', `用时 ${g.elapsed.toFixed(2)}s`);
  ok(g.elapsed < 2, '★ 停得下来（不到 2 秒）', `${g.elapsed.toFixed(2)}s`);
  ok(Math.abs(g.x - g.targetX) <= 0.5 && Math.abs(g.y - g.targetY) <= 0.5,
    '最后停在落点上', `x=${g.x.toFixed(2)} 目标=${g.targetX.toFixed(2)}`);

  const moved = g.x - 400;
  ok(moved > (plan.targetX - 400) * 0.8, '★ 松手后确实走到了落点附近',
    `滑了 ${moved.toFixed(1)}px（落点 ${(plan.targetX - 400).toFixed(1)}px）`);

  // ★ 「速度衔接」到底有没有生效，要看**刚松手那一瞬间**：速度必须还是松手速度。
  //   ⚠ 这里踩过一次坑：最早写的是「比较头三帧走了多远」，参数收紧（响应 0.4→0.26）
  //   之后两条曲线几乎重合（31.7px vs 28.3px），断言差点变成装饰 ——
  //   因为落点离得近，弹簧的拉力很快就把初速盖过去了。
  //   改成**只走一个极小步**（1/240 秒）再比速度，初速还没来得及被抹掉。
  const g1 = stepGlide(createGlide(plan), 1 / 240);
  ok(Math.abs(g1.vx - plan.vx) < plan.vx * 0.15,
    '★ 接速度：一个极小步之后，速度仍然接近松手速度（没有被瞬间抹掉）',
    `${plan.vx} → ${g1.vx.toFixed(1)}（差 ${(Math.abs(g1.vx - plan.vx) / plan.vx * 100).toFixed(1)}%）`);
  // ★ 负对照：从静止起步的话，同一个极小步之后速度差得远 —— 上面那条靠这个差异才能红
  const g1b = stepGlide(createGlide({ ...plan, vx: 0 }), 1 / 240);
  okNeg(Math.abs(g1b.vx - plan.vx) > plan.vx * 0.15,
    '丢掉速度的写法，同一极小步之后速度差得远（上面那条断言靠这个差异才能红）',
    `静止起步 ${g1b.vx.toFixed(1)} vs 松手速度 ${plan.vx}`);

  // 位置连续：单帧位移不该超过「当前速度 × dt」太多
  let maxJump = 0;
  for (let k = 1; k < pts.length; k++) {
    maxJump = Math.max(maxJump, Math.abs(pts[k].x - pts[k - 1].x), Math.abs(pts[k].y - pts[k - 1].y));
  }
  ok(maxJump < 40, '单帧位移正常（没有瞬移）', `最大单帧 ${maxJump.toFixed(1)}px`);

  // 单调靠近：滑行阶段不许先往回退（第一帧就可能因为弹而微微回头，给点余量）
  ok(pts[1].x > pts[0].x, '第一帧就顺着速度往前走', `${pts[0].x.toFixed(1)} → ${pts[1].x.toFixed(1)}`);

  // 全程不越界
  const outPts = pts.filter((p) => !inBounds(p.x, p.y));
  ok(outPts.length === 0, '★ 整段滑行都在屏幕内', `越界帧 ${outPts.length}/${pts.length}`);
}

// ---------- 4. 大 dt / 兜底 ----------
section('4. 掉帧与兜底');
{
  const plan = releasePlan({ x: 400, y: 300, vx: 1200, vy: 0, bounds: BOUNDS });
  const big = glide(plan, 0.2); // 5fps
  ok(Number.isFinite(big.g.x) && Math.abs(big.g.x) < 1e6, '★ dt=0.2（5fps）不发散',
    `末态 x=${big.g.x.toFixed(2)} 用时 ${big.g.elapsed.toFixed(2)}s`);
  ok(big.g.done, '大 dt 下也会结束');

  // 兜底：把参数改坏（damping 0 = 永远振荡）也必须停下来
  let g = createGlide({ x: 0, y: 0, vx: 0, vy: 0, targetX: 100, targetY: 0, damping: 0, response: 0.35, instant: false });
  let steps = 0;
  while (!g.done && steps < 5000) { g = stepGlide(g, 1 / 60); steps++; }
  ok(g.done && g.elapsed <= MAX_GLIDE_SECONDS + 1 / 60 + 1e-9,
    '★ damping=0（无阻尼）也不会永远动下去（3 秒兜底）',
    `用时 ${g.elapsed.toFixed(2)}s（上限 ${MAX_GLIDE_SECONDS}s，允许多走一帧）`);
  // ★ 负对照：不设兜底的话它会一直振荡（证明兜底不是摆设）
  let free = { x: 0, v: 0 };
  const { stepSpring, isSettled } = require('../src/main/spring');
  for (let k = 0; k < 300; k++) free = stepSpring(free, 100, 1 / 60, { damping: 0, response: 0.35 });
  okNeg(!isSettled(free, 100), '没有兜底时确实停不下来（说明第 4 节的兜底必要）',
    `5 秒后 x=${free.x.toFixed(2)} v=${free.v.toFixed(2)}`);

  ok(stepGlide(null, 1 / 60) === null, 'stepGlide(null) → null（不崩）');
  const same = createGlide(releasePlan({ x: 400, y: 300, vx: 100, vy: 0, bounds: BOUNDS }));
  ok(stepGlide(same, 0).x === same.x, 'dt=0 → 原地不动');
  ok(stepGlide(same, NaN).x === same.x, 'dt=NaN → 原地不动');
}

// ---------- 5. 端到端（纯算术）：从拖拽到停稳 ----------
section('5. 一次完整拖拽：拖到右边界外 → 松手 → 停稳');
{
  // 手指从界内一直拖到边界外 300px
  let x = 1000;
  const trace = [x];
  for (let i = 1; i <= 60; i++) {
    const desired = 1000 + i * 12; // 每帧手指走 12px，60 帧共 720px
    x = rubberbandAxis(desired, BOUNDS.minX, BOUNDS.maxX, SIZE.w);
    trace.push(x);
  }
  const fingerEnd = 1000 + 60 * 12;
  ok(fingerEnd > BOUNDS.maxX, '这次确实拖出了右边界', `手指到 ${fingerEnd} > ${BOUNDS.maxX}`);
  ok(x > BOUNDS.maxX, '★ 拖出边界后窗口还在（有阻力地）往外挪', `窗口到 ${x.toFixed(1)}`);
  ok(x - BOUNDS.maxX < fingerEnd - BOUNDS.maxX, '★ 窗口超出得比手指少',
    `窗口超出 ${(x - BOUNDS.maxX).toFixed(1)}px vs 手指超出 ${fingerEnd - BOUNDS.maxX}px`);
  ok(x < BOUNDS.maxX + SIZE.w, '窗口没有整个飞出屏幕', `${x.toFixed(1)} < ${BOUNDS.maxX + SIZE.w}`);

  // 松手（手指还在往右动 → 带速度）
  const plan = releasePlan({ x, y: 300, vx: 1200, vy: 0, bounds: BOUNDS });
  ok(plan.reason === 'rubberback', '越界松手 → 走「弹回」这条路', plan.reason);
  const { g } = glide(plan);
  ok(g.done && inBounds(g.x, g.y), '★ 最后稳稳停在屏幕内',
    `落点 ${g.x.toFixed(1)},${g.y.toFixed(1)}（边界 ${BOUNDS.maxX}）`);
  ok(g.x <= BOUNDS.maxX + 0.5, '落点不超出右边界', `${g.x.toFixed(2)} ≤ ${BOUNDS.maxX}`);
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
