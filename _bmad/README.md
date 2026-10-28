# BMad 项目执行器

本目录补齐已安装 `bmad-build` skill 所需的项目级运行脚本。它不替换现有 PRD、架构或开发计划，也不重新安装代理/技能目录。

## 来源与依赖

- 固定上游包：`bmad-method@6.12.0`，来源为 npm 官方注册表。
- 包地址、完整 SHA-512 SRI、逐脚本 SHA-256 和核验日期记录在 `runtime-installation.json`。
- 五个 `scripts/` 文件与该上游包逐字节一致；MIT 许可证保留在 `LICENSE`。
- 运行要求：Python 3.11+，仅依赖 Python 标准库。推荐按 skill 入口使用 `uv run --no-cache`，本机已具备可用的 Python 3.12；不需要新增 pip 依赖。

## 本项目配置

`config.toml` 使用简体中文，将规划产物指向 `docs/planning`，实施产物指向 `docs/implementation`，项目知识指向 `docs`。未复制其他项目的个人配置、定制工作流或凭据。

需要团队定制时遵循运行器的分层机制：`_bmad/custom/config.toml` 和 `_bmad/custom/<skill>.toml`；个人配置使用对应的 `.user.toml`。个人配置及包含机器绝对路径的 `render/` 快照由本目录 `.gitignore` 排除。

## 使用边界

调用 `bmad-build` 时，遵循其已安装 `SKILL.md`：运行一次规定的 `render_skill.py` 命令，然后只读取并遵循它打印的快照 `workflow.md`。渲染失败应报告错误；不要改为直接执行未渲染的工作流源文件。

新配置或 skill 源码会产生新的不可变快照；同输入再次读取会核验原快照哈希。快照被改写或包含未知文件时运行器会拒绝继续。

`memlog.py` 保持上游原始脚本及哈希，调用方需要遵守以下上游限制：

- 上游没有并发读改写保护。同一 workspace 只能有一个写入者；并行任务使用各自的 workspace，不并发追加或修改同一份 memlog。
- 上游不拒绝格式错误的元数据字段键。调用方只使用预先固定的单行 ASCII 键，例如 `topic`、`scope`、`purpose`、`altitude`；用户自由文本只能放在值中，不能用作键。

## 离线检查

在项目根目录运行：

```sh
uv run --no-cache --python 3.12 python -B -m unittest discover -s _bmad/tests -v
```

检查覆盖：上游文件完整性、项目路径/中文配置、缺失配置时停止、快照损坏时停止、合成 review_layers 指令与 skill-root 快照路径，以及 memlog 追加与拒绝覆盖。已安装 Build skill 的输入契约另作只读解析；检查不激活它、不执行实际工作流，也不访问应用数据库或模型。

全局 `bmad-build` skill 未安装的环境会跳过该主机专用输入检查；其余离线检查仍运行。执行器可用不代表业务故事已实现或应用可发布。
