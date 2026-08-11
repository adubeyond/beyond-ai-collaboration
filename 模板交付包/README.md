# BEYOND 3.1 控制仓交付包

本目录用于建立一个与业务项目平级的`beyond-control`控制仓。它同时保存 BEYOND正式文档、六个 Skills源码、项目级 BEYOND文档、团队任务和协同内容；业务代码继续留在各自项目仓。每个成员自己的工作台位于`local/`并由 Git忽略。

## 1. 使用入口

控制仓中的 Codex先读根[AGENTS.md](AGENTS.md)。项目初始化会把完整运行内核融合进业务项目根`AGENTS.md`，并合并项目级`.codex`身份护栏，所以从控制仓或业务项目进入时都使用同一套分流；本文只帮助人了解交付包，不参与运行分流。

最常见的五种路径是：

| 用户意图 | 进入方式 |
| --- | --- |
| 普通问答或只读判断 | 当前基础智能体直接处理，不建立任务 |
| 清晰的设计、开发、测试或运维请求 | 当前基础智能体按需使用一个 Action Skill |
| 平台已经给出正式业务任务 | 先进入 Worker，再由 Worker选择和切换 Action Skill |
| 接手项目、继续主线或管理多个任务 | 进入 PM，按最小项目文档链恢复主线 |
| 建立或拉取团队任务与协同 | 进入 PM，只读取团队任务与协同入口并调用固定脚本 |

具体读取顺序、冲突检查和授权边界以 [AGENTS.md](AGENTS.md) 为准，不从本文推断。

## 2. 身份与 Action Skills

身份回答“谁对结果负责”，Action Skill回答“当前用什么软件工程方法”。Skill 是方法，不是新的智能体，也不改变任务控制权。

| 身份 | 源码 | 用途 |
| --- | --- | --- |
| PM | [identity-pm](skills/identity-pm/SKILL.md) | 管理项目主线、任务、协调、验收和收口 |
| Worker | [identity-worker](skills/identity-worker/SKILL.md) | 对一个正式业务结果连续负责 |

| Action Skill | 源码 | 用途 |
| --- | --- | --- |
| 设计 | [task-design](skills/task-design/SKILL.md) | 需求、架构、边界、契约、实施与验收设计 |
| 开发 | [task-dev](skills/task-dev/SKILL.md) | 实现、修复、工程自检和代码交付 |
| 测试 | [task-test](skills/task-test/SKILL.md) | 验证实现、定位失败并给出测试裁决 |
| 运维 | [task-ops](skills/task-ops/SKILL.md) | 环境、部署、观察、故障恢复和回滚 |

正式任务由同一 Worker 根据当前主要问题依次切换方法，不按 Skill 数量拆任务。用户直接调用 Action Skill 时，由当前基础智能体执行并直接交付，不凭空制造 PM、Worker 或任务事件。

`skills/`保存的是源码，不代表当前 AI 工具已经安装并加载。已安装时可以使用`$identity-pm`、`$task-dev`等技术入口；源码直读时可以明确点名对应`SKILL.md`。目录名、frontmatter `name`和技术入口保留英文，展示说明使用中文。

Skill 无法识别时优先检查 UTF-8 无 BOM、文件头、frontmatter、安装副本和加载缓存。slash 命令只有在具体工具已另行配置映射时才有效，不是本模板默认入口。

安装或升级后，先在Codex的Hook入口审核并信任BEYOND身份护栏，再运行[安装验真脚本](scripts/verify-install-integrity.mjs)，同时指定实际 Codex Skills目录和已经完成融合的项目根`AGENTS.md`。脚本会逐文件对账六个 Skill、项目Hook和护栏脚本，核对控制仓结构，并忽略项目覆盖和原生规则保留区后校验完整运行内核；退出码非零时仍是旧版、弱入口、残留版或混合版本，不能宣布升级完成。验真通过后再重启 Codex并创建新任务。Hook内容变化后需要重新信任一次；这不是每个任务的审批。

项目特有稳定覆盖写在`AGENTS.md`的专用覆盖区，原有长规则保存在项目原生规则区。模型策略必须明确适用于 PM还是 Worker；用于新 Worker的模型分档不会改变当前 PM模型。初始化或升级后应把不含秘密的根入口纳入业务项目版本管理，否则未来无法可靠追溯规则由谁写入。

## 3. 项目文档

| 入口 | 只负责 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 第一入口、请求分流、最小读取和全局边界 |
| [00-模板入口](docs/AI编程协同机制/00-模板入口.md) | 项目文档链、缺失与冲突、事实归位和历史回收 |
| `local/当前工作台.md` | 当前成员自己的 PM主线、正式任务、三态、进度和按需协调，不进入 Git |
| `projects/<project-id>/项目总览.md` | 对应项目稳定定位、业务边界、项目结构和长期事实入口 |
| `projects/<project-id>/项目事实/README.md` | 对应项目技术栈、测试、服务器、发布、安全等实际长期事实入口 |
| [跨任务协同与共享对象机制](docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md) | 正式任务之间的依赖、共享对象、接力和冲突 |
| [团队任务与协同](docs/AI编程协同机制/团队任务与协同.md) | 内部成员通过共享 Git传递任务、共同目标和结果 |
| [格式模板](docs/AI编程协同机制/模板) | 任务卡、交接、设计、架构、工程、测试、环境和发布等可选格式 |
| [记录区](docs/AI编程协同机制/记录) | 任务明细、生产记录和历史回收 |

默认只读取当前问题需要的入口，不展开历史、所有项目事实、全部模板或未来动作材料。

项目已有正式 README、设计、架构、接口、测试或运维文档时，初始化先调查，再由用户逐组选择迁入控制仓、保留原位置并登记，或暂不处理。没有用户确认不复制、覆盖或删除。

`模板/`只提供结构，不证明真实项目已经具备对应事实。项目文档与当前代码、Git、测试、配置、服务或环境冲突时，以当前一手事实为准，并在授权内修正唯一正式入口。

密码、私钥、Token、Cookie、验证码等秘密值不得写入模板、项目总览、工作台或项目事实。

## 4. 初始化入口

先把本目录作为独立`beyond-control`放在业务项目同级，然后运行：

```powershell
node scripts/beyond-control.mjs init-control
```

安装成功后必须直接向用户展示两个可在未接入项目中生效的入口：

```text
$identity-pm
使用 BEYOND 初始化这个新项目。
```

```text
$identity-pm
使用 BEYOND 接入或升级这个已有项目。
```

新项目按需询问尚不存在的事实；已有项目先调查代码、Git、`AGENTS.md`和Markdown，只询问缺失与冲突。用户确认以 BEYOND为主融合后，再运行项目入口安装动作；固定脚本会备份原入口、保留项目原生规则并建立本机/共享项目登记。

```powershell
node scripts/beyond-control.mjs inspect-project --project-root "<业务项目目录>"
node scripts/beyond-control.mjs install-project-entry --project-root "<业务项目目录>" --confirm-fusion yes
```

本地融合不自动推送。固定脚本会建立共享项目登记、最小项目总览和最小事实索引，保证融合入口立即可达；需要让其他成员取得这些基础时，用户另行授权远端Git后，再用`project-registration`范围精确推送同一项目的这三份文件。该范围不能提交后续事实正文、其他项目文档或业务代码。

团队模式下所有内部成员克隆同一个控制仓。用户说“拉取一下任务和协同”时，由 PM调用固定脚本同步并按当前 Git身份汇总；普通个人任务不读取`shared/`。

PM查看本机任务或在验收后收拢已完成任务时，使用同一个固定脚本；收拢只处理明确点名、已有正式结果且不再影响主线的thread，执行前自动备份`local/`：

```powershell
node scripts/beyond-control.mjs workbench --action list
node scripts/beyond-control.mjs workbench --action archive --threads "<正式thread>"
```
