# core 包设计与实现状态

状态：CORE-01 已在 `packages/core` 实现（2026-11-12）：会话恢复、作品库、文件清单与播放地址；作品库完整性验收项 R1 仍未闭合，`count.user` 与全量 sales 的关系需要另行验证。CORE-02 的单 ZIP 下载计划尚未实现，须在 CORE-01 合并后从最新 main 开始；CORE-01 不暴露 `acquisition` 方法、占位模块或下载计划能力。

本稿沿用此前确认的七个模块，并合入脱敏 HAR 结论与 2026-11-12 的一次受限真实观察。公开接口已冻结为 `packages/core` 的 TypeScript 声明；尚未实现的能力只记录在后续能力表中，不以假接口出现。

阅读顺序：先看范围、验证依据和模块划分；接口与运行流程用于调用方式；后续能力与验收要求列在文档后半部分。实际命令与包配置见[开发指南](../development.md)。

## 范围与运行环境

core 是供 CLI、播放器插件和其他应用调用的 DLsite 已购音声核心库，放在 `packages/core`（包名 `@my-dlsite/core`，私有、不发布）。CORE-01 负责会话管理、查询作品、解释文件清单和生成播放地址；原版下载计划属于 CORE-02，尚未实现。

播放器、文件传输、续传、解压和数据持久化由调用方负责。core 不处理图片解扰、音频解密或 DRM 绕过，也不承载界面和 CLI 命令。

包使用 ESM、TypeScript 严格模式和 `noUncheckedIndexedAccess`，运行时兼容目标为 Node.js `>=24.11`，并已在 Node.js `24.11.1` 上验证构建产物入口。根目录的开发环境要求见[开发指南](../development.md)；core 的运行时下限不因此抬高。

原生 `fetch`、`AbortSignal` 负责 HTTP、取消和超时；Cookie Jar 使用 `tough-cookie`，外部结构校验使用 Valibot。实际声明在子包：`tough-cookie@^6.1.0`、`valibot@^1.5.0`；开发工具为 `typescript@^6.0.3`、`vitest@^5.1.0`、`@types/node@24.11.2`。根目录不增加 TypeScript 编译器、Node 类型依赖或共享 TS 配置。Node.js 24.11 已提供所需的 `fetch`、`AbortSignal.any` 和 `AbortSignal.timeout`。[Node.js 文档](https://nodejs.org/download/release/v24.11.0/docs/api/globals.html)

## 验证依据

下表来自此前的脱敏 HAR 报告及 2026-11-12 的一次受限真实观察。除该次观察外没有重新请求 DLsite；这些是已观察到的样本行为，不是 DLsite 的公开接口保证。

| 能力         | 已观察到的事实                                                                                                                                                                                                           | 对本设计的约束                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 会话与批次   | 单一 host-only `play_session` 导入隔离 Jar 后，v4 `content/sales` 省略 `last` 返回 200 JSON；works 使用 `application/json` 对象 `{worknos:[...]}`，10 条与 2 条请求的每个 workId 都各返回一次；Set-Cookie 只留在候选内存 | 支持现有 Play 会话导入；使用 10 条 works 批次；不从该观察推断作品库完整性或批次上限 |
| 作品签名     | v4 `download/sign/url` 返回 `Policy`、`Signature`、`Key-Pair-Id`；签名参数单独用于音频和 `ziptree.json` 都成功                                                                                                           | 统一采用 URL 签名，CDN 请求不附带登录 Cookie                                        |
| 优化音频     | 样本为 MP3，响应支持 Range，直接由内容域名返回；定向请求读到了 MP3 文件头                                                                                                                                                | 首先支持这条渐进式音频路径，不推广为所有音轨都未加密                                |
| 文件清单     | 顶层包含 `version`、`workno`、`revision`、`hash`、`updated_at`、`tree`、`playfile`；树节点通过 `hashname` 关联文件信息                                                                                                   | 按实际结构解析，不套用第三方旧版的 `files.optimized` 路径                           |
| 作品库       | v4 `content/count`、`content/sales`、`content/works` 已观察到；`works` 是 POST，请求体包含 `worknos`；音声类型为 `SOU`                                                                                                   | 使用 v4；读取作品元数据与购买记录分开处理                                           |
| 不完整元数据 | `sales` 中有部分作品没有对应的 `works` 元数据                                                                                                                                                                            | 不静默丢弃这些购买记录，也不猜测其缺失原因                                          |
| 原版下载     | 已观察到 `play` → `www` → `download` 的单 ZIP 跳转；`www` 响应会更新 Cookie；最终请求携带 Cookie                                                                                                                         | 下载计划与播放签名采用不同的凭据路径；留给 CORE-02                                  |

2026-11-12 的观察只证明现有 Play 态可用于该次 v4 调用，以及 10 条和 2 条 works 请求被完整处理；**不证明省略 `last` 的 sales 为完整作品库**，也不证明批次上限、增量 `last`、主站 Cookie 登录、密码登录或其他媒体。工具退出码 4 / `PASS_CANDIDATE` 只表示候选输入标记下的完整匹配，不替代上述边界。

库完整性目前采用保守门槛：`library.list` 以 v4 `content/count` 的 `user` 与本次 `content/sales` 数组长度相等作为完整性条件；不一致时抛出 `IncompleteLibrary`，不返回部分快照。`content/count` 也以省略 `last` 的全量形态请求；该请求形态和 `count.user` 是否精确等于全量 sales 记录数均未独立实测。两者相等不能被当作“已证明全量”的证据：它只能拒绝明显不一致的响应；若语义不同，仍可能误接受或在不一致时失败。该验收项保持未闭合，需另行验证后再决定是否调整。

业务请求涉及 `play.dlsite.com`、`www.dlsite.com`；签名内容请求涉及 `play.dl.dlsite.com`；已观察到的原版文件目标为 `download.dlsite.com`。每条流程只接受预期的 HTTPS 服务目标，并限制到该流程的已知 API path；CDN 只能访问当前 ResourceContext 的 grant 基址前缀。已知登录跳转在发送后续 Cookie 前分类；不把任意同 host 路径当作可携带凭据的目标。认证错误按请求上下文分类：只有 Play 会话请求的 401/登录跳转会使 Play 会话失效；签名 CDN 或匿名请求的 401 保留为对应 HTTP 错误，不影响 Play 登录态。

## 模块与依赖

七个模块属于同一个 core 包，不拆成七个 workspace 子包。`model`、`errors` 和 `client` 分别放共享契约、错误定义与组装入口，不算新的业务模块。

| 模块          | 职责                                                                        | 边界                                                                |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `transport`   | HTTP、手动重定向、按 host 调度、超时、取消、脱敏；按请求上下文读写 Cookie   | 不持有会话，不根据通用状态码决定业务含义                            |
| `auth`        | 持有和替换 Session；导入 Cookie、导出与恢复快照、初始化 Play 会话、校验会话 | 不管理作品签名，不自动重新登录                                      |
| `access`      | 申请作品 Grant、解析有效期、缓存、刷新、合并同作品的并发申请                | 不解释文件内容；签名参数不进入 Cookie Jar                           |
| `library`     | 获取购买记录和作品元数据；音声筛选、本地化、报告缺失或异常条目              | 不保存作品库，不把未返回的元数据解释为作品已删除                    |
| `manifest`    | 获取并解析 `ziptree`；生成文件树；纯函数识别音轨、字幕和版本候选            | 不替调用方选择最终版本，不生成长期有效的播放地址                    |
| `playback`    | 将已选音轨和当前 Grant 解析为 `MediaSource`                                 | 不播放、不下载，默认不探测音频内容                                  |
| `acquisition` | CORE-02 计划：解析原版下载入口与跳转，生成 `AcquisitionPlan`                | 当前不实现、不暴露；不传输和解压文件，不复用播放 Grant 充当下载认证 |

CORE-01 实现 `transport`、`auth`、`access`、`library`、`manifest`、`playback`；`acquisition` 只是 CORE-02 的职责方向，不在当前 Client 或包入口出现。

```text
调用方
  |
createClient（组装共享上下文）
  |
  +-- auth ----------- transport
  +-- library -------- transport
  +-- manifest ------- access ------- transport
  +-- playback ------- access
  +-- acquisition ---- transport        （CORE-02，当前未实现）

共享契约：model / errors
会话状态：由 auth 持有；其他模块通过共享 SessionContext 使用
音轨输入：playback 使用 manifest 的输出值，不反向调用 manifest
```

`transport` 只依赖共享契约中的 CookieStore，不导入 `auth`。业务模块使用 SessionContext，不互相调用 `auth` 的内部函数。`manifest` 内部再分网络适配、结构解析和纯推断三部分，后两部分可以脱离网络测试。

## 公开入口与数据契约

实现只提供一个包入口，通过 `createClient` 组装能力。`transport` 和 `access` 保持内部模块，不因为存在模块目录就暴露同名公开命名空间。公开类型与错误从包入口导出，不提供深层导入路径。

以下为已冻结的公开入口；实际 TypeScript 声明以 `packages/core/src/index.ts` 为准：

| 入口                        | 输入                                               | 输出与行为                                                                                        |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `createClient`              | 可选 `language`、`userAgent`、供测试替换的 `fetch` | 独立 Client；可以无会话创建，再通过 auth 建立会话                                                 |
| `client.auth.importCookies` | 带完整作用域的 Cookie 条目、可选取消信号           | 候选 Jar 内校验现有 Play 登录态；成功后原子替换当前会话，不承诺只凭主站 Cookie 自动换得 Play 会话 |
| `client.auth.restore`       | `SessionSnapshot`、可选取消信号                    | 恢复到独立候选 Jar 并重新校验；成功后替换当前会话，不相信快照里的旧有效状态                       |
| `client.auth.export`        | 无                                                 | `Promise<SessionSnapshot>`，只含版本与 Cookie 作用域                                              |
| `client.auth.validate`      | 可选取消信号                                       | 校验当前会话；明确失效时抛出 `AuthRequired`                                                       |
| `client.library.list`       | 语言、作品类型筛选、可选取消信号                   | `LibrarySnapshot`；默认筛选 `SOU`，完整性门槛不满足时抛出 `IncompleteLibrary`                     |
| `client.manifest.get`       | workId、可选 `refreshAccess`、可选取消信号         | `WorkManifest`；需要更新资源上下文时可同时重新申请 Grant                                          |
| `client.playback.resolve`   | 已选 Track、可选 `refreshAccess`、可选取消信号     | `MediaSource`；`refreshAccess` 用于调用方发现地址失效后显式换签名                                 |
| `client.acquisition.plan`   | CORE-02 计划能力，当前不存在于公开 Client          | CORE-01 不暴露该方法、占位模块或下载计划类型                                                      |

所有会发起网络操作的方法接受 `AbortSignal`；缓存命中、返回已有清单或启动共享请求前也要检查取消，预先取消的 signal 不能被当作成功。Client 之间不共享账号状态、作品缓存或 Grant；调用方通常复用一个 Client 完成同一账号的操作。

| 数据              | 保留内容                                                                 | 生命周期                                                                 |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `Session`         | 固定绝对过期时间的 CookieStore、会话状态及会话代次                       | 内部状态，由 auth 管理；无会话、未知、有效和失效需要区分                 |
| `SessionSnapshot` | 格式版本、保留 Cookie 作用域及 Jar 实际绝对过期时间                      | 属于登录凭据；Max-Age 不因导出重新计时；不含 Grant、作品清单或密码       |
| `Grant`           | workId、baseUrl、原样签名参数、expiresAt                                 | 内部短期能力；按当前会话代次与 workId 隔离                               |
| `LibrarySnapshot` | 匹配筛选的作品、元数据缺失的购买记录、已知非匹配类型的购买记录、逐条诊断 | 一次完整查询的结果；不声称含有可复用的增量游标；完整性门槛见上文         |
| `ResourceContext` | workId、无签名的资源基址、清单 revision 与 hash                          | 表示一次清单读取所对应的资源版本；不包含 Grant 或签名参数                |
| `WorkManifest`    | 资源上下文、完整文件树、未知字段、原始媒体对象、音轨、字幕和版本候选     | 不保存签名 URL；调用方可以按原树自行选择                                 |
| `PlayfileEntry`   | 固定媒体字段、typed optimized、原始 `media` 对象、未知顶层字段           | `media` 保留 audio/text/image/pdf 的嵌套未知事实；未知媒体形态留在 extra |
| `Track`           | 资源上下文、hashname、原路径、已解析的优化资源信息                       | 与产生它的清单版本绑定；原版格式与优化版格式分别表达                     |
| `MediaSource`     | url、headers、expiresAt，以及有来源的 MIME、大小等可选信息               | 当前路径的 headers 为空；由调用方交给播放器并在过期时重新解析            |
| `AcquisitionPlan` | CORE-02 计划类型，当前未声明                                             | 含 Cookie 时属于凭据；有效期未知就不填，不伪造一个 TTL                   |

播放地址和下载地址是临时能力，调用方不应将其当作作品或音轨的永久标识。CORE-02 的 `AcquisitionPlan` headers 只绑定给定目标，下载器不能将它们无条件转发到其他域名。

## 主要运行流程

### 建立与替换会话

1. 调用方导入带作用域的浏览器 Cookie，或恢复 core 导出的快照；auth 先将数据放入独立的候选 Jar。
2. 在候选会话内校验现有 Play 登录态。校验通过就使用该会话，不强制重走主站登录。Play 登录入口与 `/api/authorize` 是此前观察或参考实现中的初始化路径；仅凭主站 Cookie 换得 Play 会话的流程仍需独立验证，首版不承诺自动完成。
3. transport 在每一跳、取得 host 发送资格后按当前 Jar 和目标 URL 选取 Cookie，并把响应中的更新写回发起该操作的 Jar。收到 Set-Cookie 时，以接收时刻把数值 Max-Age 换算为绝对 `expires`，不再把相对期限留给后续读取；Max-Age 优先于 Expires。带作用域的导入和快照恢复也只接受绝对过期或真正无期限的 session Cookie。删除/已过期标记不进入导出，不能经过恢复复活。普通请求、导出和恢复都只读绝对期限，不能续期；导出只在会话代次未变时返回。
4. 当前会话明确认证失败后，依赖其登录态的操作直接返回 `AuthRequired`。候选会话的失败只影响候选，导入和恢复路径仍可执行。
5. 会话验证通过后再原子替换当前 Session，提升会话代次并清除旧 Grant 与作品缓存；替换失败或被取消时保留原会话。导入和恢复在同一 Client 内按调用顺序串行执行，候选会话使用独立 Jar，不污染当前会话。

library、manifest、playback、acquisition 的每次业务操作，以及对当前会话的 validate，都在开始时固定一个 SessionContext，并把该代次的取消信号与调用方信号一起传给网络请求。一个 `library.list` 中的 count、sales 和所有 works 批次必须始终使用同一会话；不能在每个请求开始时重新读取 Client 的最新会话。会话替换会取消旧代次的整次操作，返回 `SessionChanged`，不继续发送后续批次、恢复或签名请求，也不返回旧账号的部分结果。取消网络请求之外，在更新 Cookie、缓存、失效状态和返回业务结果前仍需校验代次，阻止迟到的响应或错误影响新会话；旧代次迟到的 4xx/5xx 也统一映射为 `SessionChanged`。候选会话的校验使用自己的上下文，不借用当前会话。认证失败按请求上下文分类：Play 会话请求的 401/登录跳转返回 `AuthRequired` 并可使当前会话失效；CDN 或匿名请求的 401 保留为 `HttpError`，不得据此使 Play 会话失效。

会话失效与 CDN 签名失效分别处理。已经交给播放器的签名地址不受 core 主动撤销，也不保证会因清除本地会话而立即失效。

### 读取作品库

1. 请求 v4 count 和 sales；若 `count.user` 与 sales 数组长度不一致，抛出 `IncompleteLibrary`。取得购买记录后按 10 条分批请求 v4 works，尾批自然短于 10 条。
2. 保留 workId 和购买时间，将返回的元数据按 workId 关联，不能依赖两个响应数组的位置相同。
3. 默认只把已确认 `work_type: SOU` 的正常条目放进作品列表。已知其他类型放在 `otherPurchases`；类型或元数据缺失的购买记录单独返回，不当作非音声而丢弃。
4. 元数据语言优先用调用方选择的语言，回退到 `ja_JP`、`en_US` 或实际存在的名称，同时保留原始多语言名称。没有名称时保留 workId 并报告问题。
5. 单条数据异常返回对应诊断，其余有效条目仍可使用；购买记录整体结构错误、认证失败、count/sales 不一致或任一批次请求失败，则整次 list 失败，不能把半份结果称为完整快照。

CORE-01 只提供完整查询，不使用尚未确认语义的 `last` 生成水位。固定使用 10 条 works 批次；不把 count 中的 `page_limit` 或旧版客户端的常数当成批量上限。`count.user` 与全量 sales 记录数相等是当前的保守门槛，其 v4 语义尚未独立验证；相等不代表已验证完整，只表示未触发这一门槛，R1 仍为未闭合验收项。

### 读取清单与生成播放地址

1. manifest 向 access 取得本作品 Grant；CDN 请求只使用签名参数，不从 Session 附加 Cookie。
2. 读取签名后的 `ziptree.json`，校验顶层、节点结构及 workno 与请求的一致性，用 `hashname` 关联 `playfile`，再从媒体类型对应的字段读取 optimized 信息。将此次读取的资源基址、revision 与 hash 作为资源上下文，附在清单和由它产生的 Track 上。
3. 解析层保留完整树及未知文件，并保留 playfile 中原始 `media` 对象（audio/text/image/pdf，含嵌套未知字段）；未支持的媒体形态仍由 `extra` 保留。即使缺少 optimized 或类型不支持，也不能从原树、映射或媒体事实中丢弃。缺失 playfile 映射或 optimized 的节点保留为不可播放项，并返回诊断。
4. 推断层根据目录与文件信息给出音轨、字幕和版本候选及其依据；不能确定的关系保持未知。默认保持原树顺序，不自动认定某个 SE 版本更好。
5. 调用方选 Track；playback 先检查它与当前会话代次中最近一次成功读取的清单是否存在已知版本冲突。没有当前代次的已知清单、基址不一致或已知 revision、hash 不一致时返回 `StaleManifest`，不把旧资源名拼接到新基址。等待 Grant（包括刷新）返回后，再对同一最近清单检查一次，防止等待期间新清单已成功写入；匹配后才生成 MediaSource。资源名按路径数据编码，不能改变 Grant 的协议、host 或覆盖签名参数。
6. 没有可用的优化音频，或资源明确带有加密标记时，返回 `UnsupportedDelivery`，不尝试回退到解密或把原版下载链接当成播放链接。

Grant 的有效期从响应或签名 Policy 的绝对时间读取；有多个限制时取适用于目标资源的保守有效期，不把历史样本的约 12 小时写死。Policy 中的 `DateLessThan` 定义过期时间；CloudFront 的 URL 安全编码（`+→-`、`=→_`、`/→~`）只在解码副本上逆转换，原始签名参数保持不变，参见 [CloudFront 自定义签名策略](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-custom-policy.html)。无法解释过期约束的签名响应按 `UnexpectedResponse` 处理。

manifest 只在当前会话内记录每个作品最近一次成功读取的资源上下文，供 playback 识别已知的旧 Track。`StaleManifest` 的恢复方式是由调用方重新获取清单，需要时使用 `manifest.get` 的 `refreshAccess` 换取新 Grant，再按新清单重新选择音轨；不能仅靠旧 Track 重试签名或按文件名悄悄替换音轨。

上述检查不额外读取音频，也不为了校验 Track 而自动重新请求清单。如果服务端在相同基址下更新内容，而本 Client 尚未读到新清单，就无法提前发现版本变化。调用方遇到资源不存在等播放错误时，应重新获取清单并选择音轨，不能把 resolve 成功当作文件仍存在的验证。

建议缓存 Grant 在剩余有效期不超过 60 秒时提前刷新。这是缓存策略，不是签名有效性的门槛：本次新取得的 Grant 只要仍在实际有效窗口内就可以使用，即使只剩 30 秒。一次操作不能因为新 Grant 仍落在提前刷新窗口内而再次主动申请；签名已真正过期时才返回 `GrantExpired`。同一会话代次、同一作品的并发申请合并，一个调用方取消等待不取消其他调用方的等待；已在等待前取消的调用方不会启动共享申请。

获取或刷新 Grant 时发生的 `Aborted`、`SessionChanged`、`AuthRequired`、`RateLimited`、`TransportError`、`HttpError` 和 `UnexpectedResponse` 保持原分类，不统一包装为 `GrantExpired`。提前刷新失败直接返回对应错误，即使旧 Grant 尚未过期。

core 自己读取 CDN 清单遇到 403 时，可以废弃该作品 Grant，重新申请并重试一次；这次受限的 403 恢复不因刷新阈值而额外循环，仍失败就保留对应错误。播放器的响应发生在 core 之外，调用方需要通过 `refreshAccess` 显式换签名；若新 Grant 与旧 Track 不匹配，仍返回 `StaleManifest`。core 不能声称自动感知播放器的 403。

### 生成原版下载计划

1. acquisition 使用登录会话请求原版下载入口，手动解析 play 到 www 的跳转，接收并保存 Cookie 更新。
2. 当 Location 已指向预期下载域名中可识别的文件 URL 时，停止跟随，按最终目标计算 Cookie 请求头，直接生成计划。
3. 文件名优先从已确认的 `/file/{filename}/` 路径提取；大小和有效期没有可靠来源时省略。仅凭 URL 和 Cookie 的存在，不声称已经验证文件可下载。
4. 调用方马上执行下载；认证或地址失效后重新生成计划，而不是永久保存 URL 和 Cookie。

这是对旧稿“跟到最终文件响应头再中止”的调整建议：已能从 Location 确定目标时，不额外 GET 或 HEAD 最终文件，避免为解析地址消耗可能只能使用一次的 URL。若下载入口直接返回文件响应而不是重定向，读取必要响应头后立即取消 body；这不保证网络接收了零字节，但不能读取或保存整个文件。

遇到未验证的分卷 HTML、序列号页面或新的交付形式，返回 `UnsupportedDelivery`。不输出尚未核实的文件顺序、序列号或凭据。

## 请求、状态与错误约束

transport 的实现策略为：Client 内按 host 串行，令牌桶容量 1、补充速率每秒 1 个请求；单个 HTTP 事务的排队、重定向、退避和读取共用 30 秒期限，最多跟随 10 次重定向。排队项取消时只让它自己的调用及时返回，队列尾仍等待前序完成后才允许后继获得发送资格；Cookie 在取得发送资格后按当前 Jar 计算，避免使用前序响应已轮换的旧值。Set-Cookie 的 Max-Age 在接收时换算成绝对过期，删除标记立即移除；普通请求和读取不会延长 Cookie。不添加后台轮询。

仅对 GET 的 429、503 按 `Retry-After` 做一次重试；缺失时等待 1 秒，等待超过剩余期限就停止。POST works 虽然用于读取，首版也不自动重放；其他网络错误不自动重试。401、403 和响应校验错误不进入 transport 的通用重试。

重定向每一跳都重新判断目标与 Cookie 作用域，不原样转发上一跳的 Cookie 或 Authorization；请求方法和请求体按重定向状态处理，无法安全处理的情况直接报错。签名内容请求显式关闭登录凭据。具体重定向语义参考 [Fetch Standard](https://fetch.spec.whatwg.org/#http-redirect-fetch)。

| 错误                       | 触发条件                                                                                  | 状态影响                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `TransportError`           | 连接失败、DNS 失败、事务超时                                                              | 不改变登录状态，超时与主动取消分别记录                                   |
| `Aborted`                  | 调用方取消                                                                                | 停止本次操作，不标记会话失效                                             |
| `SessionChanged`           | 操作期间当前会话被替换                                                                    | 终止旧代次的整次操作，不混用新会话、不返回部分结果                       |
| `StaleManifest`            | Track 的资源基址与当前 Grant 不一致、与最近已读取清单的版本不一致，或当前代次没有已知清单 | 调用方重新获取清单并选择音轨，不自动替换 Track                           |
| `RateLimited`              | 429 经允许的一次退避后仍失败，或无法在期限内等待                                          | 带可公开的重试时间，不改变登录状态                                       |
| `HttpError`                | 未映射的非成功 HTTP 响应，包括重试耗尽的 503 和匿名/CDN 的 401                            | 保留状态码和逻辑接口名，不猜测认证或购买状态；CDN 401 不使 Play 会话失效 |
| `UnexpectedResponse`       | 整体响应结构或关键协议约束不符合已支持的形态                                              | 报告接口与脱敏诊断，不附原始响应正文                                     |
| `AuthRequired`             | 仅 Play 会话请求的明确认证失败，或 Play 会话请求跳到已知登录入口                          | 只影响发起操作的会话；候选会话校验失败不使当前会话失效                   |
| `NotEntitled` / `NotFound` | 作品接口明确表示无权限或作品不存在                                                        | 不根据 CDN 403 或元数据缺失推断                                          |
| `GrantExpired`             | 签名响应已成功解析，但取得的 Grant 在使用前已过期                                         | 不包裹获取签名时的取消、认证、限流、网络或响应校验错误                   |
| `UnsupportedDelivery`      | 无可用优化音频、明确加密标记或未支持的下载交付形态                                        | 不转入其他交付流程掩盖失败                                               |
| `IncompleteLibrary`        | `count.user` 与 sales 数组长度不一致，无法证明作品库完整                                  | 整次 list 失败，不返回部分快照；不猜测差异原因                           |
| `InvalidInput`             | Cookie、快照或配置输入不符合公开契约                                                      | 不发起网络请求，不回显输入值                                             |

HTTP 状态与响应结构分别校验：HTML 登录页不能因返回 200 就当作有效 JSON，CDN 的 403 也不等同于账号登录失效。单条作品或文件解析问题通过结果中的诊断表达，不能吞掉整次请求失败。

User-Agent 默认如实标识本工具；日志默认不输出。启用日志后只输出逻辑接口、host、状态码与脱敏诊断，不输出 Cookie、Set-Cookie、签名参数、完整签名 URL、会话快照或原版下载计划中的 headers。

## 交付顺序、已实现范围与后续能力

交付顺序：CORE-01 交付“恢复会话 → 读取作品库 → 选择音轨 → 返回播放地址”；CORE-02 在 CORE-01 合并后从最新 main 开始，独立交付已观察到的单 ZIP 下载计划。下载计划不成为播放路径的依赖，CORE-01 也不暴露其假接口。

CORE-01 的两项实施前证据已由 2026-11-12 的受限真实观察有限满足：

- **会话恢复路径**：单一 host-only `play_session` 导入隔离候选 Jar 后，v4 `content/sales` 返回 200 JSON；不依赖主站重新登录。只证明该输入可用于该次调用，不证明主站 Cookie 自动换取 Play 会话。
- **works 批次**：使用 `application/json` 对象 `{worknos:[...]}` 的 10 条主批与 2 条短批均完整返回请求的每个 workId。实现固定 10 条分批并自然包含尾批；不把 `page_limit` 或第三方旧常数当作上限，也不证明更大批次可用。

`library.list` 的完整性仍受未验证协议事实限制：`count.user` 是否精确等于全量 sales 记录数尚未独立验证。当前以两者相等作为保守门槛，不一致时抛出 `IncompleteLibrary`；不返回半份结果，也不声称省略 `last` 的 sales 一定完整。

CORE-01 不定义以下能力的假接口或假数据：

| 能力                       | 尚缺什么                                             | 进入实现前的条件                                                  |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| 单 ZIP 下载计划（CORE-02） | 下载入口、分卷/序列号、凭据最小集合与寿命            | CORE-01 合并后从最新 main 开始，补充专项验证与验收                |
| 账号密码登录与 OTP         | 登录页、挑战、两步验证和 reCAPTCHA 的实际流程        | 主控先组织该流程的专项验证与设计，再补充 auth 的登录结果契约      |
| 增量同步                   | v4 `last` 的单位、边界、翻页及新增或更新语义         | 主控确认游标不会漏数据后，再提供 sync 与版本化游标                |
| 分卷与序列号               | 真实页面、分卷顺序、序列号来源和状态转换             | acquisition 有样本和验收用例后，再扩展计划的交付种类              |
| 原版下载凭据最小集合与寿命 | 哪些 Cookie 必需、是否与 IP 或其他条件绑定、何时失效 | 首版按目标作用域计算 Cookie，有效期保持未知；优化前由主控安排验证 |
| 其他媒体交付格式           | HLS、不同音频格式或不同加密标记的样本                | 逐种明确契约和能力边界，不从 MP3 样本推断支持                     |

本方案最依赖的前提是网页接口及已观察到的音频交付形态仍可用。接口变化时，网络适配或结构校验应明确失败；保留原始文件事实和隔离的签名适配，使修正局限于相关模块，不能用猜测字段继续返回错误地址。

## 验收要求

实现时用合成或充分脱敏的固定样例，替换 fetch 并控制时钟；常规测试不读取原始 HAR，不访问真实账号。离线回放只能证明已知响应下的行为，不能证明网页接口仍然可用。真实服务验证需另行明确授权与范围。

| 范围       | 必须覆盖的行为                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话恢复   | 正常导入和恢复、过期 Cookie、每跳 Set-Cookie 更新、Max-Age 绝对期限、删除标记不复活、失效后可重新恢复、有效 Play 会话无需主站初始化                                                               |
| 会话替换   | 候选 Jar 与当前 Jar 隔离、恢复失败或取消保留原会话、替换串行执行、多批查询中切换账号终止旧操作、迟到响应不能修改新会话或返回旧结果                                                                |
| HTTP       | Domain/Path/Secure 匹配、签名请求不带登录 Cookie、同 host 路径限制、跳转到未知目标、重定向循环、排队时取消不提前释放尾链、排队后按当前 Jar 选 Cookie、超时、429/503 的退避边界、POST 不被自动重放 |
| 作品库     | 空库、多批次、响应顺序不同、元数据缺失、单条异常、多语言回退、某批请求失败或 count/sales 不一致不能产出完整快照                                                                                   |
| 清单       | 实际 tree/playfile 关联、未知字段、缺少映射、没有 optimized、加密标记、多格式与多版本、字幕歧义、不改变原树事实                                                                                   |
| 签名缓存   | 到期前后、60 秒刷新阈值与实际有效期分开、30 秒有效的新 Grant 可用、不因阈值循环申请、同作品并发合并、不同作品或会话隔离、单个等待者取消、预取消不启动共享申请                                     |
| 签名错误   | CDN 403 只刷新重试一次，刷新时的取消、会话切换、认证、限流、网络和响应校验失败保留原分类                                                                                                          |
| 播放与版本 | 默认不探测音频正文、旧 Track 与新基址或已知新版本不匹配时返回 StaleManifest、等待 Grant 后再次核对最近清单、重新获取清单后使用新 Track、未观察到同基址更新时不声称文件仍存在                      |
| 下载计划   | CORE-02 计划能力；每跳 Cookie 更新、在最终 Location 停止且不请求文件、URL 文件名解析、直接文件响应及时取消、未知有效期不造值、未知交付方式明确失败                                                |
| 凭据       | 在 URL、请求头、响应头及错误正文中埋入假敏感值，确认日志和错误摘要不泄漏；明确导出的快照与下载计划仍属于凭据                                                                                      |

CORE-01 的实际命令：

```sh
pnpm --filter @my-dlsite/core typecheck
pnpm --filter @my-dlsite/core test
pnpm --filter @my-dlsite/core build
pnpm lint
pnpm format:check
```

测试使用 fake fetch、可控时钟和合成结构，不读取原始 HAR、`LIVE-RESULT` 或用户凭据。构建产物入口已在 Node.js `24.11.1` 上验证；根目录仍不提供聚合 build/test/typecheck 命令。CORE-02 的测试和最低版本验证随该子包实际命令另行确定。

## 参考实现的取舍

- [dlsite-async 的 PlayAPI](https://github.com/bhrevol/dlsite-async/blob/master/src/dlsite_async/play/api.py) 将会话初始化、作品令牌和文件清单分开处理，可借鉴这些边界。其源码仍包含 v3 接口，不能作为 v4 请求形态的依据，也不沿用其中下载到文件的行为。
- [DLsite-Play-Downloader 的旧版源码](https://github.com/cpuopt/DLsite-Play-Downloader/blob/vite-monkey/DLsite-Play-Downloader-old.user.js) 展示了树节点通过 hashname 关联 playfile 的方式。它面向浏览器漫画下载，不用于证明音频协议；本设计不引入其图片处理流程。

DLsite 的实际字段形态以上面的验证记录为依据，通用 HTTP 与签名约束采用文中链接的上游文档。后续验证得到新事实时，先更新本稿相应契约，再安排实现。
