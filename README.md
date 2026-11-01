# dsh-claude-workspace

给 DeepSeek Harness 用的「Claude Code 工作区」插件：按 DSH 工作区管理本地或 SSH 主机上的 Claude Code 会话，通过 ACP（Agent Client Protocol）保留 Claude 自己的工具、权限选项、diff、计划与模式，并把每次权限决定写入审计。

本仓库实现的是 `dsh-claude-code-workspace-plugin-plan.md` 的 **P1（可运行核心）+ P2a（右侧栏会话控制台）+ P2b（DSH 原生会话内联）+ P3（远程设置桥）**。P4–P5 的少数细节（`@` 与 DSH 文件索引一致、npm 发布）尚未实现，详见 [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md)。

## 两种 Claude 入口

| 入口 | 走哪里 | 适合 |
|---|---|---|
| 右侧栏 `Claude Code` 控制台 | 本插件自己的 ACP 客户端（`CcwService`），本地或 SSH | 远程主机、权限 Dock、放宽规则、审计 |
| 原生会话（`新建 Claude 会话`） | `@zaimokuza/dsh-acp-adapter` fork，DSH 自己的会话 UI | 本地或 SSH、原生消息流/工具卡/Trajectory、与普通 DSH 会话并列 |

原生入口在 Web UI 右侧栏 `Claude Code` 标签里，选中工作区后点 **新建 Claude 会话**：插件会用 `acp-claude-code` provider 创建一个 DSH 会话、挂到该工作区、写入配置的权限预设（默认 Full access，Claude 自己继续负责权限问答），然后直接用 `uiWorkspace.openSession()` 打开。DSH 默认模型仍然是 `opencode-go`；只有这个入口（或手动选择 `Claude Code · ACP`）才走 Claude。

SSH 工作区的原生入口由本机 `ssh` 启动远端 `claude-agent-acp`：插件把远端目录写进
`native.cwdMapFile`，适配器在会话启动时用该目录 `cd` 并作为 ACP `session/new` 的 cwd；
DSH 侧会话仍使用本地占位目录，因此工作区归属、侧栏与重启恢复都按普通会话处理。

## 它做什么

- **工作区**：在本地或 SSH 主机上创建/登记目录，目录按 `per-workspace` / `per-session` / `per-conversation` 派生；登记进 DSH 的工作区注册表（`ctx.workspaceController`）。
- **会话**：一个 DSH 会话绑定一个 Claude Code（ACP）会话；每个工作区一个常驻 `claude-agent-acp` 进程，多会话复用。DSH 重启后用 `session/load` 恢复，并重新应用模型/思考强度（`session/load` 会把模型重置为 `sonnet`）。
- **权限**：Claude 给什么选项就展示什么（`allow_once` / `allow-with-updates` / `reject…`），原样回传；额外提供「放宽」：本命令 / 命令前缀 / 本工具。默认审批**永不超时**。
- **远程**：`ssh -T -o BatchMode=yes -- <alias> claude-agent-acp` 直接承载 stdio，不暴露端口、不写桥、不要求目标机装 DSH。
- **审计**：`<dataDir>/audit/YYYY-MM-DD.jsonl`，只记元数据（主机、工作区、会话、工具、参数摘要、决定、耗时）；服务启动时按 `audit.retainDays` 清理过期文件。
- **界面**：DSH 右侧栏新增 `Claude Code` 标签（从右侧栏引导页打开），提供会话流、工具卡、diff、计划卡、权限 Dock、模型/思考强度/模式选择、停止按钮、断线重连、历史回放分隔与待审批计数；composer 支持 `/` 斜杠命令、`@` 文件选择与图片附件（超过 2 MB 自动缩放重编码）；子 agent 的工具卡嵌套在启动它的 Agent/Task 卡内；assistant 文本按 Markdown 渲染（标题、列表、表格、代码块、行内格式与安全链接）；设置页保留主机/工作区/规则管理。

不处理 Claude 登录/凭据：目标机上的 `claude` 必须已经登录。插件不读取、不缓存、不转发任何凭据。

## 安装

先在目标机安装并联通 Claude Code：

```sh
# 目标机（本地或 ssh 主机）
claude            # 完成登录
command -v claude-agent-acp
```

然后安装插件（路径按实际仓库位置）：

```sh
dsh plugin --profile web add /root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace
```

`cordis.patch.yml` 只插入本插件一行，**不会**禁用 `agent-loop` / `ui-model-selection`；普通 DSH 会话继续使用自己的 loop。

### 原生会话入口（可选）

原生入口依赖 fork 后的 ACP 适配器；仓库只提交可复现的迁移 patch，不提交上游源码：

```sh
node scripts/prepare-acp-adapter.mjs /opt/dsh-acp-adapter
dsh plugin --profile web add /opt/dsh-acp-adapter
```

**本地主机无需手写 `agents.json`**：插件加载时会把 `hosts.<local>` 的
`executable/args/env` 写进 `native.agentsFile`（默认
`$DSH_HOME/dsh-acp/agents.json`），已存在的同名 agent 不会被覆盖。因此只需
在本插件的配置里给出 ACP 可执行文件：

```yaml
- id: claude-workspace
  config:
    hosts:
      local:
        kind: local
        executable: /absolute/path/to/claude-agent-acp
        args: []
```

`GET /api/dsh-claude-workspace/status` 的 `native.seed` 会报告
`created` / `updated` / `present` / `skipped` / `failed` / `partial` 及原因
（`managedBy` 标记的条目会随配置刷新，手工条目不会被覆盖）。关闭自动写入：
`native.seedAgentsFile: false`，然后手工维护 `agents.json`。

SSH 主机还需要 `probeCwd`（远端绝对目录，通常是带 `.claude` 配置的项目根），
用于模型目录探测；每台 SSH 主机会自动得到一个 `acp-claude-code-<host>` provider：

```yaml
hosts:
  devbox:
    kind: ssh
    alias: ubuntu@192.0.2.10
    executable: /home/ubuntu/.ccw-acp/node_modules/.bin/claude-agent-acp
    args: []
    probeCwd: /home/ubuntu/project
    connectTimeoutMs: 15000
```

安装后重启 DSH，右侧栏控制台选中本地工作区时会出现 **新建 Claude 会话**。没有安装适配器时该按钮会把创建失败的原因显示在控制台里。

### 配置示例

```yaml
- insert:
    - id: claude-workspace
      name: dsh-claude-workspace
      config:
        hosts:
          local: { kind: local }
          devbox:
            kind: ssh
            alias: devbox
            executable: claude-agent-acp
            args: []
            connectTimeoutMs: 8000
            # command: "cd /path && exec ./node_modules/.bin/claude-agent-acp"  # 显式命令（替代 executable+args）
        defaultHost: local
        workspaces:
          baseDir: '${DSH_HOME}/claude-code/workspaces'
          strategy: per-workspace
          prefix: 'cc-'
        acp:
          executable: claude-agent-acp
          handshakeTimeoutMs: 20000
          requestTimeoutMs: 30000
          promptTimeoutMs: 0            # 0 = 不限制单轮时长
          idleRecycleMs: 600000
          maxLineBytes: 8388608
          minimumVersion: 0.99.0
          maximumVersionExclusive: 1.0.0
        events:
          bufferSize: 5000
        approvals:
          timeoutMs: 0                  # 0 = 一直等用户（B1）
          showSessionBadge: true
        permissions:
          forwardClaudeOptions: true    # 必须为 true（B5）
          widen:
            enabled: true
            defaultScope: command
          persist:
            target: project             # project | user
            confirmUserScope: true
        audit:
          retainDays: 30
        logs:
          dir: '${DSH_HOME}/claude-code/logs'
          maxBytes: 10485760          # 10 MB
          files: 3                    # 当前文件 + .1 + .2
        ssh:
          connectTimeoutMs: 8000
          serverAliveIntervalSec: 15
          serverAliveCountMax: 3
          strictHostKeyChecking: true
        native:                       # 原生会话入口（P2b）
          provider: acp-claude-code   # 适配器注册的 provider 路由
          model: default              # ACP 模型的默认项
          permissionPreset: danger-full-access
          attachToWorkspace: true     # 挂到对应 DSH 工作区，侧栏可见
          agentsFile: '${DSH_HOME}/dsh-acp/agents.json'
          seedAgentsFile: true        # 用 host 配置补齐 agents.json
          remoteSpawnCwd: /tmp        # ssh 启动器的本机 spawn cwd
          cwdMapFile: '${DSH_HOME}/dsh-acp/native-cwd.json'
```

配置是严格的：未知字段、越界数值、非绝对路径、未声明的 `defaultHost`、`forwardClaudeOptions: false` 都会在加载时报错并列出全部问题。

## 数据布局

```text
~/.dsh/claude-code/            # 或 config.dataDir
├── workspaces.json            # 工作区记录（原子写）
├── sessions.json              # dshSessionId ↔ acpSessionId 绑定
├── written-rules.json         # 仅本插件写入的 allow 规则（可逐条撤销）
├── audit/YYYY-MM-DD.jsonl
└── logs/<workspaceId>.log     # ACP stderr，按 maxBytes 滚动（.1、.2）

<baseDir>/<prefix><可读标识>-<16 位摘要>/
```

- 目录名摘要基于「主机身份 + 原始标识 + 基目录」计算，`a:b` 与 `a-b` 不会撞名；总长 ≤ 100。
- 所有 JSON 都走「临时文件 + fsync + rename」，设置文件额外保留 `.bak` 并在写入后回读校验。
- 启动时只读不建目录；目录只在创建/打开工作区时创建。

## 权限模型

| Claude 的选项 | 行为 |
|---|---|
| `allow_once` | 原样回传，不落盘 |
| `allow_with_updates` | 原样回传，由 Claude 自己决定是否/写到哪里（Bash 实测写 `.claude/settings.local.json`；Edit 可能是会话级） |
| `reject_once` / `reject_always` | 原样回传 |

> 实测补充：Claude Code 2.1.314 把「don't ask again」上报为 `kind: "allow_always"`、`optionId: "allow-with-updates"`，而不是 `kind: "allow_with_updates"`。插件两种写法都识别，并把选项原样回传。

「放宽」只在用户显式选择时由本插件写规则，并立即以 `allow-once` 应答：

| 范围 | 规则 |
|---|---|
| 本命令 | 不自己写，等价于转发 Claude 的 `allow-with-updates` |
| 本命令及参数变体 | `Bash(<前缀>:*)`；前缀取前两个 token（`npm test`、`git status`）或第一个 token |
| 本工具 | `Bash` / `Edit` / `Read` / `WebFetch` / `mcp__server` |

路径规则相对会话 cwd；绝对路径不生效（P0 实测），因此超出 cwd 的编辑会被拒绝放宽。写规则前必须预览；高风险命令（`rm -rf /`、`sudo`、`dd`、`mkfs`、`curl\|sh` 等）和用户级写入需要 `confirmed: true`。

远程工作区同样支持「放宽」：`HostOps` 提供远端读取与原子写（同目录临时文件 + `mv`、`.bak` 备份、回读校验），项目级规则写到远端 cwd 的 `.claude/settings.local.json`，用户级写到远端 `$HOME/.claude/settings.json`。

## 本地 HTTP API

仅在 loopback（`127.0.0.1` / `::1`）可用，由 `ctx.webServer` 挂载，前缀 `/api/dsh-claude-workspace`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 版本、数据目录、策略、注册表可用性 |
| GET | `/hosts` | 主机列表 |
| POST | `/hosts/probe` | `{hostId, cwd?}` 可执行文件/版本/握手/建会话检查 |
| GET | `/workspaces` | 工作区列表 |
| POST | `/workspaces/create` | `{hostId, title?, dir?, strategy?}` |
| POST | `/workspaces/rename` | `{workspaceId, title}` |
| POST | `/workspaces/remove` | `{workspaceId}`，只移除注册，不删目录 |
| POST | `/workspaces/delete-directory` | `{workspaceId, deleteDirectory:true}`，仅限已移除且派生的目录 |
| GET | `/workspaces/files` | `?workspaceId=&dir=&dshSessionId=`，`@` 文件选择器的目录列举 |
| GET | `/sessions` | 会话绑定 |
| POST | `/sessions/open` | `{workspaceId, dshSessionId, model?, effort?, mode?}` |
| POST | `/sessions/prompt` | `{dshSessionId, text, images?}` |
| POST | `/sessions/cancel` | `{dshSessionId}` |
| POST | `/sessions/reconnect` | `{dshSessionId}`，重建进程并 `session/load` |
| POST | `/sessions/option` | `{dshSessionId, configId, value}` |
| POST | `/sessions/reattach` | `{dshSessionId, sinceSeq?}`，恢复待审批与缓冲事件 |
| GET | `/approvals` | `?dshSessionId=` 待审批队列 |
| POST | `/approvals/answer` | `{requestId, optionId}` |
| POST | `/approvals/widen-preview` | `{requestId, scope, customRule?, target?}` |
| POST | `/approvals/widen` | `{requestId, scope, customRule?, target?, confirmed?}` |
| GET | `/rules` | 本插件写过的规则 |
| POST | `/rules/revoke` | `{id}` |
| GET | `/plans` | `?dshSessionId=` |
| POST | `/plans/decide` | `{dshSessionId, decision, feedback?}` |
| GET | `/audit` | `?day=YYYY-MM-DD` |

## 安全边界

- Claude Code 在目标机上拥有**原生访问**（等价 `danger-full-access`）；插件不限制、也无法限制它，只能在文案中说明。
- 只连接用户在配置里显式声明的主机；sshd 使用 `BatchMode=yes` 与严格主机密钥。
- 子进程环境会去掉 `DSH_*` 与常见凭据变量（`ANTHROPIC_*`、`AWS_*`、`GITHUB_TOKEN` 等），保留 `HOME`、`PATH`、locale 与目标机自己的 Claude 配置。
- 远端 stderr 只保留尾部摘要，不进入模型上下文。
- 审批队列只在 Host 内存：刷新页面可恢复；Host 重启或连接断开时标记 `expired`，不自动重放。

## 平台与版本

- Linux（本地与远端）。macOS 未验证；Windows 不在范围内。
- Node.js ≥ 22.19（`claude-agent-acp` 的 engine 要求；本机开发环境为 Node 24）。
- 已对照 ACP v1 与 `claude-agent-acp` 0.99.x 的协议字段；默认接受 `>=0.99.0 <1.0.0`，可配置。

## 开发与测试

```sh
npm install
npm run typecheck      # src + test
npm test               # 133 个用例：单元 + 假 ACP 集成 + HTTP + 入口 + 客户端
npm run test:real      # 真机端到端（需要已登录的 Claude Code）
npm run test:real:ssh  # SSH 真机端到端（见 docs/TEST-PLAN.md）
npm run test:real:plugin  # 隔离 DSH_HOME 的安装/卸载残留检查
npm run build          # tsc -> lib/，并复制浏览器半区
```

集成测试使用 `test/fake-acp/server.mjs`（可编程 ACP 服务端），覆盖：允许/拒绝落盘差异、diff、前缀放宽与规则撤销、取消、`session/load` 回放、双会话权限路由、健康检查、HTTP 校验。

`test/real/real-acp.ts` 在已登录的目标机上驱动真实 `claude-agent-acp`，覆盖：健康检查（握手 + 建会话）、允许、拒绝、`Edit(sub/**)` 放宽与撤销、转发「don't ask again」（Bash 会写带 `\(` 转义的规则）、执行中取消、`session/load` 回放与模型重设、重启恢复。默认使用 `claude-code-test` 目录，可用 `CCW_REAL_CWD` 与 `CCW_ACP_BIN` 覆盖；测试结束后恢复/删除它创建的文件，不触碰 `.claude/settings.json`。

`test/real/real-ssh.ts` 通过真实 ssh 驱动远端 Claude Code，覆盖健康检查、远程 Write 允许/拒绝、远程 `Edit(sub/**)` 放宽（写远端设置、撤销、恢复原文件）。已在第二台 Ubuntu VM（Node 22、Claude Code 2.1.316、claude-agent-acp 0.99.1）完成真实回归；`CCW_REMOTE_ARGS` 可传入远端 ACP 参数（JSON 数组），便于先用假 ACP 验证传输层。

`test/real/plugin-install.ts` 在临时 `DSH_HOME` 中执行 `dsh plugin add` → `--dump-config` → `remove` → `--dump-config`，断言插件行、依赖与 bundle 均被清理。需要 `DSH_REPO` 指向 deepseek-harness 检出。

最近一次真机结果（本机，Claude Code 2.1.314 / claude-agent-acp 0.99.1 / Node 24）：本地与 SSH（localhost）全部场景 PASS，`session/load` 回放 31 条事件。

**另一台机器如何测试**：完整的环境检查、代码传输、R1–R4 验收矩阵、证据回传与失败排查见 [docs/TEST-PLAN.md](docs/TEST-PLAN.md)。

## 目录结构

```text
src/
├── config.ts              # 严格配置解析与默认值
├── host/                  # HostOps：local / ssh、转义、探测
├── workspace/             # 命名、存储、注册表、生命周期
├── acp/                   # NDJSON JSON-RPC、进程、客户端、进程池、事件翻译、diff
├── gate/                  # 权限门、选项、放宽规则、设置写入、计划
├── audit.ts               # 每日 JSONL 审计
├── service.ts             # Host 侧编排（传输无关）
├── http.ts                # loopback HTTP API
├── index.ts               # DSH/Cordis 入口
└── client.js              # 浏览器半区：settings.section + 右侧栏会话控制台
```

## 许可证与致谢

MIT。DSH 集成与客户端槽位写法参考 `dsh-memory-journal` 与 `@zaimokuza/dsh-acp-adapter`（均为 MIT）；协议端为 `@agentclientprotocol/claude-agent-acp`（Apache-2.0，未随包分发）。见 [NOTICE](NOTICE)。
