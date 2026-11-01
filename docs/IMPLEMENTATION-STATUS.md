# 实现状态（对照 CCW 计划）

> 计划：`.claude/plan/dsh-claude-code-workspace-plugin-plan.md`（DSH 0.2.1-rc.5，2026-11-01）
> 本仓库：`/root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace`
> 本轮范围：P1 可运行核心 + 完整骨架（用户确认）。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 可行性 | 已完成（计划提供） | 握手、prompt、权限、diff、取消、`session/load`、ssh 传输均有实测记录。 |
| P1 工作区与本地会话 | **本轮完成（核心）** | 工作区模型/目录派生/登记、HostOps（local+ssh）、ACP 进程池、会话绑定、权限门（永不超时/如实转发/放宽）、审计、恢复、HTTP 控制面。 |
| P2 呈现层 | **P2a 完成；P2b 可用（本地/SSH 原生入口 + 重启恢复）** | P2a：右侧栏控制台完整。P2b：fork 适配器 host 侧、移除其客户端，DSH 原生会话 UI 跑通；一键「新建 Claude 会话」支持本地与 SSH 工作区，并补齐 0.2.1 持久化/恢复 API 迁移。 |
| P3 远程 | **P3 完成** | `HostOps` ssh、`ssh -T` stdio、keepalive、探测、远端建目录、远端设置读写、断线标记/过期/重连、`sessions/reconnect` 与控制台重连。localhost 与**第二台 Ubuntu VM 真实 Claude** 均 PASS。 |
| P4 细节对齐 | **P4a 完成 + 图片压缩 + 子 agent 工具树** | composer 已支持 `/` 斜杠命令、`@` 文件选择（Host 目录列举，限定在工作区内）、图片附件（≤4 张、每张 ≤2 MB，超限自动缩放重编码）；工具卡按 `parentToolCallId` 嵌套子 agent；计划卡与模型选择已在前序完成。`@` 索引一致与快捷键扩展仍待做。 |
| P5 硬化 | **P5a + P5b 完成，npm 发布待做** | 原子写、审计与保留清理、行/输出上限、ACP stderr 滚动日志（0600）、`prepack` 自动构建、隔离 `DSH_HOME` 的安装/卸载残留检查、Node 22/24 CI 矩阵；未执行真实 npm 发布。 |

## §12.3 实现顺序对照

| 步 | 计划内容 | 本轮结果 |
|---|---|---|
| 1 | 骨架 + bundle patch（禁用 `agent-loop` / `ui-model-selection`，插自己的行） | 部分：`package.json`、`cordis.patch.yml`、`apply()` 可加载；**只插入插件行**，两行未禁用（P1 不接管会话，禁用会让普通会话失去 loop）。`--dump-config` 未在本机 DSH 环境验证。 |
| 2 | Host ACP 客户端 + workspace store（本地） | 完成：`config`、`host/*`、`acp/*`、`workspace/*`、`gate/*`、`audit`、`service`；用假 ACP 全流程验证。 |
| 3 | 客户端 UI：会话视图 + 工具卡 + 权限 Dock | P2a：`src/client.js` 注册右侧栏 tab type（`sidebar.right.pane.tab` / `.title`）与会话控制台；设置页保留管理功能。DSH 会话内联呈现仍待 P2b。 |
| 4 | remote HostOps + 健康检查 | 本地与 localhost SSH 真机完成；远端设置读取/原子写与「放宽」已验证；**独立物理机与断线重连未验证**。 |
| 5 | 恢复/并发/中断 | 完成：`session/load` 重放标记、load 后重设 model/effort、同工作区双会话权限路由、`session/cancel` → 卡片 `cancelled`。假 ACP 验证。 |
| 6 | 硬化与打包 | 部分：原子写、`.bak`、回读校验、损坏 JSON 拒绝、审计、行上限、输出上限；冲突检测/安装卸载验证待 P2。 |

## 已验证行为（自动化）

`npm test`：133 个用例全部通过。

- 工作区：派生命名（摘要稳定、`a:b` vs `a-b`、100 字符、前缀校验）、显式目录、重复目录解析、登记失败不留记录且保留目录、移除不删目录、派生目录删除的包含性校验、`per-session` 派生。
- Host：POSIX 引号（空格/单引号/`$()`/通配/中文）、ssh argv（BatchMode/keepalive/`--`）、严格主机密钥开关。
- ACP：NDJSON 半行/CRLF/非法 JSON/超长行/服务器请求/通知/关闭拒绝 pending。
- 事件：`toolCallId` 身份、标题更新不新增卡片、状态机、diff 行级统计、`plan`/`commands`/`mode`、未知更新保留、取消只改运行中卡片。
- 权限：默认不超时、应答校验选项归属、重复请求折叠、断线/超时 expired、按会话过滤。
- 放宽：`Bash(cmd:*)` / `Bash` / `Edit(src/**)` / `Edit(**)` / `Read(**)` / `WebFetch(domain:…)` / `mcp__server`、绝对路径越界拒绝、Claude 风格转义、内存规则匹配。
- 设置写入：缺失初始化、保留其他键与顺序、去重、非法 JSON/非数组拒绝且原文件不动、`.bak`、回读校验、并发串行、撤销。
- 集成：允许 → 文件写入；拒绝 → 文件不存在且工具 failed；前缀放宽 → 文件出现 `Bash(npm test:*)`、可撤销；取消 → `cancelled`；重启 → `session/load` 回放且 `replay:true`、模型重设；双会话权限独立；健康检查握手+建会话；HTTP 校验；计划记录/批准/取消/修改反馈。

## 真机验证（2026-11-01，本机 = PA_gpu2）

环境：Linux 容器 root；`claude` 2.1.314；`claude-agent-acp` 0.99.1；Node 24.14.0；项目配置 `claude-code-test/.claude/settings.json`（第三方网关；测试全程未读取、未复制、未输出其中的凭据）。

`npm run test:real`（`test/real/real-acp.ts`）全部 PASS：

| 场景 | 实测结果 |
|---|---|
| 健康检查 | 可执行文件 0.99.1、版本区间通过、握手 + `session/new` 成功（约 60ms 内完成，本地） |
| 建会话 | `configOptions`：`mode, model, effort, ultracode`；返回 3 个可用模式 |
| 允许一次 | Write 权限 → 文件写入，工具 `ok`，turn `end_turn` |
| 拒绝 | Write 权限 → 文件不存在，工具 `failed`，会话继续 |
| 自主放宽 | 预览 `Edit(sub/**)` → 写入 `settings.local.json` → 文件写入 → 撤销后规则消失 |
| 转发「don't ask again」·Write | 原样回传成功，文件写入；Claude 未持久化 Edit 规则（符合 A1：Edit 以 Claude suggestion 为准） |
| 转发「don't ask again」·Bash | 原样回传后 Claude 写入 `Bash(python3 -c 'import time; time.sleep\\(2\\)')`，括号转义与预期一致 |
| 执行中取消 | `session/cancel` → `stopReason: cancelled`；工具卡保持 `cancelled`（agent 随后发的 `failed` 不再覆盖） |
| 模型设置 | `session/set_config_option {model: "default"}` 成功 |
| 重启恢复 | 新进程 `session/load` 回放 31 条事件，全部 `replay:true`，重设 model 未报错 |

本轮真机暴露并已修正的差异：

1. Claude 2.1.314 的「don't ask again」是 `kind: "allow_always"` + `optionId: "allow-with-updates"`，不是计划表格里的 `kind: "allow_with_updates"`；`findAllowWithUpdates` 现同时识别两种。
2. 取消后 agent 仍会发 `tool_call_update status=failed`；卡片的 `cancelled` 必须是终态，已在事件合并中固定。
3. 本地 ACP 进程必须以工作区目录为 cwd 启动，否则可能读不到项目级 `.claude/settings.json`；`spawnAcp(cwd)` 已接通（远程仍按 B7 不 `cd`）。

## P2a 右侧栏会话控制台（2026-11-01）

已实现于 `src/client.js`：

- 右侧栏 tab type `claude-workspace`，通过右侧栏引导页打开
- 会话流：assistant/user/thinking、工具卡（`toolCallId` 身份、状态机）、diff hunks、计划卡
- 权限 Dock：Claude 原生选项原样展示；放宽预览/落盘/允许；高风险提示
- 模型 / 思考强度 / 模式选择器（来自 `configOptions`）
- 停止按钮、历史回放分隔与灰化、待审批计数（tab 标题）
- Host 侧新增 `GET /sessions/options`，缓存 new/load 返回的 `configOptions`/`modes`

真实 Web profile 验证（隔离 `DSH_HOME`，`dsh-base` + `dsh-web-app` + 本插件）：

- 插件激活无 "did not activate" 警告
- `GET /api/dsh-claude-workspace/status` → `registryAvailable: true`
- `POST /workspaces/create` → 记录带 `dshWorkspaceId`（工作区已登记进 DSH）
- 页面 boot 模块列表包含 `dsh-claude-workspace/client.js`，右侧栏 slot 注册由客户端单测覆盖

本轮真实启动发现并修复：

1. 直接读 `ctx.workspaceController` 触发 Cordis “cannot get property without inject”；可选服务全部改为 `ctx.get(name)`。
2. `workspaceController` 晚于本插件加载，`apply` 时读到 `undefined`；新增 `attachWorkspaceController()`，在服务出现后登记并回填已有工作区。

未验证：真实浏览器内的点击/渲染（当前环境没有 headless browser）；客户端注册与纯函数由 `test/unit/client.test.ts` 覆盖。

浏览器冒烟（2026-11-01，临时安装 Playwright + Chromium）：隔离 web profile 加载成功，`dsh-claude-workspace/client.js` 被请求，无 console/page error；页面显示 DSH 欢迎页和通过 API 登记的工作区。右侧栏 guide 为 session-scoped，隔离 profile 没有账号/模型，无法创建会话，因此**未能在浏览器里点击到 `Claude Code` tab 本身**；该 tab 的类型注册由客户端单测覆盖。临时浏览器、playwright 缓存与 DSH_HOME 已删除。

剩余 P2b：接管 `agent-loop` / `ui-model-selection`。DSH 0.2.x 的 `AgentLoop` 通过 `private` 的 `initializeAgent`/发布流程创建 Agent，`@zaimokuza/dsh-acp-adapter` 用绑定 0.1.1-rc.2 的 host-compat 影子层绕开；这需要一次单独 spike，不能直接复用 P2a 的独立控制台。

## P3a 远程设置桥（2026-11-01）

`HostOps` 新增 `readText` / `writeTextAtomic` / `removeFile` / `home`：

- 本地：复用 `atomicWriteFile`（临时文件 + fsync + rename + `.bak`）
- SSH：`sh -c` + 同目录 `mktemp`、stdin 写入、`chmod 600`、`cp -p` 备份、`mv`；读取用 `cat`，缺失返回 `undefined`
- `SettingsWriter` 改为按 host 读写；sidecar 记录 `host`，撤销时解析对应 host
- 用户级规则的目标目录取远端 `$HOME`，不再固定本机 home

`test/real/real-ssh.ts` 已在 localhost SSH 真机验证：远程 `Edit(ccw-e2e-ssh-sub/**)` 放宽写入远端 `.claude/settings.local.json`、文件可写、规则可撤销；测试结束后恢复/删除它创建的文件与设置备份。

剩余：独立物理机回归、断网/重连的真机验证、远端 `user` 级写入的真机验证。

## P3b 断线与重连（2026-11-01）

- 连接关闭时：池标记 workspace `disconnected`，该 workspace 的待审批请求全部标 `expired` 并写审计（`expired:connection closed`），不自动重放未确认的 prompt
- 新增 `CcwService.reconnectSession()` 与 `POST /sessions/reconnect`：关闭旧进程、启动新进程、`session/load` 回放，再恢复绑定的 model/effort/mode
- 客户端：状态为 `disconnected` 时显示「重连」按钮，重连后从 seq 0 重新拉取回放事件；断线期间 composer 禁用
- 假 ACP 集成测试覆盖：
  - 允许后进程崩溃 → prompt 拒绝、状态 `disconnected`、重连 `resumed=true`、后续正常回合
  - 待审批时崩溃 → pending 清零、审计出现 `expired:connection closed`、重连成功

剩余：真实 SSH 断网/杀进程回归。

## P3c 跨物理机回归（2026-11-01）

第二台 Ubuntu VM（kernel 6.8，Node 22.22.2，Claude Code 2.1.316，`claude-agent-acp` 0.99.1），通过公钥 SSH 连接：

- 先用假 ACP 跑通真实网络上的健康检查、远程 Write 允许/拒绝、远端 `Edit(ccw-e2e-ssh-sub/**)` 写入/撤销（不依赖登录）
- 再在目标机已登录的项目目录上跑真实 Claude：**PASS**
- 发现：目标机用户级凭据存在但空项目目录仍报 `Authentication required`；必须在带项目级网关/模型配置的目录启动 ACP（或使用显式 `CCW_REMOTE_COMMAND` 指定 `cd`）
- 清理验证：目标项目 `.claude/` 只剩原有 `settings.json`，无 `settings.local.json`/`.bak`/e2e 文件；测试用的假 ACP 已删除

剩余：真实断网/杀进程（非进程崩溃）的 SSH 回归。

## P2b 会话内联（2026-11-01）

### 路线

fork 适配器的 **host 侧**（`AcpAgent`、`translate`、`process`、`remote`），移除其 12.9k 行客户端，保留 **DSH 原生会话 UI**。适配器 host 继续把 ACP 更新翻译成 DSH Session 事件，因此原生消息流、工具卡、Trajectory 都能直接渲染。

### 已验证垂直切片（PASS）

隔离 web profile（`dsh-base` + `dsh-web-app` + fork）中：

- 原生模型选择器出现 `Claude Code · ACP`
- 工作区新建会话 → Full access → 发送任务
- 原生 UI 显示用户消息、thinking、工具卡（`dsh_acp_external_tool`）与 assistant 文本
- turn `Completed in 7s`，Claude 实际写入 `cherry.txt`（内容 `hello-cherry`），文件存在于工作区
- 无 console/page error

### Host 侧迁移点（均已验证）

1. `CallId` → `ToolCallId`（`@deepseek-ai/dsh-llm`，全局替换）
2. `Inbox` 不再导出 → 本地 shim：按 `agent/inbox/spliced` 维护状态并 `session.append`
3. `assertNever` 移出 `dsh-llm` → 本地 shim
4. `session.events` 不再存在 → `session.snapshotEvents()`（resume/agent/inbox/host-compat）
5. `ownerCtx.agent` 在 0.2.x 触发未注入属性保护 → 顶级会话传 `undefined`
6. `assistant/message` 不能带 `sourceEventSeqs` → 去掉该 intent 并补 `stream: []`
7. `settings.register` 移除 → `$DSH_HOME/dsh-acp/agents.json` 种子 profile
8. `createAgent` 只在 provider 命中 `acp-*` 路由时接管；默认模型保持 `opencode-go`，不做全局劫持（早期版本曾默认路由 ACP，已恢复）
9. Full access 下 DSH 审批策略为 `never`（原生工具不审批）→ ACP 权限桥在 `never` 下按 Native Agent Access 语义回 `allow-once`，否则 Claude 会收到拒绝
10. 适配器 `dsh.client` 移除，保留原生 `ui-model-selection`；Native Agent Access 需在 UI 中二次确认

### 当前默认与 opt-in

- DSH 默认模型：`opencode-go / deepseek-v4.1-flash`，继续使用 DSH 原生 loop 与
  `~/.dsh/.credentials.yaml` 中 `refs.OPENCODE_GO_API_KEY` 保存的 token
- Claude：只有显式选择 `Claude Code · ACP` 的会话才由 fork 接管；原生模型选择器
  在会话已创建后再切换不会重建 Agent，因此新建会话时就要选 ACP（或临时改默认）
- **可靠的 opt-in 入口**：右侧栏 `Claude Code` 控制台新增 **新建 Claude 会话**
  （`POST /sessions/native-create`）。服务端用 `native.provider` 调
  `ctx.agents.create()`，挂到 DSH 工作区，写入 `native.permissionPreset`，
  返回 sessionId；客户端用 `uiWorkspace.openSession()` 直接打开原生会话。
  配置见 `native.provider/model/permissionPreset/attachToWorkspace`。
- **agents.json 由 host 配置补齐**：插件加载时把每个 host 的启动方式写进
  `native.agentsFile`（默认 `$DSH_HOME/dsh-acp/agents.json`）。本地 host 直接写
  `executable/args/env`；SSH host 写 `ssh` 启动器（`spawnCwd` + `cwdToken` +
  `probeCwd` + `cwdMapFile`）。带 `managedBy` 的条目会随配置刷新，手工条目
  不覆盖；`native.seedAgentsFile: false` 可关闭。结果通过 `/status` 的
  `native.seed` 报告（`created/updated/present/skipped/failed/partial`）。
- **SSH 工作区原生入口**：每台 SSH host 自动得到 `acp-claude-code-<host>`
  provider。创建会话时 CCW 把远端目录写入 `native.cwdMapFile`，DSH 会话本身
  使用本地占位目录（与 DSH 工作区路径一致）以便挂载与恢复；适配器在会话启动时
  读取映射，用远端目录 `cd` 并作为 ACP `session/new` 的 cwd。远端目录不在本机
  创建，DSH 注册表也不会在远端路径上建本地目录。
- CCW 右侧栏控制台仍是不依赖模型选择器的 Claude 入口

### 原生入口真机验证（2026-11-01）

隔离外的真实 web profile（源码启动，`opencode-go` 默认不变）：

1. `POST /workspaces/create` 注册 `/tmp/ccw-native-demo`，得到 `dshWorkspaceId`
2. `POST /sessions/native-create` → 24 ms 返回 `session-…`，`workspaceAttached:true`、
   `permissionPreset:"danger-full-access"`
3. 用 DSH 自己的 `session/prompt` RPC 发任务 → 1 个 turn 完成，助手回复由 Claude 生成
4. JSONL 会话物化，ACP sidecar 记录 `acp-claude-code` binding（claude-agent-acp 0.99.1）
5. 重启 DSH → 同一 sessionId 再次 prompt → `request/header reason:"resume"`、
   ACP `session/resume` 恢复上下文、第二轮回复正确
6. 同一工作区两个原生会话并发 prompt → 各自得到 A/B 回复，互不串流

并发验证表明：同一个工作区的多个 ACP 子进程由适配器独立管理；DSH 侧按
sessionId 路由事件与权限，不需要额外锁。

### 迁移修复（真机重启暴露）

1. **持久化缺失**：fork 的 `createAgent` 没有领取 `sessionPersistence.create()` 写句柄，
   会话从不落盘，重启后 `session/not-found`。已按 0.2.1 生命周期补上 handle、
   seed 写入与 dispose 关闭。
2. **恢复 API 漂移**：`resumeAcpLifecycle` 仍调用 0.1 的 `persistence.prepare()`；
   改为 `open(id,'write')` + `read(0)` + `interruptedTurnClosers()`（0.2 事件形态的本地副本），
   再把 seed 交给 `sessions.prepare()`。
3. **`persistence.inspect()` 已不存在**：路由窥测改为只读 `open(id,'read')`；`list()`
   按 snapshot 的 `header.id` 匹配。
4. **`assistant/chunk` 已不在 0.2 词表**：翻译器不再 append 该事件，否则日志会被
   session query 拒绝（`contains event type "assistant/chunk" unknown`）。
5. **tool/call 名称校验**：0.2 的 session query 要求 `tool/call` 与 assistant
   block 广告的 tool-call 同名；assistant block 改用稳定 wire name
   `dsh_acp_external_tool`，人类可读标题仍在 card meta 中。
6. **SSH 启动语义**：新增 profile 字段 `spawnCwd`（本机 spawn 目录（本地占位））、
   `cwdToken`（替换为 shell-quoted 会话 cwd）、`probeCwd`（远端模型探测目录）、
   `cwdMapFile`（按 sessionId 读取远端 cwd）；远端 cwd 不做本机 realpath。

### SSH 原生入口真机验证（第二台 Ubuntu VM，2026-11-01）

目标机 `ubuntu@42.193.248.137`，远端安装 `@agentclientprotocol/claude-agent-acp@0.99.1`
于 `~/.ccw-acp`，`probeCwd=/home/ubuntu/PYProject/claude-code-test`：

1. 插件启动自动写入 `claude-code-devbox`（`ssh` 启动器 + `cwdToken` + `cwdMapFile`），
   重启后条目被识别为 `managedBy` 并刷新为最新字段
2. `POST /workspaces/create`（host=devbox，dir=远端路径）→ DSH 注册路径为
   `$DSH_HOME/claude-code/remote-workspaces/<workspaceId>` 本地占位目录
3. `POST /sessions/native-create` → `workspaceAttached:true`；`native-cwd.json`
   记录 `sessionId → /home/ubuntu/PYProject/claude-code-test`
4. 提示词让 Claude 执行 `pwd; hostname; ls` → 输出远端路径、`VM-0-14-ubuntu`
   与远端项目文件，证明工具运行在远端
5. 重启 DSH → 同一会话再次 prompt → 恢复成功，第二轮仍返回远端机器与目录

### 审计与 state 边界

两种 Claude 入口的持久化彼此独立，排障时先看入口：

| 数据 | 控制台（本插件） | 原生会话（适配器） |
|---|---|---|
| 会话↔ACP 绑定 | `<dataDir>/sessions.json` | `<DSH_HOME>/dsh-acp/sidecar.sqlite` 的 `bindings` |
| 权限决定审计 | `<dataDir>/audit/YYYY-MM-DD.jsonl`（只记元数据） | sidecar 的 `audit` 表（适配器自己的记录） |
| 模型/模式快照 | `<dataDir>/sessions.json` 的 model/effort/mode | sidecar 的 `option_snapshots` |
| DSH 会话日志 | 无（控制台会话不落 DSH 日志） | `<DSH_HOME>/sessions/...`（普通 DSH 会话，可恢复） |

- CCW 的权限 Dock、放宽规则和 `audit` 只覆盖**控制台**会话；原生会话的权限由
  Claude 自己提问，DSH Full access 下适配器自动 `allow-once`，不写 CCW 审计。
- 两边都可能有同名 session：控制台用 `ccw-*` 自定义 ID，原生会话用
  `session-<uuid>`；互不引用。
- 原生会话的重启恢复依赖 DSH 日志与 sidecar binding；控制台依赖
  `sessions.json` + ACP `session/load`。

### 尚需

- 权限选项保真：当前 Full access 下自动 allow-once；`allow-with-updates` 与 CCW 权限 Dock 待接回
- token 级流式显示（0.2 无 `assistant/chunk`，助手文本段末一次性出现）
- 远端 ACP 运行不受 DSH 沙箱约束（ssh 启动器本身在本机 spawn 计划内）

## P4a composer 与工具树（2026-11-01）

- **`/` 斜杠命令**：读取最新的 `available_commands_update`，按前缀过滤后显示菜单，点击写入 `/<name> `
- **`@` 文件选择**：新增 `GET /workspaces/files`；目录限定在工作区根或派生会话目录内，返回目录优先排序的直接子项；选择文件写入相对路径 `@path`
- **图片附件**：选择图片后转 base64 作为 ACP image block，最多 4 张、每张 ≤2 MB；
  **超过 2 MB 时先用 canvas 等比缩放到长边 ≤2048 并重编码**（PNG 首轮保透明，
  仍超限退回 JPEG，最多 4 轮）；缩不到预算才报错。发送后清空
- **子 agent 工具树**：解析 ACP 扩展 `_meta.claudeCode.parentToolUseId`，映射为
  `ToolCard.parentToolCallId`；控制台把子 agent 的工具卡嵌套在启动它的
  `Agent`/`Task` 卡内（左侧竖线、自动展开，父卡显示 `子 agent · N` 徽标）。
  同时修正了工具卡按每次 update 重复渲染的问题：现在每个 `toolCallId` 只渲染
  最新状态一次。真机验证：父 `Agent` 卡 → 两个子 `Bash` 卡，子卡带
  `parentToolCallId`
- Host 新增 `listDirectory`（local `readdir`；SSH `find -printf '%y\t%f\0'`），并修正了远程脚本 `$0/$1` 传参问题
- 验证：单元/HTTP 用例覆盖排序、限制、越界拒绝、命令匹配、路径相对化、缩放与 base64 字节计算；SSH host 冒烟验证目录列举、原子写、读取、home、删除；`test:real:ssh` 增加“列举远端工作区并找到刚写入文件”的断言

剩余 P4：`@` 与 DSH 文件索引的一致、快捷键扩展。

## P5a 硬化（2026-11-01）

- **ACP stderr 滚动日志**：`logs.dir` / `logs.maxBytes`（默认 10 MB）/ `logs.files`（默认 3，含当前文件），按 `<dataDir>/logs/<workspaceId>.log` 写入，`.1` 最新；写入失败不影响会话
- **审计保留**：服务启动时按 `audit.retainDays` 清理
- **发布前构建**：`package.json` 增加 `prepack: npm run build`，避免发布包缺 `lib/`
- 单测覆盖：滚动/单文件/超大单块、日志配置默认值与越界、PlanGate 记录与决策
- **安装/卸载残留检查**：`test/real/plugin-install.ts` 在临时 `DSH_HOME` 中 add → dump → remove → dump，断言插件行、依赖与 bundle 全部清理
- **`@` 列举范围收紧**：只允许工作区根或当前会话 cwd，不能借派生根浏览兄弟工作区
- **自动放行标记**：命中会话放宽规则时发出 `auto-approved` 事件，工具卡显示 `auto` 徽标，并写 `auto:<rule>` 审计

剩余 P5：日志内容脱敏策略复核、正式发布（npm）。

## P5b CI 与发布准备（2026-11-01）

- **CI 矩阵**：`.github/workflows/ci.yml` 在 Node 22 / 24 上跑 `npm ci`、`typecheck`、
  `test`、`build`
- **日志权限**：ACP stderr 日志文件创建时即为 `0600`（此前跟随 umask）
- **包元数据**：补 `repository` / `homepage` / `bugs` / `publishConfig.access=public`，
  `prepack` 已会先构建
- 审计本身只记元数据（主机、工作区、会话、工具名、参数摘要 8 位哈希、决定、耗时），
  不记命令文本、文件内容与模型输出
- 尚未执行 `npm publish`（需要发布账号与 2FA）；发布前跑一次 `npm pack --dry-run`
  检查 `files` 白名单

剩余：真实 npm 发布、日志内容脱敏的人工抽样复核。

### DSH Loader 装配（隔离环境）

在临时 `DSH_HOME=/tmp/ccw-dsh-home` 下执行（未触碰 `~/.dsh`，验证后已删除）：

```sh
DSH_HOME=/tmp/ccw-dsh-home pnpm dsh plugin --profile ccwtest add /root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace
DSH_HOME=/tmp/ccw-dsh-home pnpm dsh --profile ccwtest --dump-config
```

结果：profile 自动创建并链接本包；合成配置中出现

```yaml
# == dsh-claude-workspace
- id: claude-workspace
  name: dsh-claude-workspace
  config: {}
```

未在隔离环境做完整 boot（缺少模型凭据，且 P1 不接管会话）；加载后的 API 挂载由入口单测与假 ACP 集成测试覆盖。

## 与计划的差异 / 明确未做

1. **不 fork `dsh-acp-adapter`（Q8 结论）**：本轮按计划 §8.1 独立实现 ACP 客户端与运行时，不复制其 25k 行代码；许可证上无需携带其版权，但接管的 agent-loop 行仍待 P2。若 P2 发现其恢复/选择器实现不可替代，再评估 fork。
2. **不接管 agent-loop / model-selection**：P1 用 loopback HTTP 控制面，装插件不影响普通 DSH 会话；因此 §8.5 的「加载时检测其他 agent-loop 接管并拒绝」尚未实现（目前不存在本插件注册 factory 的动作）。P2 必须先补冲突检测，再启用两行 patch。
3. **远程「放宽」与跨机已验证**：`HostOps` 新增 `readText`/`writeTextAtomic`/`removeFile`/`home`；SSH 侧用同目录临时文件 + `mv`、`.bak`、回读校验写设置，规则按 host 记入 sidecar 可撤销。localhost 与第二台 Ubuntu VM 的真实 Claude 均 PASS。
4. **无终端 PTY / 子 agent 会话树 / MCP 注入 / 历史缓存（IndexedDB）**：计划中的 P4 范围。
5. **审计写失败不阻断请求**：`#auditDecision` 吞掉写入错误，避免审计盘满导致权限流程卡死；这属于有意的可用性取舍，P5 可改为显式告警。
6. **健康检查版本探测**：使用主机配置的可执行文件（默认 `claude-agent-acp`），版本区间可配；探测不到版本时只做握手判断。

## 计划遗留问题（Q8–Q17）当前结论

| 编号 | 本轮结论 |
|---|---|
| Q8 | 已做 spike：适配器 rc.10 在 DSH 0.2.1-rc.5 上因 `CallId`/`Inbox` 移除而无法加载，host-compat 绑定旧私有结构；直接复用不可行，P2b 需 fork+迁移或自写桥。 |
| Q9 | 只实现 ACP v1；v2 未评估。 |
| Q11 | 已在 `#load` 后重新应用 `model`/`effort`/`mode`；真机已执行「设为 default → 重启 load → 重设无报错，回放 31 条」，但因 ACP 无读取当前模型的接口，未直接断言加载后的实际模型值。 |
| Q12 | 自动放行写审计 `auto:<rule>`；服务发出 `auto-approved` 事件，控制台工具卡显示 `auto` 徽标；真机确认取消后卡片保持 `cancelled`。 |
| Q13 | 本机 Node 24.14.0 下真实 ACP 通过；包声明 `>=22.19.0`，未在 Node 20 上验证。 |
| Q15 | 真机观察到 Claude 转发路径写入 `Bash(python3 -c 'import time; time.sleep\(2\)')`，与本插件 `escapeRule` 的转义规则一致。 |
| Q16 | 工具级规则（只写 `Bash`/`Edit`/`WebFetch`）是否等价全放行未真机验证。 |
| Q17 | 用户级写入需 `confirmed:true`，预览显示文件与规则；交互稿未做。 |

## 下一步（建议顺序）

1. **P1 真机回归**：本机完成本地 `test:real` 全流程；`dsh plugin --profile <test> add <路径>` + `--dump-config` 在隔离 `DSH_HOME` 验证通过（含安装/卸载残留检查）；ssh 已在第二台 Ubuntu VM 完成真实 Claude 回归。
2. **P2b 接管 agent-loop**：先做 Q8 spike（DSH 0.2.x 的私有发布流程 vs 适配器的 host-compat）；实现后补 `setFactory` 冲突检测、替换 `ui-model-selection`，再考虑把 P2a 控制台迁入会话内联呈现。
3. **P3 远程设置桥**：为 `HostOps` 增加读/原子写文件能力，解除远程 widen 限制，并在 ssh 断线时按 workspace 标 `expired`（已按 workspace 过滤）。
4. **P4**：终端 PTY、子 agent、`/` 命令、`@` 文件、图片预算。
5. **P5**：并发/断线回归脚本、打包与安装/卸载残留检查、Linux 本地/远端矩阵。

## 复跑

```sh
cd /root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace
npm install
npm run typecheck
npm test
npm run test:real   # 需要目标机已登录 Claude Code
npm run build
```

真机脚本默认使用 `claude-code-test` 与其中的 `claude-agent-acp`；可覆盖：

```sh
CCW_REAL_CWD=/path/to/project \
CCW_ACP_BIN=/path/to/claude-agent-acp \
npm run test:real
```
