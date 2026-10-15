/*
 * scripts/publish-add-coauthor.js —— 发布前一次性工具（不参与运行时）
 *
 * 作用：给每一条提交信息末尾追加两行 Co-authored-by 署名。
 *
 * ── 为什么必须放在最后、且前面空一行 ──
 *   `Co-authored-by` 是 git 的 trailer，必须位于提交信息**最末尾**，
 *   且与正文之间空一行，GitHub 才会把它渲染成协作者。
 *   夹在正文中间的话，它只是一行普通文字，不生效。
 *
 * ── 怎么用 ──
 *   作为 `git filter-branch --msg-filter` 的过滤器：
 *   stdin 拿到一条提交信息，stdout 写回改写后的信息。
 *
 * ── 幂等性 ──
 *   已经含 `Co-authored-by: deepseek` 的直接原样输出，
 *   所以重复跑不会叠加出多份署名。
 */

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  let msg = Buffer.concat(chunks).toString('utf8')

  // 去掉末尾多余空行，统一成一个 \n，方便判断「是否已加过」
  const body = msg.replace(/\s+$/, '')

  if (body.includes('Co-authored-by: deepseek')) {
    // 已经加过了，原样输出（保证幂等）
    process.stdout.write(body + '\n')
    return
  }

  const trailers = [
    'Co-authored-by: deepseek <deepseek@users.noreply.github.com>',
    'Co-authored-by: 我最可爱的大肥鱼 <dafeiyu@users.noreply.github.com>',
  ].join('\n')

  process.stdout.write(body + '\n\n' + trailers + '\n')
})
