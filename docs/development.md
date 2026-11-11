# 开发指南

## 环境

- Node.js 26 及以上（`package.json` 的 `engines`）。
- pnpm 版本由 `packageManager` 固定为 12.18.0。`pnpm install` 安装依赖，并通过 `prepare` 安装 pre-commit 钩子。
- 工作区设置集中在 `pnpm-workspace.yaml`，包括 `trustPolicy: no-downgrade` 和 `allowBuilds`；不修改全局 pnpm 配置，也不为安装绕过这些设置。

## 当前状态与边界

- 本仓库目前只有 monorepo 根目录，没有 `packages/*` 子包。
- 根包 `my-dlsite-monorepo` 为私有包，不发布；不维护 `exports`、`files`、`imports` 或发布产物，也没有根级 `src/`、`tests/`。
- 未来的业务代码放在 `packages/*`，七个业务模块属于 `packages/core`，当前尚未实现。根目录不承载播放器、下载或其他业务源码。

## 命令

| 命令                | 作用                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm install`      | 按锁文件安装依赖；`prepare` 安装 simple-git-hooks 的 pre-commit 钩子 |
| `pnpm lint`         | oxlint，包含类型感知规则；检查根目录与子包                           |
| `pnpm format`       | oxfmt 格式化                                                         |
| `pnpm format:check` | 检查格式，不修改文件                                                 |
| `pnpm deps`         | taze 递归检查并升级依赖                                              |
| `pnpm run prepare`  | 安装或更新 simple-git-hooks 的 pre-commit 钩子                       |

类型感知 lint 由根依赖 `oxlint-tsgolint` 提供。当前根目录没有可 lint 的 JS/TS 文件，`lint` 使用 `--no-error-on-unmatched-pattern` 让零匹配时返回成功。该参数只放过“没有可检查文件”，不抑制任何实际诊断；子包源码加入后会正常参与检查。

## 工作区与包约定

- `pnpm-workspace.yaml` 的 `packages: packages/*` 定义发现范围；新增或移除子包目录不需要修改根配置。
- 根目录只保留当前实际使用的命令；构建、测试等聚合命令在有实际需求时再添加。
- 子包自带 `package.json`，按需定义构建、测试和类型检查的工具、配置与脚本，根目录不假设子包存在 `src/` 或 `tests/`。
- 根目录不提供 TypeScript 编译器、Node 类型依赖、共享 TS 配置或类型检查命令；这些能力在子包创建时按实际需求配置。子包的运行时类型应匹配其自身的兼容范围，不由根目录的开发环境版本决定。
- 根级 `lint` 与 `format` 面向整个工作区，子包通常不需要重复配置 Oxc。确需包级覆盖时，使用 Oxc 的 `overrides` 并在子包文档中说明。
- 根包不发布。未来子包是否发布由各自 `package.json` 决定，不沿用根包的名称、仓库链接或版本策略。

## 检查范围与验证

- `.gitignore` 保留 HAR 忽略规则（`*.har`、`har-report*.txt`）。原始 HAR 含 Cookie、签名凭据，不提交，也不供检查或构建读取；不运行真实 DLsite 请求。
- pre-commit 钩子对整个工作区运行 `pnpm lint` 与 `pnpm format:check`，不修改文件。修改 `simple-git-hooks` 配置后，运行 `pnpm run prepare` 更新已安装的钩子。检查失败时修复后重新提交，不跳过钩子。
- 修改根配置或文档时，至少运行 `pnpm lint` 与 `pnpm format:check`。
- 子包源码改动由该子包的类型检查与测试覆盖；根目录不重复实现包级检查。

## 编码约定

- 只使用 ESM；不添加 CommonJS 字段或产物。
- 测试框架、测试目录与导入别名由子包在创建时确定并记录在子包文档中；根目录不预设这些约定。

## 依赖升级

- 用 `pnpm deps`（taze）升级依赖，不要用 `pnpm up`：后者是 pnpm 内置 `update` 的别名，不会运行 taze。
- 大版本升级前先查阅 release notes 中的 breaking changes，升级后运行全部适用的检查。
- pnpm 默认拒绝发布不满 24 小时的版本（`minimumReleaseAge`）。遇到时改用更早的版本或稍后再升级；未经确认，不在 `pnpm-workspace.yaml` 中添加例外。
- 根 `devDependencies` 只放共享工具；子包专用的构建、测试依赖放进对应子包。
