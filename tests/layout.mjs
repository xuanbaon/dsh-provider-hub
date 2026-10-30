/**
 * 版式渲染测试：验证「长路径不占表格列，而是独占第二行」。
 * ============================================================================
 * 起因：设置页里「位置」是一列长路径，把整行挤得没法读。改成主行 + 副行（colSpan 全宽）后，
 * 必须有测试证明**真的渲染出来了**，而不是只改了源码看着像对。
 *
 * 做法：用一个会记账的 React 替身（useState 有真实状态、createElement 产出节点树），
 * 喂一份典型数据，把 Panel 渲染两次（第一次挂载、第二次带数据），然后把节点树展开成
 * 纯结构，检查每个表格的行结构。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/layout.mjs
 */
let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }

// ── 假数据：都挑「路径长到没法一列显示」的样本 ────────────────────────────
const LONG_FILE = 'C:\\Users\\example\\.dsh\\demo-profile\\headless-overlay.yml'
const LONG_PATCH = 'C:\\Users\\example\\.dsh\\profiles\\demo-profile\\cordis.patch.yml'
const LONG_BACKUP = 'C:\\Users\\example\\.dsh\\profiles\\demo-profile\\cordis.patch.yml.bak-provider-hub-20261030183313'
const LONG_CWD = 'C:\\Users\\example\\Documents\\deepseek-harness\\default-workspace'

const STUB = {
  '/overview': {
    ok: true,
    home: 'C:\\Users\\example\\.dsh',
    dataDir: 'C:\\Users\\example\\.dsh\\provider-hub',
    registered: ['acme'],
    profiles: [{
      name: 'demo-profile',
      defaultModel: { provider: 'acme', model: 'demo-model' },
      providers: [{ name: 'acme', models: 1, baseURL: 'https://api.example.com/v1' }],
      patchFile: LONG_PATCH,
    }],
    overlays: [{
      file: LONG_FILE,
      declaredProfile: 'demo-profile',
      targetProfile: 'demo-profile',
      provider: 'acme',
      model: 'demo-model',
    }],
    providers: [],
    prefs: { autoScan: true },
    counters: { profiles: 1, overlays: 1, providers: 1, refs: 2, dangling: 1, missing: 0, ignored: 0 },
    diagnostics: [],
  },
  '/refs': {
    ok: true,
    refs: [
      { verdict: 'dangling', provider: 'acme', profile: 'demo-profile', model: 'demo-model', kind: 'overlay', file: LONG_FILE, line: 12, apiKeyEnv: 'DEMO_API_KEY', ignored: false },
      { verdict: 'ok', provider: 'deepseek-account', profile: 'desktop', model: 'deepseek-flash', kind: 'profile', file: LONG_PATCH, line: 25, apiKeyEnv: '', ignored: false },
    ],
    dangling: [{}],
    plan: {
      actions: [{
        profile: 'demo-profile',
        file: LONG_PATCH,
        add: [{ name: 'acme', from: 'desktop', refFile: LONG_FILE, refLine: 12 }],
      }],
      blocked: [],
    },
    counters: { refs: 2, dangling: 1 },
  },
  '/state': {
    ok: true,
    dataDir: 'C:\\Users\\example\\.dsh\\provider-hub',
    stateFile: 'C:\\Users\\example\\.dsh\\provider-hub\\state.json',
    dataDirOk: true,
    prefs: { autoScan: true, showIgnored: false, maxHistory: 20 },
    ignored: [],
    history: [],
  },
  '/sessions': {
    ok: true,
    total: 1,
    rows: [{ at: 1761800000000, provider: 'acme', model: 'demo-model', title: '一个很长标题的会话', cwd: LONG_CWD }],
    byProvider: [{ provider: 'acme', sessions: 1, models: [{ model: 'demo-model', sessions: 1 }], last: 1761800000000 }],
    errors: [],
  },
}

globalThis.fetch = (url) => {
  const path = String(url).replace('/dsh-provider-hub', '').split('?')[0]
  const data = STUB[path]
  return Promise.resolve({
    status: data ? 200 : 404,
    json: () => Promise.resolve(data || { ok: false, error: '没有桩数据：' + path }),
  })
}

await import('../lib/client.js')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

// ── 会记账的 React 替身 ─────────────────────────────────────────────────
let states = []
let hookIdx = 0
const effects = []

const ReactStub = {
  createElement: (t, p, ...children) => {
    const props = Object.assign({}, p)
    if (children.length && !('children' in props)) props.children = children.length === 1 ? children[0] : children
    return { t, p: props, c: children }
  },
  useState: (init) => {
    const i = hookIdx++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    const set = (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }
    return [states[i], set]
  },
  // 只记录，稍后手动执行 —— 这样能控制「数据到位后再重渲染一次」
  useEffect: (fn) => { effects.push(fn) },
  useCallback: (f) => f,
  useMemo: (f) => f(),
  Fragment: 'Fragment',
}

const req = (name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
}

const mod = captured.factory(req)

// ── 渲染一次（hookIdx 归零，保证 useState 顺序对齐） ────────────────────
const Panel = (() => {
  let comp = null
  const slots = {
    get: (k) => (k === 'slots'
      ? { inject: (slot, fn) => fn(), register: (def, c) => { comp = c; return () => {} } }
      : undefined),
  }
  mod.apply(slots)
  return comp
})()

ok(typeof Panel === 'function', '拿到 Panel 组件')

const render = () => {
  hookIdx = 0
  effects.length = 0
  let node
  try {
    node = Panel() // 只产出节点（Panel 里包了错误边界，真正的 hooks 在展开时执行）
  } catch (e) {
    return { error: String((e && e.message) || e), tree: null, effects: [] }
  }
  const tree = expand(node)
  return { tree, effects: effects.slice(), error: null }
}

// ── 节点树展开：把函数组件都执行掉，方便按结构断言 ──────────────────────
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const out = []
    for (const x of node) {
      const r = expand(x)
      if (Array.isArray(r)) out.push(...r)
      else if (r !== null) out.push(r)
    }
    return out
  }
  if (typeof node !== 'object') return null
  if (typeof node.t === 'function') {
    // 函数组件：拿 props 调一次（props.children 已由 createElement 补齐）
    try { return expand(node.t(node.p || {})) } catch { return null }
  }
  const kids = []
  for (const ch of node.c || []) {
    const r = expand(ch)
    if (Array.isArray(r)) kids.push(...r)
    else if (r !== null) kids.push(r)
  }
  return { t: node.t, p: node.p || {}, c: kids }
}

const walk = (node, fn) => {
  if (!node || typeof node === 'string') return
  fn(node)
  for (const ch of node.c || []) walk(ch, fn)
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return (node.c || []).map(textOf).join('')
}
const kidsOf = (node, tag) => (node && node.c ? node.c.filter((x) => x && x.t === tag) : [])
const headerOf = (table) => {
  const thead = kidsOf(table, 'thead')[0]
  const tr = thead && kidsOf(thead, 'tr')[0]
  return tr ? kidsOf(tr, 'th').map(textOf) : []
}
const rowsOf = (table) => {
  const tbody = kidsOf(table, 'tbody')[0]
  return tbody ? kidsOf(tbody, 'tr') : []
}
const cellsOf = (tr) => kidsOf(tr, 'td')

// ── 第一次渲染 + 跑 effect + 等数据落地 ─────────────────────────────────
const first = render()
ok(!first.error, '首次渲染不抛异常' + (first.error ? '：' + first.error : ''))
ok((first.effects || []).length > 0, `首次渲染登记了 ${(first.effects || []).length} 个 effect`)
for (const fn of first.effects || []) { try { fn() } catch { /* 忽略 */ } }
await new Promise((r) => setTimeout(r, 150)) // 让 fetch → then → setState 的微任务链跑完

// ── 第二次渲染：此时 state 里应已有 overview / refs / state ─────────────
const second = render()
ok(!second.error, '带数据渲染不抛异常' + (second.error ? '：' + second.error : ''))
const tree = second.tree

const tables = []
walk(tree, (n) => { if (n.t === 'table') tables.push(n) })
ok(tables.length >= 3, `渲染出 ${tables.length} 张表（期望 ≥3：会话/引用/配置）`)

const headers = tables.map(headerOf)
const refsIdx = headers.findIndex((h) => h.includes('判定'))
ok(refsIdx >= 0, '找到「引用」表：' + JSON.stringify(headers.map((h) => h.slice(0, 3))))

if (refsIdx >= 0) {
  const t = tables[refsIdx]
  const h = headers[refsIdx]
  ok(!h.includes('位置'), '引用表头里已经没有「位置」列：' + JSON.stringify(h))

  const rows = rowsOf(t)
  // 2 条数据 + 2 行副行
  ok(rows.length === 4, `引用表共 ${rows.length} 行（2 主行 + 2 副行，期望 4）`)

  const subs = rows.filter((tr) => {
    const cells = cellsOf(tr)
    return cells.length === 1 && Number(cells[0].p && cells[0].p.colSpan) === h.length
  })
  ok(subs.length === 2, `副行 ${subs.length} 条，且 colSpan = ${h.length}（整行宽）`)

  const subText = subs.map(textOf).join(' | ')
  ok(subText.includes('位置'), '副行里带「位置」标签')
  ok(subText.includes('headless-overlay.yml'), '副行显示完整文件名')
  ok(!subText.includes('…'), '副行没有省略号（显示全路径，不再截断）')
  ok(subText.includes('C:\\Users\\example\\.dsh\\'), '副行里保留完整目录前缀')

  // 主行不能再塞路径：第 1、3 行（主行）文本里不应出现长路径
  const mains = rows.filter((tr) => cellsOf(tr).length === h.length)
  ok(mains.length === 2, '主行 2 条')
  ok(!mains.some((tr) => textOf(tr).includes('C:\\Users\\example\\.dsh\\')), '主行里不再出现长路径')
}

// ── 同步计划表 / 配置表 / overlay 表都应带副行 ──────────────────────────
const planIdx = headers.findIndex((h) => h.includes('要补的 provider'))
if (planIdx >= 0) {
  const rows = rowsOf(tables[planIdx])
  const sub = rows.find((tr) => cellsOf(tr).length === 1)
  ok(!!sub, '同步计划表也有副行（写入路径 + 引用路径）')
  ok(sub && textOf(sub).includes('cordis.patch.yml'), '计划副行显示目标文件')
  ok(sub && textOf(sub).includes('headless-overlay.yml'), '计划副行显示引用位置')
}

const cfgIdx = headers.findIndex((h) => h.includes('默认模型'))
if (cfgIdx >= 0) {
  const rows = rowsOf(tables[cfgIdx])
  const sub = rows.find((tr) => cellsOf(tr).length === 1)
  ok(!!sub, '配置表有副行（patch 路径 + baseURL）')
  ok(sub && textOf(sub).includes('api.example.com'), '配置副行保留了 baseURL')
}

const ovIdx = headers.findIndex((h) => h.includes('声明的 profile'))
if (ovIdx >= 0) {
  const rows = rowsOf(tables[ovIdx])
  const sub = rows.find((tr) => cellsOf(tr).length === 1)
  ok(!!sub && textOf(sub).includes('headless-overlay.yml'), 'overlay 表有副行且显示文件')
}

// ── 会话表：工作目录也挪到副行（会话要点按钮才扫，这里主动点一次） ──────
const buttons = []
walk(tree, (n) => { if (n.t === 'button') buttons.push(n) })
const scanSessionsBtn = buttons.find((b) => textOf(b).includes('扫描对话'))
ok(!!scanSessionsBtn, '找到「扫描对话」按钮')
if (scanSessionsBtn && scanSessionsBtn.p && typeof scanSessionsBtn.p.onClick === 'function') {
  try { scanSessionsBtn.p.onClick() } catch (e) { ok(false, '点「扫描对话」抛错：' + e.message) }
  await new Promise((r) => setTimeout(r, 150))
  const third = render()
  const t3 = []
  walk(third.tree, (n) => { if (n.t === 'table') t3.push(n) })
  const h3 = t3.map(headerOf)
  const sesIdx = h3.findIndex((h) => h.includes('更新时间'))
  ok(sesIdx >= 0, '会话明细表已渲染：' + JSON.stringify(h3.map((h) => h[0])))
  if (sesIdx >= 0) {
    const rows = rowsOf(t3[sesIdx])
    const sub = rows.find((tr) => cellsOf(tr).length === 1)
    ok(!!sub && textOf(sub).includes('工作目录'), '会话表把工作目录放到副行')
    ok(!!sub && !textOf(sub).includes('…'), '工作目录没有被截断')
    ok(!h3[sesIdx].includes('工作目录'), '会话表头里已经没有「工作目录」列')
  }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
