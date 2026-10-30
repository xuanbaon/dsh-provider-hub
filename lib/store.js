/**
 * dsh-provider-hub · 持久化存储
 * ============================================================================
 * 存三样东西（都放数据目录，和代码目录分居，重装插件不丢）：
 *
 *   prefs    用户偏好：是否显示已忽略项、自动扫描、历史保留条数、备份保留个数
 *   ignored  用户手动「忽略」的悬空引用（provider@profile），避免同一堆红字天天刷屏
 *   history  最近 N 次同步的收据（哪个 profile 补了哪些 provider、备份在哪）
 *
 * 可靠性设计（对应「不要让插件因为一个错误崩掉」）：
 *
 *   1. **原子写**：先写 state.json.tmp-xxx 再 rename 覆盖。中途断电/被杀也不会
 *      留下半截 JSON —— 要么是旧内容，要么是新内容。
 *   2. **写前留底**：覆盖前把旧的复制成 state.json.bak，手工可回滚。
 *   3. **坏文件自愈**：读到解析不了的 JSON → 改名成 state.json.corrupt-<时间> 留证
 *      → 用默认值继续跑。绝不让一个坏文件把设置页卡死。
 *   4. **版本迁移**：state.version 小于当前版本时按 migrate() 补齐新字段；
 *      大于当前版本（用户降级插件）时保留原字段、只补默认值，不删数据。
 *   5. **类型兜底**：normalize() 把每个字段都强制成预期类型，配置文件被手改坏了
 *      也只是「按默认值显示」，不会让页面渲染炸掉。
 *   6. **写入失败只报错不抛**：saveState() 返回 {ok:false, error}，调用方决定怎么提示。
 *
 * 本模块全部同步 IO：状态文件很小（KB 级），同步读写的确定性比异步并发更值钱。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dataDir, stateBackupFile, stateFile } from './paths.js'

/** 当前状态结构版本。加字段时 +1，并在 migrate() 里补迁移。 */
export const STATE_VERSION = 1

/** 状态文件体积上限：超过就当坏文件处理（正常只有几 KB，防手改塞爆）。 */
const MAX_STATE_BYTES = 2 * 1024 * 1024

/** 历史保留条数的上下限，防止用户把 prefs.maxHistory 改成天文数字。 */
export const HISTORY_MIN = 1
export const HISTORY_MAX = 500

/**
 * 默认状态。每次都用 defaults() 生成**新的深拷贝** —— 直接返回这个常量对象的话，
 * 任何调用方改一下就会污染后续所有读取。
 */
export const DEFAULT_STATE = Object.freeze({
  version: STATE_VERSION,
  prefs: Object.freeze({
    showIgnored: false, // 表格里是否显示被忽略的引用
    autoScan: true, // 打开设置页自动跑一次概览
    maxHistory: 50, // 同步历史最多留几条
    maxBackups: 20, // 每个 patch 文件最多留几个 .bak-provider-hub-*
  }),
  ignored: [], // [{ key, provider, profile, note, at }]
  history: [], // [{ at, applied, total, profiles, receipts }]
  lastScanAt: 0,
  createdAt: 0,
  updatedAt: 0,
})

/** 深拷贝一份默认状态。 */
export function defaults() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE))
}

const clampInt = (v, def, min, max) => {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

const str = (v, def = '') => (typeof v === 'string' ? v : v == null ? def : String(v))

/** 忽略项的主键：同一个 provider 在不同 profile 上要能分别忽略。 */
export const ignoreKey = (provider, profile) => str(provider).trim() + '@' + str(profile).trim()

/**
 * 把任意来源（磁盘/前端）的原始对象规整成合法状态。
 * 目标：**无论输入多脏，输出都能直接被 UI 渲染**。
 * @param {any} raw
 * @returns {object}
 */
export function normalize(raw) {
  const out = defaults()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  const p = raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {}
  out.prefs.showIgnored = p.showIgnored === true
  out.prefs.autoScan = p.autoScan !== false // 缺省为 true
  out.prefs.maxHistory = clampInt(p.maxHistory, DEFAULT_STATE.prefs.maxHistory, HISTORY_MIN, HISTORY_MAX)
  out.prefs.maxBackups = clampInt(p.maxBackups, DEFAULT_STATE.prefs.maxBackups, 0, 200)

  if (Array.isArray(raw.ignored)) {
    const seen = new Set()
    for (const it of raw.ignored) {
      if (!it || typeof it !== 'object') continue
      const provider = str(it.provider).trim()
      const profile = str(it.profile).trim()
      if (!provider) continue
      const key = ignoreKey(provider, profile)
      if (seen.has(key)) continue // 去重
      seen.add(key)
      out.ignored.push({
        key,
        provider,
        profile,
        note: str(it.note).slice(0, 200),
        at: clampInt(it.at, 0, 0, Number.MAX_SAFE_INTEGER),
      })
    }
  }

  if (Array.isArray(raw.history)) {
    for (const it of raw.history) {
      if (!it || typeof it !== 'object') continue
      const receipts = Array.isArray(it.receipts)
        ? it.receipts.filter((r) => r && typeof r === 'object').slice(0, 50).map((r) => ({
          profile: str(r.profile),
          file: str(r.file),
          ok: r.ok === true,
          skipped: r.skipped === true,
          added: Array.isArray(r.added) ? r.added.map((x) => str(x)).slice(0, 50) : [],
          backup: str(r.backup),
          why: str(r.why).slice(0, 300),
        }))
        : []
      // 没有一条可用收据的历史记录没有展示价值，直接丢掉（也让坏数据自净）
      if (!receipts.length) continue
      out.history.push({
        at: clampInt(it.at, 0, 0, Number.MAX_SAFE_INTEGER),
        applied: it.applied === true,
        total: clampInt(it.total, receipts.length, 0, 10000),
        profiles: Array.isArray(it.profiles) ? it.profiles.map((x) => str(x)).slice(0, 50) : [],
        receipts,
      })
    }
    // 最新的排前面，并按偏好截断
    out.history.sort((a, b) => b.at - a.at)
    out.history = out.history.slice(0, out.prefs.maxHistory)
  }

  out.lastScanAt = clampInt(raw.lastScanAt, 0, 0, Number.MAX_SAFE_INTEGER)
  out.createdAt = clampInt(raw.createdAt, 0, 0, Number.MAX_SAFE_INTEGER)
  out.updatedAt = clampInt(raw.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  out.version = STATE_VERSION
  return out
}

/**
 * 版本迁移。当前只有 v1，保留函数是为了以后加字段时有个明确落点：
 * 老版本数据不该被丢弃，只该被补全。
 * @param {object} raw 已 normalize 的状态
 * @param {number} from 磁盘上的原始 version
 */
export function migrate(raw, from) {
  const v = Number(from) || 1
  if (v < 1) {
    // 没有版本号的（最早的手写 state）—— normalize 已经补全了，只需标记
    raw.version = STATE_VERSION
  }
  if (v > STATE_VERSION) {
    // 用户装了更新版插件又降级回来：保留现有字段，不删数据，只提示
    raw.version = STATE_VERSION
    raw.downgradedFrom = v
  }
  return raw
}

/**
 * 确保数据目录存在。
 * @returns {{ok:boolean, dir:string, error?:string}}
 */
export function ensureDataDir() {
  const dir = dataDir()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (!statSync(dir).isDirectory()) return { ok: false, dir, error: '数据目录路径被一个同名文件占用：' + dir }
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, dir, error: '创建数据目录失败：' + String((err && err.message) || err) }
  }
}

/** 给坏文件改名留证，返回新路径（失败返回空串）。 */
function quarantine(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = `${file}.corrupt-${ts}`
  try {
    renameSync(file, dst)
    return dst
  } catch {
    return ''
  }
}

/**
 * 读状态。**永不抛异常**。
 * @returns {{state:object, ok:boolean, file:string, dir:string, created:boolean, recovered:boolean, error:string, dataDirOk:boolean}}
 */
export function loadState() {
  const base = {
    state: defaults(),
    ok: true,
    file: stateFile(),
    dir: dataDir(),
    created: false,
    recovered: false,
    error: '',
    dataDirOk: true,
  }
  try {
    const ensured = ensureDataDir()
    if (!ensured.ok) return { ...base, ok: false, dataDirOk: false, error: ensured.error }

    const file = stateFile()
    let exists = false
    try {
      exists = statSync(file).isFile()
    } catch {
      exists = false
    }

    if (!exists) {
      // 第一次运行：落一份默认状态，让用户打开数据目录时能看到文件在哪
      const state = defaults()
      state.createdAt = Date.now()
      state.updatedAt = state.createdAt
      const saved = saveState(state)
      return { ...base, state, created: true, ok: saved.ok, error: saved.error || '', dataDirOk: true }
    }

    let raw = ''
    try {
      const size = statSync(file).size
      if (size > MAX_STATE_BYTES) {
        const moved = quarantine(file)
        return {
          ...base,
          recovered: true,
          ok: false,
          error: `状态文件异常大（${size} 字节），已改名留证${moved ? '：' + moved : ''}，本次用默认值`,
        }
      }
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      return { ...base, ok: false, error: '读状态文件失败：' + String((err && err.message) || err) }
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const moved = quarantine(file)
      return {
        ...base,
        recovered: true,
        ok: false,
        error: `状态文件不是合法 JSON（${String((err && err.message) || err)}），已改名留证${moved ? '：' + moved : ''}，本次用默认值`,
      }
    }

    const fromVersion = Number(parsed && parsed.version) || 0
    const state = migrate(normalize(parsed), fromVersion)
    return { ...base, state, ok: true, dataDirOk: true }
  } catch (err) {
    // 最后一道保险：任何预料之外的异常都退化成默认状态
    return { ...base, ok: false, error: '读状态时出现未预期的错误：' + String((err && err.message) || err) }
  }
}

/** 清理上次异常退出可能残留的临时文件（只会删自己造的 state.json.tmp-*）。 */
function sweepTemp(dir) {
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('state.json.tmp-')) {
        try { unlinkSync(join(dir, f)) } catch { /* 被占用就算了 */ }
      }
    }
  } catch { /* 目录读不了就算了 */ }
}

/**
 * 原子写状态。
 * @param {object} state 任意对象，写入前会 normalize
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function saveState(state) {
  const ensured = ensureDataDir()
  if (!ensured.ok) return { ok: false, file: stateFile(), error: ensured.error }

  const dir = ensured.dir
  const file = stateFile()
  const next = normalize(state)
  next.updatedAt = Date.now()
  if (!next.createdAt) next.createdAt = next.updatedAt

  sweepTemp(dir)

  const tmp = join(dir, `state.json.tmp-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, file, error: '写临时文件失败：' + String((err && err.message) || err) }
  }

  // 覆盖前留底（失败不算致命，继续写主文件）
  try {
    if (statSync(file).isFile()) copyFileSync(file, stateBackupFile())
  } catch { /* 没有旧文件或复制失败都无所谓 */ }

  try {
    renameSync(tmp, file) // 同一分区内的 rename 是原子的
    return { ok: true, file }
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    return { ok: false, file, error: '替换状态文件失败：' + String((err && err.message) || err) }
  }
}

/**
 * 读-改-写。mutator 里抛错时不落盘，返回 {ok:false}，调用方可以继续用旧状态。
 * @param {(state:object)=>void|object} mutator 直接改传入的 state，或返回新 state
 * @returns {{ok:boolean, state:object, error:string}}
 */
export function updateState(mutator) {
  const loaded = loadState()
  const state = loaded.state
  try {
    const r = mutator(state)
    const next = r && typeof r === 'object' ? r : state
    const saved = saveState(next)
    return { ok: saved.ok, state: normalize(next), error: saved.error || loaded.error || '' }
  } catch (err) {
    return { ok: false, state, error: '更新状态失败：' + String((err && err.message) || err) }
  }
}

/**
 * 记一条同步历史（自动按 prefs.maxHistory 截断）。
 * @param {object} state 会被就地修改
 * @param {{applied:boolean, receipts:Array}} entry
 */
export function pushHistory(state, entry) {
  try {
    const receipts = Array.isArray(entry && entry.receipts) ? entry.receipts : []
    state.history = Array.isArray(state.history) ? state.history : []
    state.history.unshift({
      at: Date.now(),
      applied: !!(entry && entry.applied),
      total: receipts.length,
      profiles: receipts.filter((r) => r && r.ok && !r.skipped).map((r) => str(r.profile)),
      receipts: receipts.slice(0, 50).map((r) => ({
        profile: str(r && r.profile),
        file: str(r && r.file),
        ok: !!(r && r.ok),
        skipped: !!(r && r.skipped),
        added: Array.isArray(r && r.added) ? r.added.map((x) => str(x)) : [],
        backup: str(r && r.backup),
        why: str(r && r.why).slice(0, 300),
      })),
    })
    const max = clampInt(state.prefs && state.prefs.maxHistory, DEFAULT_STATE.prefs.maxHistory, HISTORY_MIN, HISTORY_MAX)
    state.history = state.history.slice(0, max)
  } catch { /* 历史记不上不影响主流程 */ }
  return state
}

/**
 * 忽略 / 取消忽略一条引用。
 * @param {object} state
 * @param {{provider:string, profile:string, note?:string, remove?:boolean}} item
 */
export function setIgnored(state, item) {
  const provider = str(item && item.provider).trim()
  const profile = str(item && item.profile).trim()
  if (!provider) return state
  const key = ignoreKey(provider, profile)
  state.ignored = Array.isArray(state.ignored) ? state.ignored : []
  const at = state.ignored.findIndex((x) => x && x.key === key)
  if (item && item.remove) {
    if (at >= 0) state.ignored.splice(at, 1)
    return state
  }
  const row = { key, provider, profile, note: str(item && item.note).slice(0, 200), at: Date.now() }
  if (at >= 0) state.ignored[at] = row
  else state.ignored.push(row)
  return state
}
