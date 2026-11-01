# 另一台机器的测试计划（dsh-claude-workspace P1）

> 被测版本：`dsh-claude-workspace` 0.1.0（计划 P1 核心 + 骨架）
> 编写日期：2026-11-01 · 参考计划：`dsh-claude-code-workspace-plugin-plan.md`
> 目标：在一台独立机器上复现本地与 SSH 两种真机链路，并确认 DSH Loader 能正确装配插件。

## 0. 结论定义

测试机必须能给出以下四项证据：

| 编号 | 项目 | 通过标准 |
|---|---|---|
| R1 | 静态检查与单元/集成测试 | `npm run typecheck` 通过；`npm test` 99/99 通过 |
| R2 | 本地真机端到端 | `npm run test:real` 输出 `PASS` |
| R3 | SSH 真机端到端 | `npm run test:real:ssh` 输出 `PASS` |
| R4 | DSH Loader 装配 | `--dump-config` 中出现 `claude-workspace` 行 |

P2 的会话视图、工具卡、diff 卡、权限 Dock **不在本轮范围**；不要以“Web UI 里看不到工具卡”判失败。

## 1. 机器角色

- **runner**：运行测试的机器（`npm` 命令在这里执行）。
- **target**：真正运行 Claude Code 的机器（要求已登录 `claude`，并有 `claude-agent-acp`）。

三种组合都支持：

| 组合 | 说明 | 适用 |
|---|---|---|
| A | runner = target（单机） | 最快，覆盖本地链路 |
| B | runner 通过 ssh 连 target | 覆盖远程链路 |
| C | 在 target 上直接执行 runner 命令 | 同 A，换机器验证 |

不需要开放任何入站端口；远程只使用出站 SSH，ACP 走 stdio。

## 2. 环境检查（先在 target 上逐条确认）

```sh
uname -a
node -v            # 要求 >= 22.19，建议 24
npm -v
git --version
claude --version   # 目标机必须已完成登录
command -v claude-agent-acp
```

如果 `claude-agent-acp` 不在 PATH，可以在项目目录里安装：

```sh
mkdir -p ~/ccw-e2e && cd ~/ccw-e2e
npm init -y
npm i @agentclientprotocol/claude-agent-acp@0.99.1
./node_modules/.bin/claude-agent-acp --version   # 期望 0.99.1
```

SSH 组合额外确认（在 runner 上）：

```sh
ssh -T -o BatchMode=yes <alias> 'command -v claude-agent-acp; echo ssh-ok'
ssh -T -o BatchMode=yes <alias> 'test -d <remote-project> && echo dir-ok'
```

要求：免密、`BatchMode` 下不提示、主机密钥已在 `known_hosts` 中。

**不要**复制 `claude-code-test/.claude/settings.json`、`~/.claude/.credentials.json` 或任何 token；测试机自己完成登录或使用自己的网关配置。

## 3. 获取代码

从当前机器（`/root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace`，分支 `main`）传到测试机，任选一种：

```sh
# 方式 A：git bundle（保留提交历史）
git -C /root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace \
  bundle create /tmp/dsh-claude-workspace.bundle --all
scp /tmp/dsh-claude-workspace.bundle <user>@<target>:/tmp/
ssh <user>@<target> 'git clone /tmp/dsh-claude-workspace.bundle dsh-claude-workspace && cd dsh-claude-workspace && git checkout main'

# 方式 B：rsync（不带构建产物）
rsync -a --exclude node_modules --exclude lib \
  /root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace/ \
  <user>@<target>:/opt/dsh-claude-workspace/
```

然后在测试机上安装依赖：

```sh
cd /opt/dsh-claude-workspace   # 或实际路径
npm ci
```

## 4. R1：无凭据自动化测试

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

期望：

- `typecheck` 无输出、退出码 0
- `npm test`：`tests 99 / pass 99 / fail 0`（约 0.5s）
- `build` 生成 `lib/`（含 `lib/index.js`、`lib/client.js`、`*.d.ts`）
- `pack --dry-run` 约 70 个文件，不包含 `node_modules/`

这一层不需要 Claude 凭据。若失败，先解决 Node 版本与依赖问题，不要继续真机测试。

## 5. R2：本地真机端到端

准备工作目录（Claude Code 的项目配置从这里读取）：

```sh
mkdir -p ~/ccw-e2e && cd ~/ccw-e2e
claude            # 若尚未登录，先完成登录
npm i @agentclientprotocol/claude-agent-acp@0.99.1
```

如果使用第三方网关/自定义模型，请按测试机自己的方式写 `~/ccw-e2e/.claude/settings.json`；**不要**使用当前机器上的那份。

运行：

```sh
cd /opt/dsh-claude-workspace
CCW_REAL_CWD=$HOME/ccw-e2e \
CCW_ACP_BIN=$HOME/ccw-e2e/node_modules/.bin/claude-agent-acp \
npm run test:real
```

期望输出末尾：`[real-e2e] PASS`。

脚本覆盖并断言：

1. 健康检查（可执行文件、版本、握手、`session/new`）
2. Write 允许 → 文件写入
3. Write 拒绝 → 文件不存在、工具 `failed`
4. `Edit(sub/**)` 放宽 → 规则写入、可撤销
5. 转发「don't ask again」→ Write 不落盘（预期，Claude 决定）；Bash 落盘且括号被转义
6. 执行中取消 → `cancelled`，卡片保持“已中断”
7. 模型设置 → 重启后 `session/load` 回放，全部 `replay:true`

说明：

- 会产生若干次真实模型调用；不要放进 CI。
- 脚本只创建/删除 `e2e-*.txt`、`sub/e2e-*.txt` 与临时的 `settings.local.json`，结束时恢复；不会动 `.claude/settings.json`。

## 6. R3：SSH 真机端到端

前提：

- runner 能 `ssh <alias>` 免密登录 target；
- target 上已存在 `<remote-project>` 目录，且 target 的 `claude` 已登录；
- target 上有 `claude-agent-acp`（PATH 中或绝对路径）。

运行（在 runner 上）：

```sh
cd /opt/dsh-claude-workspace
CCW_SSH_ALIAS=<alias> \
CCW_REMOTE_CWD=<remote-project> \
CCW_REMOTE_ACP=claude-agent-acp \
npm run test:real:ssh
```

如果 `<remote-project>` 依赖**项目级** `.claude/settings.json`，而目标机默认从 `$HOME` 启动进程读不到它，使用显式命令（对应设计 B7）：

```sh
CCW_SSH_ALIAS=<alias> \
CCW_REMOTE_CWD=<remote-project> \
CCW_REMOTE_ACP=<remote-project>/node_modules/.bin/claude-agent-acp \
CCW_REMOTE_COMMAND="cd <remote-project> && exec ./node_modules/.bin/claude-agent-acp" \
npm run test:real:ssh
```

期望输出末尾：`[real-ssh] PASS`。脚本覆盖：

1. SSH 可达性
2. 健康检查（`initialize` + `session/new`）
3. 远程 Write 允许 → 远程文件内容正确
4. 远程 Write 拒绝 → 远程文件不存在
5. 远程「放宽」→ 明确拒绝（P1 预期限制，不是缺陷）

脚本只创建/删除 `<remote-project>/ccw-e2e-ssh-*.txt`，不会修改远程设置文件。

## 7. R4：DSH Loader 装配（可选但建议）

在装有 `deepseek-harness` 源码的机器上，用隔离的 `DSH_HOME`，避免影响个人配置：

```sh
export DSH_HOME=$(mktemp -d)
pnpm dsh plugin --profile ccwtest add /opt/dsh-claude-workspace
pnpm dsh --profile ccwtest --dump-config | grep -A3 'dsh-claude-workspace'
rm -rf "$DSH_HOME"
```

期望看到：

```yaml
# == dsh-claude-workspace
- id: claude-workspace
  name: dsh-claude-workspace
  config: {}
```

P1 不接管 `agent-loop`，因此装上后普通 DSH 会话行为不变。完整 boot 需要模型凭据，本轮不作要求。

## 8. 验收矩阵

| 编号 | 命令 | 期望 | 记录 |
|---|---|---|---|
| R1a | `npm run typecheck` | 退出码 0 | 通过/失败 |
| R1b | `npm test` | 99/99 | tests/pass/fail |
| R1c | `npm run build` | 生成 `lib/` | 产物文件数 |
| R2 | `npm run test:real` | `PASS` | 回放事件数、权限选项 kind |
| R3 | `npm run test:real:ssh` | `PASS` | 是否用了 `CCW_REMOTE_COMMAND` |
| R4 | `--dump-config` | 出现 `claude-workspace` 行 | 片段 |

## 9. 需要回传的证据

请把结果整理成 `test-report-<host>-<date>.md`，包含：

- `uname -a`、`node -v`、`claude --version`、`claude-agent-acp --version`
- 每条命令的退出码与关键输出（可截断，但保留 `PASS`/FAIL 与错误信息）
- R2/R3 的 `stopReason`、`session/load` 回放条数、权限选项的 `kind/optionId`
- 任何与预期不符的行为

**禁止回传**：`.claude/settings.json` 内容、`~/.claude/.credentials.json`、任何 token、`env` 值。错误日志如含路径可保留，含密钥请先删除。

## 10. 安全与成本

- 真实模型调用会产生费用；只跑一次完整脚本即可，不要循环压测。
- 不要使用 `--dangerously-skip-permissions` 绕过权限；本轮要验证的正是权限链路。
- 只连接自己拥有的主机；保持 `StrictHostKeyChecking=yes`。
- 测试结束后确认目标目录无 `ccw-e2e-*` 残留、临时 `DSH_HOME` 已删除。

## 11. 已知且预期的现象（不要当缺陷上报）

| 现象 | 原因 |
|---|---|
| 远程「放宽」直接报错 | P1 未实现 SSH 设置桥（P3） |
| Write 的「don't ask again」没有写设置文件 | Claude 的 Edit suggestion 可能是会话级（A1） |
| 安全命令（如 `echo`）不弹权限 | Claude 自己放行，ACP 不产生 permission 请求 |
| `session/load` 回放条数每次不同 | 与历史事件数量有关，脚本只断言 `> 0` 且全部 `replay:true` |
| 无法直接读取“当前模型” | ACP 没有查询接口；脚本只验证设置调用成功 |
| 目标机未登录 | 健康检查可能仍通过，首次 prompt 才报认证错误；提示去目标机 `claude` 登录 |

## 12. 失败排查

| 症状 | 处理 |
|---|---|
| `claude-agent-acp not found` | 设置 `CCW_ACP_BIN` / `CCW_REMOTE_ACP`，或在项目目录安装 0.99.1 |
| `EBADENGINE` / 语法错误 | Node < 22.19，升级 Node |
| `ssh ... exited 255` | 检查免密、`known_hosts`、`BatchMode`；确认 alias 在 `~/.ssh/config` |
| 健康检查通过但 prompt 报认证失败 | 目标机未登录，或项目级设置未加载；用 `CCW_REMOTE_COMMAND` 指定 `cd` |
| 等待权限超时 | 模型可能直接放行；确认 prompt 明确要求 Write 或高风险 Bash |
| `session/load failed` | 绑定记录与目标机会话不一致；删除本地 `dataDir` 后重新创建会话 |
| 端口/网络问题 | 本插件只用 loopback HTTP 与出站 SSH，不需要入站端口 |

## 13. 快速复制块

```sh
# 单机
cd /opt/dsh-claude-workspace
npm ci && npm run typecheck && npm test && npm run build
CCW_REAL_CWD=$HOME/ccw-e2e CCW_ACP_BIN=$HOME/ccw-e2e/node_modules/.bin/claude-agent-acp npm run test:real

# runner → target
CCW_SSH_ALIAS=<alias> CCW_REMOTE_CWD=<remote-project> npm run test:real:ssh
```
