import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const strictCandidate = process.argv.includes("--strict-candidate");

const publicTopLevel = new Set([
  ".github",
  ".gitignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.zh-CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SECURITY.en.md",
  "docs",
  "examples",
  "scripts",
  "模板交付包",
]);

const publicEntries = [
  ".github",
  ".gitignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.zh-CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SECURITY.en.md",
  "docs",
  "examples/minimal-project",
  "scripts",
  "模板交付包",
];

const errors = [];
const decoder = new TextDecoder("utf-8", { fatal: true });
const allowedBinaryAssets = new Set([".github/assets/social-preview.png"]);

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

function collectFiles(path) {
  if (!existsSync(path)) {
    return [];
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    errors.push(`不允许符号链接：${normalizeRelative(relative(repositoryRoot, path))}`);
    return [];
  }
  if (stat.isFile()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .flatMap((entry) => collectFiles(join(path, entry.name)));
}

function isPublicPath(path) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) {
    return false;
  }
  const top = rel.split("/")[0];
  return publicTopLevel.has(top);
}

function decodeText(path) {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    errors.push(`UTF-8 BOM：${normalizeRelative(relative(repositoryRoot, path))}`);
  }
  if (bytes.includes(0)) {
    errors.push(`公开候选包含二进制或 NUL：${normalizeRelative(relative(repositoryRoot, path))}`);
    return null;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    errors.push(`不是严格 UTF-8：${normalizeRelative(relative(repositoryRoot, path))}`);
    return null;
  }
}

function validateBinaryAsset(path) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  const bytes = readFileSync(path);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (rel !== ".github/assets/social-preview.png") {
    errors.push(`未定义校验规则的二进制资产：${rel}`);
    return;
  }
  if (bytes.length > 1024 * 1024) {
    errors.push(`社交预览图超过 1 MiB：${rel} (${bytes.length} bytes)`);
  }
  if (bytes.length < 24 || !pngSignature.every((value, index) => bytes[index] === value)) {
    errors.push(`社交预览图不是有效 PNG：${rel}`);
    return;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1280 || height < 640 || width !== height * 2) {
    errors.push(`社交预览图尺寸必须为至少 1280×640 的 2:1：${rel} (${width}×${height})`);
  }
}

function validateMarkdownLinks(path, text) {
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+["']/)[0];
    }
    if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/i.test(target)) {
      continue;
    }
    const cleanTarget = target.split("#")[0].split("?")[0];
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(cleanTarget);
    } catch {
      errors.push(`无法解码链接：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
      continue;
    }
    const resolved = resolve(dirname(path), decodedTarget);
    if (!existsSync(resolved)) {
      errors.push(`断开的本地链接：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
      continue;
    }
    const canonical = realpathSync(resolved);
    if (!isPublicPath(canonical)) {
      errors.push(`链接逃出公开范围：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
    }
  }
}

function validateMarkdownFences(path, text) {
  let active = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) {
      continue;
    }
    const marker = match[1][0];
    if (active === null) {
      active = marker;
    } else if (active === marker) {
      active = null;
    }
  }
  if (active !== null) {
    errors.push(`Markdown 围栏未闭合：${normalizeRelative(relative(repositoryRoot, path))}`);
  }
}

const sensitivePatterns = [
  ["真实 Codex 对话链接", new RegExp("codex" + ":\\/\\/threads", "i")],
  ["疑似真实 thread ID", /\b019f[0-9a-f-]{12,}\b/i],
  ["Windows 绝对路径", /\b[A-Za-z]:\\[^\s`"'<>]+/],
  ["用户目录绝对路径", /\/(?:Users|home)\/[^\s`"'<>]+/],
  ["内网 IPv4 地址", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
  ["疑似动态 SHA-256", /\b[0-9a-f]{64}\b/i],
  ["疑似秘密赋值", /\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ["私钥正文", new RegExp("BEGIN" + " (?:RSA |EC |OPENSSH )?PRIVATE KEY")],
];

function validateText(path, text) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (/[ \t]+$/m.test(text)) {
    errors.push(`尾随空白：${rel}`);
  }
  for (const [label, pattern] of sensitivePatterns) {
    if (pattern.test(text)) {
      errors.push(`${label}：${rel}`);
    }
  }
  if (extname(path).toLowerCase() === ".md") {
    validateMarkdownLinks(path, text);
    validateMarkdownFences(path, text);
  }
  if ([".yml", ".yaml"].includes(extname(path).toLowerCase()) && /\t/.test(text)) {
    errors.push(`YAML 包含 Tab 缩进：${rel}`);
  }
}

if (strictCandidate) {
  for (const entry of readdirSync(repositoryRoot, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--", entry.name], {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
      continue;
    } catch {
      // A non-zero exit means the entry is not explicitly excluded by Git.
    }
    if (!publicTopLevel.has(entry.name)) {
      errors.push(`严格候选包含未授权顶层入口：${entry.name}`);
    }
  }
}

const files = publicEntries.flatMap((entry) => collectFiles(join(repositoryRoot, entry)));
const uniqueFiles = [...new Set(files.map((path) => resolve(path)))].sort();

for (const path of uniqueFiles) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (allowedBinaryAssets.has(rel)) {
    validateBinaryAsset(path);
    continue;
  }
  const text = decodeText(path);
  if (text !== null) {
    validateText(path, text);
  }
}

const requiredSkillFacts = [
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM keeps the workbench as a dashboard",
    value: "当前工作台是 PM 的团队仪表盘，不是业务执行许可证或 Git 真值副本",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM uses a six-field task packet",
    value: "普通任务包最多包含六项",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM does not promote discussion into task control",
    value: "讨论、建议、候选方案和 PM推断没有控制效力",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "a design checkpoint does not create an implementation Worker",
    value: "不得再建立一个实施 Worker",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "formal worker prompt starts only the Worker identity",
    value: "在新任务初始提示首行只放`$identity-worker`",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "formal workers use fresh project tasks instead of forks",
    value: "全新用户可见项目任务",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "formal project tasks do not degrade to projectless",
    value: "不得因平台项目列表暂时缺失而降级成 projectless",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker completes reversible in-scope work continuously",
    value: "范围内可逆本地动作不逐步申请业务授权",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "direct requests do not invent managed tasks",
    value: "不凭空制造 PM、正式任务、任务台或生命周期消息",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker does not present an unreleased candidate as currently usable",
    value: "当前用户页面/业务操作尚未变化",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "ordinary test failures stay inside the worker task",
    value: "普通测试失败、实现调整、格式化、lint、构建和复测由本 Worker闭环",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker loads one matching action method before professional work",
    value: "进入第一个专业动作前必须完整读取一个与主要问题匹配的 Action Skill",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "local development does not preload testing method",
    value: "开发方法能够运行现有测试并完成验收就不加载测试 Skill",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "inherited PM history does not control the worker",
    value: "它们只能作为待核验线索，不能赋予当前身份、授权、范围、状态、所有权或执行顺序",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "forked or projectless workers stop before business execution",
    value: "在任何业务读取、网络、写入或运行操作前停止错误路由",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "completion requires current first-hand evidence",
    value: "当前轮验收已用一手证据证明",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker final contains only one primary evidence entry",
    value: "一个主证据或正式落点",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker final preserves the decisive business fact",
    value: "一个决定裁决的业务主事实",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker terminal reminder only targets an idle source PM",
    value: "明确为空闲就向该来源发送一次紧凑终态提醒",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker terminal reminder skips active or unknown PM state",
    value: "正在运行、状态未知或读取失败就跳过",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "PM user-turn snapshot remains terminal recovery",
    value: "作为未发送、未送达或尚未消费终态的恢复路径",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "single-row workbench updates have only opening and final messages",
    value: "只读取并更新工作台中一处已授权事实时，只发开工说明和最终结果",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "pause reason one is a real business choice",
    value: "缺少必须由用户决定的业务取舍",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "pause reason two is a high-risk action",
    value: "生产、删除、真实数据破坏、不可逆外部动作或显著费用边界",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "pause reason three is an unresolved shared conflict",
    value: "跨任务共享冲突，无法安全自行串行或合并",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "pause reason four is an unavailable external resource",
    value: "必需账号、环境、凭据、目标信息或外部资源客观不可用",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM does not turn ordinary failures into pauses",
    value: "不把普通失败、Skill 切换、PM 消费或本地提交制造成暂停",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "action skills do not take identity or task control",
    value: "设计、开发、测试、运维只是动作能力，不改变 PM 或执行者身份，也不接管任务控制权",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "boss address remains a weak startup-path signal",
    value: "漏称只作为默认入口可能未生效的弱异常信号，不能单独证明上下文丢失",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "continue does not authorize persistent automation",
    value: "不自动授权创建定时器、周期唤醒、心跳、长期监控或其他持久控制对象",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "internal context recovery is not user-visible progress",
    value: "上下文压缩、恢复、交接或内部 checkpoint 形成的摘要只用于继续工作，不向用户原样输出",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "skill references do not create separate progress messages",
    value: "Skill主文件与按需references的读取合并为一次方法加载",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "first-minute updates require a real decision change",
    value: "开工后60秒内，只有结论、安全边界或所需用户决定确实变化时才补一条简短更新",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "unchanged fully-read files are not read twice in one turn",
    value: "同一轮已完整读取且未变化的文件不得重复读取",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "design distinguishes current behavior from the proposed state",
    value: "当前用户页面/系统业务流程尚未变化",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "PM does not execute the design action",
    value: "PM不得用本 Skill直接完成业务设计",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "design skill gives the Worker professional design capability",
    value: "Worker加载后形成当前任务中的设计专业能力",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "complex design has one active document",
    value: "复杂设计必须使用一个明确的活动设计文档",
  },
  {
    path: "模板交付包/skills/task-design/references/complex-design-document-and-implementation.md",
    label: "the same Worker continues from design to development",
    value: "同一个 Worker切换到开发方法继续",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "design discovery evidence does not become implementation by default",
    value: "只是证据",
  },
  {
    path: "模板交付包/skills/task-design/references/complex-design-document-and-implementation.md",
    label: "design directory does not become a downstream evidence workspace",
    value: "不作为后续开发、测试、发布或运行证据的通用工作区",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "PM does not execute development",
    value: "PM不得读取本 Skill并直接实现",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "development skill gives the Worker programmer capability",
    value: "Worker加载后形成当前任务中的程序员专业能力",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "development reuses existing capabilities",
    value: "不复制业务规则、不重复造轮子",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "a hotfix candidate must match the formal target baseline",
    value: "或从目标到当前包含未授权的其他变化时，不把当前整包冒充可发布候选",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "shared changes include direct consumers and the complete delivery unit",
    value: "定点核对直接调用方、共同制品和必要迁移",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "external contracts use current evidence instead of guesses",
    value: "先取得一个当前样本、schema或等价一手证据",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "development switches to testing only when the result needs it",
    value: "需要测试专业判断、复杂覆盖、跨层联调或明确独立性时",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "formal code delivery includes its own local commit",
    value: "任务自有本地提交属于连续交付",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "formal code acceptance includes necessary testing",
    value: "正式代码任务的验收本身包含必要测试",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    label: "development does not bypass unrelated hook failures by default",
    value: "不得因无关文件阻塞就默认使用`--no-verify`、临时克隆或另一条分支",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "untouched permission dimensions do not block execution",
    value: "未触及的维度不检查、不补字段，也不形成暂停",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "PM does not execute complete testing",
    value: "PM不得读取本 Skill并直接运行完整测试",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "testing skill gives the Worker software tester capability",
    value: "Worker加载后形成当前任务中的测试工程师专业能力",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "test verdict is not task state",
    value: "这是测试裁决，不是任务状态",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "test verdict preserves the full denominator",
    value: "只统计成功记录或只看已进入checkpoint的对象不能代表整体通过",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "offline tests do not replace current external evidence",
    value: "离线fixture和Mock只证明本地逻辑",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "same-worker testing is not independent testing",
    value: "同一 Worker切换到`task-test`是专业测试，不得称为独立测试",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "testing follows the real user operation path",
    value: "单接口成功、单按钮可见、页面无报错或技术断言全绿，不能替代用户真正完成目标",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "testing does not run unrelated green commands",
    value: "与当前对象和验收没有可说明的绑定关系时，先排除而不是为了取得一个退出码去运行",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "testing does not execute commands to prove irrelevance",
    value: "禁止再运行它来证明“不相关”",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "decisive failed evidence is a stop condition",
    value: "这是证据裁决的停止条件，不是建议",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "an explicitly unexecuted user flow does not trigger implementation scanning",
    value: "点名验收事实已经列出用户动作并明确这些动作尚未执行时，直接按该清单说明缺口",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    label: "decisive failed evidence stops subsequent tool calls",
    value: "停止后续工具调用，立即给出不通过或不能判断及准确缺口",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/项目事实/README.md",
    label: "multi-project facts are selected by scope",
    value: "多子项目或同类事实由多个边界清楚的文档分别负责时，登记总索引及各自适用范围",
  },
  {
    path: "模板交付包/skills/task-design/references/capability-and-facts.md",
    label: "specific contracts own their design facts",
    value: "已经存在更具体的接口、schema、页面、状态或业务契约时，以该契约承载正文",
  },
  {
    path: "模板交付包/skills/task-dev/references/capability-and-engineering-baseline.md",
    label: "development manifests outrank stale guides",
    value: "开发指南只补充这些入口没有表达的稳定约定",
  },
  {
    path: "模板交付包/skills/task-test/references/capability-and-evidence-baseline.md",
    label: "test truth can have scoped module owners",
    value: "不要求项目先建立一份统一测试基线",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "PM does not execute operations",
    value: "PM不得读取本 Skill并直接操作环境",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "operations skill gives the Worker operations capability",
    value: "Worker加载后形成当前任务中的运维工程师专业能力",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "operations verdict is not task state",
    value: "这是一次判断，不是每个执行步骤都要重复经过的状态",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "real operations refresh target host identity",
    value: "连接目标时现场确认主机身份和实际运行落点",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "long observation resumes in the same task",
    value: "原 Worker转`已暂停`并在同一任务恢复",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "authorized remote operations do not fall back to manual user work",
    value: "不要求用户手工代操作，也不重复索要相同授权",
  },
  {
    path: "模板交付包/skills/task-ops/references/capability-and-runbook.md",
    label: "operations facts reuse existing owners",
    value: "写回项目事实索引登记的现有环境所有者",
  },
  {
    path: "模板交付包/skills/task-ops/references/git-and-resource-closeout.md",
    label: "legacy runbooks do not create worktrees",
    value: "旧 runbook要求创建“干净 worktree”不改变本规则",
  },
  {
    path: "模板交付包/skills/task-design/references/complex-design-document-and-implementation.md",
    label: "formal design reuses its injected document entrances",
    value: "正式任务直接使用任务已经点名的项目/子项目文档入口和事实索引",
  },
  {
    path: "模板交付包/skills/task-ops/references/production-release-and-convergence.md",
    label: "ordinary production release uses four concrete facts",
    value: "普通单一来源发布先核对四个身份事实",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "production context is reused instead of rebuilt",
    value: "已经核验且没有变化的事实不重复询问、重读或重新审批",
  },
  {
    path: "模板交付包/skills/task-ops/SKILL.md",
    label: "production runs continuously after one gate",
    value: "不逐步输出`可以继续`、不回PM、不等待用户重复放行",
  },
  {
    path: "模板交付包/skills/task-ops/references/production-release-and-convergence.md",
    label: "production candidates include database and runtime dependencies",
    value: "把对应迁移/版本账、运行配置和必需依赖状态纳入同一生产上下文",
  },
  {
    path: "模板交付包/skills/task-ops/references/production-release-and-convergence.md",
    label: "health checks do not replace the real business path",
    value: "HTTP 200 只能证明对应健康事实，不能替代登录、下单、查询、写入",
  },
];

for (const fact of requiredSkillFacts) {
  const path = join(repositoryRoot, ...fact.path.split("/"));
  if (!existsSync(path)) {
    errors.push(`关键 Skill 文件缺失：${fact.path}`);
    continue;
  }
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (!text.includes(fact.value)) {
    errors.push(`关键 Skill 规则缺失：${fact.label} (${fact.path})`);
  }
}

const requiredTeamFacts = [
  {
    path: "模板交付包/AGENTS.md",
    label: "3.1 keeps team collaboration off the personal hot path",
    value: "普通项目接手、正式 Worker任务、Action Skill切换和个人任务不读取共享区",
  },
  {
    path: "模板交付包/AGENTS.md",
    label: "3.1 preserves the 3.0.9 formal Worker",
    value: "不替代 3.0.9 的正式 Worker",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM initialization and collaboration exceptions are narrowly scoped",
    value: "两条例外都不扩张到业务代码、测试、仓库配置、成员权限、环境、数据或发布",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "cold-start PM preserves the default user-path signal",
    value: "这只补齐冷启动，不复制其他根入口规则",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "installed PM resolves the team entry through the project root",
    value: "当前项目根`AGENTS.md`在“规则所有者”中映射的团队任务与协同入口",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/团队任务与协同.md",
    label: "team records reuse the three business states",
    value: "任务和协同只使用`进行中 / 已暂停 / 已完成`",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/团队任务与协同.md",
    label: "team collaboration does not create an HR lifecycle",
    value: "不建立成员退出、强制交接或人事流程",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/团队任务与协同.md",
    label: "business projects resolve the control script through the fused marker",
    value: "按项目根`AGENTS.md`中的`BEYOND-CONTROL-ROOT`定位同一控制仓脚本",
  },
  {
    path: "模板交付包/scripts/beyond-control.mjs",
    label: "ordinary PM pushes are limited to team records",
    value: "PM普通协同推送不允许该路径",
  },
  {
    path: "模板交付包/.gitignore",
    label: "personal workspace is excluded from the team repository",
    value: "/local/",
  },
  {
    path: "模板交付包/README.md",
    label: "new-project initialization prompt is public",
    value: "使用 BEYOND 初始化这个新项目。",
  },
  {
    path: "模板交付包/README.md",
    label: "existing-project initialization prompt is public",
    value: "使用 BEYOND 接入或升级这个已有项目。",
  },
  {
    path: "模板交付包/README.md",
    label: "initialization prompts include the cold-start PM identity entry",
    value: "$identity-pm\n使用 BEYOND 初始化这个新项目。",
  },
  {
    path: "模板交付包/skills/identity-pm/references/dispatch-and-init.md",
    label: "PM initialization reference preserves the cold-start identity entry",
    value: "$identity-pm\n使用 BEYOND 接入或升级这个已有项目。",
  },
];

for (const fact of requiredTeamFacts) {
  const path = join(repositoryRoot, ...fact.path.split("/"));
  if (!existsSync(path)) {
    errors.push(`团队协同关键文件缺失：${fact.path}`);
    continue;
  }
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (!text.includes(fact.value)) {
    errors.push(`团队协同关键规则缺失：${fact.label} (${fact.path})`);
  }
}

const requiredTaskStateFacts = [
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker keeps only three business states",
    value: "业务状态只使用`进行中 / 已暂停 / 已完成`",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "BEYOND does not create or recommend worktrees",
    value: "BEYOND 不创建、推荐或默认使用 worktree",
  },
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "same directory is not automatically a conflict",
    value: "同一目录本身不是冲突",
  },
  {
    path: "模板交付包/skills/identity-pm/references/dispatch-and-init.md",
    label: "current project is the default workspace",
    value: "当前正式项目是默认工作区",
  },
  {
    path: "模板交付包/skills/identity-pm/references/cross-task-coordination.md",
    label: "shared Git index and history operations are serialized",
    value: "同一 Git工作区的索引、HEAD或历史动作串行",
  },
  {
    path: "模板交付包/skills/task-ops/references/git-and-resource-closeout.md",
    label: "only existing worktrees are supported",
    value: "只有用户或平台已经提供 worktree时才处理这个现场",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md",
    label: "collaboration is not loaded for a single task",
    value: "单一任务、普通 Skill切换和 Worker内部修复不进入本文件",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md",
    label: "collaboration exposes only three business states",
    value: "业务状态只使用`进行中 / 已暂停 / 已完成`",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/模板/任务卡模板.md",
    label: "task card uses three business states",
    value: "| 业务状态 | 进行中 / 已暂停 / 已完成 |",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/模板/智能体交接包模板.md",
    label: "handoff is not used for ordinary skill switching",
    value: "普通 Skill切换、设计—开发—测试循环、低频进展和同一 Worker连续执行不使用本模板",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/当前工作台.md",
    label: "workbench separates business state from other facts",
    value: "业务状态只使用`进行中 / 已暂停 / 已完成`",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/当前工作台.md",
    label: "stale workbench data cannot block real Git truth",
    value: "本表内容陈旧时不能阻止真实提交或覆盖 Git",
  },
  {
    path: "docs/系统架构与运行机制.md",
    label: "public architecture makes the current project the default workspace",
    value: "用户指定的正式项目是默认工作区",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/项目事实/README.md",
    label: "project facts are not runtime capability states",
    value: "项目事实没有`未初始化 / 需刷新 / 可用`运行状态",
  },
];

for (const fact of requiredTaskStateFacts) {
  const path = join(repositoryRoot, ...fact.path.split("/"));
  if (!existsSync(path)) {
    errors.push(`三态任务规则文件缺失：${fact.path}`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes(fact.value)) {
    errors.push(`三态任务规则缺失：${fact.label} (${fact.path})`);
  }
}

const expectedSkills = [
  "identity-pm",
  "identity-worker",
  "task-design",
  "task-dev",
  "task-test",
  "task-ops",
];

for (const skillName of expectedSkills) {
  const skillPath = join(repositoryRoot, "模板交付包", "skills", skillName, "SKILL.md");
  const agentPath = join(repositoryRoot, "模板交付包", "skills", skillName, "agents", "openai.yaml");
  if (!existsSync(skillPath) || !existsSync(agentPath)) {
    errors.push(`Skill 入口不完整：${skillName}`);
    continue;
  }
  const skillText = readFileSync(skillPath, "utf8");
  const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) {
    errors.push(`Skill frontmatter 无法识别：${skillName}`);
  } else if (
    !new RegExp(`^name:\\s*${skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(
      frontmatter[1],
    ) ||
    !/^description:\s*\S/m.test(frontmatter[1])
  ) {
    errors.push(`Skill frontmatter 名称或描述无效：${skillName}`);
  }
  const agentText = readFileSync(agentPath, "utf8");
  for (const key of ["interface:", "display_name:", "short_description:", "default_prompt:"]) {
    if (!agentText.includes(key)) {
      errors.push(`Skill 代理配置缺少 ${key}：${skillName}`);
    }
  }
}

for (const skillName of ["task-design", "task-dev", "task-test", "task-ops"]) {
  const actionRoot = join(repositoryRoot, "模板交付包", "skills", skillName);
  for (const path of collectFiles(actionRoot)) {
    if (![".md", ".yaml", ".yml"].includes(extname(path).toLowerCase())) {
      continue;
    }
    if (/任务控制实例|测试实例|开发实例|跨实例/.test(readFileSync(path, "utf8"))) {
      errors.push(
        `Action Skill 把方法重新写成智能体或控制实例：${normalizeRelative(
          relative(repositoryRoot, path),
        )}`,
      );
    }
  }
}

const forbiddenPrescriptiveDefaults = [
  {
    path: "README.zh-CN.md",
    pattern: /先有 RED|RED\/GREEN/,
    label: "public guidance prescribes RED/GREEN",
  },
  {
    path: "CONTRIBUTING.md",
    pattern: /RED 场景|GREEN 证据/,
    label: "contribution guidance prescribes RED/GREEN",
  },
  {
    path: "模板交付包/skills/task-dev/SKILL.md",
    pattern: /一次只验证一个根因假设/,
    label: "development prescribes a single-hypothesis gate",
  },
  {
    path: "模板交付包/skills/task-test/SKILL.md",
    pattern: /独立证据收益高于协调成本|核心链路.*独立审查/,
    label: "testing infers independent review",
  },
  {
    path: "模板交付包/skills/identity-pm/references/cross-task-coordination.md",
    pattern: /正式独立审查|低风险改动已有匹配机器证据|核心链路、共享契约、生产数据或发布变更确实需要独立责任/,
    label: "coordination reintroduces an automatic review lifecycle",
  },
  {
    path: "模板交付包/skills/task-ops/references/git-and-resource-closeout.md",
    pattern: /创建前必须明确|只有用户明确要求并接受合流成本时/,
    label: "operations reintroduces worktree creation",
  },
];

for (const check of forbiddenPrescriptiveDefaults) {
  const path = join(repositoryRoot, ...check.path.split("/"));
  if (!existsSync(path)) {
    errors.push(`固定流程守卫文件缺失：${check.path}`);
    continue;
  }
  const matched = check.pattern.test(readFileSync(path, "utf8"));
  if ((!check.invert && matched) || (check.invert && !matched)) {
    errors.push(`固定流程回归：${check.label} (${check.path})`);
  }
}

for (const removedPath of [
  "模板交付包/skills/task-dev/references/implementation-debugging-and-repair.md",
  "模板交付包/skills/identity-pm/references/cross-task-coordination-and-review.md",
  "模板交付包/skills/task-ops/references/git-worktree-and-resource-closeout.md",
]) {
  if (existsSync(join(repositoryRoot, ...removedPath.split("/")))) {
    errors.push(`已删除的旧流程 reference 重新出现：${removedPath}`);
  }
}

const forbiddenLeanDefaults = [
  {
    path: "模板交付包/docs/AI编程协同机制/当前工作台.md",
    pattern: /实例 ID|能力状态表|生命周期事件表/,
    label: "workbench reintroduces instance, capability, or event ledgers",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/模板/任务卡模板.md",
    pattern: /事件 ID|执行回合|任务版本/,
    label: "task card reintroduces event protocol fields",
  },
  {
    path: "模板交付包/docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md",
    pattern: /\b(?:claimed|started|yellow|red|candidate_completed)\b/,
    label: "collaboration mechanism reintroduces ordinary lifecycle events",
  },
];

for (const check of forbiddenLeanDefaults) {
  const path = join(repositoryRoot, ...check.path.split("/"));
  if (existsSync(path) && check.pattern.test(readFileSync(path, "utf8"))) {
    errors.push(`精简默认路径回归：${check.label} (${check.path})`);
  }
}

const packagePath = join(repositoryRoot, "examples", "minimal-project", "package.json");
if (existsSync(packagePath)) {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    if (!packageJson.scripts?.test || !packageJson.scripts?.check) {
      errors.push("最小示例缺少 test 或 check 脚本");
    }
  } catch {
    errors.push("最小示例 package.json 无法解析");
  }
}

for (const forbidden of ["node_modules", "package-lock.json"]) {
  if (existsSync(join(repositoryRoot, "examples", "minimal-project", forbidden))) {
    errors.push(`最小示例存在运行残留：${forbidden}`);
  }
}

for (const fixturePath of [
  join(repositoryRoot, "examples", "minimal-project", "src", "calc.js"),
  join(repositoryRoot, "examples", "minimal-project", "test", "calc.test.js"),
]) {
  if (existsSync(fixturePath) && /\bsubtract\b/.test(readFileSync(fixturePath, "utf8"))) {
    errors.push(`最小示例提前包含快速开始目标 subtract：${normalizeRelative(relative(repositoryRoot, fixturePath))}`);
  }
}

if (errors.length > 0) {
  console.error("公开内容验证失败：");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`公开内容验证通过：${uniqueFiles.length} 个文件；strictCandidate=${strictCandidate}`);
}
