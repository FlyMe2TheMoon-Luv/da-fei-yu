// scripts/test-reminder.js
// 阶段 2-3 · 提醒气泡「位置计算」自检
//
// 用法：npm run test:reminder
//
// 为什么只测位置：提醒呈现里唯一「算得出来对错」的就是气泡该放哪 ——
//   气泡真的弹出来了吗、内容画对了吗、点按钮能收吗，这些要真窗口才能验，
//   放在 --selftest=reminder 里做（那个会真的开窗口）。
//   而位置计算是纯数学，最容易写错（屏幕边缘、多显示器、宠物贴边），
//   又最不容易被肉眼发现（差几个像素谁看得出来），所以单独拉出来穷举。
//
// 测试原则（HANDOFF 第六节第 19 条的教训）：
//   不能只挑几个「正常情况」测通过就算完 —— 必须专门测边界和反例，
//   否则算错了也发现不了。下面的 7、8 两节就是干这个的。

const Module = require('module');

// ---------- 把 electron 换成假的 ----------
// reminder.js 顶层 require('electron')，普通 Node 里跑不了。
// 我们只调纯函数 computeBubblePosition，用不到真的 BrowserWindow，
// 所以给几个空壳就够了 —— 关键是别让它去碰真系统。
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      BrowserWindow: class FakeBrowserWindow {},
      ipcMain: { handle() {}, on() {} },
      screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      Notification: class FakeNotification { static isSupported() { return true; } },
    };
  }
  return origLoad.apply(this, arguments);
};

const reminder = require('../src/main/reminder');

const { computeBubblePosition, BUBBLE_W, BUBBLE_H, BUBBLE_GAP } = reminder;

// ---------- 迷你测试框架 ----------
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ← 失败`); }
}
function section(t) { console.log(`\n${t}`); }

const PET = { width: 400, height: 380 }; // 和 main.js 里的 WIN_W / WIN_H 一致
const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };
const EDGE = 4; // reminder.js 里的 BUBBLE_EDGE

const petAt = (x, y) => ({ x, y, width: PET.width, height: PET.height });

console.log('===== 提醒气泡位置自检（阶段 2-3）=====');
console.log(`气泡尺寸 ${BUBBLE_W}×${BUBBLE_H} · 与宠物间距 ${BUBBLE_GAP}`);

// ---------- 1. 常规情况 ----------
section('1. 常规：宠物在屏幕中间 → 气泡放右边');
{
  const pet = petAt(600, 300);
  const p = computeBubblePosition(pet, SCREEN);
  ok(p.x === pet.x + pet.width + BUBBLE_GAP, `气泡左边缘紧贴宠物右侧 + 间距（${p.x} = ${pet.x}+${pet.width}+${BUBBLE_GAP}）`);
  const expectY = pet.y + Math.round(pet.height * 0.22);
  ok(Math.abs(p.y - expectY) <= 1, `气泡竖直对齐宠物头部（y=${p.y}，期望约 ${expectY}）`);
}

// ---------- 2. 宠物贴屏幕右边 → 翻到左边 ----------
section('2. 宠物贴着屏幕右边缘 → 气泡翻到左边（不能跑出屏幕）');
{
  const pet = petAt(SCREEN.width - PET.width - 10, 300);
  const p = computeBubblePosition(pet, SCREEN);
  ok(p.x + BUBBLE_W <= SCREEN.x + SCREEN.width - EDGE, `气泡没越出屏幕右边（${p.x}+${BUBBLE_W} ≤ ${SCREEN.width - EDGE}）`);
  ok(p.x < pet.x, `气泡确实翻到了宠物左边（气泡x=${p.x} < 宠物x=${pet.x}）`);
}

// ---------- 3. 屏幕窄到左右都放不下 → 贴右边缘 ----------
section('3. 极端：屏幕窄到两边都放不下 → 贴着右边缘，但仍在屏幕内');
{
  const narrow = { x: 0, y: 0, width: 600, height: 800 };
  const pet = petAt(100, 200);
  const p = computeBubblePosition(pet, narrow);
  ok(p.x >= narrow.x + EDGE, `气泡没越过屏幕左边（x=${p.x} ≥ ${narrow.x + EDGE}）`);
  ok(p.x + BUBBLE_W <= narrow.x + narrow.width - EDGE, `气泡没越过屏幕右边（${p.x + BUBBLE_W} ≤ ${narrow.x + narrow.width - EDGE}）`);
}

// ---------- 4. 宠物贴上/下边缘 → 竖直方向被夹住 ----------
section('4. 宠物贴着屏幕上下边缘 → 竖直方向被夹住，不越界');
{
  const bottom = computeBubblePosition(petAt(600, SCREEN.height - PET.height), SCREEN);
  ok(bottom.y + BUBBLE_H <= SCREEN.y + SCREEN.height - EDGE, `宠物贴底时气泡不越出下边（${bottom.y}+${BUBBLE_H} ≤ ${SCREEN.height - EDGE}）`);
  ok(bottom.y >= SCREEN.y + EDGE, `宠物贴底时气泡也不越出上边（y=${bottom.y}）`);

  const top = computeBubblePosition(petAt(600, 0), SCREEN);
  ok(top.y >= SCREEN.y + EDGE, `宠物贴顶时气泡不越出上边（y=${top.y} ≥ ${EDGE}）`);
}

// ---------- 5. 副屏（工作区有偏移）----------
section('5. 副屏：工作区左上角不是 0,0 时，气泡要落在副屏里');
{
  // 假设主屏 1920 宽，副屏接在右边：x 从 1920 开始
  const second = { x: 1920, y: 0, width: 1600, height: 900 };
  const pet = petAt(1920 + 200, 300);
  const p = computeBubblePosition(pet, second);
  ok(p.x >= second.x + EDGE, `气泡落在副屏里（x=${p.x} ≥ ${second.x + EDGE}）`);
  ok(p.x + BUBBLE_W <= second.x + second.width - EDGE, `气泡没跑到副屏外面（${p.x + BUBBLE_W} ≤ ${second.x + second.width - EDGE}）`);
}

// ---------- 6. 负对照：随便乱摆，都不该越出工作区 ----------
section('6. ★ 负对照：穷举各种宠物位置，气泡永远不越出工作区');
{
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1366, height: 768 },
    { x: 1920, y: -200, width: 1600, height: 900 },
    { x: -1080, y: 0, width: 1080, height: 1920 },
    { x: 0, y: 0, width: 640, height: 480 }, // 极窄小屏
  ];

  let checked = 0;
  let violations = [];
  for (const a of screens) {
    // 在（略大于）工作区范围内按步长扫一遍宠物左上角
    for (let x = a.x - 100; x <= a.x + a.width + 100; x += 137) {
      for (let y = a.y - 100; y <= a.y + a.height + 100; y += 113) {
        const p = computeBubblePosition(petAt(x, y), a);
        checked++;
        if (p.x < a.x + EDGE || p.y < a.y + EDGE ||
            p.x + BUBBLE_W > a.x + a.width - EDGE ||
            p.y + BUBBLE_H > a.y + a.height - EDGE) {
          violations.push({ screen: a, pet: { x, y }, bubble: p });
        }
      }
    }
  }
  ok(violations.length === 0,
    `扫了 ${checked} 种组合，气泡全部落在工作区内（越界 ${violations.length} 处）`);
  if (violations.length) {
    for (const v of violations.slice(0, 5)) {
      console.log(`     越界：屏 ${v.screen.x},${v.screen.y} ${v.screen.width}×${v.screen.height} · ` +
        `宠物 ${v.pet.x},${v.pet.y} → 气泡 ${v.bubble.x},${v.bubble.y}`);
    }
  }
}

// ---------- 7. ★ 负对照：位置函数必须「真的在动」----------
section('7. ★ 负对照：宠物移动时气泡跟着动（防止写出「永远返回同一个值」的假实现）');
{
  const a = computeBubblePosition(petAt(200, 200), SCREEN);
  const b = computeBubblePosition(petAt(700, 500), SCREEN);
  ok(a.x !== b.x || a.y !== b.y, `宠物挪了位置，气泡位置也跟着变（${a.x},${a.y} → ${b.x},${b.y}）`);
}

// ---------- 8. ★ 负对照：整数坐标 ----------
section('8. ★ 负对照：返回的必须是整数（小数坐标会让窗口位置出现半像素模糊）');
{
  let allInt = true;
  for (const pet of [petAt(0, 0), petAt(33, 77), petAt(1234, 567), petAt(1919, 1079)]) {
    const p = computeBubblePosition(pet, SCREEN);
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) allInt = false;
  }
  ok(allInt, '各种位置算出来都是整数');
}

// ---------- 汇总 ----------
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
