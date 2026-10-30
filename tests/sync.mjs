/**
 * 命令行版「一键同步」—— 跟设置页里那个按钮走的是同一份代码（lib/scan.js）。
 * 适合在 DSH 没开着、或者想先在终端看一遍再动手的时候用。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/sync.mjs           # 只看计划
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/sync.mjs --apply   # 真写（先备份）
 *
 * 退出码：0 = 无需改动或成功；1 = 有阻塞项；2 = 写入失败
 */
import { scanConfig, scanRefs, planSync, applySync } from '../lib/scan.js'

const APPLY = process.argv.includes('--apply')
const cfg = scanConfig()
const refs = scanRefs(cfg, null)
const plan = planSync(cfg, refs)

console.log(`DSH_HOME = ${cfg.home}`)
console.log(`profiles = ${cfg.profiles.map((p) => p.name).join(', ')}`)
console.log(`引用 ${refs.refs.length} 处，悬空 ${refs.dangling.length} 处，缺定义 ${refs.missing.length} 处\n`)

if (!plan.actions.length) {
  console.log('没有需要补的定义。')
  for (const b of plan.blocked) console.log(`  跳过 ${b.provider} @${b.profile || '-'}：${b.why}`)
  process.exit(plan.blocked.length ? 1 : 0)
}

for (const a of plan.actions) {
  console.log(`[计划] ${a.profile}  ← +${a.add.map((x) => x.name + '(取自 ' + x.from + ')').join(', ')}`)
  console.log(`       文件：${a.file}`)
  for (const x of a.add) console.log(`       触发：${x.refFile}:${x.refLine}`)
}
for (const b of plan.blocked) console.log(`[跳过] ${b.provider} @${b.profile || '-'}：${b.why}`)

if (!APPLY) {
  console.log('\n（只预演，没写盘。要真写加 --apply）')
  process.exit(0)
}

const receipts = applySync(cfg, plan.actions)
let bad = 0
console.log('')
for (const r of receipts) {
  if (!r.ok) { bad++; console.log(`[失败] ${r.profile}：${r.why}`); continue }
  if (r.skipped) { console.log(`[跳过] ${r.profile}：${r.why}`); continue }
  console.log(`[写入] ${r.profile}：+${(r.added || []).join(', ')}${r.entryCreated ? '（新建了 llm-pi-ai 整块）' : ''}`)
  console.log(`       备份：${r.backup}`)
}
if (bad === 0) console.log('\n改完要重启 DSH 才生效（loader 不热读 cordis.patch.yml）。')
process.exit(bad ? 2 : 0)
