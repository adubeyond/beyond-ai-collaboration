import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const evidenceRoot = join(runtimeRoot, 'evidence');
const caseRoot = join(runtimeRoot, 'cases', 'WFA03-semantic-layers');
const message = readFileSync(join(evidenceRoot, 'WFA03-last-message.txt'), 'utf8');
const events = readFileSync(join(evidenceRoot, 'WFA03-events.jsonl'), 'utf8');
const commands = events.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === 'item.started' && event.item?.type === 'command_execution' ? [event.item.command] : [];
  } catch {
    return [];
  }
}).join('\n').replace(/[\\/]+/g, '/');

const results = [];
const check = (name, passed) => results.push({ name, passed: Boolean(passed) });

check('WFA-03 reads the named fact and design method', commands.includes('docs/classification-facts.md') && commands.includes('task-design'));
check('WFA-03 separates source site from business type', /(?:北大荒|来源站点|站点名称).{0,40}(?:表示公告来自哪里|不表示|不代表|不是|不等于|不能当成).{0,32}(?:七类|业务|公告类型|公告类别|公告业务类型)|(?:七类|业务|公告类型).{0,40}(?:不包含|不是|不应该).{0,24}(?:北大荒|来源站|站点名称)/s.test(message));
check('WFA-03 preserves the source column and normalized type separately', /站点栏目|sourceSection/.test(message) && /七类业务|noticeType/.test(message) && (/(分别|不同|不是同一|各自)/.test(message) || /sourceSection.{0,28}(记|保存|存).{0,16}(站点)?栏目.{0,80}noticeType.{0,28}(记|保存|存).{0,16}(七类|业务)/s.test(message)));
check('WFA-03 keeps storage fields distinct', ['来源站', '站点栏目', '业务类型', '产品展示'].every((field) => message.includes(field)) || ['sourceSite', 'sourceSection', 'noticeType', 'displayChannel'].every((field) => message.includes(field)));
check('WFA-03 maps the sample to engineering and tender display', /纳入|应纳入|属于工程范围/.test(message) && /工程建设/.test(message) && /招标公告/.test(message));
check('WFA-03 identifies the old inference as a layer mix-up', /(旧结论|旧摘要).{0,50}(混淆|错误)|混淆.{0,36}(来源站|七类|业务类型)/s.test(message));
check('WFA-03 remains read-only', execFileSync('git', ['status', '--short'], { cwd: caseRoot, encoding: 'utf8' }).trim() === '');
check('WFA-03 creates no task or worktree detour', !/create_thread|fork_thread|worktree/.test(commands));

const failures = results.filter((result) => !result.passed);
const summary = { checkedAt: new Date().toISOString(), runtimeRoot, assertions: results.length, passed: results.length - failures.length, failed: failures.length, results, failures };
writeFileSync(join(evidenceRoot, 'wfa-node3-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;
