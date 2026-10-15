// scripts/test-changed.js
// 「按改动挑自检」——只跑跟这次改动有关的套件，别每次全量。
//
// 用法：
//   npm run test:changed                 看这次改了什么，只跑受影响的套件
//   npm run test:changed -- --list       只列清单，不真跑（先看一眼再决定）
//   npm run test:changed -- --base=4afa448   拿某个提交当基线（默认 HEAD，即未提交的改动）
//   npm run test:changed -- --pure       只跑纯 Node 的（跳过真渲染进程 / 端到端，最快）
//   npm run test:changed -- --list --files=src/main/focus/hosts.js
//                                        预演：不改 git，直接问「改了这些会跑哪些」
//   npm run test:all                     全量（批次收尾 / 提交前用）
//
// ── 为什么要有这个 ──
//   以前每改一行都全量跑，20 多套、其中好几套要真开 Electron，一轮好几分钟。
//   但**已经验过的功能没必要每次都重验** —— 只有「这次碰到的模块」对应的套件才需要重跑。
//   这个脚本就是把「改了什么文件」翻译成「该跑哪几套」。
//
// ── 但它不是「省掉自检」的借口，两条铁律还在 ──
//   ① **批次收尾 / 提交前必须全量**（`npm run test:all`）—— 挑着跑是给内循环省时间的，
//      不是给交付省事的。
//   ② **碰到「交叉件」一律全量**：`main.js` / `package.json` / `start-dev.js` 一改，
//      几乎每个套件都可能被牵动，挑着跑就是自欺欺人（脚本会自动升级成全量并说明原因）。
//   ③ 改了**新文件**（规则表里没登记）→ 脚本会报出来并建议全量，不会静默漏掉。
//
// ── 它只读、只跑测试 ──
//   不写任何文件、不动系统、不提权。

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────
// 一、影响映射表：每个套件「管」哪些源码文件
//    kind: node = 纯 Node 快测 / ui = 真渲染进程（自己开 Electron）/ e2e = start-dev 端到端
//    covers 里是路径前缀；写 `目录/` 表示整个目录都算。
//    ★ 新加套件记得回来登记，否则它永远不会被挑中（只能靠 test:all 跑到）。
// ─────────────────────────────────────────────────────────────
const SUITES = {
  // —— 数据 / 调度层 ——
  'test:schedules': { kind: 'node', desc: '日程数据层（增删改查 / 校验）', covers: ['src/main/schedules.js'] },
  'test:scheduler': { kind: 'node', desc: '调度轮询引擎', covers: ['src/main/scheduler.js', 'src/main/schedules.js'] },
  'test:reminder': { kind: 'node', desc: '提醒判定（补提醒窗口）', covers: ['src/main/reminder.js'] },
  'test:place': { kind: 'node', desc: '窗口摆位（纯函数）', covers: ['src/main/place.js'] },
  'test:week': { kind: 'node', desc: '周视图布局数学（纯函数）', covers: ['src/main/week.js', 'src/main/schedules.js'] },
  'test:nl-time': { kind: 'node', desc: '自然语言时间解析', covers: ['src/main/nl-time.js'] },
  'test:spring': { kind: 'node', desc: '手写弹簧（可打断 / 速度衔接 / 帧率无关）', covers: ['src/main/spring.js'] },
  'test:rubberband': { kind: 'node', desc: '橡皮筋边界（渐进阻力）', covers: ['src/main/rubberband.js'] },

  // —— 聊天大脑 ——
  'test:brain-local': { kind: 'node', desc: '本地聊天规则', covers: ['src/main/brain/local.js'] },
  'test:brain-cloud': { kind: 'node', desc: '云端聊天（含 Key 掩码）', covers: ['src/main/brain/cloud.js', 'src/main/ai-config.js'] },
  'test:brain-router': { kind: 'node', desc: '聊天路由（本地→云端→降级）', covers: ['src/main/brain/index.js', 'src/main/schedules.js'] },

  // —— 专注模式（纯函数部分）——
  'test:focus-blacklist': { kind: 'node', desc: '黑名单纯函数', covers: ['src/main/focus/blacklist.js'] },
  'test:focus-timer': { kind: 'node', desc: '专注计时状态机（canExit 唯一裁定处）', covers: ['src/main/focus/timer.js'] },
  'test:focus-hosts': { kind: 'node', desc: 'hosts 文本操作 + DoH 三态', covers: ['src/main/focus/hosts.js', 'src/main/focus/doh.js'] },
  'test:focus-elevate': { kind: 'node', desc: '提权壳', covers: ['src/main/focus/elevate.js'] },
  'test:focus-helper': { kind: 'node', desc: '提权助手 .ps1（真跑，但不提权）', covers: ['src/main/focus-helper.ps1', 'src/main/focus/hosts.js'] },
  'test:focus-intercept': { kind: 'node', desc: '拦截状态 + 读失败原因', covers: ['src/main/focus/intercept.js', 'src/main/focus/hosts.js'] },
  'test:focus-wiring': { kind: 'node', desc: '接线/默认值守门员（专抓「自检全绿真机挂」）', covers: ['src/main/focus/index.js', 'src/main/focus/elevate.js'] },
  'test:apps': { kind: 'node', desc: '已安装软件扫描（解析 lnk / 过滤）', covers: ['src/main/apps.js', 'src/main/focus/blacklist.js'] },

  // —— 真渲染进程（自己开 Electron，但不碰系统）——
  'test:picker-ui': { kind: 'ui', desc: '软件选择器（先勾后存 / 无障碍）', covers: ['src/renderer/settings/', 'src/main/apps.js', 'src/main/focus/blacklist.js', 'src/main/preload-settings.js'] },
  'test:focus-stop-ui': { kind: 'ui', desc: '退出专注长按进度条', covers: ['src/renderer/settings/', 'src/main/preload-settings.js', 'src/main/focus/timer.js'] },
  'test:quit': { kind: 'ui', desc: '停止桌宠（真启动第二个实例）', covers: ['launcher/', 'scripts/make-launcher.js'] },

  // —— Electron 端到端 ——
  'test:settings-e2e': { kind: 'e2e', desc: '设置窗口端到端', covers: ['src/main/settings-window.js', 'src/renderer/settings/', 'src/main/preload-settings.js'] },
  'test:focusmode-e2e': { kind: 'e2e', desc: '专注模式端到端（真走长按路径）', covers: ['src/main/focus/', 'src/main/focus-helper.ps1', 'src/main/focus-notice.js', 'src/renderer/notice/', 'src/main/preload-notice.js', 'src/main/selftest-focusmode.js'] },
  'test:reminder-e2e': { kind: 'e2e', desc: '提醒气泡端到端', covers: ['src/main/reminder.js', 'src/renderer/bubble/', 'src/main/preload-bubble.js'] },
  'test:chat-e2e': { kind: 'e2e', desc: '聊天条端到端', covers: ['src/main/chat-window.js', 'src/renderer/chat/', 'src/main/preload-chat.js', 'src/main/selftest-chat.js', 'src/main/brain/'] },
  'test:week-e2e': { kind: 'e2e', desc: '周视图端到端', covers: ['src/main/week.js', 'src/main/selftest-week.js'] },
  'test:scheduler-e2e': { kind: 'e2e', desc: '调度端到端（要等 30 秒轮询）', covers: ['src/main/scheduler.js'] },
  'test:focus': { kind: 'e2e', desc: '窗口焦点自检（⚠ 不是专注模式）', covers: ['src/main/settings-window.js', 'src/main/focus-notice.js'] },
  'test:sync': { kind: 'e2e', desc: '#ui 对齐哨兵（控件跟角色别错位）', covers: ['src/renderer/pet/', 'src/main/preload.js'] },
  'test:gaze': { kind: 'e2e', desc: '视线跟随', covers: ['src/renderer/pet/', 'src/main/preload.js'] },
  'test:exit': { kind: 'e2e', desc: '退出按钮（⚠ 会真的退出，正常）', covers: ['src/renderer/pet/', 'src/main/preload.js'] },
  'test:drag': { kind: 'e2e', desc: '拖拽性能基准（只印测量值，不算通过/失败）', covers: ['src/renderer/pet/', 'src/main/place.js'] },
};

// ─────────────────────────────────────────────────────────────
// 二、交叉件：碰到这些就**别再挑了**，直接全量
//    （它们被谁 require 太多，挑着跑 = 假绿）
// ─────────────────────────────────────────────────────────────
const CROSS_CUTTING = [
  { path: 'src/main/main.js', why: '入口：所有窗口 + 自检分发都在这儿' },
  { path: 'package.json', why: '依赖 / 脚本本身变了' },
  { path: 'scripts/start-dev.js', why: '所有端到端的启动方式都走它' },
];

// 文档类改动不影响任何自检（改 md 不用跑测试）
const IGNORE = [/^\.workbuddy-ai\//, /^tmp\//, /^outputs\//, /^design\//, /\.md$/i, /^\.gitignore$/, /^LICENSE/];

// ─────────────────────────────────────────────────────────────
// 三、拿改动清单
//    ★ 用异步 spawn，**不能用 spawnSync**：
//      · spawnSync 在受限环境（沙箱）里会直接 EBUSY；
//      · 更坏的是——如果它只 return [] 兜底，这个脚本就会**静默地一套都不跑**，
//        看起来「全绿」，实际什么都没验。所以起不来必须**抛错**，绝不能兜底成空。
// ─────────────────────────────────────────────────────────────
function gitSpawn(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {}); // git 的警告不进汇总
    child.on('error', (e) => reject(new Error(`执行 ${bin} 失败：${e.message}`)));
    child.on('close', (code) => {
      // 退出码非 0 = 这个 ref 不存在之类的正常情况，当空处理
      if (code !== 0) return resolve([]);
      resolve(out.split('\n').map((s) => s.trim()).filter(Boolean));
    });
  });
}

async function changedFiles(base) {
  const set = new Set();
  // 已跟踪的改动（含已 add 的）：跟 base 比
  for (const f of await gitSpawn('git', ['diff', '--name-only', base])) set.add(f);
  // 未跟踪的新文件
  for (const f of await gitSpawn('git', ['ls-files', '--others', '--exclude-standard'])) set.add(f);
  return [...set].map((f) => f.replace(/\\/g, '/'));
}

function matches(file, prefix) {
  if (prefix.endsWith('/')) return file.startsWith(prefix);
  return file === prefix || file.startsWith(prefix);
}

// ─────────────────────────────────────────────────────────────
// 四、算受影响套件（纯函数：改动清单由外面传进来，好单测）
// ─────────────────────────────────────────────────────────────
function plan(files, opts = {}) {
  const relevant = files.filter((f) => !IGNORE.some((re) => re.test(f)));

  const cross = [];
  for (const f of relevant) {
    const hit = CROSS_CUTTING.find((c) => matches(f, c.path));
    if (hit) cross.push({ file: f, why: hit.why });
  }

  const picked = new Map(); // suite -> 触发它的文件
  const unknown = [];
  const tooling = [];
  for (const f of relevant) {
    let hit = false;
    for (const [name, s] of Object.entries(SUITES)) {
      if (s.covers.some((c) => matches(f, c))) {
        hit = true;
        if (!picked.has(name)) picked.set(name, []);
        picked.get(name).push(f);
      }
    }
    if (hit) continue;
    if (CROSS_CUTTING.some((c) => matches(f, c.path))) continue;
    // 只有 src/ 下的**产品代码**没登记才值得报警（漏了它就等于漏测）
    if (/^src\//.test(f)) unknown.push(f);
    // scripts/ 下没登记的是开发工具本身，安静记一笔就行
    else if (/^scripts\//.test(f)) tooling.push(f);
  }

  const full = cross.length > 0 || opts.all;
  let list = full ? Object.keys(SUITES) : [...picked.keys()];
  if (opts.pure) list = list.filter((n) => SUITES[n].kind === 'node');

  return { files, relevant, cross, picked, unknown, tooling, full, list };
}

// ─────────────────────────────────────────────────────────────
// 五、跑 + 统一汇总
//    ⚠ 各套件收尾格式不统一（有的印「结果：」有的印「结束：」），
//      所以这里用正则一起收，而不是 grep 一种。
//    ⚠ 用异步 spawn 直接起进程，**不经过 npm**：
//      · npm 每套要额外起一次 node，20 套就白等十几秒；
//      · `shell:true` 在 Windows 上要走 cmd.exe，沙箱里直接被拦（EBUSY）。
//      命令从 package.json 现读，`node xxx` 一律换成当前 node 解释器。
// ─────────────────────────────────────────────────────────────
const SUMMARY_RE = /(?:结果|结束)：\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/;
const NO_SUMMARY = new Set(['test:drag']); // 性能基准，只印测量值

const SCRIPTS = require('../package.json').scripts;

function commandOf(name) {
  const cmd = SCRIPTS[name];
  if (!cmd) throw new Error(`package.json 里没有 ${name}`);
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] === 'node') return { bin: process.execPath, args: parts.slice(1) };
  return { bin: parts[0], args: parts.slice(1) };
}

// 判定「这一套算不算过」——单独抽成纯函数，好让 --selfcheck 拿假输出验它
function judge({ name, code, out, timedOut, spawnErr }) {
  let pass = null, fail = null;
  const m = out.match(SUMMARY_RE);
  if (m) { pass = +m[1]; fail = +m[2]; }
  const noSummary = NO_SUMMARY.has(name);
  // 退出码和收尾行**两个都要看**：任一不对就是红
  const ok = !timedOut && !spawnErr && code === 0 && (fail === null || fail === 0);
  return { pass, fail, noSummary, ok };
}

function runSuite(name, timeoutMs) {
  return new Promise((resolve) => {
    const { bin, args } = commandOf(name);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 和 start-dev.js 一样先拆掉这个开关

    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    let done = false;
    const child = spawn(bin, args, { cwd: ROOT, env });

    // 长套件（端到端要开窗口）看着像卡住，每 10 秒点一个点
    const beat = setInterval(() => process.stdout.write('.'), 10000);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    const eat = (d) => { out += d; };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);

    const finish = (code, spawnErr) => {
      if (done) return;
      done = true;
      clearInterval(beat);
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const verdict = judge({ name, code, out, timedOut, spawnErr });
      const note = timedOut ? `超时（>${timeoutMs / 1000}s）` : (spawnErr ? `起不来：${spawnErr.message}` : '');
      resolve({ name, ms, timedOut, note, raw: out, ...verdict });
    };

    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
}

// ─────────────────────────────────────────────────────────────
// 六、自检这个挑选器自己（--selfcheck）
//    这个脚本本身就是「用来省自检的」，如果它自己判错了，后果是「该跑的没跑」
//    —— 比没有它更危险。所以它的判定逻辑和挑选逻辑都得能被验，且必须带负对照。
//    纯内存，不起任何进程。
// ─────────────────────────────────────────────────────────────
async function selfcheck() {
  let pass = 0, fail = 0, neg = 0, negFail = 0;
  const check = (cond, label, negative = false, detail = '') => {
    if (negative) { neg++; if (!cond) negFail++; }
    cond ? pass++ : fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${negative ? '[负对照] ' : ''}${label}${detail ? `  ${detail}` : ''}`);
  };
  const J = (o) => judge({ name: 'test:x', code: 0, out: '', timedOut: false, spawnErr: null, ...o });

  console.log('=== A. 收尾行判定 ===');
  // 「结果：」格式
  let v = J({ out: '===== 结果：10 通过 / 0 失败 =====' });
  check(v.ok && v.pass === 10 && v.fail === 0, '「结果：」全绿 → ok，且数对了', false, `pass=${v.pass} fail=${v.fail} ok=${v.ok}`);
  // 「结束：」格式（各套件收尾格式不统一，两种都要认）
  v = J({ out: '===== 结束：7 通过 / 0 失败 =====' });
  check(v.ok && v.pass === 7, '「结束：」全绿 → ok，数也对', false, `pass=${v.pass}`);
  // ★ 负对照：有失败必须判红
  v = J({ out: '===== 结果：5 通过 / 2 失败 =====' });
  check(!v.ok && v.fail === 2, '有 2 条失败 → 判红（负对照：它红才算对）', true, `ok=${v.ok} fail=${v.fail}`);
  // ★ 负对照：退出码非 0 但文字全绿 → 仍要判红（不能只看文字）
  v = J({ code: 1, out: '===== 结果：9 通过 / 0 失败 =====' });
  check(!v.ok, '退出码 1 但文字全绿 → 仍判红（退出码也要看）', true, `ok=${v.ok}`);
  // 负对照：超时 → 红
  v = J({ timedOut: true, out: '===== 结果：9 通过 / 0 失败 =====' });
  check(!v.ok, '超时 → 判红（即使文字全绿）', true, `ok=${v.ok}`);
  // 负对照：进程起不来 → 红
  v = J({ spawnErr: new Error('boom') });
  check(!v.ok, '进程起不来 → 判红', true, `ok=${v.ok}`);
  // 基准套件没有收尾行：退出码 0 时算过，但 pass 记 null（不能假装 0 通过）
  v = J({ name: 'test:drag', out: '测量值...' });
  check(v.ok && v.pass === null && v.noSummary, '基准套件无收尾行 → 算过，但 pass=null', false, `pass=${v.pass}`);

  console.log('\n=== B. 改动 → 套件 挑选 ===');
  const P = (files) => plan(files, {});
  // 只改 hosts.js：应挑中 hosts 相关，且**不能**挑中无关的
  let p = P(['src/main/focus/hosts.js']);
  check(p.list.includes('test:focus-hosts'), '改 hosts.js → 挑中 test:focus-hosts', false, p.list.join(','));
  check(p.list.includes('test:focus-intercept') && p.list.includes('test:focus-helper'),
    '改 hosts.js → 连带 focus-intercept / focus-helper', false, p.list.join(','));
  check(!p.list.includes('test:place') && !p.list.includes('test:week'),
    '改 hosts.js → 不许挑中无关的 place / week（负对照）', true, p.list.join(','));
  check(!p.full, '改 hosts.js → 不升级全量', false);
  // 只改设置页：应挑中三套界面相关的
  p = P(['src/renderer/settings/index.html']);
  check(['test:settings-e2e', 'test:picker-ui', 'test:focus-stop-ui'].every((n) => p.list.includes(n)),
    '改设置页 → 挑中 settings-e2e / picker-ui / focus-stop-ui', false, p.list.join(','));
  // ★ 负对照：交叉件必须升级全量
  p = P(['src/main/main.js']);
  check(p.full && p.list.length === Object.keys(SUITES).length,
    '改 main.js（交叉件）→ 升级全量（负对照：不许只挑几套）', true, `full=${p.full} n=${p.list.length}`);
  p = P(['package.json']);
  check(p.full, '改 package.json → 升级全量（负对照）', true, `full=${p.full}`);
  // 纯文档改动 → 一套都不跑
  p = P(['HANDOFF-V4.md', 'CLAUDE.md']);
  check(p.list.length === 0 && p.relevant.length === 0, '只改文档 → 一套都不跑', false, `n=${p.list.length}`);
  // ★ 负对照：源码里的新文件没登记 → 必须被报出来（不许静默漏掉）
  p = P(['src/main/brand-new-thing.js']);
  check(p.unknown.includes('src/main/brand-new-thing.js'), '没登记的源码新文件 → 被报为 unknown（负对照：不许静默）', true, JSON.stringify(p.unknown));
  // --pure 只留纯 Node
  p = plan(['src/renderer/settings/index.html'], { pure: true });
  check(p.list.length === 0, '--pure 下设置页（只有 ui/e2e 覆盖）→ 为空', false, p.list.join(','));

  console.log('\n=== C. git 那条路也要真走一遍 ===');
  // ★ 这一节是被真事逼出来的：上面全绿，但「忘了 import」让真跑直接崩。
  //   所以自检里必须真的调用一次读 git 的函数，不能只测纯逻辑。
  let files = null, threw = null;
  try { files = await changedFiles('HEAD'); } catch (e) { threw = e; }
  check(threw === null && Array.isArray(files),
    'changedFiles() 能跑通不抛异常', false, threw ? threw.message : `改动 ${files.length} 个`);
  // ★ 负对照：git 起不来时必须**抛错**，不许兜底成空数组
  //   （兜底成空 = 脚本会静默地一套都不跑，比崩掉更危险）
  let boom = null;
  try { await gitSpawn('definitely-not-a-real-binary-xyz', ['--version']); } catch (e) { boom = e; }
  check(boom !== null, 'git 起不来 → 必须抛错（负对照：不许静默返回空）', true,
    boom ? boom.message : '(居然没抛 —— 那会静默跳过所有自检)');
  // ★ 负对照：映射表里登记的命令，package.json 里必须真的有
  const missing = Object.keys(SUITES).filter((n) => !SCRIPTS[n]);
  check(missing.length === 0, 'SUITES 里每个套件在 package.json 里都有对应脚本（负对照）', true, missing.join(',') || '(无缺)');

  console.log(`\n===== 挑选器自检：${pass} 通过 / ${fail} 失败 · 负对照 ${neg - negFail}/${neg} =====`);
  return fail === 0 && negFail === 0 ? 0 : 1;
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return selfcheck();
  const opts = {
    list: argv.includes('--list'),
    all: argv.includes('--all'),
    pure: argv.includes('--pure'),
  };
  const baseArg = argv.find((a) => a.startsWith('--base='));
  const base = baseArg ? baseArg.slice('--base='.length) : 'HEAD';
  const toArg = argv.find((a) => a.startsWith('--timeout='));
  const timeoutMs = toArg ? Math.max(5, parseInt(toArg.slice('--timeout='.length), 10) || 300) * 1000 : 300 * 1000;
  // 调试/预演用：直接给一份文件清单，问「改了这些会跑哪些」，不碰 git。
  //   npm run test:changed -- --list --files=src/main/focus/hosts.js
  const filesArg = argv.find((a) => a.startsWith('--files='));
  if (filesArg) opts.files = filesArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);

  console.log('==============================================');
  console.log(' 按改动挑自检（scripts/test-changed.js）');
  console.log('==============================================');

  let files;
  try {
    files = opts.files || await changedFiles(base);
  } catch (e) {
    // ★ 读不到改动就**绝不能假装没改动**（那等于静默跳过所有自检）
    console.error(`\n❌ 读 git 改动失败：${e.message}`);
    console.error('   → 挑不出来就别挑了，直接全量：npm run test:all');
    return 2;
  }

  const p = plan(files, opts);

  console.log(`\n基线：${base}   改动文件：${p.files.length} 个（其中影响自检的 ${p.relevant.length} 个）`);
  if (p.files.length === 0) {
    console.log('   （没有改动 —— 想全量请用 npm run test:all）');
  } else {
    for (const f of p.files) {
      const mark = p.relevant.includes(f) ? '  ' : '  (忽略)';
      console.log(`${mark} ${f}`);
    }
  }

  if (p.cross.length) {
    console.log('\n⚠ 碰到交叉件 → 升级为全量：');
    for (const c of p.cross) console.log(`   · ${c.file}  （${c.why}）`);
  }
  if (p.unknown.length) {
    console.log('\n⚠ 这些**产品源码**没登记在任何套件的覆盖范围里：');
    for (const f of p.unknown) console.log(`   · ${f}`);
    console.log('   → 要么给它补一条映射（改本文件顶部的 SUITES），要么直接跑 npm run test:all。');
  }
  if (p.tooling.length) {
    console.log('\n（开发工具脚本，不参与挑选）');
    for (const f of p.tooling) console.log(`   · ${f}`);
  }

  console.log(`\n计划跑 ${p.list.length} 套：`);
  for (const n of p.list) {
    const s = SUITES[n];
    const why = p.picked.get(n);
    console.log(`   [${s.kind}] ${n}  —  ${s.desc}${why ? `   ← ${why.join(', ')}` : ''}`);
  }

  if (opts.list) { console.log('\n（--list：只列清单，没真跑）'); return 0; }
  if (p.list.length === 0) { console.log('\n没有需要跑的套件。'); return 0; }

  console.log('\n----------------------------------------------');
  const results = [];
  for (const n of p.list) {
    process.stdout.write(`\n▶ ${n} ... `);
    const res = await runSuite(n, timeoutMs);
    results.push(res);
    const tail = res.noSummary
      ? '(基准，看测量值)'
      : (res.pass === null ? '(没读到收尾行)' : `${res.pass} 通过 / ${res.fail} 失败`);
    console.log(`${res.ok ? 'OK' : 'FAIL'}  ${tail}${res.note ? `  [${res.note}]` : ''}  ${(res.ms / 1000).toFixed(1)}s`);
    if (!res.ok) {
      // 失败时把最后 25 行贴出来，省得再去翻日志
      const lines = res.raw.trim().split('\n');
      for (const l of lines.slice(-25)) console.log(`      | ${l}`);
    }
  }

  console.log('\n==============================================');
  console.log(' 汇总');
  console.log('==============================================');
  let bad = 0, totalPass = 0, totalFail = 0;
  for (const r of results) {
    const tail = r.noSummary ? '基准' : (r.pass === null ? '无收尾行' : `${r.pass}/${r.fail}`);
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(24)} ${tail}`);
    if (!r.ok) bad++;
    if (r.pass !== null) { totalPass += r.pass; totalFail += r.fail; }
  }
  console.log(`\n套件：${results.length - bad} 绿 / ${bad} 红  ·  断言：${totalPass} 通过 / ${totalFail} 失败`);
  console.log(bad === 0 ? '\n✅ 挑出来的套件全绿。' : '\n❌ 有套件红了，别提交。');
  if (!p.full) console.log('（这是「挑着跑」的结果 —— 批次收尾请再跑一次 npm run test:all）');

  return bad === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  // 自检崩了也必须打印结论（本项目血泪铁律）
  console.error('\n❌ 挑选器自身抛异常：', e && e.stack || e);
  process.exit(2);
});
