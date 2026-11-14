# 浏览器登录与 CLI（LOGIN-CLI-01）

当前为实施中的合同与边界记录。事务、Chromium Cookie 转换和 CLI 会话文件模块已有合成测试；实际登录观察器、`loginWithBrowser` 公开入口及 `my-dlsite` 可执行入口尚未接入，不能据此声称完整新登录链可用。

## 包与提交边界

`@my-dlsite/browser-auth` 和 `@my-dlsite/cli` 是同仓 private ESM 包。依赖方向为 CLI → browser-auth/core、browser-auth → core；Core 不依赖调用层。

登录事务接收调用方已有的 `AuthApi`。它管理专用可见 Chromium，不读取用户 profile，也不输入密码、验证码或二步验证。内部适配器先观察捕获就绪、读取和严格转换 Cookie，再关闭浏览器，最后调用一次 `auth.importCookies`。成功导入是唯一提交点；其后不再 validate、restore、export 或执行可使登录改判失败的清理。阶段通知只提供枚举，回调异常不改变事务结果。

候选捕获、转换、关闭或 Core 候选探测失败都不替换旧 Core 会话。取消信号和默认 10 分钟总期限约束等待；迟到的浏览器打开结果会关闭。浏览器库本身不持久化、不创建第二个 Client。浏览器捕获就绪、Core sales 探测成功、library 完整读取和指定作品计划成功是四个独立结果；空库允许会话建立，www 下载授权不作为登录必需条件。

## Chromium 兼容边界

固定依赖 Playwright `1.65.0`，配套 Chromium `158.0.8127.18`、revision `1254`。浏览器必须提前准备，登录函数不静默安装。版本依据包内 `browsers.json` 与[上游对应版本](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json)。

通过 page target 的 `Target.getTargetInfo` 取得专用 context ID，再通过 browser target 的 `Storage.getCookies` 读取该 context 的所有 path。不能使用默认 context，也不能只按首页 URL 导出。实际浏览器合成测试验证专用 context 与第二个空 context 相互隔离；Cookie 由 CDP 写入，不导航 DLsite、不使用真实输入。

转换按服务域及 Core 能力筛选 play/www/download 和适用父域 Cookie，不使用名称白名单。保留值、domain、hostOnly、path、Secure、HttpOnly、SameSite 及绝对期限；空值合法。Chromium `session=true, expires=-1` 映射为 Core 不带 expires 的会话 Cookie，不把过期记录改成会话记录。

会话 Cookie 没有可用的客户端绝对到期时间；保存后允许跨 CLI 进程恢复，但每次恢复仍由 Core 探测服务端是否接受，不推断服务端寿命，也不承诺浏览器关闭后服务端继续接受。

Core 的期限精度与旧快照兼容见 [Core 会话合同](./core.md#建立与替换会话)。

分区或 opaque partition Cookie 明确拒绝。当前只转换 sourceScheme=Secure、sourcePort=443 的记录，因为 Core 支持的网络目标均为 HTTPS 默认端口；其他来源绑定无法表达时拒绝，不删除字段后继续。Cookie Priority 和 size 不影响 Core 支持的目标匹配，不进入快照。

当前 Core 仍以 name/domain/path 三字段作为键。真实合成 Chromium 已验证 host-only `www.dlsite.com` 和 domain `.www.dlsite.com` 的同名同 path 记录可以并存；转换器对此明确拒绝，既不择一，也不合并期限。尚无新登录证据证明此冲突是否出现在本次专用新登录流程；该限制仍是待解决的兼容事项，不能把旧研究投影当作产品默认规则。

## CLI 会话与安全输出

内部命令编排已覆盖 `login`、`library` 和 `plan <workId>`，每次装配只创建一个 Core Client。默认仅输出 JSON 摘要，不打印 Cookie、快照、完整计划、文件名或签名 URL；Core 的公开 `acquisition.plan` 仍返回完整计划给普通 Node 调用方。本次不提供 CLI 凭据计划导出选项。

标准快照是未经另包封装的 Core v1 snapshot：

- macOS：`~/Library/Application Support/my-dlsite/session.json`。
- Linux 路径规则：`${XDG_DATA_HOME:-~/.local/share}/my-dlsite/session.json`；XDG_DATA_HOME 必须是绝对路径，当前验收只覆盖 macOS/POSIX，不承诺 Windows 支持。

应用目录为 0700，快照为当前用户拥有、链接计数为 1 的 0600 普通文件。路径祖先及文件的符号链接均拒绝；已有不安全权限明确报错。相邻 `session.lock` 使用排他创建，覆盖恢复、操作和保存；竞争进程立即报告 busy。崩溃遗留锁不自动偷取，使用者确认没有运行进程后才能手工处理。

保存使用同目录 0600 临时文件，写入、sync、关闭完成后原子 rename 替换。替换前失败保留旧文件并清理自己的临时文件；不承诺断电后的目录项持久性，也不防御拥有同一 UID 的恶意并发修改。损坏 JSON、未知版本或 Core schema 错误明确报错，不自动清空。已提交而导出/保存失败报告“会话已建立但未保存，旧快照保留”。

候选登录失败不保存。成功恢复后，业务请求失败也可能已经轮换 Cookie；除 Core 明确 `AuthRequired` 失效外，保存当前非空会话后再报告业务错误，避免无条件 finally 写入空状态。旧会话明确失效时允许开始新登录，损坏快照仍阻止自动覆盖。

## 网络与验收限制

浏览器 `proxy` 和 Node `fetch` 是独立配置。CLI 的候选 `--browser-proxy <server>` 只影响专用浏览器；不从 Node 代理环境变量复制，不硬编码代理端口。Node 调用方使用 Core 的 `createClient({ fetch })` 注入，或在所用 Node 版本支持时显式启用运行时的 `--use-env-proxy`，不承诺浏览器与 Node 自动共用出口。CLI 代理参数不接受 userinfo；程序调用层可使用独立的代理认证字段，不能输出它们。

观察器的正向捕获判据仍等待第一方来源与主控决定，不用 URL 变化或某个 Cookie 存在替代，也不新增 www 下载资格探测。未执行新真人浏览器登录、真实库读取或真实计划验证。离线 fake fetch 与本地合成浏览器测试不能证明服务端协议仍可用；`headersSufficiency`、`fileTransfer` 保持 `NOT_TESTED`。
