// scripts/patch-model-expressions.js
// 把 model/expressions/*.exp3.json 注册进 model3.json 的 FileReferences.Expressions。
//
// 为什么需要这个：
//   Cubism 规范里，模型有哪些表情是在 model3.json 的 FileReferences.Expressions 里声明的。
//   但这个模型（Andersen216/dsh-whale-girl-live2d）的 model3.json **漏了这一节** ——
//   表情文件都在，就是没登记。后果是 pixi-live2d-display 一个表情都加载不到，
//   于是 model.expression('爱心眼') 不报错、但什么也不做（静默空操作，特别坑）。
//
//   本脚本按目录扫描重新登记一遍，幂等，可以重复跑。
//
// 用法：
//   node scripts/patch-model-expressions.js
//
// ⚠️ 这会修改第三方素材文件。按 CC BY-NC-SA 4.0 的「署名」要求，
//    必须说明「素材被修改过」—— 已在 CREDITS.md 里注明。

const fs = require('fs');
const path = require('path');

const MODEL_DIR = path.join(__dirname, '..', 'src', 'renderer', 'pet', 'model');
const MODEL3 = path.join(MODEL_DIR, 'c_0120.model3.json');
const EXP_DIR = path.join(MODEL_DIR, 'expressions');

if (!fs.existsSync(MODEL3)) {
  console.error(`✗ 找不到 ${path.relative(process.cwd(), MODEL3)}`);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(MODEL3, 'utf8'));
settings.FileReferences = settings.FileReferences || {};

// 扫描表情目录，按文件名排序（保证每次跑出来结果一致）
const files = fs
  .readdirSync(EXP_DIR)
  .filter((f) => f.endsWith('.exp3.json'))
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

const before = (settings.FileReferences.Expressions || []).length;

settings.FileReferences.Expressions = files.map((f) => ({
  Name: f.replace(/\.exp3\.json$/, ''), // 名字就是文件名（去掉后缀）
  File: `expressions/${f}`,
}));

fs.writeFileSync(MODEL3, JSON.stringify(settings, null, 4) + '\n', 'utf8');

console.log(`✓ 已登记 ${files.length} 个表情到 c_0120.model3.json（原来 ${before} 个）`);
console.log('');
console.log('表情清单：');
for (let i = 0; i < files.length; i += 4) {
  console.log('  ' + files.slice(i, i + 4).map((f) => f.replace(/\.exp3\.json$/, '')).join('  ·  '));
}
