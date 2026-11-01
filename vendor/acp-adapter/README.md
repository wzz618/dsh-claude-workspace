# ACP adapter fork（P2b）

DSH 原生会话内联依赖 `@zaimokuza/dsh-acp-adapter` 的 **host 侧**代码。上游是
MIT、版本 `0.1.0-rc.10`，但绑定 DSH 0.1.x 的私有 API。本目录不提交上游源
码，只提交可复现的迁移 patch。

## 生成可运行副本

```sh
cd /path/to/dsh-claude-workspace
node scripts/prepare-acp-adapter.mjs /tmp/dsh-acp-adapter
```

等价手动步骤：

```sh
cd /tmp && npm pack @zaimokuza/dsh-acp-adapter@0.1.0-rc.10
mkdir -p /tmp/dsh-acp-adapter
tar -xzf zaimokuza-dsh-acp-adapter-0.1.0-rc.10.tgz -C /tmp/dsh-acp-adapter --strip-components=1
cd /tmp/dsh-acp-adapter
patch -p1 < /path/to/dsh-claude-workspace/vendor/acp-adapter/migration.patch
npm install --legacy-peer-deps --no-audit --no-fund
```

## 安装到 DSH profile

```sh
export DSH_HOME=/path/to/dsh-home
mkdir -p "$DSH_HOME/dsh-acp"
cat > "$DSH_HOME/dsh-acp/agents.json" <<'JSON'
{"agents":{"claude-code":{"name":"Claude Code","command":"claude-agent-acp","args":[],"env":{}}}}
JSON
pnpm dsh plugin --profile web add /tmp/dsh-acp-adapter
pnpm dsh --profile web --dump-config | grep -A3 agent-loop-acp
```

在 Web UI 中：

1. 工作区新建会话；
2. 访问模式切到 **Full access** 并确认（Native Agent Access）；
3. 只有显式选择 `Claude Code · ACP` 的会话才走 Claude；默认模型保持
   `opencode-go`，原生会话继续使用 DSH 的 loop 与 `OPENCODE_GO_API_KEY`。
   注意：原生模型选择器在会话已创建后再切换 provider 不会重建 Agent；
   需要 Claude 时应在新建会话时选择 ACP（或临时把默认模型设为
   `acp-claude-code`）。
4. 发送任务即可在**原生会话 UI** 中看到 thinking、工具卡与回复。

## 上游版本与许可

- 上游：`@zaimokuza/dsh-acp-adapter` 0.1.0-rc.10（MIT）。运行时副本随
  `npm pack` 一起携带上游 `LICENSE`，请保留。
- 迁移 patch 与本文档：本仓库 MIT。

## 迁移内容

patch 包含：

1. `CallId` → `ToolCallId`
2. 本地 `Inbox` shim（`agent/inbox/spliced` + `session.append`）
3. 本地 `assertNever` shim
4. `session.events` → `session.snapshotEvents()`
5. `ownerCtx.agent` → `undefined`
6. `assistant/message` 去掉 `sourceEventSeqs`、补 `stream: []`
7. `settings.register` → `$DSH_HOME/dsh-acp/agents.json`
8. `createAgent` 仅在 provider 命中 `acp-*` 路由时接管；其余会话交给原生 loop（不做默认劫持）
9. Full access（`never` 策略）下 ACP 权限回 `allow-once`
10. 移除上游 `dsh.client`（客户端半区），保留原生 `ui-model-selection`
11. **持久化**：`createAgent` 走 `sessionPersistence.create()` 领取写句柄并写入 seed；
    `resumeAcpLifecycle` 改用 `open(id, 'write')` + `read(0)` + `interruptedTurnClosers()`，
    不再调用 0.2 已移除的 `persistence.prepare()`；句柄随生命周期关闭
12. **路由窥测**：`persistence.inspect()` 换为只读 `open(id, 'read')` + `read`，
    `persistence.list()` 按 0.2 的 snapshot 结构读取 `header.id`
13. **事件词表**：不再落 0.2 已不存在的 `assistant/chunk`；助手内容在段收口时
    以单条 `assistant/message`（`stream: []`）提交；assistant block 的 tool-call
    名与 `tool/call` 一致（`dsh_acp_external_tool`），否则 session query 判日志损坏
14. **远程启动语义**：profile 新增 `spawnCwd`（本机 spawn 目录）、`cwdToken`
    （args 中替换为 shell-quoted 会话 cwd）、`probeCwd`（远端模型探测目录）、
    `cwdMapFile`（按 DSH sessionId 读取远端 cwd）；远端 cwd 跳过本机 realpath，
    探针的进程 cwd 仍在本机而 `session/new` 使用 `probeCwd`

## 原生入口与恢复

CCW 的 `POST /sessions/native-create` 用 `native.provider`（默认
`acp-claude-code`）创建 DSH 会话并挂到工作区，因此 DSH 侧的会话列表、重启恢复
和会话流都按普通 DSH 会话处理。实测（2026-11-01）：

1. 新建 → 首轮完成 → JSONL 落盘；
2. 重启 DSH → 再次 prompt → 适配器 `session/resume` 恢复 ACP 上下文 → 第二轮正常完成。

会话只在生命周期关闭或 checkpoint flush 时物化；进程被 SIGKILL 时未 flush 的
尾部仍可能丢失（与原生 loop 相同）。

## SSH 原生入口

CCW 会为每台 SSH host 自动写入 `ssh` 启动器；远端目录由 `native.cwdMapFile`
按 session 提供，DSH 会话使用本地占位目录。已验证：远端执行 `pwd; hostname; ls`
返回远端机器与项目路径，DSH 重启后同一会话可继续。要求 host 配置
`probeCwd`（远端项目目录，通常含 `.claude` 配置）。

## 已知限制（P2b 待办）

- 原生会话使用 `agents.json` 的静态 profile；远程目录经 `cwdMapFile` 动态映射。
- 远端 ACP 进程不受 DSH 沙箱约束；DSH 的权限预设只约束本机启动器。
- 无 token 级流式显示：0.2 没有 `assistant/chunk`，助手文本在段结束时一次性出现。
- 权限选项未保真：Full access 下自动 `allow-once`，`allow-with-updates`
  需接回 CCW 权限 Dock。
- 上游 sidecar/audit 与 CCW 审计并存，需要划清边界。
- 未覆盖并发多会话、跨机与上游版本升级的真机回归。
- 上游客户端半区已移除，ACP 设置页与专用模型选择器不可用。

状态与验证记录见 [`docs/IMPLEMENTATION-STATUS.md`](../../docs/IMPLEMENTATION-STATUS.md) 的 P2b 一节。
