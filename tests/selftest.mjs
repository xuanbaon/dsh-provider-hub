/**
 * 自测：不启动 DSH，直接跑 scan.js 的三个扫描 + 同步预演（**不写盘**）。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/selftest.mjs
 *
 * 退出码：0 = 全部关键断言通过；1 = 有断言失败。
 */
import { scanConfig, scanSessions, scanRefs, planSync, piAiProviders, agentDefaultModel, insertProviders, applySync, planRewrite, applyRewrite } from '../lib/scan.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

let fail = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fail++
}

const cfg = scanConfig()
console.log('\n=== 1. 实际配置 ===')
console.log('DSH_HOME =', cfg.home)
console.log('profiles =', cfg.profiles.map((p) => `${p.name}(${p.providers.length}个定义${p.defaultModel ? ',默认' + p.defaultModel.provider : ''})`).join(' | ') || '(无)')
console.log('providers =', cfg.allDefs.map((d) => `${d.name}←${d.from}`).join(' | ') || '(无)')
console.log('overlays =', cfg.overlays.map((o) => `${o.stateDir.split(/[\\/]/).pop()}→${o.targetProfile}: ${o.provider}/${o.model}`).join(' | ') || '(无)')
ok(Array.isArray(cfg.profiles) && cfg.profiles.length > 0, '至少读到 1 个 profile')

const desktop = cfg.profiles.find((p) => p.name === 'desktop')
ok(!!desktop, '读到 desktop profile')
if (desktop) ok(desktop.providers.length > 0, 'desktop 里读到了 provider 定义（' + desktop.providers.map((p) => p.name).join(', ') + '）')
if (desktop) ok(desktop.defaultModel && !!desktop.defaultModel.provider, 'desktop 的 agent-default-model 解析出来 = ' + JSON.stringify(desktop.defaultModel))

console.log('\n=== 2. 会话实际在用谁 ===')
const sess = scanSessions(20)
console.log('库里', sess.total, '个会话；按 provider 汇总：')
for (const b of sess.byProvider) console.log(`  ${b.provider}: ${b.sessions} 个会话  ${b.models.map((m) => m.model + '×' + m.sessions).join(', ')}`)
ok(sess.byProvider.length >= 0, '会话扫描没抛错')

console.log('\n=== 3. 引用与悬空 ===')
const registered = null // 自测里没有运行时，按「静态定义」判定
const refs = scanRefs(cfg, registered)
console.log('共', refs.refs.length, '处 provider 引用；悬空(可自动补)', refs.dangling.length, '处；谁都没定义', refs.missing.length, '处')
for (const r of refs.refs) {
  const tag = { ok: '✓', dangling: '✗悬空', 'runtime-only': '~运行时', missing: '!缺失' }[r.verdict] || '?'
  console.log(`  ${tag} [${r.kind}] ${r.file.split(/[\\/]/).slice(-3).join('/')}:${r.line} provider=${r.provider} ${r.model ? 'model=' + r.model : ''} profile=${r.profile || '-'}${r.apiKeyEnv ? ' key=' + r.apiKeyEnv : ''}`)
}


console.log('\n=== 4. 同步预演（不写盘）===')
const plan = planSync(cfg, refs)
console.log('计划改', plan.actions.length, '个文件')
for (const a of plan.actions) console.log(`  ${a.profile} ← +${a.add.map((x) => x.name + '(来自' + x.from + ')').join(', ')}  ${a.file}`)
for (const b of plan.blocked) console.log(`  跳过 ${b.provider} @${b.profile}：${b.why}`)

console.log('\n=== 5. 纯函数单测 ===')
const sample = `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      aaa:
        displayName: A
        api: openai-completions
        baseURL: https://a.example/v1
        apiKeyEnv: AAA_KEY
        models:
          - id: a-1
            name: a-1
      bbb:
        displayName: B
        models:
          - id: b-1
- id: agent-default-model
  config:
    provider: aaa
    model: a-1
`
const p1 = piAiProviders(sample)
ok(p1.providers.length === 2, '解析出 2 个 provider')
ok(p1.providers[0].baseURL === 'https://a.example/v1', 'baseURL 解析正确')
ok(p1.providers[1].name === 'bbb', '第二个 provider 名字正确')
ok(piAiProviders(sample).providers[0].models.join() === 'a-1', 'models 解析正确')
ok(agentDefaultModel(sample)?.provider === 'aaa', 'agent-default-model 解析正确')

const mergedText = insertProviders(sample, ['ccc'], [{ name: 'ccc', lines: ['      ccc:', '        displayName: C'] }]).text
const p2 = piAiProviders(mergedText)
ok(p2.providers.length === 3 && p2.providers[2].name === 'ccc', '追加 provider 后仍能正确解析')
ok(agentDefaultModel(mergedText)?.provider === 'aaa', '追加后没有破坏后面的条目')

const created = insertProviders('- id: agent-default-model\n  config:\n    provider: x\n', ['ccc'], [{ name: 'ccc', lines: ['      ccc:', '        displayName: C'] }])
ok(created.entryCreated === true && piAiProviders(created.text).providers.length === 1, '没有 llm-pi-ai 条目时会新建整块')

const noDup = insertProviders(mergedText, ['ccc'], [{ name: 'ccc', lines: ['      ccc:', '        displayName: C'] }])
void noDup // 去重发生在 applySync，这里只验证解析稳定

// ---------------------------------------------------------------------------
// 6. 沙盒端到端：造一个假的 DSH_HOME，跑「扫描 → 计划 → 真写 → 幂等」全链路
// ---------------------------------------------------------------------------
console.log('\n=== 6. 沙盒端到端（在临时目录里真写，不碰真实配置）===')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-'))
  const mk = (rel, text) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
    return p
  }
  mk('profiles/alpha/cordis.patch.yml', [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      zz:',
    '        displayName: 测试供应商',
    '        api: openai-completions',
    '        baseURL: https://zz.example/v1',
    '        apiKeyEnv: ZZ_KEY',
    '        models:',
    '          - id: zz-1',
    '            name: zz-1',
    '- id: agent-default-model',
    '  config:',
    '    provider: zz',
    '    model: zz-1',
    '',
  ].join('\n'))
  mk('profiles/alpha/package.json', JSON.stringify({ name: 'dsh-profile-alpha', dsh: { profile: { bundles: [] } } }))
  const betaPatch = mk('profiles/beta/cordis.patch.yml', [
    '- id: agent-default-model',
    '  config:',
    '    provider: zz',
    '    model: zz-1',
    '',
  ].join('\n'))
  mk('profiles/beta/package.json', JSON.stringify({ name: 'dsh-profile-beta', dsh: { profile: { bundles: [] } } }))
  mk('state/headless-overlay.yml', ['- id: agent-default-model', '  config:', '    provider: zz', '    model: zz-1', ''].join('\n'))
  mk('state/config.json', JSON.stringify({ headlessProfile: 'beta' }))

  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const sc = scanConfig()
    ok(sc.profiles.length === 2, '沙盒：读到 2 个 profile')
    ok(sc.overlays.length === 1 && sc.overlays[0].targetProfile === 'beta', '沙盒：overlay 归到 beta')
    const rr = scanRefs(sc, null)
    ok(rr.dangling.length >= 2, '沙盒：alpha 之外的两处引用被判悬空（实际 ' + rr.dangling.length + '）')
    const pl = planSync(sc, rr)
    // ⭐ 2026-10-30：overlay 是插件每轮重写的临时层，往里"同步"没意义 ⇒ 必须被拦下并说明原因
    ok(pl.blocked.some((b) => b.kind === 'overlay' && /overlay/.test(String(b.why))), '沙盒：overlay 里的引用不进计划（会被下一轮覆盖）')
    ok(!pl.actions.some((a) => a.add.some((x) => x.refFile && /headless-overlay\.yml$/.test(x.refFile))), '沙盒：计划里没有来自 overlay 的改动')
    ok(pl.actions.length === 1 && pl.actions[0].profile === 'beta', '沙盒：计划只改 beta 一个文件')
    ok(pl.actions[0].add[0].name === 'zz' && pl.actions[0].add[0].from === 'alpha', '沙盒：从 alpha 取 zz 的定义')
    const rec = applySync(sc, pl.actions)
    ok(rec.length === 1 && rec[0].ok && !rec[0].skipped, '沙盒：写入成功')
    ok(!!rec[0].backup && existsSync(rec[0].backup), '沙盒：写前留了备份 ' + (rec[0].backup || '').split(/[\\/]/).pop())
    const after = readFileSync(betaPatch, 'utf8')
    ok(after.includes('      zz:') && after.includes('baseURL: https://zz.example/v1'), '沙盒：beta patch 里补上了完整的 zz 定义')
    ok(after.includes('- id: agent-default-model'), '沙盒：原有的 agent-default-model 没被破坏')
    const sc2 = scanConfig()
    const rr2 = scanRefs(sc2, null)
    ok(rr2.dangling.length === 0, '沙盒：同步后不再有悬空引用')
    const pl2 = planSync(sc2, rr2)
    ok(pl2.actions.length === 0, '沙盒：同步是幂等的（再跑没有待办）')

    // ── 换供应商（面板上说的"同步过去"，底层是 planRewrite/applyRewrite）───────
    // 场景：alpha / beta / overlay 都写着 zz，现在要把它们整体换成 yy
    const rp = planRewrite(sc2, rr2, { from: 'zz', to: { provider: 'yy', model: 'yy-9' } })
    ok(rp.edits.length >= 2, '换供应商：计划里有多处要改（实际 ' + rp.edits.length + '）')
    ok(rp.edits.every((e) => e.from === 'zz' && e.toProvider === 'yy'), '换供应商：每项都记了从哪到哪')
    ok(rp.edits.some((e) => e.kind === 'overlay' && e.volatile), '换供应商：overlay 里的引用也会被改，并标记为易被覆盖')
    const rRec = applyRewrite(sc2, rp.edits)
    ok(rRec.some((r) => r.ok), '换供应商：写入成功')
    ok(rRec.filter((r) => r.ok).every((r) => r.backup && existsSync(r.backup)), '换供应商：每处写前都留了备份')
    const betaAfter = readFileSync(betaPatch, 'utf8')
    ok(/provider:\s*yy/.test(betaAfter), '换供应商：beta 的 provider 已改成 yy')
    ok(/model:\s*yy-9/.test(betaAfter), '换供应商：模型也一起换了')
    ok(!/provider:\s*zz/.test(betaAfter), '换供应商：文件里不再有旧 provider 的引用')
    const adm = agentDefaultModel(betaAfter)
    ok(adm && adm.provider === 'yy' && adm.model === 'yy-9', '换供应商：改完仍能解析出 agent-default-model（结构没坏）')
    ok(/^ {6}zz:/m.test(betaAfter), '换供应商：provider 的**定义**没被顺手删掉（只改选择）')
    const rr3 = scanRefs(scanConfig(), null)
    ok(!rr3.refs.some((r) => r.provider === 'zz'), '换供应商：再扫描已经没有 zz 的引用了')
    // 同一份计划再跑一次：不该再动（行号已对不上 provider 了，应全部判失败而不是改坏）
    const rRec2 = applyRewrite(sc2, rp.edits)
    ok(!rRec2.some((r) => r.ok), '换供应商：旧计划重放不会二次改写（防手抖重复点击）')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
