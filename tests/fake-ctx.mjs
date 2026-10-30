/**
 * 假 ctx：模拟 **cordis 真实注入规则** 的最小实现，给路由/契约测试共用。
 * ============================================================================
 * 为什么需要它：早期测试的假 ctx 是「要什么给什么」的宽松对象，
 * 于是 `export const inject` 漏写 webServer 这种错在测试里完全看不出来，
 * 一直到真机才变成「设置页能开、每个接口 404」。
 *
 * 真实 cordis 的行为是：
 *   - 只有写进插件 `inject` 数组的服务，`ctx.<service>` 才能取；
 *   - 没写的服务，访问属性会**直接抛** `cannot get property "X" without inject`
 *     （不是返回 undefined —— 这点最容易踩）；
 *   - `ctx.get('X')` 不受 inject 限制，取不到返回 undefined（所以插件可以拿它做降级）。
 *
 * 这里逐条复刻，测试才有意义。
 */

/**
 * @param {object} opts
 * @param {string[]} [opts.inject]  插件声明的依赖（直接把 `mod.inject` 传进来最真实）
 * @param {Record<string, any>} [opts.services]  宿主提供的服务实例（如 webServer）
 * @param {Record<string, any>} [opts.getTable]  ctx.get() 能取到的服务（模拟老版本/缺服务）
 * @param {(label?: string) => void} [opts.onEffect]  每次 effect 被调用时通知（可选）
 */
export function makeStrictCtx({ inject = [], services = {}, getTable = {}, onEffect } = {}) {
  const allowed = new Set(Array.isArray(inject) ? inject : [])

  // 内部实现属性：这些不是「服务」，访问它们不能受 inject 限制
  const inner = {
    /** cordis 的 effect 会立即执行回调，并返回 dispose 函数 */
    effect: (fn, label) => {
      if (typeof onEffect === 'function') onEffect(label)
      const d = typeof fn === 'function' ? fn() : undefined
      return typeof d === 'function' ? d : () => {}
    },
    /** ctx.get 不受 inject 约束，取不到就是 undefined */
    get: (serviceName) => {
      if (!Object.prototype.hasOwnProperty.call(getTable, serviceName)) return undefined
      const v = getTable[serviceName]
      return typeof v === 'function' ? v() : v
    },
    /** 有些插件会读 ctx.logger / ctx.scope，这里给个安静的空实现 */
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  }

  return new Proxy(inner, {
    get(target, prop) {
      // Symbol（util.inspect、toPrimitive 之类）和 then（避免被当成 thenable）一律放过
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      if (!allowed.has(prop)) {
        // 复刻 cordis 的报错原文，便于和真机日志对照
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return services[prop]
    },
    has(target, prop) {
      if (typeof prop === 'symbol') return false
      return Object.prototype.hasOwnProperty.call(target, prop) || allowed.has(prop)
    },
  })
}
