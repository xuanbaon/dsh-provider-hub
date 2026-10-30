/**
 * dsh-provider-hub · 日志
 * ============================================================================
 * 一行式日志器：写控制台（便于 `dsh` 终端里直接看）+ 追加到数据目录下的文件。
 *
 * 硬性要求：**日志绝不能成为故障源**。
 *   - 目录建不出来、文件被占用、磁盘满 —— 一律吞掉，只在控制台留一句
 *   - 文件超过 1MB 自动轮转成 .1（只留一代，避免长期运行把数据目录撑大）
 *   - 不引第三方依赖，不碰异步流，避免进程退出时还有句柄
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { logFile } from './paths.js'

const MAX_BYTES = 1024 * 1024 // 单文件上限 1MB

/** 轮转：provider-hub.log → provider-hub.log.1（覆盖上一代）。失败静默。 */
function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_BYTES) return
    const old = file + '.1'
    try { unlinkSync(old) } catch { /* 不存在或占用，忽略 */ }
    renameSync(file, old)
  } catch { /* 忽略 */ }
}

/**
 * 造一个日志函数。
 * @param {{tag?:string, toFile?:boolean, toConsole?:boolean}} [opts]
 * @returns {(msg:string, level?:'info'|'warn'|'error')=>void}
 */
export function createLogger(opts = {}) {
  const tag = opts.tag || 'provider-hub'
  const toFile = opts.toFile !== false
  const toConsole = opts.toConsole !== false
  let filePath = ''
  try { filePath = logFile() } catch { filePath = '' }
  let fileBroken = false // 文件写失败一次后不再反复尝试，省得每个请求都卡一下

  return function log(msg, level = 'info') {
    const line = `[${new Date().toISOString()}] [${level}] ${String(msg)}`
    if (toConsole) {
      try {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
        fn(`[${tag}]`, String(msg))
      } catch { /* 忽略 */ }
    }
    if (!toFile || !filePath || fileBroken) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      rotateIfNeeded(filePath)
      appendFileSync(filePath, line + '\n', 'utf8')
    } catch {
      fileBroken = true // 之后只写控制台，避免每条日志都抛一次
    }
  }
}

/** 把任意错误对象压成一行可读文本（日志/回执都用它）。 */
export function errText(err) {
  if (err == null) return ''
  if (typeof err === 'string') return err
  const msg = String((err && err.message) || err)
  const stack = err && err.stack ? String(err.stack).split('\n').slice(1, 3).join(' | ') : ''
  return stack ? `${msg}（${stack.trim()}）` : msg
}
