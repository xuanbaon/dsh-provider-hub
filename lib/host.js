/**
 * dsh-provider-hub · 宿主半边
 * ============================================================================
 * 只做两件事：把设置页要的数据算出来（scan.js），把「一键同步」和用户偏好落到磁盘上。
 * 全部经 `/dsh-provider-hub/*` 路由；网页半边（lib/client.js）只负责显示。
 *
 * 路由总表：
 *   GET  /dsh-provider-hub/health    版本 / 目录 / 运行时长（排查用，无副作用）
 *   GET  /dsh-provider-hub/overview  实际配置：各 profile 的 provider 定义 + 默认模型 + overlay + 运行时注册表
 *   GET  /dsh-provider-hub/sessions  会话实际在用谁（session_projcache → modelSelection.lastUsed）
 *   GET  /dsh-provider-hub/refs      谁引用了谁 + 悬空判定 + 同步计划（已剔除被忽略项）
 *   GET  /dsh-provider-hub/state     偏好 / 已忽略项 / 同步历史 / 数据目录位置
 *   POST /dsh-provider-hub/sync      {apply:false} 预演 / {apply:true} 真写（先备份）
 *   POST /dsh-provider-hub/rewrite   {from,to:{provider,model},apply} 换供应商：把所有引用 A 的地方改成 B
 *   POST /dsh-provider-hub/prefs     改偏好 {patch:{showIgnored,autoScan,maxHistory,maxBackups}}
 *   POST /dsh-provider-hub/ignore    忽略 / 取消忽略一条引用 {provider, profile, remove?}
 *   POST /dsh-provider-hub/history   清空同步历史 {clear:true}
 *
 * ⚠ 两个方向，别搞混：
 *   · /sync    = **补定义**：引用了 A 但这份 profile 没有 A 的定义 ⇒ 把定义复制过去（治 NO_ADAPTER）
 *   · /rewrite = **换引用**：把「provider: A」这行改成「provider: B」（就是平时说的"换供应商"）
 *     换完会自动跑一次补定义，免得换成的是一个没定义的名字。
 * ⚠ 改完 patch 要重启 DSH 才生效（loader 不热读 patch），页面会明确提示。
 *
 * ⚠ 错误处理：本模块的任何一条路径都不允许把异常抛给 DSH。路由内有顶层 try/catch 兜到 500 JSON；
 *   apply() 本身也整体 try/catch —— 插件加载失败只会让这一页消失，不会拖垮整个设置面板。
 */
import { scanConfig, scanSessions, scanRefs, planSync, applySync, planRewrite, applyRewrite, applyIgnores } from './scan.js'
import { dshHome, dataDir, stateFile } from './paths.js'
import { createLogger, errText } from './log.js'
import { loadState, saveState, normalize, pushHistory, setIgnored } from './store.js'
import { basename } from 'node:path'

/**
 * cordis 插件名。loader 用 entry 的 id（cordis.patch.yml 里是 `provider-hub`）来引用本模块，
 * 这个名字只用于日志与依赖图，保持和包名一致即可。
 */
export const name = 'provider-hub'

/**
 * ⚠ 这一行不能少，也不能漏项。
 *
 * cordis 的服务是按需注入的：**没写进 inject 的服务，`ctx.<service>` 取的时候会直接抛**
 * `cannot get property "webServer" without inject`（不是返回 undefined）。
 * 早先版本漏了这行，表现就是设置页能打开、但每个接口都 404——
 * 因为 apply() 在挂路由那一步就抛了，被外层 catch 吞成一条日志，Host 于是对
 * `/dsh-provider-hub/*` 一律回它自己的 404 页面，前端拿到 HTML 就说「返回的不是 JSON」。
 *
 * 只用 `ctx.get('connection')` / `ctx.get('llm')` 取的服务**故意不列**：
 * 它们只在需要时才取，取不到就降级（栅栏退回同源判定、运行时注册表留空），
 * 列进来会让缺这两个服务的宿主直接装不上插件。
 */
export const inject = ['webServer']

const PREFIX = '/dsh-provider-hub'
const VERSION = '1.0.2'

/** 请求体上限：同步请求最多带个 {apply:true}，50KB 已经极其宽松。 */
const MAX_BODY_BYTES = 50_000

/**
 * 安全响应：res 可能已经被栅栏关掉（writableEnded）或客户端已断开。
 * 这些情况下继续写会抛 ERR_STREAM_*，所以先检查再写，且整体吞异常。
 */
function sendJson(res, code, obj) {
  try {
    if (!res || res.writableEnded || res.headersSent) return
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch { /* 客户端已断开，忽略 */ }
}

/** 纯文本响应（栅栏拒绝时用，保持和 DSH 自身的风格一致）。 */
function sendStatus(res, code) {
  try {
    if (!res || res.writableEnded) return
    res.statusCode = code
    res.end()
  } catch { /* 忽略 */ }
}

/**
 * 读请求体。任何异常都归零成 {}，让路由走「没带参数」的分支而不是 500。
 *
 * 超过上限时：停止累积，但**继续把剩余数据消费掉**（不 destroy socket）——
 * 直接 destroy 会让客户端收到 ECONNRESET 而不是 413，用户看到的是「网络错误」，
 * 完全不知道是自己发的包太大。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let tooLarge = false
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      req.on('data', (c) => {
        if (done || tooLarge) return // 已判定过大：只是把剩余字节读掉
        data += c
        if (data.length > MAX_BODY_BYTES) {
          tooLarge = true
          data = ''
          finish({ tooLarge: true })
        }
      })
      req.on('end', () => {
        if (tooLarge) return
        try { finish(JSON.parse(data || '{}')) } catch { finish({}) }
      })
      req.on('error', () => finish({}))
      req.on('aborted', () => finish({}))
    } catch { finish({}) }
  })
}

/** 运行时已注册的 provider（拿不到就是 null，页面会显示「未知」而不是乱判悬空）。 */
function registeredProviders(ctx) {
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
    if (!llm || typeof llm.listProviders !== 'function') return null
    const list = llm.listProviders()
    if (!Array.isArray(list)) return null
    return list
      .map((x) => (typeof x === 'string' ? x : (x && (x.provider || x.name || x.id)) || ''))
      .filter(Boolean)
  } catch { return null }
}

/**
 * 把一条路由的实现包起来：统一 try/catch + 统一错误响应 + 统一日志。
 * 这样每个 handler 里可以放心写业务逻辑，不用到处 try。
 */
function guard(log, name, fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      log(`路由 ${name} 出错：${errText(err)}`, 'error')
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err), route: name })
    }
  }
}

export function apply(ctx) {
  const log = createLogger({ tag: 'provider-hub' })
  const startedAt = Date.now()

  // ── 安全闸门 ────────────────────────────────────────────────────────────
  /** 本机同源兜底（fence 拿不到时也挡得住浏览器里别的网页）。 */
  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '')
      if (!host) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const pick = String(req.headers.origin || req.headers.referer || '')
      if (!pick) return true
      try {
        const u = new URL(pick)
        if (String(u.host || '').toLowerCase() === host.toLowerCase()) return true
        const def = u.protocol === 'https:' ? '443' : '80'
        return `${u.hostname}:${u.port || def}`.toLowerCase() === host.toLowerCase()
      } catch { return false }
    } catch { return false }
  }

  /** DSH 的信任栅栏（真鉴权）；拿不到就退回同源判定。 */
  const fenceReject = (req, res) => {
    let conn = null
    try { conn = ctx.get('connection') } catch { conn = null }
    if (!conn || typeof conn.requestRejection !== 'function') return false
    try {
      const rejection = conn.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      sendStatus(res, typeof rejection === 'number' ? rejection : 403)
      return true
    } catch (err) {
      log('信任栅栏出错，按不通过处理：' + errText(err), 'warn')
      sendStatus(res, 403)
      return true
    }
  }

  // ── 公共取数（都带兜底，绝不让一次扫描失败带崩页面） ──────────────────
  /** 读状态；失败时返回默认状态 + warning，页面照常渲染。 */
  const readState = () => {
    const loaded = loadState()
    return loaded
  }

  /** 把扫描结果的 errors 收敛成页面能直接显示的一小段。 */
  const diagOf = (...lists) => {
    const out = []
    for (const l of lists) {
      for (const e of (l && l.errors) || []) out.push({ where: String(e.where || ''), message: String(e.message || '') })
    }
    return out.slice(0, 60)
  }

  /** 一次把「配置 + 运行时 + 引用 + 忽略」都算好，好几个路由都要用。 */
  const snapshot = () => {
    const cfg = scanConfig()
    const registered = registeredProviders(ctx)
    const rawRefs = scanRefs(cfg, registered)
    const loaded = readState()
    const marked = applyIgnores(rawRefs, loaded.state, {
      showIgnored: loaded.state.prefs.showIgnored,
    })
    const plan = planSync(cfg, marked)
    return { cfg, registered, rawRefs, marked, plan, loaded }
  }

  // ── 路由实现 ───────────────────────────────────────────────────────────
  const routes = {
    'GET /health': guard(log, 'health', async (req, res) => {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        home: dshHome(),
        dataDir: dataDir(),
        stateFile: stateFile(),
      })
    }),

    'GET /overview': guard(log, 'overview', async (req, res) => {
      const { cfg, registered, marked, loaded } = snapshot()
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        home: cfg.home,
        dataDir: loaded.dir,
        registered,
        profiles: cfg.profiles,
        overlays: cfg.overlays,
        // lines 只在宿主内部用来拼同步块，不下发给页面（省体积）
        providers: cfg.allDefs.map(({ lines, ...rest }) => rest),
        prefs: loaded.state.prefs,
        counters: {
          profiles: cfg.profiles.length,
          overlays: cfg.overlays.length,
          providers: cfg.allDefs.length,
          refs: marked.refs.length,
          dangling: marked.dangling.length,
          missing: marked.missing.length,
          ignored: marked.ignoredCount,
        },
        diagnostics: diagOf(cfg),
        warning: loaded.error || '',
        dataDirOk: loaded.dataDirOk,
      })
    }),

    'GET /sessions': guard(log, 'sessions', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200))
      const out = scanSessions(limit)
      sendJson(res, 200, { ok: true, ...out, diagnostics: diagOf(out) })
    }),

    'GET /refs': guard(log, 'refs', async (req, res) => {
      const { cfg, registered, marked, plan, loaded } = snapshot()
      sendJson(res, 200, {
        ok: true,
        registered,
        refs: marked.refs,
        dangling: marked.dangling,
        missing: marked.missing,
        ignored: marked.ignoredCount,
        plan: { actions: plan.actions, blocked: plan.blocked },
        prefs: loaded.state.prefs,
        diagnostics: diagOf(cfg),
        warning: loaded.error || '',
      })
    }),

    'GET /state': guard(log, 'state', async (req, res) => {
      const loaded = readState()
      sendJson(res, 200, {
        ok: true,
        dataDir: loaded.dir,
        stateFile: loaded.file,
        dataDirOk: loaded.dataDirOk,
        created: loaded.created,
        recovered: loaded.recovered,
        warning: loaded.error || '',
        prefs: loaded.state.prefs,
        ignored: loaded.state.ignored,
        history: loaded.state.history,
        lastScanAt: loaded.state.lastScanAt,
      })
    }),

    'POST /prefs': guard(log, 'prefs', async (req, res) => {
      const body = await readBody(req)
      if (body.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : {}
      const loaded = readState()
      const cur = loaded.state
      const next = normalize({
        ...cur,
        prefs: { ...cur.prefs, ...patch }, // 只覆盖传上来的键，其余保持
      })
      const saved = saveState(next)
      if (!saved.ok) { sendJson(res, 500, { ok: false, error: saved.error || '保存失败' }); return }
      log(`偏好已更新：${JSON.stringify(next.prefs)}`)
      sendJson(res, 200, { ok: true, prefs: next.prefs, stateFile: saved.file })
    }),

    'POST /ignore': guard(log, 'ignore', async (req, res) => {
      const body = await readBody(req)
      if (body.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      const provider = String(body.provider || '').trim()
      if (!provider) { sendJson(res, 400, { ok: false, error: '缺少 provider' }); return }
      const loaded = readState()
      const next = loaded.state
      setIgnored(next, { provider, profile: String(body.profile || ''), note: body.note, remove: !!body.remove })
      const saved = saveState(next)
      if (!saved.ok) { sendJson(res, 500, { ok: false, error: saved.error || '保存失败' }); return }
      log(`${body.remove ? '取消忽略' : '忽略'} ${provider}@${String(body.profile || '')}`)
      sendJson(res, 200, { ok: true, ignored: next.ignored })
    }),

    'POST /history': guard(log, 'history', async (req, res) => {
      const body = await readBody(req)
      if (body.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      if (!body.clear) { sendJson(res, 400, { ok: false, error: '只支持 {clear:true}' }); return }
      const loaded = readState()
      const next = loaded.state
      const n = next.history.length
      next.history = []
      const saved = saveState(next)
      if (!saved.ok) { sendJson(res, 500, { ok: false, error: saved.error || '保存失败' }); return }
      log(`清空同步历史（${n} 条）`)
      sendJson(res, 200, { ok: true, cleared: n })
    }),

    'POST /sync': guard(log, 'sync', async (req, res) => {
      const body = await readBody(req)
      if (body.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      const { cfg, marked, plan, loaded } = snapshot()
      if (!body.apply) {
        sendJson(res, 200, { ok: true, applied: false, plan: { actions: plan.actions, blocked: plan.blocked }, warning: loaded.error || '' })
        return
      }
      if (!plan.actions.length) {
        sendJson(res, 200, { ok: true, applied: false, plan: { actions: [], blocked: plan.blocked }, note: '没有需要补的定义' })
        return
      }

      // maxBackups 只在写之前读一次；0 表示不清理历史备份
      const receipts = applySync(cfg, plan.actions, { maxBackups: loaded.state.prefs.maxBackups })
      for (const r of receipts) {
        log(`同步 ${r.profile}: ${r.ok ? (r.skipped ? '已是最新' : (r.added || []).join(',')) : '失败 ' + r.why}`,
          r.ok ? 'info' : 'warn')
      }

      // 记历史（写失败不影响收据返回 —— 用户最关心的是「这次改成了没有」）
      let historyError = ''
      try {
        const st = readState().state
        pushHistory(st, { applied: true, receipts })
        const saved = saveState(st)
        if (!saved.ok) historyError = saved.error || ''
      } catch (err) {
        historyError = errText(err)
      }
      if (historyError) log('记同步历史失败：' + historyError, 'warn')

      sendJson(res, 200, {
        ok: true,
        applied: true,
        receipts,
        plan: { blocked: plan.blocked },
        restartRequired: receipts.some((r) => r.ok && !r.skipped),
        historyError,
        diagnostics: diagOf(cfg, marked),
      })
    }),

    /**
     * ⭐ 「换供应商」——这个插件的主要用途。
     * 面板上把 A 家换成 B 家，这里负责把「provider: A」同步到所有真正写着 A 的地方，
     * 顺带把 B 的定义补进还没有它的 profile（否则换完就是 NO_ADAPTER）。
     *
     * body: { from, to: {provider, model}, apply, kinds? }
     *   apply=false 只预演，不碰任何文件（默认安全）
     */
    'POST /rewrite': guard(log, 'rewrite', async (req, res) => {
      const body = await readBody(req)
      if (body.tooLarge) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return }
      const from = String(body.from || '').trim()
      const to = body.to && typeof body.to === 'object' ? body.to : {}
      const toProvider = String(to.provider || '').trim()
      const toModel = String(to.model || '').trim()
      if (!from) { sendJson(res, 400, { ok: false, error: '缺少 from（要换掉哪个 provider）' }); return }
      if (!toProvider) { sendJson(res, 400, { ok: false, error: '缺少 to.provider（换成哪个）' }); return }

      const { cfg, marked, loaded } = snapshot()
      const plan = planRewrite(cfg, marked, { from, to: { provider: toProvider, model: toModel }, kinds: body.kinds })

      if (!body.apply) {
        sendJson(res, 200, {
          ok: true,
          applied: false,
          from,
          to: { provider: toProvider, model: toModel },
          hasDef: !!plan.hasDef,
          edits: plan.edits,
          skipped: plan.skipped,
          diagnostics: plan.errors.length ? plan.errors : diagOf(cfg),
          warning: loaded.error || '',
        })
        return
      }
      if (!plan.edits.length) {
        sendJson(res, 200, { ok: true, applied: false, edits: [], skipped: plan.skipped, note: '没有需要改写的引用' })
        return
      }

      // ① 换引用
      const rewrite = applyRewrite(cfg, plan.edits, { maxBackups: loaded.state.prefs.maxBackups })
      for (const r of rewrite) {
        log(`换供应商 ${basename(r.file)}: ${r.from} → ${r.toProvider}${r.ok ? '' : ' 失败 ' + r.why}`, r.ok ? 'info' : 'warn')
      }

      // ② 换完立刻补定义：B 在某个 profile 里没定义的话，改完就是 NO_ADAPTER —— 一次做完
      let backfill = []
      let backfillError = ''
      try {
        const cfg2 = scanConfig()
        const refs2 = scanRefs(cfg2, registeredProviders(ctx))
        const marked2 = applyIgnores(refs2, readState().state, { showIgnored: loaded.state.prefs.showIgnored })
        const plan2 = planSync(cfg2, marked2)
        if (plan2.actions.length) backfill = applySync(cfg2, plan2.actions, { maxBackups: loaded.state.prefs.maxBackups })
      } catch (err) {
        backfillError = errText(err)
        log('换供应商后补定义失败：' + backfillError, 'warn')
      }

      // ③ 记历史
      let historyError = ''
      try {
        const st = readState().state
        pushHistory(st, {
          applied: true,
          action: 'rewrite',
          from,
          to: toProvider,
          receipts: rewrite.map((r) => ({ profile: r.profile, file: r.file, ok: r.ok, why: r.why, added: [r.toProvider] })),
        })
        const saved = saveState(st)
        if (!saved.ok) historyError = saved.error || ''
      } catch (err) {
        historyError = errText(err)
      }

      sendJson(res, 200, {
        ok: true,
        applied: true,
        from,
        to: { provider: toProvider, model: toModel },
        receipts: rewrite,
        backfill,
        backfillError,
        historyError,
        restartRequired: rewrite.some((r) => r.ok),
        diagnostics: diagOf(cfg),
      })
    }),
  }

  /**
   * 路由分发：先过安全闸门，再按 `方法 路径` 找实现；找不到时区分 404 / 405。
   * 全部包在 try/catch 里 —— 分发本身也不许抛。
   */
  const handler = async (req, res) => {
    try {
      if (fenceReject(req, res)) return
      if (!sameOriginOk(req)) { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }); return }

      let path = ''
      try {
        path = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || PREFIX
      } catch {
        sendJson(res, 400, { ok: false, error: '请求地址无法解析' })
        return
      }

      const sub = path === PREFIX ? '/overview' : path.startsWith(PREFIX + '/') ? path.slice(PREFIX.length) : null
      if (sub === null) { sendJson(res, 404, { ok: false, error: '没有这个路由：' + path }); return }

      const key = `${req.method} ${sub}`
      const fn = routes[key]
      if (fn) { await fn(req, res); return }

      // 路径存在但方法不对 → 405，比笼统的 404 更好排查
      const anyMethod = Object.keys(routes).some((k) => k.endsWith(' ' + sub))
      if (anyMethod) {
        sendJson(res, 405, { ok: false, error: `${sub} 不支持 ${req.method}`, allow: Object.keys(routes).filter((k) => k.endsWith(' ' + sub)).map((k) => k.split(' ')[0]) })
        return
      }
      sendJson(res, 404, { ok: false, error: '没有这个路由：' + path })
    } catch (err) {
      log('分发请求时出错：' + errText(err), 'error')
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  }

  // ── 注册（失败只记日志，不把插件加载搞崩）──────────────────────────────
  // 先安全地拿到 webServer：inject 已声明，正常走 ctx.webServer；
  // 万一宿主版本没有这个服务（或 cordis 的注入规则变了），退回 ctx.get，再不行就明说原因退出，
  // 而不是让异常冒到 cordis 里变成难懂的加载错误。
  let webServer = null
  try { webServer = ctx.webServer } catch { webServer = null }
  if (!webServer && typeof ctx.get === 'function') {
    try { webServer = ctx.get('webServer') } catch { webServer = null }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    log('宿主没有可用的 webServer 服务，设置页接口不会挂载（DSH 其他功能不受影响）。', 'error')
    return
  }

  try {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: PREFIX, handler }),
      'provider-hub: /dsh-provider-hub 路由',
    )
    log(`已注册路由 ${PREFIX}/*（kind=prefix）`)
  } catch (err) {
    log('挂载路由失败（设置页会用不了，但不会影响 DSH 其他功能）：' + errText(err), 'error')
    return
  }

  // 启动自检：数据目录建不出来时提前在日志里说清楚，别等到用户点保存才报错
  try {
    const st = loadState()
    if (!st.dataDirOk) log('数据目录不可用：' + st.error, 'error')
    else if (st.error) log('状态文件有问题（已用默认值继续）：' + st.error, 'warn')
    log(`已挂载 ${PREFIX} v${VERSION}（DSH_HOME=${dshHome()}，数据目录=${dataDir()}）`)
  } catch (err) {
    log('启动自检失败：' + errText(err), 'warn')
  }
}
