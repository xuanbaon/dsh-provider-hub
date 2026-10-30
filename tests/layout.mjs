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
// Section 组件自身也有 useState（折叠状态），而且同一页有多个 Section 实例。
// 真实 React 里「同一种组件的每个实例」各自有独立 state，所以这里的帧要按
// **实例**隔离，不能按组件函数引用隔离（那样多个 Section 会互相覆盖）。
// 实例的稳定标识 = 它在节点树里的位置（从根到该节点，每层是「组件函数引用 + 兄弟序号」）。
let effects = []
const framesByKey = new Map() // 实例路径 -> { states, idx }
let compStack = [] // 当前展开链上的「实例路径」字符串

const frameOf = () => {
  const key = compStack[compStack.length - 1]
  let f = framesByKey.get(key)
  if (!f) { f = { states: [], idx: 0 }; framesByKey.set(key, f) }
  return f
}

const ReactStub = {
  createElement: (t, p, ...children) => {
    const props = Object.assign({}, p)
    if (children.length && !('children' in props)) props.children = children.length === 1 ? children[0] : children
    return { t, p: props, c: children }
  },
  useState: (init) => {
    const frame = frameOf()
    const i = frame.idx++
    if (!(i in frame.states)) frame.states[i] = typeof init === 'function' ? init() : init
    const set = (v) => { frame.states[i] = typeof v === 'function' ? v(frame.states[i]) : v }
    return [frame.states[i], set]
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

// ── 渲染一次（每次把所有实例的 hook 计数归零，但 state 保留） ────────────
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
  for (const f of framesByKey.values()) f.idx = 0 // state 保留，只把 hook 计数归零
  compStack = []
  effects.length = 0
  let node
  try {
    node = Panel()
  } catch (e) {
    return { error: String((e && e.message) || e), tree: null, effects: [] }
  }
  const tree = expand(node)
  return { tree, effects: effects.slice(), error: null }
}

// ── 节点树展开：把函数组件都执行掉，方便按结构断言 ──────────────────────
// 每个函数组件实例的「路径」= 父实例路径 + 自己在父级 children 里的序号，
// 这样同一函数组件出现多次时，各自的 useState 互不串扰。
const expand = (node, path) => {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const out = []
    for (let i = 0; i < node.length; i++) {
      const r = expand(node[i], path ? path + ':' + i : 'a' + i)
      if (Array.isArray(r)) out.push(...r)
      else if (r !== null) out.push(r)
    }
    return out
  }
  if (typeof node !== 'object') return null
  if (typeof node.t === 'function') {
    const myPath = path || 'root'
    compStack.push(myPath)
    let r = null
    try { r = expand(node.t(node.p || {}), myPath) } catch { r = null }
    compStack.pop()
    return r
  }
  const kids = []
  const kidsArr = node.c || []
  for (let i = 0; i < kidsArr.length; i++) {
    const r = expand(kidsArr[i], path ? path + ':' + i : 'k' + i)
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

// ── 折叠区块：点击「点击展开」的标题行，把收起的 Section 全部展开 ──────
// Section 标题是个带 onClick 的 div，其 title 属性是「点击展开」/「点击收起」。
// 展开后再检查表格，避免「默认收起」把表格藏起来导致断言误判。
const expandAllSections = (tree) => {
  walk(tree, (n) => {
    if (n && n.t === 'div' && n.p && n.p.title === '点击展开' && typeof n.p.onClick === 'function') {
      try { n.p.onClick() } catch { /* 忽略 */ }
    }
  })
}

// ── 第一次渲染 + 跑 effect + 等数据落地 ─────────────────────────────────
const first = render()
ok(!first.error, '首次渲染不抛异常' + (first.error ? '：' + first.error : ''))
ok((first.effects || []).length > 0, `首次渲染登记了 ${(first.effects || []).length} 个 effect`)
for (const fn of first.effects || []) { try { fn() } catch { /* 忽略 */ } }
await new Promise((r) => setTimeout(r, 150)) // 让 fetch → then → setState 的微任务链跑完

// ── 第二次渲染：此时 state 里应已有 overview / refs / state ─────────────
let second = render()
ok(!second.error, '带数据渲染不抛异常' + (second.error ? '：' + second.error : ''))
// 把默认收起的 Section 展开（点「点击展开」标题），再取一份展开后的树
expandAllSections(second.tree)
second = render()
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
  let third = render()
  expandAllSections(third.tree) // 会话 Section 默认收起，展开后再取树
  third = render()
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

// ── 每条引用都能「单独」换供应商（不是只有批量那一个入口） ──────────────────
const swapBtn = buttons.find((b) => textOf(b) === '换')
ok(!!swapBtn, '引用表每行都有「换」按钮（可单独更换提供商）')
if (swapBtn && swapBtn.p && typeof swapBtn.p.onClick === 'function') {
  try { swapBtn.p.onClick() } catch (e) { ok(false, '点「换」抛错：' + e.message) }
  const fourth = render()
  const t4 = []
  walk(fourth.tree, (n) => { if (n.t === 'table') t4.push(n) })
  const h4 = t4.map(headerOf)
  const refsIdx = h4.findIndex((h) => h.includes('密钥变量'))
  ok(refsIdx >= 0, '引用表仍然渲染出来了')
  if (refsIdx >= 0) {
    const rows4 = rowsOf(t4[refsIdx])
    const editRow = rows4.find((tr) => textOf(tr).includes('把这一处换成'))
    ok(!!editRow, '点「换」后这一行的副行变成编辑区（选 provider + 模型）')
    ok(!!editRow && textOf(editRow).includes('确定'), '编辑区有「确定」按钮')
    ok(!!editRow && textOf(editRow).includes('只改这一行'), '编辑区说明了只影响这一处')
    // 别的行不该跟着变成编辑区（只能选中的那一行展开）
    const editing = rows4.filter((tr) => textOf(tr).includes('把这一处换成'))
    ok(editing.length === 1, '只有被点的那一行展开编辑区（实际 ' + editing.length + ' 行）')
  }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
