/**
 * dsh-provider-hub · 扫描与同步（纯文件逻辑，不依赖 DSH 运行时，可用 tests/*.mjs 单独跑）
 * ============================================================================
 * 三件事，对应设置页的三个按钮：
 *
 *   1. scanSessions()  —— 会话实际在用哪个 provider/model（读 session_projcache 的 modelSelection）
 *   2. scanConfig()    —— 「实际配置」：各 profile 的 llm-pi-ai providers 定义、默认模型、运行时 overlay
 *   3. scanRefs()      —— 「谁引用了谁」：profile patch / 插件的 overlay / 插件自带 patch / 插件 config.json
 *
 * 以及 planSync() / applySync() —— 一键同步：把「已在别处定义」的 provider 补进「引用了它的 profile」，
 * 消除 `NO_ADAPTER: no adapter registered for provider "xxx"` 这类悬空引用。
 *
 * ── 错误处理约定（很重要，改这个文件前先读）──────────────────────────────
 * 本模块被设计成**永不抛异常**：
 *   · 每个公共函数内部自建 errors[] 并随结果返回；
 *   · 每一次文件读、目录列、JSON 解析都单独 try/catch，失败只记一条 error 并跳过；
 *   · 单个损坏的 profile / 会话 / 插件文件，只会让它自己那一行缺失，
 *     其余照常显示 —— 设置页不允许因为一个坏文件变白屏。
 * 调用方（host.js）把 errors 原样透给页面，用户在「诊断」区能看到到底哪个文件读失败了。
 *
 * ── 为什么不用 yaml 库 ────────────────────────────────────────────────
 * 插件跑在 DSH 进程里，不该再拖第三方依赖。这里只认 llm-pi-ai 那一段的固定结构：
 *
 *     - id: llm-pi-ai          ← 顶格
 *       config:                ← 2 空格
 *         providers:           ← 4 空格
 *           acme:            ← 6 空格（provider 名）
 *             baseURL: ...     ← 8 空格（字段）
 *             models:          ← 8 空格
 *               - id: xxx      ← 10 空格
 *
 * DSH 的 patch 文件就是按这个缩进生成的，所以文本解析足够稳，且不会因为
 * 某个用户手写的注释就把整份配置解析失败。
 */
import {
  copyFileSync, existsSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHome, isDir } from './paths.js'

// 路径工具在 paths.js 里统一定义，这里再导出一次保持向后兼容（老测试直接 import 这里）
export { dshHome } from './paths.js'

/** DSH 内置供应商（适配器随 llm-deepseek* 一起装，不需要在 llm-pi-ai 里定义）。 */
export const BUILTIN_PROVIDERS = ['deepseek-official', 'deepseek-account']

/** 单个配置文件的大小上限：超过就不读，避免误读一个几 GB 的文件把进程拖死。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** 会话缓存文件上限（会话里可能塞了很长的历史，单独给个更宽松的值）。 */
const MAX_SESSION_BYTES = 8 * 1024 * 1024

/**
 * 安全读文本：任何失败都返回 null，并在 errors 里记一条。
 * 文件不存在（配置本来就没有）不算错，静默跳过。
 * @param {string} file
 * @param {Array<{where:string,message:string}>} errors
 */
function readTextSafe(file, errors) {
  try {
    const st = statSync(file)
    if (!st.isFile()) {
      errors.push({ where: file, message: '不是一个普通文件，已跳过' })
      return null
    }
    if (st.size > MAX_FILE_BYTES) {
      errors.push({ where: file, message: `文件过大（${st.size} 字节），已跳过` })
      return null
    }
    return readFileSync(file, 'utf8')
  } catch (err) {
    const code = err && err.code
    if (code !== 'ENOENT') errors.push({ where: file, message: '读不到：' + String((err && err.message) || err) })
    return null
  }
}

/** 安全列目录：失败返回空数组并记一条。 */
function readdirSafe(dir, errors) {
  try {
    return readdirSync(dir)
  } catch (err) {
    errors.push({ where: dir, message: '列目录失败：' + String((err && err.message) || err) })
    return []
  }
}

/** 安全读 JSON：解析失败记一条，返回 null（调用方按「没有这个文件」处理）。 */
function readJsonSafe(file, errors) {
  const t = readTextSafe(file, errors)
  if (t == null) return null
  try {
    return JSON.parse(t)
  } catch (err) {
    errors.push({ where: file, message: 'JSON 解析失败：' + String((err && err.message) || err) })
    return null
  }
}

/** 生成 `20261030183000` 这种定宽时间戳（备份文件后缀，按名字排序即按时间排序）。 */
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 把 text 切成顶层 `- xxx` 条目，返回 [{start,end,id}]（end 不含）。 */
function splitEntries(lines) {
  const marks = []
  for (let i = 0; i < lines.length; i++) if (/^-(?:\s|$)/.test(lines[i])) marks.push(i)
  return marks.map((s, k) => {
    const end = k + 1 < marks.length ? marks[k + 1] : lines.length
    const head = lines[s]
    const m = /^-\s*id:\s*['"]?([^'"\s]+)/.exec(head)
    return { start: s, end, id: m ? m[1] : '' }
  })
}

const indentOf = (line) => {
  const m = /^( *)/.exec(line)
  return m ? m[1].length : 0
}
const isBlankOrComment = (line) => line.trim() === '' || line.trim().startsWith('#')

/**
 * 取出 patch 文本里 llm-pi-ai 的 providers 段。
 * @param {string} text
 * @returns {{present:boolean, providers:Array, providersLine:number, sectionEnd:number, entry?:object, lines:string[]}}
 */
export function piAiProviders(text) {
  const lines = String(text || '').split(/\r?\n/)
  const entry = splitEntries(lines).find((e) => e.id === 'llm-pi-ai')
  if (!entry) return { present: false, providers: [], providersLine: -1, sectionEnd: -1, lines }

  let providersLine = -1
  for (let i = entry.start; i < entry.end; i++) {
    if (/^ {4}providers:\s*(#.*)?$/.test(lines[i])) { providersLine = i; break }
  }
  if (providersLine < 0) return { present: true, providers: [], providersLine: -1, sectionEnd: entry.end, entry, lines }

  let sectionEnd = entry.end
  for (let i = providersLine + 1; i < entry.end; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentOf(lines[i]) <= 4) { sectionEnd = i; break }
  }

  const starts = []
  for (let i = providersLine + 1; i < sectionEnd; i++) {
    if (/^ {6}[^\s:#][^:]*:\s*(#.*)?$/.test(lines[i])) starts.push(i)
  }
  const providers = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : sectionEnd
    const name = lines[s].trim().replace(/:\s*$/, '').replace(/^['"]|['"]$/g, '')
    const raw = lines.slice(s, end)
    while (raw.length && raw[raw.length - 1].trim() === '') raw.pop()
    const pick = (key) => {
      for (const l of raw) {
        const m = new RegExp(`^ {8}${key}:\\s*(.+)$`).exec(l)
        if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
      }
      return ''
    }
    const models = []
    for (const l of raw) {
      const m = /^ {10,14}-\s*id:\s*(.+)$/.exec(l)
      if (m) models.push(m[1].trim().replace(/^['"]|['"]$/g, ''))
    }
    return {
      name,
      lines: raw,
      displayName: pick('displayName'),
      api: pick('api'),
      baseURL: pick('baseURL'),
      apiKeyEnv: pick('apiKeyEnv'),
      models,
      bytes: raw.join('\n').length,
    }
  })
  return { present: true, providers, providersLine, sectionEnd, entry, lines }
}

/**
 * 取 agent-default-model 条目的 provider / model。
 * @param {string} text
 * @returns {{provider:string, model:string, file:string}|null}
 */
export function agentDefaultModel(text) {
  const lines = String(text || '').split(/\r?\n/)
  const entry = splitEntries(lines).find((e) => e.id === 'agent-default-model')
  if (!entry) return null
  const pick = (key) => {
    for (let i = entry.start; i < entry.end; i++) {
      const m = new RegExp(`^\\s+${key}:\\s*['"]?([^'"\\s#]+)`).exec(lines[i])
      if (m) return m[1]
    }
    return ''
  }
  const provider = pick('provider')
  const model = pick('model')
  if (!provider && !model) return null
  return { provider, model, file: '' }
}

/**
 * 「实际配置」：各 profile 的 provider 定义、默认模型、运行时 overlay。
 * @returns {{home:string, profiles:Array, overlays:Array, allDefs:Array, errors:Array, writable:boolean}}
 */
export function scanConfig() {
  const errors = []
  const home = dshHome()
  const profilesDir = join(home, 'profiles')
  const profiles = []
  const allDefs = new Map() // provider 名 -> { from, file, lines, meta }

  if (!isDir(profilesDir)) {
    errors.push({ where: profilesDir, message: '没有 profiles 目录（profile 还没初始化？）' })
  } else {
    for (const name of readdirSafe(profilesDir, errors)) {
      const dir = join(profilesDir, name)
      if (!isDir(dir)) continue
      // 每个 profile 单独隔离：某个 profile 的 patch 坏了，不影响其他 profile 显示
      try {
        const patchFile = join(dir, 'cordis.patch.yml')
        const text = readTextSafe(patchFile, errors)
        const pkg = readJsonSafe(join(dir, 'package.json'), errors)
        const parsed = text ? piAiProviders(text) : { present: false, providers: [] }
        const def = text ? agentDefaultModel(text) : null
        profiles.push({
          name,
          dir,
          patchFile,
          exists: !!text,
          bundles: (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [],
          providers: parsed.providers.map((p) => ({
            name: p.name, displayName: p.displayName, api: p.api, baseURL: p.baseURL,
            apiKeyEnv: p.apiKeyEnv, models: p.models.length, bytes: p.bytes,
          })),
          defaultModel: def ? { provider: def.provider, model: def.model } : null,
        })
        for (const p of parsed.providers) {
          if (!allDefs.has(p.name)) allDefs.set(p.name, { from: name, file: patchFile, lines: p.lines, meta: p })
        }
      } catch (err) {
        errors.push({ where: dir, message: '解析 profile 失败：' + String((err && err.message) || err) })
      }
    }
  }

  // 运行时 overlay：~/.dsh/<状态目录>/headless-overlay.yml（插件每轮重写，是「插件内容」的典型）
  const overlays = []
  for (const name of readdirSafe(home, errors)) {
    if (name.startsWith('.')) continue
    const dir = join(home, name)
    if (!isDir(dir)) continue
    try {
      const file = join(dir, 'headless-overlay.yml')
      if (!existsSync(file)) continue
      const text = readTextSafe(file, errors) || ''
      const def = agentDefaultModel(text)
      const cfg = readJsonSafe(join(dir, 'config.json'), errors) || {}
      const want = String(cfg.headlessProfile || '').trim()
      // 插件里 `headlessProfile: headless` 其实会落到最小权限 profile（demo-profile）；按现有 profile 推断
      let target = want
      if (!want || want === 'headless') target = profiles.some((p) => p.name === 'demo-profile') ? 'demo-profile' : 'headless'
      overlays.push({
        file,
        stateDir: dir,
        declaredProfile: want || '(未声明)',
        targetProfile: target,
        provider: def ? def.provider : '',
        model: def ? def.model : '',
        generatedBy: (() => {
          // 谁在写这个文件：同目录有 mcp_server.py / duty 相关文件的，通常是刷B站那类值班插件
          try {
            return readdirSafe(dir, []).some((f) => f === 'mcp_server.py') ? '插件生成（同目录有 mcp_server.py）' : '未知来源'
          } catch { return '未知来源' }
        })(),
      })
    } catch (err) {
      errors.push({ where: dir, message: '解析 overlay 失败：' + String((err && err.message) || err) })
    }
  }

  return {
    home,
    profiles,
    overlays,
    allDefs: [...allDefs.entries()].map(([k, v]) => ({
      name: k, from: v.from, file: v.file, lines: v.lines,
      meta: { api: v.meta.api, baseURL: v.meta.baseURL, apiKeyEnv: v.meta.apiKeyEnv, models: v.meta.models.length },
    })),
    errors,
  }
}

/**
 * 会话实际在用的 provider：读 storages/session_projcache/sessions/*.json 的 modelSelection。
 * @param {number} limit 返回多少条明细（汇总不受限）
 */
export function scanSessions(limit = 200) {
  const errors = []
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const rows = []
  if (!isDir(dir)) return { rows, byProvider: [], total: 0, dir, errors, note: '没有 session_projcache 目录' }

  for (const f of readdirSafe(dir, errors)) {
    if (!f.endsWith('.json')) continue
    const full = join(dir, f)
    // 单条会话隔离：一条坏 JSON 只丢这一条
    try {
      const st = statSync(full)
      if (st.size > MAX_SESSION_BYTES) {
        errors.push({ where: full, message: `会话缓存过大（${st.size} 字节），已跳过` })
        continue
      }
      const d = readJsonSafe(full, errors)
      if (!d || !d.record || !d.record.rows) continue
      const r = d.record.rows
      const val = (x) => (x && typeof x === 'object' && 'val' in x ? x.val : x)
      const sel = val(r.modelSelection) || {}
      const meta = val(r.sessionListMetadata) || {}
      const used = (sel && typeof sel === 'object' && sel.lastUsed) || null
      const ident = d.record.identity || {}
      let title = val(r.title)
      if (title && typeof title === 'object') title = title.text || title.title || ''
      let mtime = 0
      try { mtime = st.mtimeMs } catch { /* 忽略 */ }
      rows.push({
        sessionId: String(ident.id || basename(f).replace(/\.json$/, '')),
        file: full,
        cwd: ident.cwd || '',
        title: String(title || '').slice(0, 60),
        provider: used ? String(used.provider || '') : '',
        model: used ? String(used.model || '') : '',
        preset: typeof val(r.agentPreset) === 'string' ? val(r.agentPreset) : '',
        lastPromptAt: Number(meta.lastPromptAt || 0) || mtime,
        at: Number(meta.lastPromptAt || 0) || mtime,
      })
    } catch (err) {
      errors.push({ where: full, message: '读取会话失败：' + String((err && err.message) || err) })
    }
  }

  rows.sort((a, b) => b.at - a.at)
  const agg = new Map()
  for (const r of rows) {
    const k = r.provider || '(未知/未记录)'
    const cur = agg.get(k) || { provider: k, sessions: 0, models: new Map(), last: 0 }
    cur.sessions++
    if (r.model) cur.models.set(r.model, (cur.models.get(r.model) || 0) + 1)
    cur.last = Math.max(cur.last, r.at)
    agg.set(k, cur)
  }
  const byProvider = [...agg.values()]
    .map((x) => ({
      provider: x.provider,
      sessions: x.sessions,
      last: x.last,
      models: [...x.models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ model: m, sessions: n })),
    }))
    .sort((a, b) => b.sessions - a.sessions)

  return { rows: rows.slice(0, Math.max(1, limit)), byProvider, total: rows.length, dir, errors }
}

/**
 * 「谁引用了谁」：profile patch + 运行时 overlay + 插件自带 patch + 插件 config.json。
 * @param {ReturnType<typeof scanConfig>} cfg
 * @param {string[]|null} registered 运行时已注册的 provider 名单（ctx.llm.listProviders()），拿不到传 null
 */
export function scanRefs(cfg, registered = null) {
  const refs = []
  const errors = []
  const safeCfg = cfg && typeof cfg === 'object' ? cfg : { allDefs: [], profiles: [], overlays: [], home: dshHome() }
  const home = safeCfg.home || dshHome()
  const regSet = Array.isArray(registered) ? new Set(registered.filter((x) => typeof x === 'string' && x)) : null
  const defsByName = new Map((safeCfg.allDefs || []).map((d) => [d.name, d]))
  const defByProfile = new Map((safeCfg.profiles || []).map((p) => [p.name, new Set((p.providers || []).map((x) => x.name))]))

  /**
   * 判定口径（重要）：**按 profile 自己有没有定义**算，不看别的 profile。
   * 因为 headless / 值班轮跑的是它自己的 profile 那套配置 —— 桌面端注册了 acme，
   * 不代表 demo-profile 那一轮也有。NO_ADAPTER 就是这么来的。
   */
  const push = (file, kind, profile, line, provider, model) => {
    if (!provider) return
    const builtin = BUILTIN_PROVIDERS.includes(provider)
    const definedHere = builtin || (defByProfile.get(profile) ? defByProfile.get(profile).has(provider) : false)
    const elsewhere = defsByName.get(provider)
    const verdict = definedHere ? 'ok'
      : elsewhere ? 'dangling' // 别处有定义 → 可一键补
        : (regSet && regSet.has(provider)) ? 'runtime-only' // 只有运行时注册（插件动态注册的）
          : 'missing' // 谁都没定义
    refs.push({
      file,
      kind, // profile | overlay | plugin-patch | plugin-config
      profile: profile || '',
      line,
      provider,
      model: model || '',
      apiKeyEnv: (elsewhere && elsewhere.meta && elsewhere.meta.apiKeyEnv) || '',
      definedHere,
      fromProfile: (elsewhere && elsewhere.from) || '',
      verdict,
    })
  }

  /**
   * YAML patch：**只看 agent-default-model 条目**。
   * 别的条目里也有 `provider:`（子代理的 spawn/fork/codex/claude-code、工具提供方…），
   * 那些不是模型供应商，扫进来只会制造假红。
   */
  const scanYaml = (file, kind, profile) => {
    const text = readTextSafe(file, errors)
    if (!text) return
    try {
      const lines = text.split(/\r?\n/)
      for (const e of splitEntries(lines)) {
        if (e.id !== 'agent-default-model') continue
        let provider = ''
        let model = ''
        let line = 0
        for (let i = e.start; i < e.end; i++) {
          const p = /^\s+provider:\s*['"]?([^'"\s#]+)/.exec(lines[i])
          if (p && !provider) { provider = p[1]; line = i + 1 }
          const m = /^\s+model:\s*['"]?([^'"\s#]+)/.exec(lines[i])
          if (m && !model) model = m[1]
        }
        push(file, kind, profile, line, provider, model)
      }
    } catch (err) {
      errors.push({ where: file, message: '解析 YAML 失败：' + String((err && err.message) || err) })
    }
  }

  /** JSON/杂项：只认「值为已知 provider」的，避免把 mock/别的字段当引用。 */
  const scanGeneric = (file, kind, profile) => {
    const text = readTextSafe(file, errors)
    if (!text) return
    try {
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const m = /["']?provider["']?\s*:\s*["']?([A-Za-z0-9_.\-]+)/.exec(lines[i])
        if (!m) continue
        const provider = m[1]
        if (!defsByName.has(provider) && !BUILTIN_PROVIDERS.includes(provider) && !(regSet && regSet.has(provider))) continue
        push(file, kind, profile, i + 1, provider, '')
      }
    } catch (err) {
      errors.push({ where: file, message: '解析 JSON 失败：' + String((err && err.message) || err) })
    }
  }

  for (const p of safeCfg.profiles || []) if (p && p.exists) scanYaml(p.patchFile, 'profile', p.name)

  for (const o of safeCfg.overlays || []) if (o && o.file) scanYaml(o.file, 'overlay', o.targetProfile)

  // 插件自带 patch / 插件 config.json：只看一层，避免把 node_modules 里上千个文件全扫了
  for (const p of safeCfg.profiles || []) {
    if (!p || !p.dir) continue
    const nm = join(p.dir, 'node_modules')
    if (!isDir(nm)) continue
    for (const name of readdirSafe(nm, errors)) {
      if (name.startsWith('.')) continue
      const d = join(nm, name)
      if (!isDir(d)) continue
      const f = join(d, 'cordis.patch.yml')
      if (existsSync(f)) scanYaml(f, 'plugin-patch', p.name)
    }
  }
  for (const o of safeCfg.overlays || []) {
    if (!o || !o.stateDir) continue
    const f = join(o.stateDir, 'config.json')
    if (existsSync(f)) scanGeneric(f, 'plugin-config', o.targetProfile)
  }

  // 去重（同文件同行同 provider）
  const seen = new Set()
  const uniq = refs.filter((r) => {
    const k = `${r.file}#${r.line}#${r.provider}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const dangling = uniq.filter((r) => r.verdict === 'dangling')
  const missing = uniq.filter((r) => r.verdict === 'missing')
  return { refs: uniq, dangling, missing, registered: Array.isArray(registered) ? registered : null, scanned: home, errors }
}

/**
 * 一键同步计划：把「已在别处定义」的 provider 补进「引用了它却没有定义」的 profile。
 * 只产出计划，不写盘 —— 写盘在 applySync()。
 */
export function planSync(cfg, refsResult) {
  const safeCfg = cfg && typeof cfg === 'object' ? cfg : { allDefs: [], profiles: [] }
  const defsByName = new Map((safeCfg.allDefs || []).map((d) => [d.name, d]))
  const perFile = new Map() // file -> { file, profile, add: [] }
  const blocked = []

  for (const r of (refsResult && refsResult.dangling) || []) {
    try {
      if (!r || !r.provider) continue
      if (!r.profile) { blocked.push({ ...r, why: '这个引用不在任何 profile 作用域内，跳过' }); continue }
      // ⭐ 2026-10-30：这两类文件**不归用户改**，写进去也没用（甚至更糟）——
      //   · overlay：插件每轮重写的运行时覆盖层，下一轮就被盖掉；而且它是最外层，会压过 profile 的配置
      //   · plugin-patch：插件自带的 patch，插件升级一次就回来
      //   真正的修法在生成它的那个插件里（例：demo-profile 的 headless-overlay.yml 硬跟桌面端的第三方
      //   provider，而最小权限 profile 没有那家适配器 ⇒ 每轮 NO_ADAPTER）。别让"一键同步"去改 profile
      //   假装修好了：给最小权限 profile 插一条它根本没有的插件条目，profile 反而会起不来。
      if (r.kind === 'overlay') {
        blocked.push({ ...r, why: '这条在插件每轮重写的 overlay 里，同步到 profile 会被下一轮盖掉 ⇒ 要改生成这个 overlay 的插件' })
        continue
      }
      if (r.kind === 'plugin-patch') {
        blocked.push({ ...r, why: '这条是插件自带的 patch，插件一升级就会恢复 ⇒ 要改插件本身（或换成正确的 provider）' })
        continue
      }
      const target = (safeCfg.profiles || []).find((p) => p && p.name === r.profile)
      if (!target || !target.exists) { blocked.push({ ...r, why: `profile "${r.profile}" 不存在` }); continue }
      if ((target.providers || []).some((x) => x.name === r.provider)) continue // 本 profile 已定义
      const src = defsByName.get(r.provider)
      if (!src) {
        blocked.push({ ...r, why: '任何 profile 都没有这个 provider 的定义，无法自动补（要先在模型供应商页配一次）' })
        continue
      }
      const k = target.patchFile
      const cur = perFile.get(k) || { file: k, profile: target.name, add: [] }
      if (!cur.add.some((a) => a.name === r.provider)) {
        cur.add.push({ name: r.provider, from: src.from, refLine: r.line, refFile: r.file })
      }
      perFile.set(k, cur)
    } catch (err) {
      blocked.push({ ...r, why: '生成计划时出错：' + String((err && err.message) || err) })
    }
  }

  return { actions: [...perFile.values()], blocked, defsByName: [...defsByName.keys()] }
}

/**
 * 把 provider 块插进 patch 文本（保留原有缩进风格与行尾）。
 * @param {string} text 原 patch 文本
 * @param {string[]} addNames 要补的 provider 名
 * @param {Array<{name:string, lines:string[]}>} cfgAllDefs 定义来源（scanConfig().allDefs）
 */
export function insertProviders(text, addNames, cfgAllDefs) {
  const src = String(text == null ? '' : text)
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)
  const byName = new Map((cfgAllDefs || []).map((d) => [d.name, d]))
  const blocks = []
  for (const n of addNames || []) {
    const d = byName.get(n)
    if (d && d.lines && d.lines.length) blocks.push(d.lines)
  }
  if (!blocks.length) return { text: src, entryCreated: false, added: [] }

  const entry = splitEntries(lines).find((e) => e.id === 'llm-pi-ai')
  if (!entry) {
    // 整个 llm-pi-ai 条目都没有：补一整块（demo-profile 当初就是这个情况）
    const add = ['', '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:']
    for (const b of blocks) add.push(...b)
    const out = lines.slice()
    while (out.length && out[out.length - 1].trim() === '') out.pop()
    out.push(...add, '')
    return { text: out.join(eol), entryCreated: true, added: addNames }
  }

  let providersLine = -1
  for (let i = entry.start; i < entry.end; i++) {
    if (/^ {4}providers:\s*(#.*)?$/.test(lines[i])) { providersLine = i; break }
  }

  if (providersLine < 0) {
    // 有条目但没 providers 段：插在 config: 之后
    let at = entry.start + 1
    for (let i = entry.start; i < entry.end; i++) {
      if (/^ {2}config:\s*$/.test(lines[i])) { at = i + 1; break }
    }
    const add = ['    providers:', ...blocks.flat()]
    lines.splice(at, 0, ...add)
    return { text: lines.join(eol), entryCreated: false, added: addNames, providersSectionCreated: true }
  }

  let sectionEnd = entry.end
  for (let i = providersLine + 1; i < sectionEnd; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentOf(lines[i]) <= 4) { sectionEnd = i; break }
  }
  let at = sectionEnd
  while (at > providersLine + 1 && lines[at - 1].trim() === '') at--
  const add = []
  for (const b of blocks) add.push('', ...b)
  lines.splice(at, 0, ...add)
  return { text: lines.join(eol), entryCreated: false, added: addNames }
}

/**
 * 只保留最近 maxBackups 个本插件自己造的备份。
 * 严格限定文件名模式 `<文件名>.bak-provider-hub-<14位时间戳>`，绝不碰用户自己的
 * `.bak-*` 或别的东西；maxBackups<=0 时完全不删。
 * @returns {number} 删掉了几个
 */
export function pruneBackups(file, maxBackups) {
  const keep = Math.trunc(Number(maxBackups))
  if (!Number.isFinite(keep) || keep <= 0) return 0
  let removed = 0
  try {
    const dir = dirname(file)
    const prefix = basename(file) + '.bak-provider-hub-'
    const cands = []
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue
      const tail = f.slice(prefix.length)
      if (!/^\d{14}$/.test(tail)) continue // 只认我们自己生成的时间戳格式
      cands.push(f)
    }
    cands.sort().reverse() // 时间戳定宽，字典序倒排即最新在前
    for (const f of cands.slice(keep)) {
      try { unlinkSync(join(dir, f)); removed++ } catch { /* 被占用就留着 */ }
    }
  } catch { /* 列目录失败就什么都不做 */ }
  return removed
}

/**
 * 真正写盘：先校验 → 备份 → 原子替换 → 清理旧备份。幂等（已存在的 provider 不重复加）。
 * @param {object} cfg scanConfig() 结果
 * @param {Array} actions planSync().actions
 * @param {{maxBackups?:number, validate?:boolean}} [opts]
 * @returns {Array} 给 UI 的收据
 */
export function applySync(cfg, actions, opts = {}) {
  const out = []
  const defsByName = new Map(((cfg && cfg.allDefs) || []).map((d) => [d.name, d]))
  const validate = opts.validate !== false
  const maxBackups = opts.maxBackups

  for (const a of Array.isArray(actions) ? actions : []) {
    try {
      if (!a || !a.file) { out.push({ ...a, ok: false, why: '计划项缺少文件路径' }); continue }
      const text = readTextSafe(a.file, [])
      if (text == null) { out.push({ ...a, ok: false, why: '读不到文件（可能没权限或已被删除）' }); continue }
      const have = new Set(piAiProviders(text).providers.map((p) => p.name))
      const need = (a.add || []).filter((x) => x && x.name && !have.has(x.name))
      if (!need.length) { out.push({ ...a, ok: true, skipped: true, why: '已经都有定义了' }); continue }

      const res = insertProviders(text, need.map((x) => x.name), [...defsByName.values()])
      if (!res.added || !res.added.length) {
        out.push({ ...a, ok: false, why: '没有拿到这些 provider 的原始定义片段，已放弃写入' })
        continue
      }

      // 写入前自检：新文本必须还能解析回来，且真的带上这些 provider。
      // 解析不回来就宁可不写 —— 上面的原文件保持原样，比写坏强。
      if (validate) {
        const back = piAiProviders(res.text)
        const names = new Set(back.providers.map((p) => p.name))
        const lost = res.added.filter((n) => !names.has(n))
        if (lost.length) {
          out.push({ ...a, ok: false, why: `生成的新内容解析校验失败（缺 ${lost.join(', ')}），已放弃写入，原文件未改动` })
          continue
        }
      }

      const backup = `${a.file}.bak-provider-hub-${stamp()}`
      try {
        copyFileSync(a.file, backup)
      } catch (err) {
        out.push({ ...a, ok: false, why: '备份失败，为安全起见没有写入：' + String((err && err.message) || err) })
        continue
      }

      // 原子替换：先写同目录临时文件，再 rename —— 中途被杀也不会留下一份被截断的 patch
      const tmp = `${a.file}.tmp-provider-hub-${process.pid}`
      try {
        writeFileSync(tmp, res.text, 'utf8')
        renameSync(tmp, a.file)
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* 忽略 */ }
        out.push({ ...a, ok: false, why: '写入失败（备份还在，可手动恢复）：' + String((err && err.message) || err), backup })
        continue
      }

      pruneBackups(a.file, maxBackups)
      out.push({ ...a, ok: true, added: res.added, entryCreated: !!res.entryCreated, backup })
    } catch (err) {
      // 单项失败不影响后续项
      out.push({ ...a, ok: false, why: '写入时出现未预期的错误：' + String((err && err.message) || err) })
    }
  }
  return out
}

/**
 * 把「已忽略」标记刷到引用列表上，并从同步计划里剔掉被忽略的项。
 * 纯函数，不改入参（返回新对象），方便测试。
 * @param {ReturnType<typeof scanRefs>} refs
 * @param {object} state store 里的状态
 * @param {{showIgnored?:boolean}} [opts]
 */
export function applyIgnores(refs, state, opts = {}) {
  const safe = refs && typeof refs === 'object' ? refs : { refs: [], dangling: [], missing: [] }
  const keys = new Set(((state && state.ignored) || []).map((x) => x && x.key).filter(Boolean))
  const showIgnored = opts.showIgnored ?? !!(state && state.prefs && state.prefs.showIgnored)
  const mark = (r) => {
    const key = `${r.provider}@${r.profile}`
    return keys.has(key) ? { ...r, ignored: true, ignoreKey: key } : { ...r, ignored: false, ignoreKey: key }
  }
  const all = (safe.refs || []).map(mark)
  const visible = all.filter((r) => showIgnored || !r.ignored)
  const dangling = visible.filter((r) => r.verdict === 'dangling')
  const missing = visible.filter((r) => r.verdict === 'missing')
  const ignoredCount = all.filter((r) => r.ignored).length
  return { ...safe, refs: visible, allRefs: all, dangling, missing, ignoredCount }
}

/**
 * ⭐「换供应商」——本插件的**主要用途**：在面板上把 A 家换成 B 家，然后把这件事
 * 同步到**所有真正写着 A 的地方**（profile patch、插件生成的 overlay、插件自己的 config.json）。
 *
 * 和 planSync() 的区别（两个方向，别搞混）：
 *   · planSync  = **补定义**：某处引用了 A，但这份 profile 里没有 A 的定义 ⇒ 把 A 的定义搬过去。
 *     它改的是「定义」，解决 NO_ADAPTER 里「找不到这个 provider」那一半。
 *   · planRewrite = **换引用**：把「provider: A」这一行本身改成「provider: B」。
 *     它改的是「选择」，也就是平时说的"换供应商"。
 *
 * 只产出计划，不写盘；写盘在 applyRewrite()。
 *
 * @param {object} cfg scanConfig() 结果
 * @param {ReturnType<typeof scanRefs>} refsResult 引用扫描结果（建议传已按忽略过滤过的）
 * @param {{from:string, to:{provider:string, model?:string}, kinds?:string[]}} opts
 *   from —— 要被换掉的 provider 名；to.provider —— 换成谁；to.model —— 顺带换模型（可选）
 *   kinds —— 只改哪几类来源（默认四类全改）
 * @returns {{edits:Array, skipped:Array, errors:Array}}
 */
export function planRewrite(cfg, refsResult, opts = {}) {
  const from = String(opts.from || '').trim()
  const to = opts.to && typeof opts.to === 'object' ? opts.to : {}
  const toProvider = String(to.provider || '').trim()
  const toModel = String(to.model || '').trim()
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null
  const edits = []
  const skipped = []
  const errors = []

  if (!from) return { edits, skipped, errors: [{ where: '', message: '没有指定要换掉的 provider' }] }
  if (!toProvider) return { edits, skipped, errors: [{ where: '', message: '没有指定换成哪个 provider' }] }
  if (from === toProvider) return { edits, skipped: [{ file: '', kind: '', provider: from, why: '目标就是它自己，不用改' }], errors }

  const seen = new Set() // 同文件同行只改一次（一个文件里可能被扫出重复引用）
  for (const r of (refsResult && refsResult.refs) || []) {
    try {
      if (!r || r.provider !== from) continue
      if (!r.file) { skipped.push({ ...r, why: '这条引用没有文件路径，改不了' }); continue }
      if (kinds && !kinds.has(r.kind)) continue
      const k = `${r.file}#${r.line}`
      if (seen.has(k)) continue
      seen.add(k)
      edits.push({
        file: r.file,
        kind: r.kind,
        profile: r.profile || '',
        line: Number(r.line) || 0,
        from: r.provider,
        fromModel: r.model || '',
        toProvider,
        toModel,
        // overlay / plugin-patch 能被改，但**改了不一定留得住** —— 交给 UI 提醒，别在这里假装没事
        volatile: r.kind === 'overlay' || r.kind === 'plugin-patch',
      })
    } catch (err) {
      errors.push({ where: (r && r.file) || '', message: '生成改写计划时出错：' + String((err && err.message) || err) })
    }
  }

  // 定义缺失的，顺手把「得先有 B 的定义」这件事说清楚（真正补定义仍由 planSync 做）
  const defs = new Set(((cfg && cfg.allDefs) || []).map((d) => d.name))
  const hasDef = defs.has(toProvider) || BUILTIN_PROVIDERS.includes(toProvider)
  return { edits, skipped, errors, hasDef, toProvider, toModel }
}

/**
 * 真正执行「换供应商」：逐文件把 provider 行改成新名字，按需改 model，备份 + 原子替换 + 自检。
 * 一个文件失败不影响其它文件（每个文件独立 try/catch）。
 *
 * @param {object} cfg scanConfig() 结果（用于备份清理策略）
 * @param {Array} edits planRewrite().edits
 * @param {{maxBackups?:number, validate?:boolean}} [opts]
 * @returns {Array} 收据
 */
export function applyRewrite(cfg, edits, opts = {}) {
  const out = []
  const maxBackups = opts.maxBackups
  const validate = opts.validate !== false

  // 按文件分组：一个 patch 里可能有多条要改的引用，必须一次读完、一次写回
  const byFile = new Map()
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!e || !e.file) { out.push({ ...e, ok: false, why: '计划项缺少文件路径' }); continue }
    const arr0 = byFile.get(e.file) || []
    arr0.push(e)
    byFile.set(e.file, arr0)
  }

  for (const [file, list] of byFile) {
    try {
      const text = readTextSafe(file, [])
      if (text == null) { for (const e of list) out.push({ ...e, ok: false, why: '读不到文件（可能没权限或已被删除）' }); continue }
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      const entries = splitEntries(lines)
      const done = [] // 本文件已成功改掉的项
      let expectProvider = '' // 校验用：本文件最终应该是谁

      // 从后往前改：行号不会因为前面的改动而错位
      const ordered = list.slice().sort((a, b) => (Number(b.line) || 0) - (Number(a.line) || 0))
      for (const e of ordered) {
        const idx = (Number(e.line) || 0) - 1
        if (!(idx >= 0 && idx < lines.length)) { out.push({ ...e, ok: false, why: '行号越界（文件在这期间被改过？请重新扫描）' }); continue }
        const m = /^(\s*provider:\s*)(['"]?)([^'"\s#]+)(['"]?)(.*)$/.exec(lines[idx])
        if (!m) { out.push({ ...e, ok: false, why: '这一行已经不是 provider 引用了（文件被改过？请重新扫描）' }); continue }
        if (m[3] !== e.from) { out.push({ ...e, ok: false, why: `这一行现在是 "${m[3]}"，不是要换掉的 "${e.from}"（请重新扫描）` }); continue }

        lines[idx] = m[1] + m[2] + e.toProvider + m[4] + m[5]
        expectProvider = e.toProvider
        let modelChanged = false

        // 模型：只在**同一个条目**里找 model:（不能跨到旁边那条插件的配置去找）
        if (e.toModel) {
          const entry = entries.find((en) => idx >= en.start && idx < en.end)
          if (entry) {
            for (let i = idx + 1; i < entry.end; i++) {
              const mm = /^(\s*model:\s*)(['"]?)([^'"\s#]+)(['"]?)(.*)$/.exec(lines[i])
              if (mm) { lines[i] = mm[1] + mm[2] + e.toModel + mm[4] + mm[5]; modelChanged = true; break }
            }
          }
        }
        done.push({ ...e, modelChanged })
      }

      if (!done.length) continue // 全部失败，已经逐个记过原因了

      const next = lines.join(eol)
      // 写前自检：改完还要能解析回 agent-default-model，且值真的是新的
      if (validate && expectProvider) {
        const back = agentDefaultModel(next)
        if (!back) {
          for (const e of done) out.push({ ...e, ok: false, why: '生成的新内容里找不到 agent-default-model，已放弃写入，原文件未改动' })
          continue
        }
        if (back.provider !== expectProvider) {
          for (const e of done) out.push({ ...e, ok: false, why: `生成的新内容解析出来是 "${back.provider}"，不是期望的 "${expectProvider}"，已放弃写入`, })
          continue
        }
      }

      const backup = `${file}.bak-provider-hub-${stamp()}`
      try {
        copyFileSync(file, backup)
      } catch (err) {
        for (const e of done) out.push({ ...e, ok: false, why: '备份失败，为安全起见没有写入：' + String((err && err.message) || err) })
        continue
      }

      const tmp = `${file}.tmp-provider-hub-${process.pid}`
      try {
        writeFileSync(tmp, next, 'utf8')
        renameSync(tmp, file)
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* 忽略 */ }
        for (const e of done) out.push({ ...e, ok: false, why: '写入失败（备份还在，可手动恢复）：' + String((err && err.message) || err), backup })
        continue
      }

      pruneBackups(file, maxBackups)
      for (const e of done) out.push({ ...e, ok: true, backup })
    } catch (err) {
      for (const e of list) out.push({ ...e, ok: false, why: '写入时出现未预期的错误：' + String((err && err.message) || err) })
    }
  }
  return out
}
