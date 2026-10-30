/**
 * 路由自测：用假 ctx 把 lib/host.js 挂起来，起一个真的 http 服务，把全部路由打一遍。
 * 目的是在**不重启 DSH** 的前提下验证宿主半边：路径、返回结构、预演不写盘、
 * 偏好/忽略能落盘、错误输入不会 500、安全闸门有效。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/routes.mjs
 *
 * 注意：会把 DSH_PROVIDER_HUB_DATA 指到临时目录，**不碰你真实的偏好文件**。
 */
import http from 'node:http'
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 必须在 import host.js 之前设好：store 每次调用都读 env，但保险起见先设
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-hub-routes-'))
process.env.DSH_PROVIDER_HUB_DATA = dataDir

const host = await import('../lib/host.js')
const { scanConfig } = await import('../lib/scan.js')
const { makeStrictCtx } = await import('./fake-ctx.mjs')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

let route = null
// 用「像 cordis 那样严格」的 ctx：未写进 inject 的服务访问会抛。
// 这样「忘声明 inject 导致真机 404」在本用例里就能被抓到（v1.0.0 就是栽在这）。
const ctx = makeStrictCtx({
  inject: host.inject,
  services: { webServer: { register: (def) => { route = def; return () => {} } } },
  getTable: {}, // 没有 llm / connection → 走「读不到就未知」的分支
})
let applyThrew = null
try { host.apply(ctx) } catch (e) { applyThrew = e }
ok(!applyThrew, 'apply 未抛异常' + (applyThrew ? '：' + applyThrew.message : ''))
ok(!!route, 'ctx.webServer.register 被调用')
ok(route && route.kind === 'prefix' && route.path === '/dsh-provider-hub', '注册的是 prefix /dsh-provider-hub')
if (!route) {
  console.log('\n没有挂上路由，后续用例无法继续。')
  process.exit(1)
}

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const get = (p) => fetch(base + p).then((r) => r.json())
const post = (p, body, raw) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: raw !== undefined ? raw : JSON.stringify(body || {}),
}).then((r) => r.json().catch(() => ({ ok: false, parseError: true })))
const status = (p, opts) => fetch(base + p, opts).then((r) => r.status)

try {
  // ── health ────────────────────────────────────────────────────────────
  const hl = await get('/dsh-provider-hub/health')
  ok(hl.ok === true && typeof hl.version === 'string', 'GET /health 返回版本 ' + hl.version)
  ok(hl.dataDir === resolve(dataDir), '/health 的 dataDir 指向测试临时目录')

  // ── overview ──────────────────────────────────────────────────────────
  const ov = await get('/dsh-provider-hub/overview')
  ok(ov.ok === true, 'GET /overview 成功')
  ok(Array.isArray(ov.profiles) && ov.profiles.length > 0, '/overview 返回 profiles（' + (ov.profiles || []).length + ' 个）')
  ok(Array.isArray(ov.providers) && ov.providers.every((p) => !('lines' in p)), '/overview 的 providers 不夹带内部 lines 字段')
  ok(ov.counters && typeof ov.counters.dangling === 'number', '/overview 带 counters.dangling = ' + (ov.counters && ov.counters.dangling))
  ok(ov.registered === null, '没有 llm 服务时 registered 是 null（页面显示「未知」而不是乱判）')
  ok(Array.isArray(ov.diagnostics), '/overview 带 diagnostics 数组（坏文件诊断）')
  ok(ov.prefs && ov.prefs.autoScan === true, '/overview 带默认偏好（autoScan=true）')
  ok(statSync(join(dataDir, 'state.json')).isFile(), '首次访问自动创建了状态文件')

  // ── sessions ──────────────────────────────────────────────────────────
  const ss = await get('/dsh-provider-hub/sessions?limit=5')
  ok(ss.ok === true && Array.isArray(ss.byProvider), 'GET /sessions 成功，byProvider 是数组（' + (ss.byProvider || []).length + ' 组）')
  ok(Array.isArray(ss.rows) && ss.rows.length <= 5, '/sessions 遵守 limit')

  // ── refs ──────────────────────────────────────────────────────────────
  const rf = await get('/dsh-provider-hub/refs')
  ok(rf.ok === true && Array.isArray(rf.refs), 'GET /refs 成功（' + (rf.refs || []).length + ' 处引用）')
  ok(rf.plan && Array.isArray(rf.plan.actions), '/refs 同时给出 plan')

  // ── state ─────────────────────────────────────────────────────────────
  const st0 = await get('/dsh-provider-hub/state')
  ok(st0.ok === true && st0.prefs && Array.isArray(st0.ignored), 'GET /state 返回偏好与忽略列表')
  ok(st0.stateFile === join(dataDir, 'state.json'), '/state 的 stateFile 在临时目录里')

  // ── prefs：能改、能读回、幂等 ─────────────────────────────────────────
  const p1 = await post('/dsh-provider-hub/prefs', { patch: { maxHistory: 20, autoScan: false } })
  ok(p1.ok === true && p1.prefs.maxHistory === 20 && p1.prefs.autoScan === false, 'POST /prefs 写入 maxHistory=20 / autoScan=false')
  const st1 = await get('/dsh-provider-hub/state')
  ok(st1.prefs.maxHistory === 20 && st1.prefs.autoScan === false, '偏好已落盘，重新读回一致')
  const p2 = await post('/dsh-provider-hub/prefs', { patch: { maxHistory: 99999 } })
  ok(p2.ok === true && p2.prefs.maxHistory === 500, '越界的 maxHistory 被夹到上限 500（不报错）')
  const p3 = await post('/dsh-provider-hub/prefs', { patch: { autoScan: true } })
  ok(p3.ok === true && p3.prefs.autoScan === true, '偏好只覆盖传上来的键（maxHistory 保持 500）' + JSON.stringify(p3.prefs))
  const p4 = await post('/dsh-provider-hub/prefs', null, '{不是 JSON')
  ok(p4.ok === true, '坏 JSON 请求体被当成空对象处理（不 500）')

  // ── ignore：加、读回、去重、删除 ──────────────────────────────────────
  const i1 = await post('/dsh-provider-hub/ignore', { provider: 'zz-test', profile: 'beta' })
  ok(i1.ok === true && i1.ignored.length === 1 && i1.ignored[0].key === 'zz-test@beta', 'POST /ignore 记下 zz-test@beta')
  await post('/dsh-provider-hub/ignore', { provider: 'zz-test', profile: 'beta' })
  const i2 = await get('/dsh-provider-hub/state')
  ok(i2.ignored.length === 1, '重复忽略同一项不会产生重复条目（仍 1 条）')
  const i3 = await post('/dsh-provider-hub/ignore', { provider: 'zz-test', profile: 'beta', remove: true })
  ok(i3.ok === true && i3.ignored.length === 0, 'POST /ignore {remove:true} 能取消忽略')
  const i4 = await post('/dsh-provider-hub/ignore', { profile: 'beta' })
  ok(i4.ok === false, 'POST /ignore 缺 provider 被拒绝：' + (i4.error || ''))

  // ── history ───────────────────────────────────────────────────────────
  const h1 = await post('/dsh-provider-hub/history', {})
  ok(h1.ok === false, 'POST /history 不带 clear 被拒绝（400）')
  const h2 = await post('/dsh-provider-hub/history', { clear: true })
  ok(h2.ok === true && typeof h2.cleared === 'number', 'POST /history {clear:true} 成功，清掉 ' + h2.cleared + ' 条')

  // ── 预演：不能改任何配置文件 ──────────────────────────────────────────
  const before = new Map()
  for (const a of (rf.plan.actions || [])) { try { before.set(a.file, statSync(a.file).mtimeMs) } catch { /* 忽略 */ } }
  const dry = await post('/dsh-provider-hub/sync', { apply: false })
  ok(dry.ok === true && dry.applied === false, 'POST /sync {apply:false} 是预演（applied=false）')
  let changed = 0
  for (const [f, t] of before) { try { if (statSync(f).mtimeMs !== t) changed++ } catch { /* 忽略 */ } }
  ok(changed === 0, '预演没有修改任何配置文件')

  // ── 换供应商（/rewrite）：预演不写盘，缺参数要 400 ─────────────────────
  const fromA = (rf.refs || []).find((r) => r && r.provider) || null
  const rwDry = await post('/dsh-provider-hub/rewrite', { from: fromA ? fromA.provider : 'nope', to: { provider: 'zz-new' }, apply: false })
  ok(rwDry.ok === true && rwDry.applied === false, 'POST /rewrite {apply:false} 是预演（applied=false）')
  ok(Array.isArray(rwDry.edits), '/rewrite 预演返回 edits 数组（' + ((rwDry.edits || []).length) + ' 处）')
  let changedRw = 0
  for (const [f, t] of before) { try { if (statSync(f).mtimeMs !== t) changedRw++ } catch { /* 忽略 */ } }
  ok(changedRw === 0, '换供应商的预演没有修改任何配置文件')
  const rwBad1 = await post('/dsh-provider-hub/rewrite', { to: { provider: 'x' }, apply: false })
  ok(rwBad1.ok === false, 'POST /rewrite 缺 from 被拒绝：' + (rwBad1.error || ''))
  const rwBad2 = await post('/dsh-provider-hub/rewrite', { from: 'x', apply: false })
  ok(rwBad2.ok === false, 'POST /rewrite 缺 to.provider 被拒绝：' + (rwBad2.error || ''))
  const rwSame = await post('/dsh-provider-hub/rewrite', { from: 'zz-same', to: { provider: 'zz-same' }, apply: false })
  ok(rwSame.ok === true && (rwSame.edits || []).length === 0, 'POST /rewrite 换成自己 = 零改动')

  // 超大请求体：应被 413 挡掉，而不是把宿主拖住
  const big = '{"apply":false,"pad":"' + 'a'.repeat(60_000) + '"}'
  const over = await status('/dsh-provider-hub/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })
  ok(over === 413, '超大请求体返回 413（实际 ' + over + '）')

  // ── 404 / 405 ─────────────────────────────────────────────────────────
  const nf = await status('/dsh-provider-hub/nope')
  ok(nf === 404, '未知路由返回 404（实际 ' + nf + '）')
  const mna = await status('/dsh-provider-hub/health', { method: 'POST' })
  ok(mna === 405, 'GET 路由用 POST 访问返回 405（实际 ' + mna + '）')

  // ── 安全闸门：非本机 Host 头要被挡（undici 的 fetch 不让改 Host，用 node:http）──
  const blocked = await new Promise((resolve2) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/dsh-provider-hub/overview', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve2(res.statusCode) })
    r.on('error', () => resolve2(-1))
    r.end()
  })
  ok(blocked === 403, '非本机 Host 头被挡（实际 ' + blocked + '）')

  // ── 状态文件确实在临时目录，不在插件目录 ──────────────────────────────
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  ok(!(resolve(dataDir) + sep).startsWith(pluginDir + sep), '数据目录不在插件安装目录里（重装不会被覆盖）')
  const raw = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
  ok(raw.version === 1 && raw.createdAt > 0, '状态文件带版本号与创建时间')
  ok(existsSync(join(dataDir, 'state.json.bak')), '覆盖写入前留了 state.json.bak')

  const cfg = scanConfig()
  const total = cfg.profiles.reduce((n, p) => n + p.providers.length, 0)
  console.log(`\n真实配置概况：${cfg.profiles.length} 个 profile、${total} 个 provider 定义、${cfg.overlays.length} 个 overlay`)
} finally {
  server.close()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
