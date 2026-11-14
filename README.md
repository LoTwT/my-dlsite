# my-dlsite

my-dlsite 项目的 pnpm workspace monorepo，私有根包名为 `my-dlsite-monorepo`。

`packages/core`（`@my-dlsite/core`）已实现 CORE-01（现有 Play 会话 → 作品库 → 文件清单 → 播放地址）和 CORE-02 的已观察单 ZIP 原版下载计划（`client.acquisition.plan`）。下载器、文件传输、解压和序列号流程仍由调用方负责，不在 core 内实现。

LOGIN-CLI-01 正在新增 `packages/browser-auth` 和 `packages/cli`。当前已有登录事务、Chromium 转换和安全会话文件模块；登录观察器与 CLI 可执行入口尚未接入，完整交互仍待验收，见[实施边界](./docs/specs/browser-login-cli.md)。

## 技术栈

- [pnpm](https://pnpm.io) - workspace 与包管理
- [oxlint](https://oxc.rs/docs/guide/usage/linter) - 类型感知 linter
- [oxfmt](https://oxc.rs/docs/guide/usage/formatter) - 格式化
- [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) - pre-commit 检查
- [taze](https://github.com/antfu-collective/taze) - 依赖升级

构建与测试工具随子包创建时配置，根目录不预置未使用的构建产物或测试框架。

## 环境要求

- Node.js 26 或更高版本
- pnpm 12.18.0（由 `package.json` 的 `packageManager` 固定）

## 开始

```sh
pnpm install
```

安装依赖并通过 `prepare` 安装 pre-commit 钩子。

## 目录

```text
.
├── docs/               # 文档，入口见 docs/index.md
├── packages/core/      # core 业务实现与测试
├── .vscode/            # 编辑器配置
├── AGENTS.md           # Agent 工作指南
├── package.json        # 私有根包与工作区命令
└── pnpm-workspace.yaml # workspace 范围与 pnpm 设置
```

根目录没有 `src/` 或 `tests/`；业务源码和测试在对应子包内。

## 命令

| 命令                                      | 说明                              |
| ----------------------------------------- | --------------------------------- |
| `pnpm lint`                               | oxlint 检查根目录与子包           |
| `pnpm format`                             | oxfmt 格式化                      |
| `pnpm format:check`                       | 只检查格式，不修改文件            |
| `pnpm deps`                               | 用 taze 递归检查并升级依赖        |
| `pnpm run prepare`                        | 安装或更新 pre-commit 钩子        |
| `pnpm --filter @my-dlsite/core typecheck` | core 类型检查                     |
| `pnpm --filter @my-dlsite/core test`      | core Vitest 测试                  |
| `pnpm --filter @my-dlsite/core build`     | 编译 core 到 `packages/core/dist` |
| `pnpm --filter @my-dlsite/core check`     | core typecheck、test、build       |

构建、测试与类型检查的工具和配置放在子包；根目录不提供 TypeScript 编译器、Node 类型依赖或共享 TS 配置。

## 检查范围

`.gitignore` 保留 HAR 忽略规则；原始 HAR 含 Cookie、签名凭据，禁止提交或供构建读取。

## 文档

从 [docs/index.md](./docs/index.md) 开始；开发环境、命令、检查范围和包边界见 [docs/development.md](./docs/development.md)。

core 的实现状态、接口、验证依据与下载计划边界见 [core 包设计](./docs/specs/core.md)。

## License

[MIT](./LICENSE)。版权归属沿用模板来源，见 `LICENSE`。
