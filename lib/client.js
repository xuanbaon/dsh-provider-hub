// DSH「供应商中心」· 网页半边
// ============================================================================
// 在 **设置 → 供应商中心** 加一页，回答三个问题：
//   ① 会话实际在用哪个 provider/model      （按钮：扫描对话）
//   ② 插件 / profile 配置里引用了谁         （按钮：扫描插件与配置）
//   ③ 谁被引用了却没有定义（悬空引用）      （自动标红）
// 外加「一键同步」：把别处已定义的 provider 补进引用了它却没定义的 profile，
// 这正是 `NO_ADAPTER: no adapter registered for provider "acme"` 的修法。
//
// ⚠ client bundle 不是 ESM，是自注册脚本（跟 dsh-speak-up / dsh-bili-scroll 同一套约定）：
//     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
// ⚠ 进「设置」靠 `settings.section` 槽位；不自己糊全屏 overlay。
// ⚠ 所有写操作都在宿主半边做（lib/host.js → /dsh-provider-hub/*），这里只发请求。
//
// 健壮性约定（对应「不要让插件因一个错误而崩溃」）：
//   · 每个请求都带 20 秒超时，失败一律转成 {ok:false,error}，绝不 reject 到渲染层；
//   · 外面套一层 ErrorBoundary：万一某个字段结构变了导致渲染抛错，只在本区内显示
//     错误信息，不会把整个设置面板带白屏；
//   · 所有可能为 undefined 的数组在渲染前都过一遍 arr()，空值一律显示占位符。
window.__ModuleLoader__.load({
  id: 'dsh-provider-hub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    const B = '/dsh-provider-hub'
    const TIMEOUT_MS = 20000

    /** 数组兜底：任何非数组都当成空数组，避免上游字段缺失把渲染搞崩。 */
    const arr = (v) => (Array.isArray(v) ? v : [])

    /**
     * 统一请求封装。返回的 Promise **永不 reject**，
     * 失败也变成 { ok:false, error } —— 页面只需要一种错误形状。
     */
    const jfetch = (path, opts) => {
      const o = Object.assign({ cache: 'no-store' }, opts || {})
      let ctrl = null
      let timer = null
      try {
        if (typeof AbortController !== 'undefined') {
          ctrl = new AbortController()
          o.signal = ctrl.signal
          timer = setTimeout(() => { try { ctrl.abort() } catch { /* 忽略 */ } }, TIMEOUT_MS)
        }
      } catch { ctrl = null }
      const done = () => { if (timer) { clearTimeout(timer); timer = null } }
      return fetch(B + path, o)
        .then((r) => r.json().catch(() => ({
          ok: false,
          // 404 几乎总是「宿主半边没挂上路由」（inject 漏项 / 插件未重启），
          // 直接把排查位置写在提示里，省得看着一句「不是 JSON」无从下手。
          error: r.status === 404
            ? '接口没有挂上（HTTP 404）：插件宿主半边未生效。请看 ~/.dsh/provider-hub/logs/provider-hub.log，然后重启 DSH。'
            : r.status === 401 || r.status === 403
              ? `被宿主拒绝（HTTP ${r.status}），可能不是从 DSH 本机页面打开的。`
              : `返回的不是 JSON（HTTP ${r.status}）`,
        })))
        .catch((e) => ({
          ok: false,
          error: e && e.name === 'AbortError'
            ? `请求超时（${TIMEOUT_MS / 1000} 秒没有响应），宿主半边可能卡住或没挂上`
            : String((e && e.message) || e),
        }))
        .then((d) => { done(); return d })
        .catch((e) => { done(); return { ok: false, error: String((e && e.message) || e) } })
    }
    const jget = (p) => jfetch(p, {})
    const jpost = (p, body) => jfetch(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    // 配色跟着主题变量走，浅色/深色都自动对
    const S = {
      wrap: {
        padding: '12px 14px 28px',
        fontSize: 13,
        lineHeight: 1.65,
        color: 'var(--dsw-alias-text-1, inherit)',
      },
      h: { fontSize: 13.5, fontWeight: 600, margin: '18px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.6))',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        borderRadius: 7,
        padding: '4px 11px',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      btnMain: {
        border: '1px solid var(--dsw-alias-border-accent, rgba(64,120,255,.6))',
        background: 'var(--dsw-alias-bg-accent, rgba(64,120,255,.12))',
        color: 'inherit',
        borderRadius: 7,
        padding: '4px 12px',
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
      },
      btnMini: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '0 6px',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '18px',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        fontWeight: 600,
        opacity: 0.75,
        padding: '5px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '4px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))',
        verticalAlign: 'top',
      },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, Consolas, monospace)', fontSize: 11.5 },
      chip: (c) => ({
        display: 'inline-block',
        padding: '0 7px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: '18px',
        border: '1px solid ' + c.border,
        background: c.bg,
        color: c.fg,
        whiteSpace: 'nowrap',
      }),
      code: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, Consolas, monospace)',
        fontSize: 11.5,
        opacity: 0.85,
        wordBreak: 'break-all',
      },
      note: {
        borderLeft: '3px solid var(--dsw-alias-border-accent, rgba(64,120,255,.6))',
        padding: '6px 10px',
        margin: '8px 0',
        background: 'var(--dsw-alias-bg-layer-2, rgba(64,120,255,.06))',
        borderRadius: 6,
        fontSize: 12,
      },
      err: {
        borderLeft: '3px solid #d9534f',
        padding: '6px 10px',
        margin: '8px 0',
        background: 'rgba(217,83,79,.08)',
        borderRadius: 6,
        fontSize: 12,
      },
      warn: {
        borderLeft: '3px solid #c8940a',
        padding: '6px 10px',
        margin: '8px 0',
        background: 'rgba(200,148,10,.1)',
        borderRadius: 6,
        fontSize: 12,
      },
      label: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' },
    }

    const VERDICT = {
      ok: { text: '正常', border: 'rgba(60,160,90,.5)', bg: 'rgba(60,160,90,.12)', fg: '#2e7d4f' },
      dangling: { text: '悬空·可补', border: 'rgba(217,83,79,.55)', bg: 'rgba(217,83,79,.12)', fg: '#c0392b' },
      'runtime-only': { text: '仅运行时', border: 'rgba(200,150,40,.55)', bg: 'rgba(200,150,40,.12)', fg: '#9a6a00' },
      missing: { text: '缺定义', border: 'rgba(120,120,120,.5)', bg: 'rgba(120,120,120,.12)', fg: '#666' },
      ignored: { text: '已忽略', border: 'rgba(120,120,120,.4)', bg: 'rgba(120,120,120,.08)', fg: '#888' },
    }
    const Chip = (v, extra) => {
      const c = VERDICT[v] || VERDICT.missing
      return h('span', { style: extra ? Object.assign({}, S.chip(c), extra) : S.chip(c) }, c.text)
    }
    const time = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
    const short = (p, n) => {
      const s = String(p || '')
      return s.length > (n || 60) ? '…' + s.slice(-(n || 60)) : s
    }
    const Btn = (props) =>
      h('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        style: Object.assign({}, props.main ? S.btnMain : props.mini ? S.btnMini : S.btn, props.disabled ? { opacity: 0.5, cursor: 'default' } : null),
        title: props.title || '',
      }, props.children)

    function Table(props) {
      const { cols, rows, empty } = props
      const list = arr(rows)
      if (!list.length) return h('div', { style: S.dim }, empty || '（空）')
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: S.table },
          h('thead', null, h('tr', null, arr(cols).map((c, i) => h('th', { key: i, style: Object.assign({}, S.th, c.style || {}) }, c.title)))),
          h('tbody', null, list.map((r, ri) => h('tr', { key: ri }, arr(cols).map((c, ci) => {
            let content
            try {
              content = c.render ? c.render(r) : r[c.key]
            } catch (e) {
              // 单个单元格渲染失败只影响这一格
              content = h('span', { style: S.dim }, '（渲染失败：' + String((e && e.message) || e) + '）')
            }
            return h('td', { key: ci, style: Object.assign({}, S.td, c.style || {}) }, content)
          })))),
        ),
      )
    }

    /** 复选框：偏好项都用它，样式统一。 */
    function Check(props) {
      return h('label', { style: S.label },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: !!props.disabled,
          onChange: (e) => { try { props.onChange(!!(e && e.target && e.target.checked)) } catch { /* 忽略 */ } },
        }),
        props.children,
      )
    }

    /**
     * 错误边界：任何子树的渲染异常都被关在这里，显示一段可复制的错误信息。
     * 没有 React.Component（极简环境/测试替身）时退化成透传，不影响加载。
     */
    function makeBoundary() {
      const Base = React && React.Component
      if (!Base) return function PassThrough(props) { return props.children }
      class Boundary extends Base {
        constructor(props) {
          super(props)
          this.state = { error: '' }
        }

        static getDerivedStateFromError(err) {
          return { error: String((err && err.message) || err) }
        }

        componentDidCatch(err) {
          // 只记控制台：页面本身已经能看到错误了
          try { console.error('[provider-hub] 渲染出错', err) } catch { /* 忽略 */ }
        }

        render() {
          if (this.state.error) {
            return h('div', { style: S.wrap },
              h('div', { style: S.err },
                h('b', null, '这一页渲染出错了'), '（插件其他功能不受影响，DSH 本体也不受影响）',
                h('div', { style: Object.assign({}, S.code, { marginTop: 6 }) }, this.state.error),
                h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '可以点下面的按钮重试；如果一直失败，请把这段信息发给我。'),
              ),
              h(Btn, { onClick: () => { try { this.setState({ error: '' }) } catch { /* 忽略 */ } } }, '重试'),
            )
          }
          return this.props.children
        }
      }
      return Boundary
    }
    const ErrorBoundary = makeBoundary()

    function PanelInner() {
      const [overview, setOverview] = React.useState(null)
      const [sessions, setSessions] = React.useState(null)
      const [refs, setRefs] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [receipts, setReceipts] = React.useState(null)
      const [st, setSt] = React.useState(null) // 偏好 / 已忽略 / 历史
      const [busy, setBusy] = React.useState('')
      const [err, setErr] = React.useState('')
      const [showDiag, setShowDiag] = React.useState(false)

      const prefs = (st && st.prefs) || (overview && overview.prefs) || {}

      const loadState = React.useCallback(() => {
        return jget('/state').then((d) => {
          if (!d || d.ok === false) return
          setSt(d)
        })
      }, [])

      const loadOverview = React.useCallback(() => {
        setBusy('overview'); setErr('')
        return jget('/overview').then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '读不到配置'); return null }
          setOverview(d)
          if (d.warning) setErr(d.warning)
          return d // 返回给调用方，省掉一次额外请求
        })
      }, [])

      const scanSessions = () => {
        setBusy('sessions'); setErr('')
        jget('/sessions?limit=200').then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '扫描会话失败'); return }
          setSessions(d)
        })
      }

      const scanRefs = () => {
        setBusy('refs'); setErr('')
        jget('/refs').then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '扫描引用失败'); return }
          setRefs(d)
          setPlan(d.plan || { actions: [], blocked: [] })
          setReceipts(null)
          if (d.warning) setErr(d.warning)
        })
      }

      const dryRun = () => {
        setBusy('plan'); setErr('')
        jpost('/sync', { apply: false }).then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '预演失败'); return }
          setPlan(d.plan || { actions: [], blocked: [] })
          setReceipts(null)
        })
      }

      const applyNow = () => {
        const n = plan && Array.isArray(plan.actions) ? plan.actions.length : 0
        if (!n) return
        if (typeof window !== 'undefined' && window.confirm) {
          const lines = arr(plan.actions).map((a) => `· ${a.profile} ← +${arr(a.add).map((x) => x.name).join(', ')}`).join('\n')
          if (!window.confirm(`要写入下面这些 profile 的 cordis.patch.yml 吗？（写前会自动备份）\n\n${lines}\n\n改完需要重启 DSH 才生效。`)) return
        }
        setBusy('apply'); setErr('')
        jpost('/sync', { apply: true }).then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '同步失败'); return }
          setReceipts(arr(d.receipts))
          setPlan({ actions: [], blocked: arr(d.plan && d.plan.blocked) })
          if (d.historyError) setErr('同步成功，但记历史失败：' + d.historyError)
          loadOverview()
          loadState()
          jget('/refs').then((r2) => { if (r2 && r2.ok !== false) { setRefs(r2); setPlan(r2.plan || { actions: [], blocked: [] }) } })
        })
      }

      /** 忽略 / 取消忽略某条引用。失败只提示，不影响列表其他部分。 */
      const toggleIgnore = (row, remove) => {
        setBusy('ignore'); setErr('')
        jpost('/ignore', { provider: row.provider, profile: row.profile, remove }).then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '保存忽略项失败'); return }
          loadState()
          jget('/refs').then((r2) => { if (r2 && r2.ok !== false) { setRefs(r2); setPlan(r2.plan || { actions: [], blocked: [] }) } })
        })
      }

      /** 改偏好：先本地乐观更新，再落盘；失败回滚并提示。 */
      const setPref = (key, value) => {
        const prev = st
        if (st) setSt(Object.assign({}, st, { prefs: Object.assign({}, st.prefs, { [key]: value }) }))
        jpost('/prefs', { patch: { [key]: value } }).then((d) => {
          if (!d || d.ok === false) {
            setErr((d && d.error) || '保存偏好失败')
            if (prev) setSt(prev)
            return
          }
          if (key === 'showIgnored') {
            jget('/refs').then((r2) => { if (r2 && r2.ok !== false) { setRefs(r2); setPlan(r2.plan || { actions: [], blocked: [] }) } })
          }
        })
      }

      const clearHistory = () => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('清空同步历史？（只删本插件记录，不动任何配置文件）')) return
        setBusy('history')
        jpost('/history', { clear: true }).then((d) => {
          setBusy('')
          if (!d || d.ok === false) { setErr((d && d.error) || '清空历史失败'); return }
          loadState()
        })
      }

      // 首次进页面：读偏好 + 概览；偏好里 autoScan 为真时顺手跑一次引用扫描
      React.useEffect(() => {
        loadState()
        let alive = true
        loadOverview().then((d) => {
          if (!alive) return
          const p = (d && d.prefs) || {}
          if (p.autoScan !== false) scanRefs()
        })
        return () => { alive = false } // 卸载后不再 setState（避免 React 警告）
      }, [loadState, loadOverview])

      const c = (overview && overview.counters) || {}
      const dangling = refs ? arr(refs.dangling).length : (c.dangling || 0)
      const diag = (overview && arr(overview.diagnostics)) || []

      return h('div', { style: S.wrap },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '供应商中心'),
          h('div', { style: S.dim }, '看会话在用谁、插件引用了谁、谁缺定义 —— 一键补齐'),
        ),

        err ? h('div', { style: S.err }, err) : null,

        // ── 概览 + 工具栏 ───────────────────────────────────────────────────
        h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
          h('div', { style: S.row },
            h(Btn, { onClick: loadOverview, disabled: busy === 'overview' }, busy === 'overview' ? '读取中…' : '刷新概览'),
            h(Btn, { onClick: scanSessions, disabled: busy === 'sessions' }, busy === 'sessions' ? '扫描中…' : '扫描对话'),
            h(Btn, { onClick: scanRefs, disabled: busy === 'refs' }, busy === 'refs' ? '扫描中…' : '扫描插件与配置'),
            h(Btn, {
              onClick: dryRun,
              main: true,
              disabled: busy === 'plan',
              title: '先出一份计划：哪些 profile 缺哪些 provider 定义（这一步不写盘）',
            }, busy === 'plan' ? '生成计划…' : '一键同步'),
          ),
          h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 } },
            h('span', null, 'DSH_HOME ', h('code', { style: S.code }, overview ? short(overview.home, 46) : '—')),
            h('span', null, 'profile ', h('b', null, c.profiles == null ? '—' : c.profiles)),
            h('span', null, '已定义供应商 ', h('b', null, c.providers == null ? '—' : c.providers)),
            h('span', null, '引用点 ', h('b', null, c.refs == null ? '—' : c.refs)),
            h('span', { style: dangling ? { color: '#c0392b', fontWeight: 600 } : null },
              '悬空引用 ', h('b', null, dangling)),
            h('span', null, '已忽略 ', h('b', null, c.ignored == null ? 0 : c.ignored)),
            h('span', null, '运行时已注册 ', h('b', null,
              overview && arr(overview.registered).length ? arr(overview.registered).length : '未知')),
          ),
          overview && arr(overview.registered).length
            ? h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '运行时：' + arr(overview.registered).join(' · '))
            : h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
              overview && overview.registered === null ? '运行时注册表读不到（ctx.llm.listProviders 不可用），判定只按静态配置算' : ''),
        ),

        // ── 偏好 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' } },
            h(Check, { checked: prefs.autoScan !== false, onChange: (v) => setPref('autoScan', v) }, '进页面自动扫描'),
            h(Check, { checked: !!prefs.showIgnored, onChange: (v) => setPref('showIgnored', v) }, '显示已忽略的引用'),
            h('span', { style: S.dim }, '历史保留'),
            h('select', {
              value: prefs.maxHistory || 50,
              onChange: (e) => setPref('maxHistory', Number(e && e.target && e.target.value) || 50),
              style: { fontSize: 12, padding: '1px 4px', borderRadius: 6, background: 'transparent', color: 'inherit' },
            }, [10, 20, 50, 100, 200].map((n) => h('option', { key: n, value: n }, n + ' 条'))),
            h(Btn, { mini: true, onClick: clearHistory, disabled: busy === 'history', title: '只删本插件的同步记录，不碰任何配置文件' }, '清空历史'),
          ),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
            '偏好与历史存在 ', h('code', { style: S.code }, st ? short(st.stateFile, 52) : '…'),
            ' —— 放在 DSH 数据目录里，不在插件安装目录，更新或重装插件都不会丢。'),
          st && st.recovered
            ? h('div', { style: S.warn }, '上次的状态文件损坏，已自动改名留证并用默认值继续：' + (st.warning || ''))
            : (st && st.warning ? h('div', { style: S.warn }, st.warning) : null),
        ),

        // ── 诊断（只在有问题时出现）────────────────────────────────────────
        diag.length
          ? h('div', { style: S.card },
            h('div', { style: S.row },
              h(Btn, { mini: true, onClick: () => setShowDiag(!showDiag) }, (showDiag ? '收起' : '展开') + `诊断（${diag.length} 条）`),
              h('span', { style: S.dim }, '这些文件读失败被跳过了，其余结果仍然可用；不影响你的配置。'),
            ),
            showDiag
              ? h(Table, {
                cols: [
                  { title: '文件', render: (r) => h('span', { style: S.code }, short(r.where, 60)) },
                  { title: '原因', key: 'message' },
                ],
                rows: diag,
              })
              : null,
          )
          : null,

        // ── 同步计划 / 结果 ─────────────────────────────────────────────────
        plan && arr(plan.actions).length
          ? h('div', null,
            h('div', { style: S.h }, '同步计划'),
            h('div', { style: S.note },
              '下面这些 profile 引用了某个 provider，但自己那份 patch 里没有定义（这就是 NO_ADAPTER 的来源）。' +
              '同步只是把别处已有的定义原样追加进去，不改你写的任何一行，写前会备份。'),
            h(Table, {
              cols: [
                { title: '目标 profile', render: (r) => h('b', null, r.profile) },
                { title: '要补的 provider', render: (r) => arr(r.add).map((x, i) => h('div', { key: i }, x.name, ' ', h('span', { style: S.dim }, '（定义取自 ' + x.from + '）'))) },
                { title: '引用位置', render: (r) => arr(r.add).map((x, i) => h('div', { key: i, style: S.code }, short(x.refFile, 52) + ':' + x.refLine)) },
                { title: '目标文件', render: (r) => h('div', { style: S.code }, short(r.file, 52)) },
              ],
              rows: plan.actions,
            }),
            h('div', { style: Object.assign({}, S.row, { marginTop: 10 }) },
              h(Btn, {
                onClick: applyNow,
                main: true,
                disabled: busy === 'apply',
                title: '写前自动备份；只追加 llm-pi-ai.providers，不动你已有的行',
              }, busy === 'apply' ? '写入中…' : `确认写入（${arr(plan.actions).length} 个文件）`),
              h('span', { style: Object.assign({}, S.dim, { alignSelf: 'center' }) },
                '写完要重启 DSH 才生效；备份文件在同目录 *.bak-provider-hub-<时间>'),
            ),
          )
          : null,

        plan && arr(plan.blocked).length
          ? h('div', null,
            h('div', { style: S.h }, '无法自动补的引用'),
            h(Table, {
              cols: [
                { title: 'provider', key: 'provider' },
                { title: 'profile', key: 'profile' },
                { title: '原因', key: 'why' },
                { title: '位置', render: (r) => h('span', { style: S.code }, short(r.file, 44) + ':' + r.line) },
              ],
              rows: plan.blocked,
            }),
          )
          : null,

        receipts && receipts.length
          ? h('div', null,
            h('div', { style: S.h }, '同步结果'),
            h(Table, {
              cols: [
                { title: 'profile', key: 'profile' },
                { title: '结果', render: (r) => r.ok ? (r.skipped ? '已是最新，跳过' : '已写入') : h('span', { style: { color: '#c0392b' } }, r.why || '失败') },
                { title: '补了哪些', render: (r) => arr(r.added).join(', ') || '—' },
                { title: '备份', render: (r) => h('span', { style: S.code }, r.backup ? short(r.backup, 46) : '—') },
              ],
              rows: receipts,
            }),
            receipts.some((r) => r && r.ok && !r.skipped)
              ? h('div', { style: S.note }, '重启 DSH 后生效（loader 不会热读 cordis.patch.yml）。要回滚就用右边那列备份文件覆盖回去。')
              : null,
          )
          : null,

        // ── 会话 ───────────────────────────────────────────────────────────
        h('div', { style: S.h }, '① 会话实际在用谁'),
        !sessions ? h('div', { style: S.dim }, '点「扫描对话」看结果（读 session_projcache 里每个会话的 modelSelection）')
          : h('div', null,
            h(Table, {
              cols: [
                { title: 'provider', render: (r) => h('b', null, r.provider) },
                { title: '会话数', key: 'sessions', style: { width: 70 } },
                { title: '用过的模型', render: (r) => arr(r.models).length ? arr(r.models).map((m, i) => h('div', { key: i }, m.model + ' × ' + m.sessions)) : h('span', { style: S.dim }, '—') },
                { title: '最近一次', render: (r) => time(r.last) },
              ],
              rows: sessions.byProvider,
              empty: '库里还没有带模型记录的会话',
            }),
            h('div', { style: Object.assign({}, S.dim, { margin: '6px 0 4px' }) }, '最近 12 个会话：'),
            h(Table, {
              cols: [
                { title: '更新时间', render: (r) => time(r.at), style: { whiteSpace: 'nowrap' } },
                { title: 'provider / model', render: (r) => (r.provider ? h('span', null, r.provider + ' / ' + r.model) : h('span', { style: S.dim }, '未记录')) },
                { title: '标题', render: (r) => r.title || h('span', { style: S.dim }, '（无标题）') },
                { title: '工作目录', render: (r) => h('span', { style: S.code }, short(r.cwd, 40)) },
              ],
              rows: arr(sessions.rows).slice(0, 12),
            }),
          ),

        // ── 引用 ───────────────────────────────────────────────────────────
        h('div', { style: S.h }, '② 插件与配置引用了谁'),
        !refs ? h('div', { style: S.dim }, '点「扫描插件与配置」看结果（profile patch、插件生成的 headless overlay、插件自带 patch、插件 config.json）')
          : h('div', null,
            h(Table, {
              cols: [
                { title: '判定', render: (r) => (r.ignored ? Chip('ignored') : Chip(r.verdict)), style: { width: 86 } },
                { title: 'provider', render: (r) => h('b', null, r.provider) },
                { title: 'profile', key: 'profile' },
                { title: '模型', render: (r) => r.model || h('span', { style: S.dim }, '—') },
                { title: '来源', render: (r) => h('span', { style: S.dim }, ({ profile: 'profile 配置', overlay: '插件生成 overlay', 'plugin-patch': '插件自带 patch', 'plugin-config': '插件配置' })[r.kind] || r.kind) },
                { title: '位置', render: (r) => h('span', { style: S.code }, short(r.file, 46) + ':' + r.line) },
                { title: '密钥变量', render: (r) => r.apiKeyEnv || h('span', { style: S.dim }, '—') },
                {
                  title: '操作',
                  style: { width: 64 },
                  render: (r) => h(Btn, {
                    mini: true,
                    disabled: busy === 'ignore',
                    title: r.ignored ? '恢复显示这条引用' : '忽略这条引用：不再计入悬空、不进同步计划',
                    onClick: () => toggleIgnore(r, !!r.ignored),
                  }, r.ignored ? '恢复' : '忽略'),
                },
              ],
              rows: refs.refs,
              empty: '没有扫到任何 provider 引用',
            }),
            h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
              '判定口径：按该 profile 自己有没有定义算。「悬空·可补」= 别处有定义、这份没有 → 一键同步能补；' +
              '「缺定义」= 哪儿都没有 → 先去模型供应商页配一次。忽略只影响本页统计与同步计划，不改任何配置。'),
          ),

        // ── 实际配置 ───────────────────────────────────────────────────────
        h('div', { style: S.h }, '③ 实际配置（各 profile 的定义与默认模型）'),
        overview
          ? h('div', null,
            h(Table, {
              cols: [
                { title: 'profile', render: (r) => h('b', null, r.name) },
                { title: '默认模型', render: (r) => r.defaultModel ? (r.defaultModel.provider + ' / ' + r.defaultModel.model) : h('span', { style: S.dim }, '未设置') },
                { title: '已定义的 provider', render: (r) => arr(r.providers).length ? arr(r.providers).map((p, i) => h('div', { key: i }, p.name, ' ', h('span', { style: S.dim }, (p.models || 0) + ' 个模型' + (p.baseURL ? ' · ' + short(p.baseURL, 34) : '')))) : h('span', { style: S.dim }, '无') },
                { title: 'patch 文件', render: (r) => h('span', { style: S.code }, short(r.patchFile, 42)) },
              ],
              rows: overview.profiles,
            }),
            arr(overview.overlays).length
              ? h('div', null,
                h('div', { style: Object.assign({}, S.dim, { margin: '10px 0 4px' }) }, '插件每轮重写的 overlay（这些文件不归你改，改了也会被覆盖）：'),
                h(Table, {
                  cols: [
                    { title: '文件', render: (r) => h('span', { style: S.code }, short(r.file, 44)) },
                    { title: '声明的 profile', key: 'declaredProfile' },
                    { title: '实际落到', render: (r) => h('b', null, r.targetProfile) },
                    { title: '指向的模型', render: (r) => r.provider ? r.provider + ' / ' + r.model : h('span', { style: S.dim }, '—') },
                  ],
                  rows: overview.overlays,
                }),
                h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
                  '提醒：overlay 里的模型来自「桌面当前选中的模型」。值班轮跑的是它落到那个 profile 的配置，所以桌面选了 A 家、值班 profile 没配 A 家，就会 NO_ADAPTER。'),
              )
              : null,
          )
          : h('div', { style: S.dim }, '读取中…'),

        // ── 历史 ───────────────────────────────────────────────────────────
        st && arr(st.history).length
          ? h('div', null,
            h('div', { style: S.h }, '④ 同步历史（最近 ' + arr(st.history).length + ' 次）'),
            arr(st.history).slice(0, 10).map((it, i) => h('div', { key: i, style: S.card },
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' } },
                h('b', null, time(it.at)),
                h('span', { style: S.dim }, it.applied ? `写入 ${it.total} 个文件` : '仅预演'),
              ),
              h(Table, {
                cols: [
                  { title: 'profile', key: 'profile' },
                  { title: '结果', render: (r) => r.ok ? (r.skipped ? '已是最新' : '已写入') : h('span', { style: { color: '#c0392b' } }, r.why || '失败') },
                  { title: '补了哪些', render: (r) => arr(r.added).join(', ') || '—' },
                  { title: '备份', render: (r) => h('span', { style: S.code }, r.backup ? short(r.backup, 40) : '—') },
                ],
                rows: arr(it.receipts),
              }),
            )),
          )
          : null,

        h('div', { style: Object.assign({}, S.dim, { marginTop: 18, fontSize: 11.5 }) },
          'dsh-provider-hub · 只读扫描 + 补定义；不动你已有的配置行。',
          st ? ' 数据目录：' + short(st.dataDir, 60) : '',
          ' 日志：provider-hub/logs/provider-hub.log'),
      )
    }

    /** 对外组件 = 错误边界包一层，任何渲染异常都关在里面。 */
    function Panel() {
      return h(ErrorBoundary, null, h(PanelInner, null))
    }

    function apply(ctx) {
      try {
        const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          // 拿不到槽位系统说明 DSH 版本不匹配：安静退出，别抛异常影响其他插件
          try { console.warn('[provider-hub] 没有 slots 服务，设置页未注册') } catch { /* 忽略 */ }
          return
        }
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'provider-hub', order: 54, label: () => '供应商中心' },
            Panel,
          ),
        )
      } catch (e) {
        try { console.warn('[provider-hub] 注册设置页失败：', e) } catch { /* 忽略 */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
