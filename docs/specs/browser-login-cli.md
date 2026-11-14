# 浏览器登录与 CLI（LOGIN-CLI-01）

本包实现“专用浏览器真人登录 → Core 候选会话导入 → 作品库与单 ZIP 计划 → 后续 CLI 进程恢复”的调用层。已完成公开接口、CLI 入口和离线合成验证；新真人登录链仍需另行授权验收，不能把合成结果称为线上通过。

## 包与提交边界

`@my-dlsite/browser-auth` 和 `@my-dlsite/cli` 是同仓 private ESM 包。依赖方向为 CLI → browser-auth/core、browser-auth → core；Core 不依赖调用层。

登录事务接收调用方已有的 `AuthApi`。它管理专用可见 Chromium，不读取用户 profile，也不输入密码、验证码或二步验证。内部适配器先观察捕获就绪、读取和严格转换 Cookie，再关闭浏览器，最后调用一次 `auth.importCookies`。成功导入是唯一提交点；其后不再 validate、restore、export 或执行可使登录改判失败的清理。阶段通知只提供枚举，回调异常不改变事务结果。

公开接口为 `loginWithBrowser(auth, options?): Promise<void>`。options 支持 `signal`、有限的 `timeoutMs`（默认 600000）和 `onStage`，以及独立的 `proxy: { server, bypass?, username?, password? }`。不接受用户 profile、浏览器路径、任意启动参数或自行定义成功判据。代理认证字段只留在内存，server 不接受 userinfo。

阶段枚举为 `opening-browser`、`waiting-for-user`、`capture-ready`、`closing-browser`、`checking-session`、`session-established`。`BrowserLoginError.code` 区分无匹配浏览器、浏览器失败或关闭、取消、总期限超时、输入配置错误和无法表示的 Cookie；Core 候选导入的原有错误分类继续保留。

候选捕获、转换、关闭或 Core 候选探测失败都不替换旧 Core 会话。取消信号和默认 10 分钟总期限约束等待；迟到的浏览器打开结果会关闭。浏览器库本身不持久化、不创建第二个 Client。浏览器捕获就绪、Core sales 探测成功、library 完整读取和指定作品计划成功是四个独立结果；空库允许会话建立，www 下载授权不作为登录必需条件。

Core 负责候选探测与队列的取消。登录事务直接等待 import 的结果，不再用取消竞争其成功返回，避免 Core 已经提交后被误报取消；排队取消的约束见 [Core 会话合同](./core.md#建立与替换会话)。

## 捕获就绪与第一方依据

观察器在导航前安装，然后正常打开 `https://play.dlsite.com`，由用户沿第一方 www/Play 页面完成登录。它仅被动观察该主页面自然发起的 GET `/api/authorize`：精确 Play HTTPS origin、无额外 query、fetch/xhr、成功 JSON 响应。iframe、worker、旧 localStorage、Cookie 存在和 URL 变化均不能单独证明就绪；库不主动 authorize fetch 或轮询，不执行抓取的 bundle，也不插入 www 下载授权探测。

身份判断依据 2026-11-14 主控核对的匿名第一方副本：`auth-resource.BY03EpAF.chunk.js` 的 a() 排除数组和空对象，`session.DfKvosQo.chunk.js` 的 r() 按 `customer_id || production_id || admin_id` 取身份。实现识别非空字符串或有限非零数值；未知字段和未知类型保持未证明。副本 SHA-256 分别为 `1f71e4974b770d88223c64bb36d6f5d50564c48dbb0310ac03c9da6b2e60368d` 与 `101d417c088c947e0dec5f18f5561c02546a56ccad50f591f868be44867ce554`。这些是已观察前端版本的代码依据，不保证未来 schema，也不是本轮 fresh live。

身份正文仅在内存检查，解析上限 64 KiB，不进入通知或日志。等待响应体后再次核对所属主文档代次、当前 Play 页面和 DOMContentLoaded 边界；新主文档导航使旧响应失效，同文档路由变化不凭空制造身份。页面关闭、取消和总期限会结束等待并清理事件监听器。未匹配响应继续有限等待，不把 403、网络失败或无身份统一解释为 Play 会话失效。

## Chromium 兼容边界

固定依赖 Playwright `1.65.0`，配套 Chromium `158.0.8127.18`、revision `1254`。浏览器必须提前准备，登录函数不静默安装。版本依据包内 `browsers.json` 与[上游对应版本](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json)。

通过 page target 的 `Target.getTargetInfo` 取得专用 context ID，再通过 browser target 的 `Storage.getCookies` 读取该 context 的所有 path。不能使用默认 context，也不能只按首页 URL 导出。实际浏览器合成测试验证专用 context 与第二个空 context 相互隔离；Cookie 由 CDP 写入，不导航 DLsite、不使用真实输入。

转换按服务域及 Core 能力筛选 play/www/download 和适用父域 Cookie，不使用名称白名单。保留值、domain、hostOnly、path、Secure、HttpOnly、SameSite 及绝对期限；空值合法。Chromium `session=true, expires=-1` 映射为 Core 不带 expires 的会话 Cookie，不把过期记录改成会话记录。

会话 Cookie 没有可用的客户端绝对到期时间；保存后允许跨 CLI 进程恢复，但每次恢复仍由 Core 探测服务端是否接受，不推断服务端寿命，也不承诺浏览器关闭后服务端继续接受。

Core 的期限精度与旧快照兼容见 [Core 会话合同](./core.md#建立与替换会话)。

分区或 opaque partition Cookie 明确拒绝。当前只转换 sourceScheme=Secure、sourcePort=443 的记录，因为 Core 支持的网络目标均为 HTTPS 默认端口；其他来源绑定无法表达时拒绝，不删除字段后继续。Cookie Priority 和 size 不影响 Core 支持的目标匹配，不进入快照。

当前 Core 仍以 name/domain/path 三字段作为键。真实合成 Chromium 已验证 host-only `www.dlsite.com` 和 domain `.www.dlsite.com` 的同名同 path 记录可以并存；转换器对此明确拒绝，既不择一，也不合并期限。当前支持无此冲突、无分区且来源满足上述目标能力的会话。尚无新登录证据证明冲突是否出现在正常专用登录流程；若真人验收命中此限制，应报告兼容问题，不能要求用户手工删除记录或沿用旧研究的有损投影，也不能宣称该会话已支持。

## CLI 会话与安全输出

`my-dlsite` 提供 `login [--browser-proxy <server>]`、`library` 和 `plan <workId>`，每次装配只创建一个 Core Client。默认仅输出 JSON 摘要，不打印 Cookie、快照、完整计划、文件名或签名 URL；library 输出计数与规范作品编号，便于选择 plan 的 workId。Core 的公开 `acquisition.plan` 仍返回完整计划给普通 Node 调用方。本次不提供 CLI 凭据计划导出选项。进度写 stderr，结果写 stdout；失败返回非零退出码。Ctrl+C/SIGTERM 取消当前操作。

当前分发方式尚未决定。构建后可在仓库内使用 `node packages/cli/dist/bin.js login`、`node packages/cli/dist/bin.js library`、`node packages/cli/dist/bin.js plan RJ000001`；包的 bin 名为 `my-dlsite`，不承诺当前已全局安装。

标准快照是未经另包封装的 Core v1 snapshot：

- macOS：`~/Library/Application Support/my-dlsite/session.json`。
- Linux 路径规则：`${XDG_DATA_HOME:-~/.local/share}/my-dlsite/session.json`；XDG_DATA_HOME 必须是绝对路径，当前验收只覆盖 macOS/POSIX，不承诺 Windows 支持。

应用目录为 0700，快照为当前用户拥有、链接计数为 1 的 0600 普通文件。路径祖先及文件的符号链接均拒绝；已有不安全权限明确报错。相邻 `session.lock` 使用排他创建，覆盖恢复、操作和保存；竞争进程立即报告 busy。崩溃遗留锁不自动偷取，使用者确认没有运行进程后才能手工处理。

保存使用同目录 0600 临时文件，写入、sync、关闭完成后原子 rename 替换。替换前失败保留旧文件并清理自己的临时文件；不承诺断电后的目录项持久性，也不防御拥有同一 UID 的恶意并发修改。损坏 JSON、未知版本或 Core schema 错误明确报错，不自动清空。已提交而导出/保存失败报告“会话已建立但未保存，旧快照保留”。

候选登录失败不保存。成功恢复后，业务请求失败也可能已经轮换 Cookie；除 Core 明确 `AuthRequired` 失效外，保存当前非空会话后再报告业务错误，避免无条件 finally 写入空状态。旧会话明确失效时允许开始新登录，损坏快照仍阻止自动覆盖。

## 网络与验收限制

浏览器 `proxy` 和 Node `fetch` 是独立配置。CLI 的 `--browser-proxy <server>` 只影响专用浏览器；不从 Node 代理环境变量复制，不硬编码代理端口。Node 调用方使用 Core 的 `createClient({ fetch })` 注入，或在所用 Node 版本支持时显式启用运行时的 `--use-env-proxy`，不承诺浏览器与 Node 自动共用出口。CLI 代理参数不接受 userinfo；程序调用层可使用独立的代理认证字段，不能输出它们。

浏览器观察器用回环合成页面验证；普通 Node consumer 和 CLI 用同一公开 `loginWithBrowser`、Core Client、作品库及下载计划接口，在仅替换浏览器边界与 fetch 的条件下验证，最终文件请求断言为零。未执行新真人浏览器登录、真实库读取或真实计划验证。离线测试不能证明服务端协议仍可用；`headersSufficiency`、`fileTransfer` 保持 `NOT_TESTED`。

## 普通 Node 调用

先构建 Core 和 browser-auth。调用方只创建一个 Client，其 fetch 配置不会被登录库更换：

```ts
import { loginWithBrowser } from "@my-dlsite/browser-auth"
import { createClient } from "@my-dlsite/core"

const client = createClient() // 也可传入 { fetch: configuredFetch }
await loginWithBrowser(client.auth, {
  onStage: (stage) => console.error(stage),
})
const library = await client.library.list()
const workId = library.works[0]?.purchase.workId
const plan = workId === undefined ? null : await client.acquisition.plan(workId)
// plan 是完整的短期凭据对象，仅供本机调用方立即使用，不打印或跨目标复用。
const snapshot = await client.auth.export()
// snapshot 同样包含凭据；调用方负责安全保存。后续进程使用其唯一 Client 的
// await client.auth.restore(snapshot) 重新探测，之后直接调用 library/plan。
```
