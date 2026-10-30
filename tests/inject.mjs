/**
 * 注入契约测试：防止「忘记 export const inject」这类**只在真机爆炸**的错误。
 * ============================================================================
 * 背景（真实事故）：v1.0.0 发布后，设置页能打开，但每个接口都返回 404。
 * 原因不是路由写错了，而是 host.js 没有 `export const inject = ['webServer']`，
 * cordis 于是拒绝 `ctx.webServer`（抛 `cannot get property "webServer" without inject`），
 * apply() 在挂路由那一步就退出了，Host 只能对 `/dsh-provider-hub/*` 回它自己的 404 页面。
 *
 * 这类错误用「宽松假 ctx」永远测不出来，所以本用例用 tests/fake-ctx.mjs 复刻
 * cordis 的真实注入规则，逐条卡死：
 *   1. 必须导出 name / inject，且 inject 声明了 webServer
 *   2. 严格 ctx 下能真的挂上路由（path / kind / handler 都对）
 *   3. 故意把 inject 清空 —— 插件必须**安静降级**而不是抛异常，且不会假装挂上了
 *   4. 宿主压根没有 webServer 服务 —— 同样不许抛
 *   5. webServer.register 自己抛错 —— 同样不许抛
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tests/inject.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import host.js 之前设：apply() 会做启动自检、写日志文件，别污染真实数据目录
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-hub-inject-'))
process.env.DSH_PROVIDER_HUB_DATA = dataDir

const { makeStrictCtx } = await import('./fake-ctx.mjs')
const mod = await import('../lib/host.js')

let fail = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

console.log('=== 1. 导出声明 ===')
ok(mod.name === 'provider-hub', `导出 name = "provider-hub"（实际 ${JSON.stringify(mod.name)}）`)
ok(typeof mod.apply === 'function', '导出 apply 函数')
ok(Array.isArray(mod.inject), '导出 inject 数组')
ok(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'inject 包含 webServer（缺了就会全站 404）')

console.log('\n=== 2. 严格 ctx 下正常挂载 ===')
const mounted = []
const goodCtx = makeStrictCtx({
  inject: mod.inject,
  services: {
    webServer: {
      register(def) {
        mounted.push(def)
        return () => {}
      },
    },
  },
})
let threw = null
try { mod.apply(goodCtx) } catch (e) { threw = e }
ok(!threw, 'apply 不抛异常' + (threw ? '：' + threw.message : ''))
ok(mounted.length === 1, `webServer.register 被调用 1 次（实际 ${mounted.length}）`)
const def = mounted[0] || {}
ok(def.kind === 'prefix', 'kind = prefix')
ok(def.path === '/dsh-provider-hub', `path = /dsh-provider-hub（实际 ${JSON.stringify(def.path)}）`)
ok(typeof def.handler === 'function', '带 handler 函数')

console.log('\n=== 3. inject 漏声明时：不许抛，也不许假装挂上 ===')
const mountedBad = []
const badCtx = makeStrictCtx({
  inject: [], // 故意漏掉 webServer，模拟 v1.0.0 的 bug
  services: {
    webServer: { register(d) { mountedBad.push(d); return () => {} } },
  },
})
let threwBad = null
try { mod.apply(badCtx) } catch (e) { threwBad = e }
ok(!threwBad, '漏声明时 apply 仍然不抛（只记日志并退出）' + (threwBad ? '：' + threwBad.message : ''))
ok(mountedBad.length === 0, '漏声明时确实没挂上（说明本用例真的能抓到这类 bug）')

console.log('\n=== 4. 宿主完全没有 webServer 服务 ===')
const noSvcCtx = makeStrictCtx({ inject: mod.inject, services: {}, getTable: {} })
let threwNoSvc = null
try { mod.apply(noSvcCtx) } catch (e) { threwNoSvc = e }
ok(!threwNoSvc, '没有 webServer 服务时不抛' + (threwNoSvc ? '：' + threwNoSvc.message : ''))

console.log('\n=== 5. register 自己抛错 ===')
const brokenCtx = makeStrictCtx({
  inject: mod.inject,
  services: { webServer: { register() { throw new Error('宿主拒绝注册') } } },
})
let threwBroken = null
try { mod.apply(brokenCtx) } catch (e) { threwBroken = e }
ok(!threwBroken, 'register 抛错时不往外冒' + (threwBroken ? '：' + threwBroken.message : ''))

// 收尾：临时数据目录
try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`)
process.exit(fail === 0 ? 0 : 1)
