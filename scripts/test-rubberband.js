// scripts/test-rubberband.js
// v4 批次 3-4 · 橡皮筋自检（纯 Node，不 require electron）
//
// 用法：npm run test:rubberband
//
// ── 橡皮筋要满足什么（这些就是「手感」的量化）──
//   拖出边界时：还能动（不然像卡住），但动得比手指少（不然没边界感），
//   越拖越沉，而且永远拖不飞。
//   这几条**全都看不出来**——一张截图里根本没有「拖动中」这回事。
//
// ── 断言原则 ──
//   ① 负对照必须能答上「它怎样才能红」。
//   ② 量绝对量。
//   ③ 报错带数值。

const { rubberband, DEFAULT_CONSTANT } = require('../src/main/rubberband');

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

const DIM = 400; // 参考尺寸：桌宠窗口宽度量级

// ---------- 1. 边界与坏输入 ----------
section('1. 不越界 / 坏输入 → 0（不是 NaN，也不是「随便给个值」）');
{
  ok(rubberband(0, DIM) === 0, '越界 0 → 0', `得到 ${rubberband(0, DIM)}`);
  ok(rubberband(NaN, DIM) === 0, '越界 NaN → 0');
  ok(rubberband(10, 0) === 0, '尺寸 0 → 0（没法算）');
  ok(rubberband(10, NaN) === 0, '尺寸 NaN → 0');
  ok(rubberband(10, -5) === 0, '尺寸负数 → 0');
  ok(Number.isFinite(rubberband(10, DIM)), '正常输入 → 有限数', `得到 ${rubberband(10, DIM).toFixed(3)}`);
}

// ---------- 2. 有阻力：0 < 位移 < 手指 ----------
section('2. 核心性质：动，但动得比手指少');
{
  let allOk = true, worst = null;
  for (const d of [1, 5, 20, 60, 150, 400, 1200]) {
    const o = rubberband(d, DIM);
    const good = o > 0 && o < d;
    if (!good) { allOk = false; worst = { d, o }; }
  }
  ok(allOk, '★ 每个越界距离都满足 0 < 位移 < 手指',
    worst ? `反例 d=${worst.d} o=${worst.o}` : 'd=1/5/20/60/150/400/1200 全部通过');
  console.log(`     实测：` + [1, 5, 20, 60, 150, 400, 1200]
    .map((d) => `d=${d}→${rubberband(d, DIM).toFixed(2)}`).join(' · '));

  // ★ 负对照：硬夹（拖出边界就一点都不动）—— 很多实现就是这样的
  const hardClamp = () => 0;
  okNeg(!(hardClamp(60, DIM) > 0), '硬夹写法（位移恒 0）会被第 2 节抓住',
    `硬夹给出 ${hardClamp(60, DIM)}`);
  // ★ 负对照：完全 1:1 跟手（没有阻力）
  const oneToOne = (d) => d;
  okNeg(!(oneToOne(60, DIM) < 60), '1:1 跟手（位移 = 手指）会被第 2 节抓住',
    `1:1 给出 ${oneToOne(60, DIM)}`);
}

// ---------- 3. 有上界：永远拖不飞 ----------
section('3. 上界：无限逼近参考尺寸，但永不超过');
{
  let bounded = true, badD = null;
  for (const d of [DIM, DIM * 2, DIM * 10, 1e6]) {
    const o = rubberband(d, DIM);
    if (!(o < DIM)) { bounded = false; badD = { d, o }; }
  }
  ok(bounded, `★ 再怎么拖都 < ${DIM}`, badD ? `反例 d=${badD.d} o=${badD.o}` : `d=400/800/4000/1e6 全部 < ${DIM}`);
  const huge = rubberband(1e6, DIM);
  ok(huge > DIM * 0.99, '拖得极远时会非常接近上界（说明确实「顶住了」）',
    `d=1e6 → ${huge.toFixed(4)}（上界 ${DIM}）`);

  // ★ 负对照：没有上界的写法（线性）会超过
  okNeg(!((DIM * 3) < DIM), '线性写法会超过上界（说明第 3 节能红）', `线性给出 ${DIM * 3}`);
}

// ---------- 4. 越拖越沉：位移/手指 单调递减 ----------
section('4. 越拖越沉（位移÷手指 从系数起步、一路变小）');
{
  const ratios = [1, 2, 5, 10, 20, 40, 80, 160, 320, 640].map((d) => ({ d, r: rubberband(d, DIM) / d }));
  let mono = true, bad = null;
  for (let i = 1; i < ratios.length; i++) {
    if (!(ratios[i].r < ratios[i - 1].r)) { mono = false; bad = ratios[i]; }
  }
  ok(mono, '★ 位移÷手指 严格单调递减（越拖越沉）',
    bad ? `反例 d=${bad.d} r=${bad.r}` : ratios.map((x) => `${x.d}:${x.r.toFixed(3)}`).join(' '));

  // 起点等于阻力系数本身（默认 0.55）—— 刚越界就已经「打了折」
  const tiny = rubberband(0.01, DIM) / 0.01;
  ok(Math.abs(tiny - DEFAULT_CONSTANT) < 0.01, `越界瞬间的跟手比例 ≈ 系数 ${DEFAULT_CONSTANT}`,
    `实测 ${tiny.toFixed(4)}`);

  // ★ 负对照：常量（不递减）的写法会被这条抓住
  const flat = (d) => d * 0.5;
  const flatRatios = [1, 10, 100].map((d) => flat(d) / d);
  okNeg(!(flatRatios[1] < flatRatios[0]), '「恒定比例」写法会被单调性抓住',
    `恒定比例 ${flatRatios.join(' / ')}`);
}

// ---------- 5. 左右对称 ----------
section('5. 对称（往左越界和往右越界一样）');
{
  let sym = true, bad = null;
  for (const d of [1, 25, 100, 900]) {
    if (Math.abs(rubberband(-d, DIM) + rubberband(d, DIM)) > 1e-9) { sym = false; bad = d; }
  }
  ok(sym, '★ rubberband(-d) === -rubberband(d)', bad ? `反例 d=${bad}` : 'd=1/25/100/900 全部对称');
}

// ---------- 6. 系数生效 + 越界夹回默认 ----------
section('6. 阻力系数');
{
  const soft = rubberband(200, DIM, 0.3);
  const hard = rubberband(200, DIM, 0.9);
  ok(hard > soft, '系数越大越跟手', `c=0.3 → ${soft.toFixed(2)} · c=0.9 → ${hard.toFixed(2)}`);
  ok(Math.abs(rubberband(200, DIM, 0) - rubberband(200, DIM)) < 1e-9, '系数 0（无效）→ 退回默认');
  ok(Math.abs(rubberband(200, DIM, NaN) - rubberband(200, DIM)) < 1e-9, '系数 NaN → 退回默认');
  // 系数 > 1 会被夹到 1 —— 否则会出现「动得比手指还多」
  ok(rubberband(200, DIM, 5) < 200, '系数 5 被夹到 1（仍然有阻力）',
    `c=5 → ${rubberband(200, DIM, 5).toFixed(2)} < 200`);
  // ★ 负对照：不夹紧的话，系数 5 会让位移**超过**手指 —— 那就不是橡皮筋了
  const unclamped = (d, dim, c) => (1 - 1 / ((d * c) / dim + 1)) * dim;
  okNeg(!(unclamped(200, DIM, 5) < 200), '不夹紧系数会让位移超过手指（说明「夹紧」这条能红）',
    `不夹紧 c=5 → ${unclamped(200, DIM, 5).toFixed(2)} > 200`);
}

// ---------- 汇总 ----------
console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
