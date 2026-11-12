# 开发指南

## 环境

- Node.js 26 及以上（`package.json` 的 `engines`）。
- pnpm 版本由 `packageManager` 固定为 12.18.0。`pnpm install` 安装依赖，并通过 `prepare` 安装 pre-commit 钩子。
- 工作区设置集中在 `pnpm-workspace.yaml`，包括 `trustPolicy: no-downgrade` 和 `allowBuilds`；不修改全局 pnpm 配置，也不为安装绕过这些设置。

## 当前状态与边界

- `packages/core` 已存在，包名 `@my-dlsite/core`，私有、不发布；CORE-01 已实现会话恢复、作品库、文件清单和播放地址。
- CORE-02 已实现已观察的单 ZIP 原版下载计划：`client.acquisition.plan(workId, { signal? })` 返回 `AcquisitionPlan`。它只生成下载地址和按最终 URL 作用域计算的请求头，不下载、不写文件、不解压，也不支持分卷、序列号或其他交付方式。
- 根包 `my-dlsite-monorepo` 仍为私有包，不发布；不维护 `exports`、`files`、`imports` 或发布产物，也没有根级 `src/`、`tests/`。
- 根目录不承载播放器、下载或其他业务源码；后续子包继续放在 `packages/*`。

## 命令

| 命令                                      | 作用                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `pnpm install`                            | 按锁文件安装依赖；`prepare` 安装 simple-git-hooks 的 pre-commit 钩子 |
| `pnpm lint`                               | oxlint，包含类型感知规则；检查根目录与子包                           |
| `pnpm format`                             | oxfmt 格式化                                                         |
| `pnpm format:check`                       | 检查格式，不修改文件                                                 |
| `pnpm deps`                               | taze 递归检查并升级依赖                                              |
| `pnpm run prepare`                        | 安装或更新 simple-git-hooks 的 pre-commit 钩子                       |
| `pnpm --filter @my-dlsite/core typecheck` | core 的严格 TypeScript 类型检查                                      |
| `pnpm --filter @my-dlsite/core test`      | core 的 Vitest 测试；使用 fake fetch/合成样例                        |
| `pnpm --filter @my-dlsite/core build`     | 把 core 编译到 `packages/core/dist`                                  |
| `pnpm --filter @my-dlsite/core check`     | 依次运行 typecheck、test、build                                      |

类型感知 lint 由根依赖 `oxlint-tsgolint` 提供，直接检查 `packages/core` 源码与测试。`lint` 的 `--no-error-on-unmatched-pattern` 只放过零匹配，不抑制任何实际诊断。

## 工作区与包约定

- `pnpm-workspace.yaml` 的 `packages: packages/*` 定义发现范围；新增或移除子包目录不需要修改根配置。
- 根目录只保留当前实际使用的命令；构建、测试等聚合命令在有实际需求时再添加。
- 子包自带 `package.json`，按需定义构建、测试和类型检查的工具、配置与脚本，根目录不假设子包存在 `src/` 或 `tests/`。
- `@my-dlsite/core` 使用 ESM、TypeScript 严格模式和 `noUncheckedIndexedAccess`；运行时 `engines.node` 为 `>=24.11`，已在 Node.js `24.11.0` 上验证构建产物入口与测试（CORE-01 基线另在 `24.11.1` 上验证过）。根目录的开发环境 Node 26 不抬高该下限。
- core 的运行时依赖为 `tough-cookie` 与 `valibot`；开发依赖 `typescript`、`vitest`、`@types/node` 放在子包。根目录不提供 TypeScript 编译器、Node 类型依赖或共享 TS 配置。
- 根级 `lint` 与 `format` 面向整个工作区，子包不重复配置 Oxc。确需包级覆盖时，使用 Oxc 的 `overrides` 并在子包文档中说明。
- 根包不发布。子包是否发布由各自 `package.json` 决定，不沿用根包的名称、仓库链接或版本策略；core 当前为私有包。

## 检查范围与验证

- `.gitignore` 保留 HAR 忽略规则（`*.har`、`har-report*.txt`）。原始 HAR 含 Cookie、签名凭据，不提交，也不供检查或构建读取；常规测试不运行真实 DLsite 请求。
- pre-commit 钩子对整个工作区运行 `pnpm lint` 与 `pnpm format:check`，不修改文件。修改 `simple-git-hooks` 配置后，运行 `pnpm run prepare` 更新已安装的钩子。检查失败时修复后重新提交，不跳过钩子。
- 修改根配置或文档时，至少运行 `pnpm lint` 与 `pnpm format:check`。
- core 源码改动运行 `pnpm --filter @my-dlsite/core check`（typecheck、test、build），并运行根 `pnpm lint`、`pnpm format:check`。测试使用 fake fetch、可控时钟和合成/充分脱敏结构，不读取 `LIVE-RESULT` 或用户凭据；下载计划测试不得请求最终文件 URL。
- 真实服务验证需另行明确授权与范围；离线测试不能证明线上协议仍可用。

## 编码约定

- 只使用 ESM；不添加 CommonJS 字段或产物。
- core 的测试位于 `packages/core/test`，使用 Vitest 与显式导入，不使用全局测试 API 或路径别名。根目录不预设其他子包的测试约定。

## 依赖升级

- 用 `pnpm deps`（taze）升级依赖，不要用 `pnpm up`：后者是 pnpm 内置 `update` 的别名，不会运行 taze。
- 大版本升级前先查阅 release notes 中的 breaking changes，升级后运行全部适用的检查。
- pnpm 默认拒绝发布不满 24 小时的版本（`minimumReleaseAge`）。遇到时改用更早的版本或稍后再升级；未经确认，不在 `pnpm-workspace.yaml` 中添加例外。
- 根 `devDependencies` 只放共享工具；子包专用的构建、测试依赖放进对应子包。
