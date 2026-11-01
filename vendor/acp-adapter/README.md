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

## 已知限制（P2b 待办）

- 不是 CCW 工作区/主机模型：目前使用静态 `agents.json`。
- 原生模型选择器在已有会话内切换 ACP 不会重建 Agent；opt-in 入口仍需完善
  （CCW 右侧栏控制台是当前可靠的 Claude 入口）。
- 权限选项未保真：Full access 下自动 `allow-once`，`allow-with-updates`
  需接回 CCW 权限 Dock。
- 上游 sidecar/audit 与 CCW 审计并存，需要划清边界。
- 未覆盖恢复、并发、跨机与上游版本升级。
- 上游客户端半区已移除，ACP 设置页与专用模型选择器不可用。

状态与验证记录见 [`docs/IMPLEMENTATION-STATUS.md`](../../docs/IMPLEMENTATION-STATUS.md) 的 P2b 一节。
