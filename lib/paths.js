/**
 * dsh-provider-hub · 路径约定
 * ============================================================================
 * 只有一个原则：**数据目录必须和代码目录分开**。
 *
 *   代码：<插件安装目录>            ← 更新/重装插件时整目录会被覆盖
 *   数据：$DSH_HOME/provider-hub/  ← 本模块负责，装在别处，重装不丢
 *
 * 可用环境变量覆盖（测试和便携场景用）：
 *   DSH_HOME                 DSH 的根目录，默认 ~/.dsh
 *   DSH_PROVIDER_HUB_DATA    本插件数据目录，默认 $DSH_HOME/provider-hub
 *
 * 所有函数都是纯计算或轻量 fs 探测，**任何情况下都不抛异常** —— 路径算不出来时
 * 退化成「尽量合理」的默认值，让上层继续工作而不是整个插件崩掉。
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** DSH 根目录。注意：每个请求都重新读 env，方便测试中途切换。 */
export function dshHome() {
  const v = process.env.DSH_HOME
  if (v && String(v).trim()) return resolve(String(v).trim())
  try {
    return join(homedir(), '.dsh')
  } catch {
    // homedir() 在极少数受限环境会抛；给个兜底，别让插件起不来
    return resolve('.dsh')
  }
}

/**
 * 本插件的数据目录（用户偏好、已忽略项、同步历史、日志）。
 * 刻意放在 DSH_HOME 下而不是插件安装目录里：插件更新/重装是整目录替换，
 * 放在代码目录里的任何状态都会丢。
 */
export function dataDir() {
  const custom = process.env.DSH_PROVIDER_HUB_DATA
  if (custom && String(custom).trim()) return resolve(String(custom).trim())
  return join(dshHome(), 'provider-hub')
}

/** 状态文件（JSON，含 prefs / ignored / history）。 */
export const stateFile = () => join(dataDir(), 'state.json')
/** 状态文件的上一个版本（每次写入前复制一份，误操作可手工回滚）。 */
export const stateBackupFile = () => join(dataDir(), 'state.json.bak')
/** 运行日志（按大小轮转，见 lib/log.js）。 */
export const logFile = () => join(dataDir(), 'logs', 'provider-hub.log')

/**
 * 判断 path 是否位于 parent 目录之内（含 parent 本身）。
 * 用来在测试与自检里断言「数据目录不在插件目录里」。
 * @param {string} p
 * @param {string} parent
 */
export function isInside(p, parent) {
  try {
    const a = resolve(p)
    const b = resolve(parent)
    if (a === b) return true
    return a.startsWith(b.endsWith(sep) ? b : b + sep)
  } catch {
    return false
  }
}

/**
 * 目录是否存在（任何错误都当作「不存在」，调用方据此决定是否创建）。
 * @param {string} p
 */
export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
