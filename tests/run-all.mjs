/**
 * 测试总入口：依次跑全部用例，汇总结果。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/run-all.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/run-all.mjs store errors   # 只跑指定几个
 *
 * 为什么用子进程而不是直接 import：每个用例文件结尾都会 process.exit()，
 * 同进程跑会把后面的用例一起终止。子进程还能保证「一个用例崩了不影响其他用例」。
 *
 * 退出码：0 = 全部通过；1 = 有失败或崩溃。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 全部用例（顺序 = 由浅入深：纯逻辑 → 持久化 → 容错 → 路由 → 前端契约）。 */
const ALL = [
  { file: 'selftest.mjs', desc: '扫描 + 纯函数 + 沙盒端到端' },
  { file: 'store.mjs', desc: '持久化（原子写 / 坏文件自愈 / 类型兜底）' },
  { file: 'errors.mjs', desc: '容错（故障注入：坏文件不崩、不写坏盘）' },
  { file: 'routes.mjs', desc: '路由（真 http 打全部接口 + 安全闸门）' },
  { file: 'client_contract.mjs', desc: '前端契约（自注册 / 槽位 / 错误边界）' },
]

// 支持按关键字过滤，方便开发时只跑其中一两个
const want = process.argv.slice(2).map((s) => s.toLowerCase()).filter(Boolean)
const list = want.length
  ? ALL.filter((t) => want.some((w) => t.file.toLowerCase().includes(w)))
  : ALL

if (!list.length) {
  console.log('没有匹配的用例。可用：' + ALL.map((t) => t.file.replace('.mjs', '')).join(', '))
  process.exit(1)
}

const results = []
for (const t of list) {
  const file = join(HERE, t.file)
  process.stdout.write(`\n${'='.repeat(72)}\n▶ ${t.file} —— ${t.desc}\n${'='.repeat(72)}\n`)
  const started = Date.now()
  const r = spawnSync(process.execPath, [file], {
    stdio: 'inherit', // 直接把用例的输出透到终端，失败时能立刻看到哪一条错了
    env: process.env,
    windowsHide: true,
  })
  const ms = Date.now() - started
  const code = r.status == null ? -1 : r.status
  results.push({ ...t, code, ms, signal: r.signal || '' })
}

const bad = results.filter((r) => r.code !== 0)
console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`)
for (const r of results) {
  const tag = r.code === 0 ? 'PASS' : 'FAIL'
  const extra = r.code === 0 ? '' : `（退出码 ${r.code}${r.signal ? ', 信号 ' + r.signal : ''}）`
  console.log(`  ${tag}  ${r.file.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${r.desc}${extra}`)
}
console.log(`\n${bad.length === 0 ? '全部通过' : bad.length + ' 个用例失败'}：${results.length} 个用例，共 ${results.reduce((n, r) => n + r.ms, 0)}ms`)
process.exit(bad.length === 0 ? 0 : 1)
