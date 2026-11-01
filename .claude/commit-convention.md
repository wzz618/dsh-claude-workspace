# 提交信息规范

## 格式

```
<type>(<scope>): <简短描述>

<可选正文，说明 why>
```

- **type**：`feat` 新功能 / `fix` 修复 / `chore` 杂项（配置、依赖等） / `refactor` 重构 / `docs` 文档 / `test` 测试
- **scope**：受影响的模块，如 `config`、`host`、`acp`、`workspace`、`gate`、`audit`、`client`、`core`
- **简短描述**：中文，动词开头，一句话说清楚做了什么，不超过 50 字左右，不加句号
- **正文**：非必须。只有当改动的动机不是从 diff 里能看出来的时候才写（比如修复的 bug 背景、为什么这么改而不是那么改）

## 示例

```
fix(config): 本地 ACP 进程以工作区目录为 cwd 启动，确保读到项目级设置
fix(acp): 取消后的工具卡保持 cancelled，不被后续 failed 覆盖
feat(gate): 增加「本命令及参数变体」放宽规则与撤销
chore: 添加真机端到端脚本与实现状态文档
```

## 注意事项

- 只提交明确要求的改动，不要顺手夹带无关文件
- 不要在提交信息里写 `Co-Authored-By: Claude`
- 优先新建 commit，而不是 `--amend` 已经存在的 commit（除非用户明确要求）
- 用户说「整理成一个」时用 `git reset --soft <base>` 后重新提交，不要留一堆碎提交

## 本项目补充

- **不提交构建产物**：`lib/`、`node_modules/` 不进仓库，发布前用 `npm run build` 生成
- **不提交真机测试产物**：`e2e-*.txt`、`.claude/settings.local.json`、临时 `DSH_HOME` 都不进仓库
- **提交前**至少跑 `npm run typecheck && npm test`；改动 ACP/权限/恢复链路时再跑 `npm run test:real`
- **不读取或复制凭据**：`claude-code-test/.claude/settings.json` 含网关 key，只作为测试环境使用
- **只整理本窗口的提交**：不要 `reset --soft`、rebase 或 `--amend` 其他窗口产生的 commit
