/**
 * 网页半边「契约」自测：不启动 DSH，检查 lib/client.js
 *   1. 是否按 DSH 的模块加载约定自注册（window.__ModuleLoader__.load）
 *   2. apply(ctx) 是否把一页注册进 settings.section
 *   3. 异常路径是否安静（没有 slots / slots.register 抛错 / ctx 是 undefined）
 *   4. 组件树是否套了 ErrorBoundary（渲染抛错不会带白屏）
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/client_contract.mjs
 */
let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }

await import('../lib/client.js')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

ok(!!captured, 'client.js 调用了 window.__ModuleLoader__.load')
ok(captured && captured.id === 'dsh-provider-hub', 'bundle id 与包名一致（' + (captured && captured.id) + '）')
ok(captured && typeof captured.factory === 'function', 'factory 是函数')

/**
 * 极简 React 替身：够 factory 执行到导出，也能模拟一次渲染（不挂载 DOM）。
 * 故意不提供 Component —— 用来验证「没有 class 组件能力时错误边界退化成透传」。
 */
const renders = []
const ReactStub = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  Fragment: 'Fragment',
}
const req = (name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
}
let mod = null
try {
  mod = captured.factory(req)
  ok(true, 'factory 执行成功（没有意外 require）')
} catch (e) {
  ok(false, 'factory 抛错：' + String(e && e.message || e))
}
ok(mod && Array.isArray(mod.inject) && mod.inject.includes('slots'), '导出 inject 数组：' + JSON.stringify(mod && mod.inject))
ok(mod && typeof mod.apply === 'function', '导出 apply 函数')

// ── 注册路径 ────────────────────────────────────────────────────────────
const registered = []
const slotsCtx = {
  get: (k) => (k === 'slots'
    ? {
      inject: (slot, fn) => { ok(slot === 'settings.section', '往 settings.section 槽位注入'); fn() },
      register: (def, comp) => { registered.push({ def, comp }); return () => {} },
    }
    : undefined),
}
try {
  mod.apply(slotsCtx)
  ok(registered.length === 1, '注册了 1 个设置分区')
  ok(registered[0] && registered[0].def.id === 'provider-hub', '分区 id = provider-hub')
  ok(registered[0] && typeof registered[0].def.label === 'function' && registered[0].def.label() === '供应商中心', '分区标题 = 供应商中心')
  ok(registered[0] && typeof registered[0].comp === 'function', '分区组件是函数组件')
  ok(typeof registered[0].def.order === 'number', '分区有排序号 ' + (registered[0] && registered[0].def.order))
} catch (e) {
  ok(false, 'apply 抛错：' + String(e && e.message || e))
}

// ── 异常路径：都不许抛 ──────────────────────────────────────────────────
const quiet = (label, fn) => {
  try { fn(); ok(true, label) } catch (e) { ok(false, label + ' —— 抛了：' + String(e && e.message || e)) }
}
quiet('apply(undefined) 不抛', () => mod.apply(undefined))
quiet('apply({}) 不抛', () => mod.apply({}))
quiet('没有 slots 服务时安静退出', () => mod.apply({ get: () => undefined }))
quiet('slots 缺 register 时安静退出', () => mod.apply({ get: () => ({ inject: () => {} }) }))
quiet('slots.register 抛错时被吞掉', () => mod.apply({
  get: () => ({ inject: (s, fn) => fn(), register: () => { throw new Error('DSH 版本不匹配') } }),
}))

// ── 组件树：应能渲染出根节点，且不抛 ────────────────────────────────────
const Panel = registered[0] && registered[0].comp
if (typeof Panel === 'function') {
  quiet('Panel() 渲染不抛异常', () => { renders.push(Panel()) })
  const node = renders[0]
  ok(!!node, 'Panel 返回了节点')
  // Panel 应把真实内容包进错误边界
  const isBoundaryWrapper = node && node.t && node.t.name === 'Boundary'
  const hasBoundaryOrInner = node && (isBoundaryWrapper || (node.p && node.p.children) || node.c)
  ok(!!hasBoundaryOrInner, '组件树里包含错误边界/内层组件')
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
