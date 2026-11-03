# MySkill

自己使用的 Skill 的维护仓库。每个子目录是一个独立技能。

## 技能列表

| 技能 | 作用 |
| --- | --- |
| [web-perf-audit](./web-perf-audit/) | 网页加载性能检测：Lighthouse 采集 + 生成含指标卡、请求瀑布、体积分析的 HTML 报告，支持复用本机浏览器登录态检测需登录页面。 |

> 新增技能后请同步更新此表。

## 新增技能

在仓库根目录新建文件夹，遵循以下结构：

```
<skill-name>/
├── SKILL.md              # 必须。YAML frontmatter + 正文
├── references/           # 可选。按需加载的参考文档
├── scripts/              # 可选。可执行脚本
├── assets/               # 可选。模板、图片等静态资源
└── ...
```

`SKILL.md` 的 frontmatter：

```yaml
---
name: <skill-name>            # 与目录名保持一致
description: <一句话说明用途与触发场景>   # 决定技能何时被选中，写准
---
```

`description` 是最关键的一行—— Agent 靠它判断何时调用该技能，要写清「做什么 + 什么情况下用」。

结构写好后更新上面的技能列表。

## 注意事项

- **不要提交凭证**：`perf-auth.json` 等含登录态的文件已在 `.gitignore` 中屏蔽，勿手动加回。
- 脚本中引用自身资源请用相对锚定（如 `$(dirname "$0")`），不要硬编码绝对路径，否则换机器即失效。
- `assets/` 为空目录时 git 不会跟踪，需要保留请放一个 `.gitkeep`。
