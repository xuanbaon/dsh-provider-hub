/**
 * 容错自测（故障注入）：故意把各种东西弄坏，验证 scan.js / log.js **不抛异常、不写坏文件**。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/errors.mjs
 *
 * 覆盖：配置目录不存在、patch 是个目录、二进制垃圾、4MB 巨文件、CRLF/tab/空文件、
 *      坏会话 JSON、超大会话、类型错乱的会话数据、null 入参、
 *      写入前校验失败必须放弃且不动原文件、备份清理只删自己造的、日志写不进去也不抛。
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const {
  scanConfig, scanSessions, scanRefs, planSync, applySync, insertProviders,
  piAiProviders, agentDefaultModel, applyIgnores, pruneBackups, BUILTIN_PROVIDERS,
} = await import('../lib/scan.js')
const { createLogger, errText } = await import('../lib/log.js')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }
/** 断言「调用不抛异常」。 */
function noThrow(fn, label) {
  try {
    const v = fn()
    ok(true, label)
    return v
  } catch (e) {
    ok(false, label + ' —— 抛了异常：' + errText(e))
    return null
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-hub-err-'))
const mk = (rel, content) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
  return p
}
const prevHome = process.env.DSH_HOME
const prevData = process.env.DSH_PROVIDER_HUB_DATA

try {
  // ── 1. 配置目录根本不存在 ────────────────────────────────────────────
  console.log('\n=== 1. 空/不存在的 DSH_HOME ===')
  process.env.DSH_HOME = join(root, 'not-exist')
  process.env.DSH_PROVIDER_HUB_DATA = join(root, 'data')
  const c0 = noThrow(() => scanConfig(), 'scanConfig 在目录不存在时不抛')
  ok(c0 && c0.profiles.length === 0 && Array.isArray(c0.errors), '返回空 profiles + errors 数组')
  ok(c0 && c0.errors.length >= 1, '至少记了一条「没有 profiles 目录」的诊断')
  const s0 = noThrow(() => scanSessions(10), 'scanSessions 在目录不存在时不抛')
  ok(s0 && s0.rows.length === 0 && s0.byProvider.length === 0, '会话扫描返回空结果')
  const r0 = noThrow(() => scanRefs(c0, null), 'scanRefs 在空配置上不抛')
  ok(r0 && r0.refs.length === 0 && r0.dangling.length === 0, '引用扫描返回空结果')

  // ── 2. patch 是个目录 / 二进制垃圾 ──────────────────────────────────
  console.log('\n=== 2. 坏 profile 隔离 ===')
  process.env.DSH_HOME = join(root, 'home2')
  mkdirSync(join(root, 'home2', 'profiles', 'broken', 'cordis.patch.yml'), { recursive: true })
  writeFileSync(join(root, 'home2', 'profiles', 'broken', 'package.json'), '{坏 JSON', 'utf8')
  mk('home2/profiles/binary/cordis.patch.yml', Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x00, 0x01]))
  mk('home2/profiles/good/cordis.patch.yml', [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ok1:',
    '        api: openai-completions',
    '        models:',
    '          - id: m1',
    '- id: agent-default-model',
    '  config:',
    '    provider: ok1',
    '    model: m1',
    '',
  ].join('\n'))
  const c2 = noThrow(() => scanConfig(), '一个坏 profile 不影响整体扫描')
  ok(c2 && c2.profiles.some((p) => p.name === 'good' && p.providers.length === 1), '好 profile 仍然被正常解析')
  ok(c2 && c2.errors.length >= 1, '坏文件被记进诊断（' + (c2 && c2.errors.length) + ' 条）')
  ok(c2 && c2.profiles.some((p) => p.name === 'broken' && p.exists === false), 'patch 是目录的 profile 标记为不存在而不是报错')

  // ── 3. 4MB 巨文件被跳过 ────────────────────────────────────────────
  console.log('\n=== 3. 超大文件保护 ===')
  mk('home2/profiles/huge/cordis.patch.yml', '- id: llm-pi-ai\n  config:\n    providers:\n' + '      pad:\n'.repeat(800000))
  const c3 = noThrow(() => scanConfig(), '遇到 4MB 以上的 patch 不抛、不卡死')
  ok(c3 && c3.errors.some((e) => /过大/.test(e.message)), '超大文件被记为「文件过大，已跳过」')
  ok(c3 && !c3.profiles.some((p) => p.name === 'huge' && p.providers.length), '超大 profile 没有产生任何 provider')

  // ── 4. YAML 文本奇形怪状 ───────────────────────────────────────────
  console.log('\n=== 4. 畸形 patch 文本 ===')
  const weird = [
    ['空字符串', ''],
    ['只有注释', '# 什么都没有\n# 再来一行\n'],
    ['CRLF', '- id: llm-pi-ai\r\n  config:\r\n    providers:\r\n      w1:\r\n        api: x\r\n'],
    ['tab 缩进', '- id: llm-pi-ai\n\tconfig:\n\t\tproviders:\n'],
    ['没有结尾换行', '- id: llm-pi-ai\n  config:\n    providers:\n      w2:\n        api: y'],
    ['providers 是空值', '- id: llm-pi-ai\n  config:\n    providers:\n'],
    ['providers 后面直接跟别的键', '- id: llm-pi-ai\n  config:\n    providers:\n    other: 1\n'],
    ['半截缩进', '- id: llm-pi-ai\n  config:\n    providers:\n  name: x\n'],
  ]
  for (const [name, text] of weird) {
    const p = noThrow(() => piAiProviders(text), `piAiProviders(${name}) 不抛`)
    ok(p && Array.isArray(p.providers), `piAiProviders(${name}) 返回 providers 数组`)
    noThrow(() => agentDefaultModel(text), `agentDefaultModel(${name}) 不抛`)
    noThrow(() => insertProviders(text, ['zz'], [{ name: 'zz', lines: ['      zz:', '        api: q'] }]), `insertProviders(${name}) 不抛`)
  }
  noThrow(() => piAiProviders(null), 'piAiProviders(null) 不抛')
  noThrow(() => piAiProviders(undefined), 'piAiProviders(undefined) 不抛')
  noThrow(() => insertProviders(undefined, ['a'], []), 'insertProviders(undefined) 不抛')
  noThrow(() => insertProviders('- id: llm-pi-ai', null, null), 'insertProviders 传 null 名单不抛')
  ok(insertProviders('', ['zz'], []).text === '', '没有定义片段时原样返回（不改内容）')

  // ── 5. 会话数据损坏 ────────────────────────────────────────────────
  console.log('\n=== 5. 会话缓存损坏 ===')
  const sessDir = join(root, 'home2', 'storages', 'session_projcache', 'sessions')
  mkdirSync(sessDir, { recursive: true })
  writeFileSync(join(sessDir, 'a-broken.json'), '{半截 JSON', 'utf8')
  writeFileSync(join(sessDir, 'b-null.json'), 'null', 'utf8')
  writeFileSync(join(sessDir, 'c-array.json'), '[]', 'utf8')
  writeFileSync(join(sessDir, 'd-weird.json'), JSON.stringify({
    record: { identity: { id: 42, cwd: null }, rows: { modelSelection: '我是个字符串', sessionListMetadata: 7, title: { text: '标题' }, agentPreset: 3 } },
  }), 'utf8')
  writeFileSync(join(sessDir, 'e-good.json'), JSON.stringify({
    record: {
      identity: { id: 'sid-1', cwd: 'C:/work' },
      rows: {
        modelSelection: { val: { lastUsed: { provider: 'acme', model: 'm-1' } } },
        sessionListMetadata: { val: { lastPromptAt: 1700000000000 } },
        title: { val: '正常会话' },
      },
    },
  }), 'utf8')
  writeFileSync(join(sessDir, 'f-empty.json'), '', 'utf8')
  const s5 = noThrow(() => scanSessions(50), '一堆坏会话文件不抛异常')
  // 坏 JSON / null / 空文件被跳过；结构可用但没有模型记录的会话按「未记录」保留（这正是用户要看的）
  ok(s5 && s5.total === 2, '坏 JSON 被跳过，剩下 2 条结构可用的（实际 ' + (s5 && s5.total) + '）')
  const goodRow = s5 && s5.rows.find((r) => r.sessionId === 'sid-1')
  ok(goodRow && goodRow.provider === 'acme' && goodRow.model === 'm-1', '正常会话的 provider/model 解析正确')
  const unknownRow = s5 && s5.rows.find((r) => r.sessionId === '42')
  ok(unknownRow && unknownRow.provider === '', 'modelSelection 是字符串的会话被判为「未记录」而不是崩溃')
  ok(s5 && s5.byProvider.some((b) => b.provider === 'acme' && b.sessions === 1), '按 provider 汇总里 acme 计 1 条')
  ok(s5 && s5.byProvider.some((b) => b.provider === '(未知/未记录)'), '未记录的会话单独成组')
  ok(s5 && s5.errors.length >= 2, '坏文件都进了诊断（' + (s5 && s5.errors.length) + ' 条）')

  // ── 6. 入参是 null / 缺字段 ───────────────────────────────────────
  console.log('\n=== 6. 入参兜底 ===')
  ok(noThrow(() => scanRefs(null, null), 'scanRefs(null) 不抛') !== null, 'scanRefs(null) 有返回值')
  ok(noThrow(() => scanRefs({}, null), 'scanRefs({}) 不抛') !== null, 'scanRefs({}) 有返回值')
  const pn = noThrow(() => planSync(null, null), 'planSync(null,null) 不抛')
  ok(pn && pn.actions.length === 0, 'planSync(null) 返回空计划')
  const ai = noThrow(() => applyIgnores(null, null), 'applyIgnores(null,null) 不抛')
  ok(ai && ai.refs.length === 0 && ai.ignoredCount === 0, 'applyIgnores(null) 返回空结构')
  const ai2 = applyIgnores(
    { refs: [{ provider: 'a', profile: 'p', verdict: 'dangling' }, { provider: 'b', profile: 'p', verdict: 'missing' }], dangling: [], missing: [] },
    { ignored: [{ key: 'a@p' }], prefs: { showIgnored: false } },
  )
  ok(ai2.refs.length === 1 && ai2.ignoredCount === 1, '忽略项被剔除出可见列表，且计数正确')
  ok(ai2.dangling.length === 0, '被忽略的悬空项不再进计划')
  ok(BUILTIN_PROVIDERS.includes('deepseek-account'), '内置供应商常量还在')

  // ── 7. 写盘保护：校验不过就不写 ───────────────────────────────────
  console.log('\n=== 7. 写盘保护 ===')
  const target = mk('home2/profiles/needfix/cordis.patch.yml', [
    '- id: agent-default-model',
    '  config:',
    '    provider: zz',
    '    model: zz-1',
    '',
  ].join('\n'))
  const original = readFileSync(target, 'utf8')

  // 7a. 定义片段格式不对 → 校验失败 → 必须放弃写入且原文件不动
  const badCfg = { allDefs: [{ name: 'zz', lines: ['  zz:', '    api: broken-indent'] }] }
  const recBad = noThrow(() => applySync(badCfg, [{ file: target, profile: 'needfix', add: [{ name: 'zz', from: 'x' }] }]), '校验失败时 applySync 不抛')
  ok(recBad && recBad.length === 1 && recBad[0].ok === false, '校验失败返回 ok:false')
  ok(recBad && /解析校验失败|放弃写入/.test(recBad[0].why || ''), '原因写明是校验失败：' + String(recBad && recBad[0].why).slice(0, 40))
  ok(readFileSync(target, 'utf8') === original, '校验失败时原文件一个字节都没动')

  // 7b. 计划里给的 provider 根本没有定义片段
  const recNoDef = applySync({ allDefs: [] }, [{ file: target, profile: 'needfix', add: [{ name: '不存在', from: 'x' }] }])
  ok(recNoDef[0].ok === false && /定义片段/.test(recNoDef[0].why), '拿不到定义片段时拒绝写入')
  ok(readFileSync(target, 'utf8') === original, '拒绝写入后原文件未变')

  // 7c. 文件不存在
  const recMissing = applySync({ allDefs: [] }, [{ file: join(root, 'no-such-file.yml'), profile: 'x', add: [{ name: 'a' }] }])
  ok(recMissing[0].ok === false && /读不到/.test(recMissing[0].why), '目标文件不存在时返回失败而不是抛错')

  // 7d. 计划项本身残缺：null / 没文件名 → 失败；有文件名但没 add → 视为「无事可做」跳过
  const recEmpty = noThrow(() => applySync({}, [null, {}, { file: target }]), '残缺计划项不抛异常')
  ok(recEmpty && recEmpty.length === 3, '三个残缺项都产出了收据（逐条隔离）')
  ok(recEmpty && recEmpty[0].ok === false && recEmpty[1].ok === false, 'null / 缺文件路径的项标记失败')
  ok(recEmpty && recEmpty[2].ok === true && recEmpty[2].skipped === true, '没有要补的 provider 时标记为跳过而不是失败')

  // 7e. 正常写入：校验通过 → 写入 + 备份 + 幂等
  const goodDef = { allDefs: [{ name: 'zz', lines: ['      zz:', '        displayName: Z', '        api: openai-completions', '        models:', '          - id: zz-1'] }] }
  const recGood = applySync(goodDef, [{ file: target, profile: 'needfix', add: [{ name: 'zz', from: 'x' }] }], { maxBackups: 20 })
  ok(recGood[0].ok === true && !recGood[0].skipped, '合法定义写入成功')
  ok(!!recGood[0].backup && existsSync(recGood[0].backup), '写前备份存在')
  ok(piAiProviders(readFileSync(target, 'utf8')).providers.some((p) => p.name === 'zz'), '写入后能重新解析出 zz')
  ok(readFileSync(target, 'utf8').includes('agent-default-model'), '原有条目没被破坏')
  const recAgain = applySync(goodDef, [{ file: target, profile: 'needfix', add: [{ name: 'zz', from: 'x' }] }], { maxBackups: 20 })
  ok(recAgain[0].ok === true && recAgain[0].skipped === true, '重复同步是幂等的（skipped=true）')

  // ── 8. 备份清理只碰自己造的 ───────────────────────────────────────
  console.log('\n=== 8. 备份清理边界 ===')
  const bdir = join(root, 'home2', 'profiles', 'needfix')
  const userFile = join(bdir, 'cordis.patch.yml.bak-我自己备份的')
  writeFileSync(userFile, 'user data', 'utf8')
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(bdir, `cordis.patch.yml.bak-provider-hub-2026010${i}000000`), 'x', 'utf8')
    writeFileSync(join(bdir, `cordis.patch.yml.bak-provider-hub-notatimestamp`), 'x', 'utf8')
  }
  const removed = pruneBackups(target, 2)
  const left = readdirSync(bdir).filter((f) => /^cordis\.patch\.yml\.bak-provider-hub-\d{14}$/.test(f))
  ok(removed > 0, '旧备份被清理（删了 ' + removed + ' 个）')
  ok(left.length === 2, '只保留最近 2 个（实际 ' + left.length + '）')
  ok(left.includes('cordis.patch.yml.bak-provider-hub-20260105000000'), '保留的是最新的那两个')
  ok(existsSync(userFile), '用户自己的 .bak-* 备份没被碰')
  ok(existsSync(join(bdir, 'cordis.patch.yml.bak-provider-hub-notatimestamp')), '不符合时间戳格式的文件不删')
  ok(pruneBackups(target, 0) === 0, 'maxBackups=0 时完全不清理')

  // ── 9. 日志写不进去也不抛 ─────────────────────────────────────────
  console.log('\n=== 9. 日志容错 ===')
  const occupied = join(root, 'occupied-as-file')
  writeFileSync(occupied, 'not a dir', 'utf8')
  process.env.DSH_PROVIDER_HUB_DATA = occupied
  const log = createLogger({ toConsole: false })
  const r9 = noThrow(() => { log('这条日志应该静默失败'); log('第二条', 'error') }, '数据目录不可写时写日志不抛异常')
  ok(r9 === undefined, '日志函数返回 undefined，没有副作用')
  process.env.DSH_PROVIDER_HUB_DATA = join(root, 'data')
  const log2 = createLogger({ toConsole: false })
  noThrow(() => log2('正常情况能写'), '正常情况下写日志不抛')
  ok(existsSync(join(root, 'data', 'logs', 'provider-hub.log')), '日志文件生成在数据目录 logs/ 下')
  ok(readFileSync(join(root, 'data', 'logs', 'provider-hub.log'), 'utf8').includes('正常情况能写'), '日志内容确实写进去了')
  ok(errText(new Error('炸了')).includes('炸了'), 'errText 能把异常压成文本')
  ok(errText(null) === '', 'errText(null) 返回空串')

  // ── 10. 端到端：真实损坏场景下的完整链路 ──────────────────────────
  console.log('\n=== 10. 损坏场景下的端到端链路 ===')
  const c10 = noThrow(() => scanConfig(), '整体扫描不抛')
  const r10 = noThrow(() => scanRefs(c10, null), '引用扫描不抛')
  const p10 = noThrow(() => planSync(c10, r10), '计划生成不抛')
  ok(p10 && Array.isArray(p10.actions) && Array.isArray(p10.blocked), '计划结构完整（actions/blocked）')
  ok(c10 && c10.errors.length > 0, '整条链路上损坏文件都被记录下来，没有被静默吞掉')
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  if (prevData === undefined) delete process.env.DSH_PROVIDER_HUB_DATA
  else process.env.DSH_PROVIDER_HUB_DATA = prevData
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
