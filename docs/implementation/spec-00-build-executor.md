---
title: 阶段0：可重复执行的BMad与分阶段PR验证
type: chore
created: '2026-10-29'
status: done
route: dispatch
review_loop_iteration: 0
baseline_commit: 7dc0b333904264379cb2be49a3ae510087040f6e
context:
  - AGENTS.md
  - docs/repository-contributing.md
---

<frozen-after-approval reason="用户已授权补齐执行器并连续阶段开发/验收/提交PR">

## Intent

**Problem:** 已确认4个Epic的开发需要可用的BMad执行入口和不漏检的依赖PR。当前项目没有执行器，CI只覆盖master目标。

**Approach:** 保留规划与现有应用，安装经校验的最小官方runtime；让指向本项目codex功能分支的叠加PR执行与master相同的只读检查。用户已授权阶段自主验收与commit/PR，不需要重复菜单批准。

## Boundaries & Constraints

**Always:** 中文产物；固定Node22.22.1、pnpm10.28.2；完整保留当前CI、PR格式与Linux制品检查；脚本来源与哈希可核验；只修改本仓库。

**Never:** 不修改其他应用、数据库、生产服务；不复制其他项目配置或凭据；不升级模型/Next/React；不将本机render快照和私密记录入Git；不自动合并或发布。

## I/O & Edge-Case Matrix

| 场景 | 输入 | 结果 | 失败处理 |
| --- | --- | --- | --- |
| 正常渲染 | 安装后的中文config和本机Build skill | 输出不可变workflow绝对路径 | 不直接执行未渲染源文件 |
| 配置缺失/快照被改 | 不完整或损坏输入 | 拒绝渲染 | 不制造宽松替代执行器 |
| 依赖PR | 目标master或codex/** | 相同的只读CI/格式检查 | 不提供生产secrets |
| 无关分支push | 非master | 不触发发布或额外生产动作 | 现有发布入口不变 |

</frozen-after-approval>

## Code Map

- `_bmad/scripts/`：5个已校验的bmad-method6.12.0官方脚本，保持逐字节来源一致。
- `_bmad/config.toml`、`runtime-installation.json`、`tests/test_runtime.py`：独立项目中文配置、来源与离线检查；已由前置安装任务生成，避免重复实现。
- `.github/workflows/ci.yml`、`pr-format.yml`：只读PR检查；生产发布不在这两个工作流中。
- `scripts/release/tests/test_workflows.py`：保护分支过滤、只读权限和既有检查的回归契约。
- `docs/planning/`、`docs/product/`、`docs/architecture/`：已确认规格，原样保留。

## Tasks & Acceptance

**Execution:**
- [x] `_bmad/` — 最小官方runtime、许可证、来源校验、中文配置、render/个人配置忽略规则与离线测试。
- [x] `.github/workflows/ci.yml` — pull_request目标加入`codex/**`，保持push只master及现有检查；Python就绪后加入BMad runtime离线检查。
- [x] `.github/workflows/pr-format.yml` — 同样扩展PR目标，保持只读权限和元数据校验。
- [x] `scripts/release/tests/test_workflows.py` — 保护叠加PR覆盖与push范围、现有检查、无生产secrets的行为，不放宽安全断言。
- [x] `docs/repository-contributing.md` — 简述依赖PR增量、基线更新后重跑检查、用户保留合并/发布授权。

**Acceptance Criteria:**
- Given 正常配置，when 激活skill，then workflow成功生成，且官方runtime源文件哈希一致。
- Given 叠加PR，when 检查触发，then 与master使用同一检查任务；PR不获得写权限或生产secrets。
- Given 当前文档与代码工作区，when 完成准备，then 保留既有改动、无凭据/生成快照入Git。

## Implementation Notes

2026-10-29：用户授权在Goal中连续完成全部范围；本规格只是阶段0。runtime已成功用规定入口激活。目标浏览器ego lite曾创建空间11，随后空间API返回空、原生UI通道未授权；浏览器验收暂未执行，不重建或接管其他任务空间。

## Spec Change Log

## Review Triage Log

| 来源 | 判断 | 证据与处理 |
| --- | --- | --- |
| Blind：PR目标更改遗漏CI | medium / patch | 已加入edited事件；元数据编辑与代码事件分并发通道，避免取消正在进行的完整检查；没有跳过代码job。 |
| Blind：memlog并发覆盖 | medium / defer | 官方固定版本的既有局限；当前调用由主代理按workspace串行执行，README明确单写者；不擅改已校验上游脚本。 |
| Edge：memlog并发覆盖 | medium / defer | 与上一条同根因，保留独立记录；后续若引入同日志多写者必须先升级或增加可信串行边界。 |
| Edge：元数据字段换行 | low / defer | 调用仅使用固定单行ASCII键，用户输入放value；README记录约束，当前无动态字段键消费者，不修改官方脚本。 |
| Edge：全局skill符号链接 | medium / patch | 本机测试将skill目录strict resolve后交给renderer；支持合法链接安装且保留逃逸检测。 |
| Verification：定制审阅层完整渲染缺口 | medium / patch | 新增合成customize/review文件的完整render测试，断言文本、绝对快照路径和目标文件存在，无需激活真实Build。 |

## Verification

- `uv run --no-cache --python 3.12 python -B -m unittest discover -s _bmad/tests -v`
- `python3 -m unittest discover -s scripts/release/tests -p test_workflows.py -v`
- `pnpm test:pr`、`pnpm release:check`（固定Node22.22.1）
- `actionlint`、`git diff --check`。

2026-10-29 本地执行记录：初轮使用固定 Node v22.22.1、pnpm 10.28.2，工作流/发布元数据测试 21/21、PR 格式测试 8/8 与 `pnpm release:check` 通过。审阅修正后，runtime 离线测试 6/6、`WorkflowSafetyTests` 14/14、`actionlint .github/workflows/ci.yml`、`git diff --check` 通过；修正轮只运行受影响的检查，未重跑发布元数据和应用全量测试。已确认 `_bmad/render/` 被忽略，既有规划和应用改动保留。GitHub PR 事件与 Linux 制品检查需在提交后的远端 CI 验证，本地结果不替代该层证据。

补充：根据当前 release-please.yml 同步 contributing 中已过期的 GITHUB_TOKEN/workflow_dispatch 说明；没有更改发布工作流或其秘密。

主代理最终复验：runtime 6/6、工作流/发布元数据 22/22、PR格式 8/8、release:check、actionlint、diff检查通过；审阅中的CI重定向、符号链接和渲染覆盖问题已修正。两项上游memlog局限记录于deferred-work.md并以调用约束避免；远端CI和Linux制品待PR回读。
