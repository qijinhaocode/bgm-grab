# 贡献约定（CONTRIBUTING）

本仓库采用 **STORY 驱动的 issue-driven 开发流程**：所有改动都要能回溯到一张 STORY 卡。

## 1. 分支模型

单人小项目：`main` 直推，每个 commit 首行绑 `STORY-NNN`。不使用功能分支，不提 PR。

## 2. Commit 规范（git hook 强制）

首行必须含 `STORY-NNN`：

```
STORY-001: 初始化仓库与流程约定
```

- 一条提交只做一件事；无编号的提交会被 `commit-msg` / `pre-push` 拦截。
- `pre-push` 只校验编号**格式**，不校验 Issue 是否真实存在（离线也能工作）。

## 3. 卡片与看板

- 先建卡再动手：`gh issue create --title "STORY-NNN · <feature>"`
- 看板：https://github.com/users/qijinhaocode/projects/8
- 完成后把卡片拖到 Done。

## 4. AI 协作纪律

- **AI 绝不自动 commit/push** —— 必须用户明确放行。
- 未经用户验证不得提交。
- 交付前逐条对照 Issue 的范围；验收判据要能区分「做对了」与「碰巧没报错」。
- 被 hook 拦住就改 commit 消息，不要绕开钩子。
