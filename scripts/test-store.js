// scripts/test-store.js
// 数据读写自检（纯 Node，不 require electron —— 靠 setBaseDir 注入临时目录）
//
// 用法：npm run test:store
//
// ── 为什么值得单独测 ──
//   store.js 存的是**用户的全部数据**（日程、专注黑名单、专注时长预设）。
//   它坏了不会崩，只会「静默地读回空数据」—— 日程没了、黑名单没了，
//   界面上看不出是它干的。所以这里盯四件事：
//     ① 写进去能原样读回来；
//     ② 文件不在 / 内容坏了 → 给兜底值，**绝不抛**；
//     ③ 目录不存在能自己建；
//     ④ 写完不留 .tmp 半成品，写失败要返回 false。
//   （这个模块以前顶部就 require('electron')，普通 Node 里根本 require 不了，
//     所以长期没有自检。批次 4-a 改成延迟解析 + 可注入目录。）
//
// ── 断言原则 ──
//   ① 负对照必须能答上「它怎样才能红」。
//   ② 量绝对量。
//   ③ 报错带数值。

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/main/store');

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

// 全部测试都在这个临时目录里跑，绝不碰真实的 userData
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-selftest-'));
store.setBaseDir(TMP);
const p = (name) => path.join(TMP, name);
const tmpFiles = () => fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'));

try {
  // ---------- 1. 目录 ----------
  section('1. 所有读写都落在注入的目录里（不碰真实 userData）');
  {
    ok(store.fileOf('a.json') === p('a.json'), 'fileOf 拼在注入目录下', store.fileOf('a.json'));
    ok(path.dirname(store.fileOf('a.json')) === TMP, '目录就是注入的那个', TMP);
    ok(store.fileOf('sub/a.json') === p('sub/a.json'), '带子目录的名字也拼得对');
  }

  // ---------- 2. 往返 ----------
  section('2. 写进去能原样读回来（含中文键名 / 嵌套 / 0 与 false）');
  {
    const data = {
      名称: '早会',
      list: [{ id: 1, 标题: '喝水' }, { id: 2, 标题: '' }],
      n: 0,
      neg: -1.5,
      big: 9007199254740991,
      flag: false,
      nil: null,
      nested: { a: { b: { c: [1, 2, 3] } } },
    };
    ok(store.write('rt.json', data) === true, 'write 返回 true');
    const back = store.read('rt.json', 'FALLBACK');
    ok(back !== 'FALLBACK' && back !== null, 'read 读回来了（不是兜底值）');
    ok(JSON.stringify(back) === JSON.stringify(data), '★ 内容和写进去的逐字符一致',
      `写 ${JSON.stringify(data).length} 字符 → 读回 ${JSON.stringify(back).length} 字符`);
    ok(back.名称 === '早会', '中文键名往返正常', back.名称);
    ok(back.n === 0 && back.flag === false && back.nil === null,
      '0 / false / null 都没被当成「空」丢掉',
      `n=${back.n} flag=${back.flag} nil=${back.nil}`);
    ok(back.big === 9007199254740991, '大整数没被截断', String(back.big));
  }

  // ---------- 3. 兜底 ----------
  section('3. 读不到 / 读坏了 → 给兜底值，绝不抛');
  {
    ok(store.read('not-exist.json', 'FALLBACK') === 'FALLBACK', '文件不存在 → 返回兜底值');
    ok(store.read('not-exist.json') === null, '没给兜底值时 → null（不是 undefined）');
    ok(!fs.existsSync(p('not-exist.json')), 'read 不存在的文件不会顺手把它建出来');

    fs.writeFileSync(p('bad.json'), '{ 这不是 JSON', 'utf8');
    let threw = null, got;
    try { got = store.read('bad.json', 'FALLBACK'); } catch (e) { threw = e; }
    ok(threw === null, '★ 内容坏了也不抛异常', threw ? threw.message : '');
    ok(got === 'FALLBACK', '★ 内容坏了 → 返回兜底值', `得到 ${JSON.stringify(got)}`);
    // ★ 负对照：那个文件**确实是坏的** —— 直接解析会抛。
    //   不钉这一条的话，「兜底」可能只是因为文件其实还能解析。
    let rawThrew = false;
    try { JSON.parse(fs.readFileSync(p('bad.json'), 'utf8')); } catch { rawThrew = true; }
    okNeg(rawThrew, '那个文件确实坏到直接 JSON.parse 会抛（上面「兜底」才有意义）');

    fs.writeFileSync(p('empty.json'), '', 'utf8');
    ok(store.read('empty.json', 'FALLBACK') === 'FALLBACK', '空文件 → 兜底（不是抛）');
    // ★ 负对照：空文件也确实解析不了
    let emptyThrew = false;
    try { JSON.parse(''); } catch { emptyThrew = true; }
    okNeg(emptyThrew, '空字符串确实解析不了（说明「空文件 → 兜底」不是白写的）');
  }

  // ---------- 4. 自动建目录 ----------
  section('4. 目录不存在 → 自己建出来（打包后 userData 可能是空的）');
  {
    ok(!fs.existsSync(path.join(TMP, 'deep')), '先确认 deep/ 还不存在');
    ok(store.write('deep/a/b/c.json', { ok: 1 }) === true, '往多层子目录里写成功');
    ok(fs.existsSync(p('deep/a/b/c.json')), '目录被自动建出来了');
    const back = store.read('deep/a/b/c.json', null);
    ok(back && back.ok === 1, '读得回来', JSON.stringify(back));
  }

  // ---------- 5. 原子写 ----------
  section('5. 原子写：不留 .tmp 半成品，覆盖写要整个换掉');
  {
    ok(store.write('atomic.json', { v: 1 }) === true, '写入成功');
    ok(tmpFiles().length === 0, '★ 写完之后没有 .tmp 残留', `残留 ${tmpFiles().join(',') || '(无)'}`);

    ok(store.write('atomic.json', { v: 2, only: true }) === true, '覆盖写成功');
    const back = store.read('atomic.json', null);
    ok(back && back.v === 2 && back.only === true, '覆盖写之后是**新**内容', JSON.stringify(back));
    ok(back && back.v !== 1, '旧内容没有残留', `v=${back && back.v}`);
    ok(tmpFiles().length === 0, '覆盖写之后也没有 .tmp 残留');

    // ★ 负对照：这个「不留 .tmp」的检查本身有效吗？—— 手动放一个 .tmp，它必须看得见。
    fs.writeFileSync(p('probe.json.tmp'), 'x', 'utf8');
    const seen = tmpFiles();
    okNeg(seen.includes('probe.json.tmp'), '检查能发现残留的 .tmp（证明上面那条不是永远为真）',
      `看到 [${seen.join(',')}]`);
    fs.unlinkSync(p('probe.json.tmp'));
  }

  // ---------- 6. 写失败 ----------
  section('6. 写不了 → 返回 false，不抛、不留下半成品');
  {
    // 把「目录」指到一个**文件**上 —— mkdirSync 必然失败
    const blocker = p('blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    store.setBaseDir(blocker);
    let threw = null, r;
    try { r = store.write('x.json', { a: 1 }); } catch (e) { threw = e; }
    ok(threw === null, '写失败时也不抛异常', threw ? threw.message : '');
    ok(r === false, '★ 目录不可用时 write 返回 false', `得到 ${r}`);
    store.setBaseDir(TMP);

    // ★ 负对照：同一段代码在正常目录下是成功的 ——
    //   证明上面那个 false 来自「目录不可用」，不是我调用姿势写错了。
    okNeg(store.write('x.json', { a: 1 }) === true,
      '同一段代码在正常目录下写成功（说明上面那个 false 是目录的问题）');

    const cyc = {}; cyc.self = cyc;
    ok(store.write('cyc.json', cyc) === false, '★ 循环引用 → false（JSON.stringify 会抛，被兜住）');
    ok(store.write('undef.json', undefined) === false, '★ 写 undefined → false');
    ok(!fs.existsSync(p('cyc.json')), '失败的写不会留下目标文件');
    ok(tmpFiles().length === 0, '失败的写也不会留下 .tmp', `残留 ${tmpFiles().join(',') || '(无)'}`);
  }

  // ---------- 7. setBaseDir 边界 ----------
  section('7. 既没注入、也不在 Electron 里 → 明确报错，不静默乱写');
  {
    store.setBaseDir(null);
    let msg = null;
    try { store.fileOf('a.json'); } catch (e) { msg = e.message; }
    ok(msg !== null, '★ 明确抛错（不是静默写到某个目录里）', msg || '(没抛)');
    okNeg(!!msg && /userData|baseDir/.test(msg), '报错说清了原因（负对照：它得是有用的报错）',
      msg || '');
    store.setBaseDir(TMP);
    ok(store.fileOf('a.json') === p('a.json'), '重新注入后恢复正常');
  }
} catch (e) {
  // 自检自身崩了也必须打印结论（CLAUDE.md 自检铁律 7）
  fail++;
  console.log(`\n  ✗ 自检自身抛异常：${e && e.message}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉无所谓 */ }

console.log(`\n负对照：${negPass}/${negTotal} 通过`);
console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (negPass !== negTotal) console.log('⚠️ 负对照没有全部通过，这个自检不算数！');
process.exit(fail === 0 && negPass === negTotal ? 0 : 1);
