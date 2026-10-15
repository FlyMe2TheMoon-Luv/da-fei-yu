/*
 * scripts/publish-strip-coauthor.js —— 发布前一次性工具（不参与运行时）
 *
 * 作用：从提交信息里删掉指定的 Co-authored-by 署名行。
 *
 * ── 为什么不能简单粗暴地全删 ──
 *   `Co-authored-by` 是 git trailer，必须位于提交信息最末尾、与正文空一行。
 *   删掉某几行后，要重新压掉尾部多余空行，否则提交信息末尾会留一串空行
 *   （看起来脏，也容易让后续追加 trailer 时格式错乱）。
 *
 *   本脚本只删「点击名单」里的那两个假邮箱署名，
 *   其它 trailer（比如 WorkBuddy 那条）原样保留。
 *
 * ── 怎么用 ──
 *   作为 `git filter-branch --msg-filter` 的过滤器（需传绝对路径）。
 *
 * ── 幂等性 ──
 *   目标署名已经不存在时原样输出，重复跑不会出错。
 */

// 要删掉的署名：按邮箱匹配（大小写不敏感）
const DROP_EMAILS = [
  'deepseek@users.noreply.github.com',
  'dafeiyu@users.noreply.github.com',
]

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  const msg = Buffer.concat(chunks).toString('utf8')

  // 逐行过滤：凡是 Co-authored-by 且邮箱在删除名单里的，丢掉这一行
  const kept = msg.split('\n').filter((line) => {
    const m = line.match(/^\s*co-authored-by:\s*.*?<([^>]*)>\s*$/i)
    if (!m) return true // 不是 co-author 行，保留
    const email = m[1].trim().toLowerCase()
    return !DROP_EMAILS.includes(email) // 命中的删掉
  })

  // 压掉尾部多余空行，统一以一个 \n 结尾
  const out = kept.join('\n').replace(/\s+$/, '') + '\n'
  process.stdout.write(out)
})
