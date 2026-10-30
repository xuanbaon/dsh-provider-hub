/**
 * 持久化自测：把 DSH_PROVIDER_HUB_DATA 指到临时目录，验证 store.js 的每一条可靠性承诺。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/store.mjs
 *
 * 覆盖：首次创建 / 读写往返 / 原子写不留临时文件 / 写前留底 / 坏 JSON 自愈 /
 *      超大文件自愈 / 脏类型兜底 / 历史截断 / 忽略项增删改 / 数据目录被占 /
 *      mutator 抛错不落盘 / 版本降级不丢数据 / 环境变量覆盖路径。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  loadState, saveState, updateState, normalize, defaults, pushHistory, setIgnored,
  ignoreKey, STATE_VERSION, DEFAULT_STATE,
} = await import('../lib/store.js')
const { dataDir, stateFile, isInside } = await import('../lib/paths.js')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

/** 每个用例一个独立的临时数据目录，互不干扰。 */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-store-'))
  const prev = process.env.DSH_PROVIDER_HUB_DATA
  process.env.DSH_PROVIDER_HUB_DATA = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_PROVIDER_HUB_DATA
    else process.env.DSH_PROVIDER_HUB_DATA = prev
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

console.log('\n=== 1. 环境变量与路径 ===')
withDir((dir) => {
  ok(dataDir() === dir, 'DSH_PROVIDER_HUB_DATA 覆盖生效：' + dataDir())
  ok(stateFile() === join(dir, 'state.json'), 'stateFile 落在数据目录下')
  const pluginDir = join(dir, '..', 'fake-plugin')
  ok(!isInside(dataDir(), pluginDir), '数据目录不在插件目录内（重装插件不会覆盖数据）')
})

console.log('\n=== 2. 首次读取自动建库 ===')
withDir((dir) => {
  const r = loadState()
  ok(r.ok === true && r.created === true, '首次读取返回 created=true')
  ok(existsSync(join(dir, 'state.json')), '自动创建了 state.json')
  ok(r.state.version === STATE_VERSION, '带版本号 ' + r.state.version)
  ok(r.state.createdAt > 0, '带创建时间')
  ok(r.state.prefs.autoScan === true, '默认偏好 autoScan=true')
  const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  ok(disk.version === STATE_VERSION && disk.prefs, '磁盘上的内容可被 JSON 解析且结构正确')
})

console.log('\n=== 3. 读写往返 ===')
withDir((dir) => {
  const st = loadState().state
  st.prefs.maxHistory = 20
  st.prefs.showIgnored = true
  setIgnored(st, { provider: 'acme', profile: 'demo-profile', note: '已知问题' })
  pushHistory(st, { applied: true, receipts: [{ profile: 'demo-profile', ok: true, added: ['acme'], backup: 'x.bak' }] })
  const saved = saveState(st)
  ok(saved.ok === true, 'saveState 成功')

  const back = loadState().state
  ok(back.prefs.maxHistory === 20 && back.prefs.showIgnored === true, '偏好往返一致')
  ok(back.ignored.length === 1 && back.ignored[0].key === 'acme@demo-profile', '忽略项往返一致')
  ok(back.ignored[0].note === '已知问题', '忽略项备注保留')
  ok(back.history.length === 1 && back.history[0].receipts[0].added[0] === 'acme', '同步历史往返一致')
  ok(existsSync(join(dir, 'state.json.bak')), '第二次写入前留了 state.json.bak')

  const left = readdirSync(dir).filter((f) => f.startsWith('state.json.tmp-'))
  ok(left.length === 0, '原子写没有留下临时文件（实际 ' + left.length + ' 个）')
})

console.log('\n=== 4. 坏 JSON 自愈 ===')
withDir((dir) => {
  writeFileSync(join(dir, 'state.json'), '{ 这不是 JSON ]', 'utf8')
  const r = loadState()
  ok(r.ok === false && r.recovered === true, '识别为损坏并标记 recovered')
  ok(r.state.prefs.autoScan === true, '损坏时退回默认偏好（页面仍可用）')
  ok(/JSON/.test(r.error), '错误信息说明了原因：' + r.error.slice(0, 40))
  const quarantined = readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'))
  ok(quarantined.length === 1, '坏文件被改名留证（' + quarantined.length + ' 个 corrupt 文件）')
  // 自愈后应能正常写
  const s = saveState(r.state)
  ok(s.ok === true && loadState().ok === true, '自愈后可以正常写入并读回')
})

console.log('\n=== 5. 超大状态文件自愈 ===')
withDir((dir) => {
  writeFileSync(join(dir, 'state.json'), '{"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}', 'utf8')
  const r = loadState()
  ok(r.recovered === true && r.ok === false, '超过 2MB 视为异常并隔离')
  ok(/异常大/.test(r.error), '错误信息说明是体积问题')
  ok(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')), '已改名留证')
})

console.log('\n=== 6. 脏类型兜底（手改坏了也不崩）===')
withDir((dir) => {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 'abc',
    prefs: ['not', 'object'],
    ignored: 'nope',
    history: [{ at: 'x', receipts: 'bad' }, null, 42, { at: 1, receipts: [{ profile: 3, ok: 'yes', added: 'no' }] }],
    lastScanAt: {},
  }), 'utf8')
  const r = loadState()
  ok(r.ok === true, '脏数据不抛异常，按 ok:true 返回')
  ok(typeof r.state.prefs === 'object' && r.state.prefs.autoScan === true, 'prefs 被纠正成对象并用默认值')
  ok(Array.isArray(r.state.ignored) && r.state.ignored.length === 0, 'ignored 被纠正成空数组')
  ok(Array.isArray(r.state.history), 'history 被纠正成数组')
  ok(r.state.history.length === 1 && r.state.history[0].receipts.length === 1, '只有结构可用的那条历史被保留')
  ok(r.state.history[0].receipts[0].ok === false, '布尔字段按严格 true 判定（"yes" → false）')
  ok(r.state.lastScanAt === 0, '数字字段兜底为 0')
})

console.log('\n=== 7. normalize 边界 ===')
ok(normalize(null).version === STATE_VERSION, 'normalize(null) 返回默认状态')
ok(normalize('字符串').prefs.autoScan === true, 'normalize 字符串不抛错')
ok(normalize({ prefs: { maxHistory: -5 } }).prefs.maxHistory === 1, 'maxHistory 负数夹到下限 1')
ok(normalize({ prefs: { maxHistory: 1e9 } }).prefs.maxHistory === 500, 'maxHistory 过大夹到上限 500')
ok(normalize({ prefs: { maxBackups: -1 } }).prefs.maxBackups === 0, 'maxBackups 负数夹到 0')
ok(normalize({ prefs: { showIgnored: 'yes' } }).prefs.showIgnored === false, 'showIgnored 只认严格 true')
const dup = normalize({ ignored: [{ provider: 'a', profile: 'b' }, { provider: 'a', profile: 'b' }] })
ok(dup.ignored.length === 1, '重复忽略项被去重')
ok(ignoreKey(' a ', ' b ') === 'a@b', 'ignoreKey 会 trim 两端空格')

console.log('\n=== 8. 历史截断与忽略项增删改 ===')
withDir(() => {
  const st = loadState().state
  st.prefs.maxHistory = 3
  for (let i = 0; i < 10; i++) pushHistory(st, { applied: true, receipts: [{ profile: 'p' + i, ok: true }] })
  ok(st.history.length === 3, '历史按 maxHistory 截断到 3 条（实际 ' + st.history.length + '）')
  ok(st.history[0].receipts[0].profile === 'p9', '保留的是最新的那几条')

  setIgnored(st, { provider: 'x', profile: 'p1' })
  setIgnored(st, { provider: 'x', profile: 'p2' })
  ok(st.ignored.length === 2, '不同 profile 可分别忽略')
  setIgnored(st, { provider: 'x', profile: 'p1', note: '改了备注' })
  ok(st.ignored.length === 2 && st.ignored.find((i) => i.profile === 'p1').note === '改了备注', '重复忽略是更新而不是新增')
  setIgnored(st, { provider: 'x', profile: 'p1', remove: true })
  ok(st.ignored.length === 1, '取消忽略生效')
  setIgnored(st, { provider: '', profile: 'p1' })
  ok(st.ignored.length === 1, '缺 provider 的忽略请求被忽略')
})

console.log('\n=== 9. 数据目录被同名文件占用 ===')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-store-'))
  const occupied = join(root, 'provider-hub')
  const prev = process.env.DSH_PROVIDER_HUB_DATA
  try {
    writeFileSync(occupied, 'I am a file, not a directory', 'utf8')
    process.env.DSH_PROVIDER_HUB_DATA = occupied
    const r = loadState()
    ok(r.ok === false && r.dataDirOk === false, 'loadState 明确报告数据目录不可用')
    ok(/占用|数据目录/.test(r.error), '错误信息可读：' + r.error.slice(0, 40))
    ok(r.state.prefs.autoScan === true, '目录不可用时仍返回可用默认状态（页面能开）')
    const s = saveState(r.state)
    ok(s.ok === false && !!s.error, 'saveState 返回失败而不是抛异常')
    ok(statSync(occupied).isFile(), '没有破坏那个占用路径的文件')
  } finally {
    if (prev === undefined) delete process.env.DSH_PROVIDER_HUB_DATA
    else process.env.DSH_PROVIDER_HUB_DATA = prev
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

console.log('\n=== 10. mutator 抛错不落盘 ===')
withDir((dir) => {
  const first = loadState()
  first.state.prefs.maxHistory = 30
  saveState(first.state)
  const before = readFileSync(join(dir, 'state.json'), 'utf8')

  const r = updateState(() => { throw new Error('故意的错误') })
  ok(r.ok === false && /故意的错误/.test(r.error), 'updateState 捕获 mutator 的异常并返回 ok:false')
  ok(readFileSync(join(dir, 'state.json'), 'utf8') === before, 'mutator 抛错时原文件一个字节都没动')

  const r2 = updateState((s) => { s.prefs.maxHistory = 40 })
  ok(r2.ok === true && r2.state.prefs.maxHistory === 40, '正常 mutator 能落盘')
})

console.log('\n=== 11. 版本降级不丢数据 ===')
withDir((dir) => {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 99,
    prefs: { maxHistory: 11, autoScan: false, 未来字段: 'x' },
    ignored: [{ provider: 'p', profile: 'q' }],
    history: [],
  }), 'utf8')
  const r = loadState()
  ok(r.ok === true, '未来版本的状态文件仍可读')
  ok(r.state.version === STATE_VERSION, '版本号被归一到当前 ' + STATE_VERSION)
  ok(r.state.downgradedFrom === 99, '记下降级来源版本 99')
  ok(r.state.prefs.maxHistory === 11 && r.state.prefs.autoScan === false, '原有偏好没有被清掉')
  ok(r.state.ignored.length === 1, '原有忽略项没有丢')
  ok(r.state.prefs.未来字段 === undefined, '未知字段被丢弃（结构可控）')
})

console.log('\n=== 12. 默认常量不被污染 ===')
{
  const a = defaults()
  a.prefs.maxHistory = 999
  a.ignored.push({ provider: 'x' })
  ok(DEFAULT_STATE.prefs.maxHistory !== 999, 'defaults() 返回深拷贝，改它不影响默认常量')
  ok(defaults().ignored.length === 0, '再次 defaults() 仍是干净的')
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
