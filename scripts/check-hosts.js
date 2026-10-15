// scripts/check-hosts.js
// 「hosts 到底能不能读」一键体检 —— 给主人排错用。
//
// 用法：
//   npm run check:hosts               检查真实 hosts（默认）
//   npm run check:hosts -- <某个路径>  检查指定文件（自检 / 试错用）
//
// 它**只读，不写、不改、不提权**，随便跑。
//
// 为什么要有它：专注模式要求「先读得到原文，才允许开始」，
// 读不到时界面只会说一句「读不到」。到底是杀软拦了、文件被占了、
// 还是路径不对，光看界面分不出来 —— 这个脚本把系统给的原话打出来。

const ic = require('../src/main/focus/intercept');
const elevator = require('../src/main/focus/elevate');
const hosts = require('../src/main/focus/hosts');

const p = process.argv[2] || elevator.HOSTS_PATH;

console.log('===== hosts 体检 =====');
console.log(`路径：${p}`);

const text = ic.readHostsText(p);

if (text === null) {
  const info = ic.readError();
  console.log('结果：❌ 读不到');
  console.log(`  错误码：${(info && info.code) || '(系统没给)'}`);
  console.log(`  意思：  ${ic.explainReadError(info)}`);
  console.log(`  系统原话：${(info && info.message) || '(无)'}`);
  console.log('');
  console.log('怎么办：');
  console.log('  1) 多半是杀毒 / 安全软件在拦 —— 把项目目录加入它的「信任区」；');
  console.log('  2) 想确认是不是它：临时退出杀软，再跑一次本命令；');
  console.log('  3) 还不行就把上面的「错误码」和「系统原话」发给小安。');
  process.exitCode = 1;
} else {
  const bytes = Buffer.byteLength(text, 'latin1');
  console.log(`结果：✅ 读到了（${text.length} 个字符 / ${bytes} 字节）`);
  if (hosts.hasBlock(text)) {
    console.log('⚠️ 里面还留着专注模式的标记块 —— 上次没正常结束。');
    console.log('   重启桌宠会自动帮你恢复；也可以手动把 BEGIN/END 之间那几行删掉。');
  } else {
    console.log('（没有专注标记块，是干净的）');
  }
}
