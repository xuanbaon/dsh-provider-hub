# dsh-provider-hub · 供应商中心

给 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh`）加一页设置：**看清「模型提供商」这三个真相，并把不一致补齐。**

位置：**设置 → 供应商中心**

> 它解决的是这类故障：
>
> ```
> dsh: NO_ADAPTER: no adapter registered for provider "acme"
> ```
>
> 也就是「桌面端好好的，命令行 / 定时那一轮一启动就退」。

## 为什么会有这个问题

DSH 的 provider 引用散在三个地方，改一处其余不动：

| 位置 | 谁在写 |
|---|---|
| `profiles/<name>/cordis.patch.yml` 里的 `agent-default-model` | 你在模型选择器里选的那一下 |
| `~/.dsh/<状态目录>/headless-overlay.yml` | 插件每轮重写（值班轮、定时任务那类） |
| `profiles/<name>/cordis.patch.yml` 里的 `llm-pi-ai.providers` | 你在「模型供应商」页配的定义 |

典型链路：某个插件把「桌面当前选中的模型」原样抄进 overlay → overlay 是最后一层补丁（bundle → profile → `--patch`）→ 它指向的 profile 里根本没有那个 provider 的定义 → 那一轮 `NO_ADAPTER` 退出，连报告都不写。

## 三个按钮

| 按钮 | 做什么 | 数据来源 |
|---|---|---|
| **扫描对话** | 每个会话最后一次实际用的 provider/model，并按 provider 汇总 | `storages/session_projcache/sessions/*.json` 的 `modelSelection.lastUsed` |
| **扫描插件与配置** | 谁引用了哪个 provider，按「该 profile 自己有没有定义」判定：正常 / 悬空·可补 / 仅运行时 / 缺定义 | profile patch、插件生成的 overlay、插件自带 patch、插件 `config.json` |
| **一键同步** | 先出计划（不写盘），确认后把**别处已定义的 provider** 原样追加进**引用了它却没定义的 profile** | 写目标：`profiles/<name>/cordis.patch.yml` |

## 判定口径（重要）

「悬空」**按该 profile 自己有没有定义**算，不看别的 profile。

桌面端（`desktop`）注册了 `acme`，不代表 `demo-profile` 那一轮也有 —— headless 跑的是它自己那份配置。把「全局有定义」当成「没问题」，正是这类故障一直查不出来的原因。

| 判定 | 含义 | 你能做什么 |
|---|---|---|
| 正常 | 内置供应商（`deepseek-official`、`deepseek-account`）或本 profile 已定义 | — |
| 悬空·可补 | 别处有定义、本 profile 没有 | 点「一键同步」 |
| 仅运行时 | 静态配置里没有，但运行时注册表里有（插件动态注册） | 不用管 |
| 缺定义 | 哪儿都没有 | 先去「模型供应商」页配一次 |

只扫 `agent-default-model` 条目里的 `provider:`。别的条目里也有 `provider:`（子代理的 `spawn` / `fork` / `codex`、工具提供方…），那些不是模型供应商，扫进来只会制造假红。

## 同步的行为边界

- **只追加**：在 `llm-pi-ai` 条目的 `providers:` 末尾追加缺的那几个块；不重排、不改你写的任何一行。
- **写前自检**：新文本必须能被重新解析、且真的带上那些 provider，否则**放弃写入**，原文件保持原样。
- **先备份**：写前复制 `cordis.patch.yml.bak-provider-hub-<时间>`，回滚就是覆盖回去；备份数量按偏好自动清理（默认每个文件留 20 个，只删本插件自己造的那种文件名）。
- **原子替换**：先写同目录临时文件再 `rename`，中途被杀也不会留下一份被截断的 patch。
- **幂等**：已经有定义的不重复加，连点几次都安全。
- **不动 overlay**：`headless-overlay.yml` 是插件每轮重写的，改了也会被覆盖 —— 所以修法永远是「补 profile 的定义」。
- **要重启才生效**：loader 不热读 `cordis.patch.yml`。定时 / 值班那类每轮新起进程的任务会立刻用上新配置。

## 数据存哪（重装不丢）

```
<DSH_HOME>/provider-hub/                 ← 数据目录，和代码目录分居
  state.json          偏好 / 已忽略项 / 同步历史
  state.json.bak      上一次的内容（手工可回滚）
  logs/provider-hub.log  运行日志（超 1MB 自动轮转）
```

`<DSH_HOME>` 默认 `~/.dsh`，插件安装目录通常在 `%LOCALAPPDATA%\dsh-plugins\` 或 profile 的 `node_modules` 下 —— **更新或重装插件是整目录替换**，所以数据一律不放代码目录。可用环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 根目录，默认 `~/.dsh` |
| `DSH_PROVIDER_HUB_DATA` | 本插件数据目录，默认 `$DSH_HOME/provider-hub` |

可靠性：原子写（临时文件 + rename）、写前留 `.bak`、坏 JSON 自动改名留证并退回默认值、结构版本迁移（降级安装也不丢数据）、每个字段强制类型兜底。

## 错误处理

插件被设计成「**一个坏文件不能把设置页弄崩**」：

- 每次读文件 / 列目录 / 解析 JSON 都单独 `try/catch`，失败只记一条诊断并跳过；
- 页面顶部有「诊断」区，直接告诉你哪个文件读失败、为什么；
- 所有请求 20 秒超时，失败一律转成 `{ok:false,error}`，不会 reject 到渲染层；
- 组件外面套 `ErrorBoundary`：万一渲染抛错，只在本区内显示错误并提供「重试」，不会带白屏；
- 路由层统一 `try/catch` → 500 JSON；请求体超限返回 413（而不是把连接掐了让你看到「网络错误」）；
- 日志写不进去也不会抛（只在控制台说一句，之后不再重试）；
- 拿不到 `slots` 服务（DSH 版本不匹配）时安静退出，不影响其他插件。

## 安装

插件目录放到 DSH 能解析到的位置，然后在 profile 的 `package.json` 里登记：

```jsonc
{
  "dependencies": { "dsh-provider-hub": "^1.0.0" },
  "dsh": { "profile": { "bundles": ["dsh-provider-hub"] } }
}
```

本地开发可以直接用目录联接（Windows `mklink /J`、macOS `ln -s`）链到 `profiles/<name>/node_modules/dsh-provider-hub`，改完重启 DSH 即可。

**重启 DSH 生效。**

## 测试

6 个用例，覆盖扫描、持久化、容错、注入契约、路由、前端契约；全部不依赖 DSH 运行时，也不碰你真实的配置和偏好。

```bash
npm test                                  # 跑全部
npm run test:scan                         # 扫描 + 纯函数 + 沙盒端到端（临时目录里真写）
npm run test:store                        # 持久化：原子写 / 坏文件自愈 / 类型兜底
npm run test:errors                       # 容错：坏文件不崩、校验不过不写盘
npm run test:inject                       # 注入契约：inject 声明 / 严格 ctx 挂载 / 缺服务降级
npm run test:routes                       # 路由：起真 http 打全部接口（临时数据目录）
npm run test:client                       # 前端契约：自注册 / 槽位 / 错误边界
```

`tests/inject.mjs` 与 `tests/fake-ctx.mjs` 是专门为一次真实事故加的：v1.0.0 忘了
`export const inject = ['webServer']`，cordis 拒绝 `ctx.webServer`，路由压根没挂上，
表现是**设置页能打开、但每个接口都 404**。假 ctx 如果「要什么给什么」就永远测不出来，
所以现在复刻了 cordis 的注入规则——没写进 `inject` 的服务，访问属性会直接抛。

在没装 Node 的机器上（比如只有 DSH 自带运行时），用 Electron 的 Node 跑：

```bash
ELECTRON_RUN_AS_NODE=1 "/path/to/DeepSeek Harness.exe" tests/run-all.mjs
```

## 命令行等价物

设置页那几个按钮的同一份逻辑，也能在终端跑（DSH 没开的时候尤其方便）：

```bash
node tests/sync.mjs           # 只看计划
node tests/sync.mjs --apply   # 真写（先备份）
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-provider-hub/health` | 版本 / 目录 / 运行时长（无副作用，排查用） |
| GET | `/dsh-provider-hub/overview` | 各 profile 的定义与默认模型、overlay、运行时注册表、计数、诊断 |
| GET | `/dsh-provider-hub/sessions?limit=200` | 会话实际在用谁 |
| GET | `/dsh-provider-hub/refs` | 引用与悬空判定 + 同步计划 |
| GET | `/dsh-provider-hub/state` | 偏好 / 已忽略项 / 同步历史 / 数据目录 |
| POST | `/dsh-provider-hub/sync` | `{apply:false}` 预演 / `{apply:true}` 写盘（先备份） |
| POST | `/dsh-provider-hub/prefs` | 改偏好 `{patch:{...}}` |
| POST | `/dsh-provider-hub/ignore` | 忽略 / 取消忽略一条引用 |
| POST | `/dsh-provider-hub/history` | 清空同步历史 `{clear:true}` |

全部走本机同源校验 + DSH 信任栅栏（`connection.requestRejection`，拿不到就退回同源判定）。

## 故障排查

### 设置页红字「接口没有挂上（HTTP 404）」

意思是**宿主半边没把路由挂上**，前端请求打到了 DSH Host 的兜底 404（返回 HTML，所以「不是 JSON」）。
先看日志，原因都写在里面：

```
~/.dsh/provider-hub/logs/provider-hub.log
```

按出现频率排：

| 日志里看到 | 含义 | 处理 |
|---|---|---|
| `cannot get property "webServer" without inject` | `host.js` 没声明 `export const inject = ['webServer']`（v1.0.0 的原始 bug） | 升级到 1.0.1+ |
| 完全没有 `已注册路由 /dsh-provider-hub/*` 这行 | 插件没被加载，或加载后立刻退出了 | 托盘退出 DSH 再开（loader 不热读插件代码） |
| `宿主没有可用的 webServer 服务` | DSH 版本没有这个服务 | 升级 DSH |

想不打开界面就确认路由在不在（`401` = 挂了且在鉴权，`404` = 没挂）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5488/dsh-provider-hub/health
```

### 强依赖：`export const inject`

cordis 里**只有写进 `inject` 数组的服务才能用 `ctx.<name>` 访问**，没写的会直接抛异常（不是返回 undefined）。
本插件的 `host.js` 顶部有 `export const inject = ['webServer']`，删掉它页面就会全 404。
`tests/inject.mjs` 专门守这条。

## 已知边界

- 插件目录只扫一层 `node_modules/*/cordis.patch.yml`，不钻子目录（避免把上千个文件全读一遍）。
- overlay 落到哪个 profile 是**推断**的：读同目录 `config.json` 的 `headlessProfile`；写的是 `headless` 或空时，按「存在 `demo-profile` 就用 `demo-profile`」处理。
- 会话里没有 `modelSelection` 记录的老会话显示「未记录」，不做猜测反推。
- 单文件超过 4MB（会话缓存 8MB）直接跳过并记诊断，不尝试读。
- 不做热更新：改完 patch 一律要重启。

## License

MIT
