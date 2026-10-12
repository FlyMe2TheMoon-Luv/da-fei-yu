// scripts/test-place.js
// 阶段 2-4 补充 · 「把小窗口摆在桌宠旁边」的位置计算自检
//
// 用法：npm run test:place
//
// 为什么值得单独测：这类「摆位置」的代码最容易写错（屏幕边、多显示器、
// 上下放不下），又最不容易被肉眼发现（差几十像素谁看得出来）。
// place.js 是纯函数、不依赖 Electron，所以能穷举。
//
// 测试原则（HANDOFF 第六节第 19 条的教训）：
//   不能只挑几个「正常情况」测通过就算完 —— 必须专门测边界和反例，
//   否则算错了也发现不了。第 5、6、7、9 节就是干这个的。

const { placeNear, candidate } = require('../src/main/place');

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function section(t) { console.log(`\n${t}`); }

// 和 settings-window.js 保持一致（480×640 是不含 useContentSize 的「外框」尺寸，
// 也就是 Electron 里 getBounds() 会返回的那个尺寸 —— 摆位置要用它，不是网页可视区）
const WIN = { w: 480, h: 640 };
const GAP = 10;
const EDGE = 8;
const PET = { width: 400, height: 380 };
const SCREEN = { x: 0, y: 0, width: 1707, height: 1067 };  // 主人这台机器的实测值

const petAt = (x, y) => ({ x, y, width: PET.width, height: PET.height });
const place = (pet, work = SCREEN) => placeNear(pet, WIN, work, { gap: GAP, edge: EDGE });

const inside = (p, work = SCREEN) =>
  p.x >= work.x + EDGE && p.y >= work.y + EDGE &&
  p.x + WIN.w <= work.x + work.width - EDGE &&
  p.y + WIN.h <= work.y + work.height - EDGE;

// 屏幕比窗口还小时「完整放下」是不可能的，这时只要求左上角别跑到屏幕外
const fitsScreen = (work) => WIN.w + 2 * EDGE <= work.width && WIN.h + 2 * EDGE <= work.height;
const cornerIn = (p, work) =>
  p.x >= work.x && p.y >= work.y && p.x <= work.x + work.width && p.y <= work.y + work.height;

const overlaps = (p, pet) =>
  p.x < pet.x + pet.width && p.x + WIN.w > pet.x &&
  p.y < pet.y + pet.height && p.y + WIN.h > pet.y;

// 两个矩形之间的最短距离（相交就是 0）。用来断言「窗口始终挨着宠物」。
const rectGap = (p, pet) => {
  const dx = Math.max(pet.x - (p.x + WIN.w), p.x - (pet.x + pet.width), 0);
  const dy = Math.max(pet.y - (p.y + WIN.h), p.y - (pet.y + pet.height), 0);
  return Math.sqrt(dx * dx + dy * dy);
};

const petCenterIn = (pet, work) => {
  const cx = pet.x + pet.width / 2;
  const cy = pet.y + pet.height / 2;
  return cx >= work.x && cx <= work.x + work.width && cy >= work.y && cy <= work.y + work.height;
};

console.log('===== 窗口摆放位置自检（place.js）=====');
console.log(`窗口 ${WIN.w}×${WIN.h} · 与宠物间距 ${GAP} · 离屏幕边 ${EDGE}`);
console.log(`屏幕 ${SCREEN.width}×${SCREEN.height} · 宠物 ${PET.width}×${PET.height}`);

// ---------- 1. 各方位的基本形状 ----------
section('1. 各个方位算出来的位置符合定义');
{
  const pet = petAt(600, 400);
  const ur = candidate('up-right', pet, WIN, GAP);
  ok(ur.x === pet.x + pet.width + GAP, 'up-right：窗口左边缘紧贴宠物右侧 + 间距');
  ok(ur.y === pet.y - WIN.h - GAP, 'up-right：窗口底边紧贴宠物顶边 - 间距');

  const ar = candidate('above-right', pet, WIN, GAP);
  ok(ar.x + WIN.w === pet.x + pet.width, 'above-right：窗口右边缘和宠物右边缘对齐');
  ok(ar.y === pet.y - WIN.h - GAP, 'above-right：在宠物正上方');

  const ul = candidate('up-left', pet, WIN, GAP);
  ok(ul.x + WIN.w === pet.x - GAP, 'up-left：窗口右边缘紧贴宠物左侧 - 间距');

  const r = candidate('right', pet, WIN, GAP);
  ok(r.x === pet.x + pet.width + GAP && r.y === pet.y, 'right：在宠物右侧、顶端对齐');

  const ab = candidate('above', pet, WIN, GAP);
  ok(ab.x + Math.round(WIN.w / 2) === pet.x + Math.round(pet.width / 2), 'above：水平居中对齐宠物');
}

// ---------- 2. 有地方就优先右上 ----------
section('2. 宠物在屏幕左下、上方和右边都有地方 → 应该放右上方');
{
  const pet = petAt(300, 700);
  const p = place(pet);
  ok(p.side === 'up-right', `选了 up-right（实际 ${p.side}）`);
  ok(p.clamped === false, '不需要被屏幕边挤（原样放下）');
  ok(p.x === pet.x + pet.width + GAP && p.y === pet.y - WIN.h - GAP, '位置和定义完全一致');
  ok(!overlaps(p, pet), '和宠物不重叠');
}

// ---------- 3. 右边放不下 → 退到「正上方、右对齐」 ----------
section('3. 宠物贴屏幕右边（右边放不下）→ 退到上方右对齐，仍不压住它');
{
  // 屏幕 1707 宽，宠物宽 400，放在 x=1250 → 右边只剩 57px，放不下 480
  const pet = petAt(1250, 750);
  const p = place(pet);
  ok(p.side !== 'up-right' && p.side !== 'right', `没有硬塞到右边（实际 ${p.side}）`);
  ok(inside(p), '★ 完整落在屏幕工作区内');
  ok(!overlaps(p, pet), '不压住宠物');
  ok(p.x + WIN.w === pet.x + pet.width, '窗口右边缘和宠物右边缘对齐（贴着它）');
}

// ---------- 4. 副屏（工作区有偏移）----------
section('4. 副屏：工作区左上角不是 0,0');
{
  const second = { x: 1707, y: 0, width: 1600, height: 900 };
  const pet = petAt(1707 + 200, 300);
  const p = place(pet, second);
  ok(inside(p, second), `★ 落在副屏工作区内（${p.x},${p.y} · 方位 ${p.side}）`);
  ok(p.x >= second.x, '没有跑到主屏去');
}

// ---------- 5. ★ 负对照：穷举各种位置，永远不越出工作区 ----------
section('5. ★ 负对照：穷举宠物位置和屏幕尺寸，窗口永远不越界');
{
  const screens = [
    { x: 0, y: 0, width: 1707, height: 1067 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1366, height: 768 },
    { x: 1707, y: -300, width: 1600, height: 900 },
    { x: -1080, y: 0, width: 1080, height: 1920 },
    { x: 0, y: 0, width: 600, height: 500 },   // 比窗口还小的极窄屏
  ];
  let checked = 0;
  const bad = [];
  for (const wa of screens) {
    const fit = fitsScreen(wa);
    for (let x = wa.x - 200; x <= wa.x + wa.width + 200; x += 151) {
      for (let y = wa.y - 200; y <= wa.y + wa.height + 200; y += 137) {
        const p = placeNear(petAt(x, y), WIN, wa, { gap: GAP, edge: EDGE });
        checked++;
        const good = fit ? inside(p, wa) : cornerIn(p, wa);
        if (!good) bad.push({ wa, pet: { x, y }, p, fit });
      }
    }
  }
  ok(bad.length === 0, `扫了 ${checked} 种组合，窗口全部落在工作区内（越界 ${bad.length} 处）`);
  for (const b of bad.slice(0, 3)) {
    console.log(`     越界：屏 ${b.wa.x},${b.wa.y} ${b.wa.width}×${b.wa.height} · ` +
      `宠物 ${b.pet.x},${b.pet.y} → ${b.p.x},${b.p.y}`);
  }

  // ★ 第二个负对照：窗口不许「飞到屏幕另一头」。
  //   放不下的时候最怕的实现是「随便挑一个方位」→ 窗口离宠物十万八千里。
  //   这里要求：窗口和宠物之间的缝隙，始终不超过「间距 + 屏幕边距 + 余量」。
  //   （只扫「宠物中心在工作区内」的组合 —— 宠物被拖到屏幕外面是另一种情况，
  //     现实中不会发生，拿它当断言会变成误报。）
  const gapLimit = GAP + EDGE + 20;
  let far = 0;
  let worst = 0;
  let worstCase = null;
  let scanned = 0;
  for (const wa of screens) {
    for (let x = wa.x - PET.width; x <= wa.x + wa.width; x += 173) {
      for (let y = wa.y - PET.height; y <= wa.y + wa.height; y += 149) {
        const pet = petAt(x, y);
        if (!petCenterIn(pet, wa)) continue;
        scanned++;
        const p = placeNear(pet, WIN, wa, { gap: GAP, edge: EDGE });
        const g = rectGap(p, pet);
        if (g > worst) { worst = g; worstCase = { wa, pet, p }; }
        if (g > gapLimit) far++;
      }
    }
  }
  ok(far === 0,
    `扫了 ${scanned} 种组合，窗口始终挨着宠物（最远 ${worst.toFixed(1)}px ≤ 上限 ${gapLimit}px，超限 ${far} 处）`);
  if (worstCase) {
    console.log(`     最远的一处：屏 ${worstCase.wa.width}×${worstCase.wa.height} · ` +
      `宠物 ${worstCase.pet.x},${worstCase.pet.y} → 窗口 ${worstCase.p.x},${worstCase.p.y} · 方位 ${worstCase.p.side}`);
  }
}

// ---------- 6. ★ 负对照：位置必须真的随宠物变化 ----------
section('6. ★ 负对照：宠物移动时窗口跟着动（防止写出「永远返回同一个值」的假实现）');
{
  const a = place(petAt(100, 500));
  const b = place(petAt(700, 100));
  ok(a.x !== b.x || a.y !== b.y, `宠物挪位置，窗口位置跟着变（${a.x},${a.y} → ${b.x},${b.y}）`);
}

// ---------- 7. ★ 负对照：整数 + 不重叠 ----------
section('7. ★ 负对照：整数坐标 + 有地方就不压住宠物');
{
  let allInt = true;
  for (const pet of [petAt(0, 0), petAt(33, 77), petAt(1234, 567), petAt(1706, 1066)]) {
    const p = place(pet);
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) allInt = false;
  }
  ok(allInt, '各种位置算出来都是整数');

  // 宠物在屏幕正中偏左，右边有一大片地方 —— 必须放到它右边而不是压上去
  const mid = petAt(600, 300);
  const p = place(mid);
  ok(!overlaps(p, mid), `宠物在中间时，窗口不压住它（方位 ${p.side}）`);
}

// ---------- 8. 主人这台机器的真实情况 ----------
section('8. 主人这台机器的真实情况（宠物贴在屏幕右下角 1340,650）');
{
  const pet = petAt(1340, 650);
  const p = place(pet);
  console.log(`     结果：${p.x},${p.y} · 方位 ${p.side} · 被挤过=${p.clamped}`);
  ok(inside(p), '★ 完整落在屏幕工作区内');
  ok(p.y + WIN.h <= pet.y, `在宠物上方、不压住它（窗口底 ${p.y + WIN.h} ≤ 宠物顶 ${pet.y}）`);
  ok(p.side.startsWith('up') || p.side.startsWith('above'),
    `方位属于「上方」这一族 → ${p.side}`);
  // 右边和下面都没地方了，那至少要「尽量靠右」，不能缩到屏幕左半边去
  ok(p.x === SCREEN.width - WIN.w - EDGE,
    `已经顶到屏幕允许的最右边（x=${p.x}）`);
  ok(Math.abs((p.x + WIN.w) - (pet.x + pet.width)) < 100,
    `横向离宠物不远（差 ${Math.abs((p.x + WIN.w) - (pet.x + pet.width))}px）`);
}

// ---------- 9. ★ 负对照：屏幕四角 —— 再挤也不能把桌宠盖住 ----------
section('9. ★ 负对照：宠物贴在屏幕四角时，窗口宁可挪开也不许盖住角色');
{
  // 右上角最危险：光看「离靶心最近」会把窗口正好夹到角色身上。
  // 这一条就是当初差点漏掉的坑，必须留着。
  const tr = petAt(1300, 0);
  const a = place(tr);
  console.log(`     右上角 → 窗口 ${a.x},${a.y} · 方位 ${a.side}`);
  ok(!overlaps(a, tr), `★ 没有盖住桌宠（方位 ${a.side}）`);
  ok(inside(a), '完整落在屏幕工作区内');
  ok(rectGap(a, tr) <= GAP + EDGE + 20, `还挨着宠物（缝隙 ${rectGap(a, tr).toFixed(1)}px）`);

  // 左上角：右边一大片地方，应该老实待在角色右边、靠上
  const tl = petAt(0, 0);
  const b = place(tl);
  console.log(`     左上角 → 窗口 ${b.x},${b.y} · 方位 ${b.side}`);
  ok(!overlaps(b, tl), '没有盖住桌宠');
  ok(b.x >= tl.x + tl.width, `在宠物右边（x=${b.x} ≥ ${tl.x + tl.width}）`);
  ok(inside(b), '完整落在屏幕工作区内');
}

// ---------- 10. 宠物停在默认的右下角 ----------
section('10. 宠物停在默认位置（屏幕右下角 1259,639）→ 该贴在它正上方，不该被甩到屏幕左边');
{
  // 这一条是「压住宠物按面积算代价」那个改动的回归哨兵。
  // 宠物停在这里时，「正上方、右对齐」只差 9 像素放不下（窗口底 648 / 宠物顶 639）。
  // 如果「压住就一票否决」，唯一不压住它的方位在屏幕左边（x≈769），
  // 窗口会被甩到 440px 外 —— 那正是主人抱怨的「太远」。
  const pet = petAt(1259, 639);
  const p = place(pet);
  console.log(`     结果：${p.x},${p.y} · 方位 ${p.side}`);

  ok(inside(p), '★ 完整落在屏幕工作区内');
  ok(p.y + WIN.h - pet.y <= 20,
    `★ 贴在宠物正上方（最多压住顶上一点点，实际 ${p.y + WIN.h - pet.y}px）`);
  ok(p.x > SCREEN.width / 2,
    `★ 负对照：没有被甩到屏幕左半边（x=${p.x} > ${Math.round(SCREEN.width / 2)}）`);
  ok(rectGap(p, pet) <= GAP + EDGE + 20, `紧挨着宠物（缝隙 ${rectGap(p, pet).toFixed(1)}px）`);
}

// ---------- 汇总 ----------
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
