# 实现状态（对照 CCW 计划）

> 计划：`.claude/plan/dsh-claude-code-workspace-plugin-plan.md`（DSH 0.2.1-rc.5，2026-11-01）
> 本仓库：`/root/autodl-tmp/code/wangzhengzhuo512/dsh-claude-workspace`
> 本轮范围：P1 可运行核心 + 完整骨架（用户确认）。

## 总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 可行性 | 已完成（计划提供） | 握手、prompt、权限、diff、取消、`session/load`、ssh 传输均有实测记录。 |
| P1 工作区与本地会话 | **本轮完成（核心）** | 工作区模型/目录派生/登记、HostOps（local+ssh）、ACP 进程池、会话绑定、权限门（永不超时/如实转发/放宽）、审计、恢复、HTTP 控制面。 |
| P2 呈现层 | 骨架 | 设置页控制面（工作区/会话/审批/规则）+ loopback API；**未**接管 `agent-loop`、无会话视图/工具卡/diff 卡/权限 Dock/回放分隔。 |
| P3 远程 | 部分 | `HostOps` ssh 实现、`ssh -T` stdio、keepalive、探测、远端建目录；未做远端写设置（「放宽」在远程被明确拒绝）。**远端尚未真机回归。** |
| P4 细节对齐 | 未开始 | 会话树、子 agent、斜杠命令、@ 文件、图片 UI、模型/effort 选择器（API 已有）。 |
| P5 硬化 | 部分 | 原子写、审计、审计保留、行/输出上限；未做打包发布、兼容矩阵 CI。 |

## §12.3 实现顺序对照

| 步 | 计划内容 | 本轮结果 |
|---|---|---|
| 1 | 骨架 + bundle patch（禁用 `agent-loop` / `ui-model-selection`，插自己的行） | 部分：`package.json`、`cordis.patch.yml`、`apply()` 可加载；**只插入插件行**，两行未禁用（P1 不接管会话，禁用会让普通会话失去 loop）。`--dump-config` 未在本机 DSH 环境验证。 |
| 2 | Host ACP 客户端 + workspace store（本地） | 完成：`config`、`host/*`、`acp/*`、`workspace/*`、`gate/*`、`audit`、`service`；用假 ACP 全流程验证。 |
| 3 | 客户端 UI：会话视图 + 工具卡 + 权限 Dock | 骨架：`src/client.js` 注册 `settings.section`，提供工作区/主机/会话/审批/规则操作；工具卡与 Dock 待 P2。 |
| 4 | remote HostOps + 健康检查 | 本地真机完成；ssh 分支有代码与单测，**未在 ssh 目标上真机回归**；默认 no-cd 形态与 `cd … && exec` 形态都支持。 |
| 5 | 恢复/并发/中断 | 完成：`session/load` 重放标记、load 后重设 model/effort、同工作区双会话权限路由、`session/cancel` → 卡片 `cancelled`。假 ACP 验证。 |
| 6 | 硬化与打包 | 部分：原子写、`.bak`、回读校验、损坏 JSON 拒绝、审计、行上限、输出上限；冲突检测/安装卸载验证待 P2。 |

## 已验证行为（自动化）

`npm test`：99 个用例全部通过。

- 工作区：派生命名（摘要稳定、`a:b` vs `a-b`、100 字符、前缀校验）、显式目录、重复目录解析、登记失败不留记录且保留目录、移除不删目录、派生目录删除的包含性校验、`per-session` 派生。
- Host：POSIX 引号（空格/单引号/`$()`/通配/中文）、ssh argv（BatchMode/keepalive/`--`）、严格主机密钥开关。
- ACP：NDJSON 半行/CRLF/非法 JSON/超长行/服务器请求/通知/关闭拒绝 pending。
- 事件：`toolCallId` 身份、标题更新不新增卡片、状态机、diff 行级统计、`plan`/`commands`/`mode`、未知更新保留、取消只改运行中卡片。
- 权限：默认不超时、应答校验选项归属、重复请求折叠、断线/超时 expired、按会话过滤。
- 放宽：`Bash(cmd:*)` / `Bash` / `Edit(src/**)` / `Edit(**)` / `Read(**)` / `WebFetch(domain:…)` / `mcp__server`、绝对路径越界拒绝、Claude 风格转义、内存规则匹配。
- 设置写入：缺失初始化、保留其他键与顺序、去重、非法 JSON/非数组拒绝且原文件不动、`.bak`、回读校验、并发串行、撤销。
- 集成：允许 → 文件写入；拒绝 → 文件不存在且工具 failed；前缀放宽 → 文件出现 `Bash(npm test:*)`、可撤销；取消 → `cancelled`；重启 → `session/load` 回放且 `replay:true`、模型重设；双会话权限独立；健康检查握手+建会话；HTTP 校验。

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
3. **远程「放宽」未实现**：`previewWiden` 对 ssh 工作区直接报 `widen-unsupported`，提示改用 Claude 自己的「don't ask again」。P3 需要 SSH 读/写/原子替换设置文件的通道。
4. **无终端 PTY / 子 agent 会话树 / MCP 注入 / 历史缓存（IndexedDB）**：计划中的 P4 范围。
5. **审计写失败不阻断请求**：`#auditDecision` 吞掉写入错误，避免审计盘满导致权限流程卡死；这属于有意的可用性取舍，P5 可改为显式告警。
6. **健康检查版本探测**：使用主机配置的可执行文件（默认 `claude-agent-acp`），版本区间可配；探测不到版本时只做握手判断。

## 计划遗留问题（Q8–Q17）当前结论

| 编号 | 本轮结论 |
|---|---|
| Q8 | 不 fork，独立实现（见上）；P2 前做一次 agent-loop 接管的 spike 决定复用还是自写 ACP agent 适配层。 |
| Q9 | 只实现 ACP v1；v2 未评估。 |
| Q11 | 已在 `#load` 后重新应用 `model`/`effort`/`mode`；真机已执行「设为 default → 重启 load → 重设无报错，回放 31 条」，但因 ACP 无读取当前模型的接口，未直接断言加载后的实际模型值。 |
| Q12 | 自动放行写审计 `auto:<rule>`；真机确认取消后卡片保持 `cancelled`。UI 的 auto 徽标仍待 P2。 |
| Q13 | 本机 Node 24.14.0 下真实 ACP 通过；包声明 `>=22.19.0`，未在 Node 20 上验证。 |
| Q15 | 真机观察到 Claude 转发路径写入 `Bash(python3 -c 'import time; time.sleep\(2\)')`，与本插件 `escapeRule` 的转义规则一致。 |
| Q16 | 工具级规则（只写 `Bash`/`Edit`/`WebFetch`）是否等价全放行未真机验证。 |
| Q17 | 用户级写入需 `confirmed:true`，预览显示文件与规则；交互稿未做。 |

## 下一步（建议顺序）

1. **P1 真机回归**：本机已完成本地 `test:real` 全流程；剩余 `dsh plugin --profile <test> add <路径>` + `--dump-config` 的插件加载验证（会改 `~/.dsh`，本轮未执行）与 ssh 目标真机回归。
2. **P2 接管 agent-loop**：实现 `agent-loop` 子类/工厂、`setFactory` 冲突检测、`ui-model-selection` 替换；把 `src/client.js` 从设置页控制面迁到 `conversation.*` 工具卡与权限 Dock。
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
