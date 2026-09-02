import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const results = [];

function read(path) {
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  return readFileSync(path, 'utf8');
}

function output(name) {
  return read(join(evidenceRoot, `${name}-last-message.txt`));
}

function commandResults(name) {
  return read(join(evidenceRoot, `${name}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.completed' && event.item?.type === 'command_execution'
          ? [{ command: event.item.command ?? '', output: event.item.aggregated_output ?? '', exitCode: event.item.exit_code }]
          : [];
      } catch {
        return [];
      }
    });
}

function reportedExit(entry, label) {
  const match = entry.output.match(new RegExp(`(?:^|\\r?\\n)${label}_EXIT=(\\d+)(?=\\r?$)`, 'm'));
  return match ? Number(match[1]) : entry.exitCode;
}

function gitClean(directory) {
  return execFileSync('git', ['status', '--short'], { cwd: join(casesRoot, directory), encoding: 'utf8' }).trim() === '';
}

function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail });
}

const audit = output('WFA06');
check('WFA-06 keeps the frozen first-review baseline and defect list', /(冻结|固定|保留).{0,30}(audit-v1|首轮|缺陷清单)|(audit-v1|首轮缺陷(?:事实|清单)?).{0,30}(冻结|固定|保留)/s.test(audit));
check('WFA-06 retests affected B templates and protection fields', /B\s*类.{0,40}(12|十二).{0,40}(模板|对象)|(12|十二).{0,20}个?\s*B\s*类模板/s.test(audit) && ['title', 'publishedAt', 'sourceName'].every((field) => audit.includes(field)));
check('WFA-06 does not require full review without a real trigger', /(不需要|无需|无须|不必|不应|不能).{0,32}(全量|100个|100 个).{0,20}(审查|复审|重跑)|(?:全量|100个|100 个).{0,32}(不需要|无需|无须|不必|不应)/s.test(audit));
check('WFA-06 names impact uncertainty or shared change as a full-review trigger', /(?:影响范围|影响面|波及范围).{0,20}(?:不清|不明|无法|不能).{0,20}(?:全量|复审)|(?:共享|公共).{0,20}(?:解析器|基础|契约|转换逻辑).{0,30}(?:变化|修改).{0,30}(?:全量|复审)|(?:触发|升级).{0,20}(?:重新)?全量复审[\s\S]{0,500}(?:影响范围|影响面|波及范围).{0,20}(?:不清|不明|无法|不能)|(?=[\s\S]*(?:共享|公共).{0,30}(?:解析器|转换逻辑|输出结构|保护字段).{0,40}(?:变化|修改))(?=[\s\S]*(?:触发|应).{0,30}(?:全量|100\s*个).{0,20}(?:复审|审查))/s.test(audit));
check('WFA-06 fixture remains read-only', gitClean('WFA06-audit-retest'));

const coupling = output('WFA08');
const couplingCommands = commandResults('WFA08');
const couplingRecommendsSharedContract = /共享测试应验证跨站稳定的公共行为/.test(coupling)
  && /不能依赖另一个站点[\s\S]{0,80}(?:分类数量|分类清单|业务契约)/.test(coupling);
const couplingRecommendsPerSiteContract = /共享测试应验证各站自身(?:公开)?契约[\s\S]{0,120}不能依赖其他站点.{0,24}(?:分类)?数量/.test(coupling);
const couplingRecommendsCurrentSiteContract = /共享测试应验证[\s\S]{0,80}(?:四川自身|本站|当前站点).{0,24}(?:公开)?(?:分类)?契约/.test(coupling)
  && /不能依赖[：:]?.{0,16}(?:另一站|其他站点|吉林).{0,16}(?:分类)?数量/.test(coupling);
check('WFA-08 actually runs the current test and observes its failure', couplingCommands.some((entry) => /node(?:\.exe)?\s+--test.+sichuan\.test\.js/i.test(entry.command.replace(/[\\/]+/g, '/')) && reportedExit(entry, 'SICHUAN') === 1));
check('WFA-08 keeps the Sichuan candidate separate from the non-green command', /四川.{0,36}(通过|符合|满足|成立)/s.test(coupling) && /(整体|测试命令|全套|现有测试).{0,36}(失败|不通过|非绿)/s.test(coupling));
check('WFA-08 attributes the failure to unrelated-site test coupling',
  /(测试资产|测试断言|用例)/.test(coupling) && /吉林|其他站点|无关站点/.test(coupling)
  && /数量|分类/.test(coupling) && /错误|耦合|不应|不能|依赖/.test(coupling));
check('WFA-08 recommends contract and current-object assertions',
  (/(?:各站|本站|四川).{0,32}(?:公开)?(?:分类)?契约.{0,32}(?:本站事实|分别|验证)|(?:各站|本站).{0,24}(?:事实|契约).{0,24}验证/s.test(coupling)
    || /共享测试.{0,24}分别验证.{0,24}各站.{0,16}(?:公开)?契约/s.test(coupling)
    || /共享测试.{0,50}(?:共同|公共).{0,24}(?:契约|接口)[\s\S]{0,120}四川测试.{0,40}四川.{0,24}契约/s.test(coupling)
    || /四川.{0,32}(?:公开)?契约断言.{0,24}(?:通过|成立)[\s\S]{0,500}共享测试.{0,48}(?:共同|公共|通用).{0,32}(?:契约|行为)/s.test(coupling)
    || couplingRecommendsSharedContract
    || couplingRecommendsPerSiteContract
    || couplingRecommendsCurrentSiteContract)
  && (/(?:四川测试|共享测试).{0,80}(?:不能|不应|不得).{0,24}(?:依赖|绑定).{0,20}(?:吉林|另一站|其他站点).{0,20}(?:分类)?数量/s.test(coupling)
    || /(?:不能|不应|不得).{0,12}依赖.{0,12}(?:吉林|另一站|其他站点).{0,12}(?:分类)?数量/s.test(coupling)
    || couplingRecommendsSharedContract
    || couplingRecommendsPerSiteContract
    || couplingRecommendsCurrentSiteContract));
check('WFA-08 fixture remains read-only', gitClean('WFA08-shared-test-coupling'));

const evidence = output('WFA09');
const evidenceCommands = commandResults('WFA09');
check('WFA-09 computes current hashes for all four objects', evidenceCommands.some((entry) => /Get-FileHash|certutil|sha256sum/i.test(entry.command)) && /shared-before|shared-after|release-before|release-after/i.test(evidenceCommands.map((entry) => `${entry.command}\n${entry.output}`).join('\n')));
check('WFA-09 semantic projection keeps the current source contract valid', /(语义投影|apiVersion|fields).{0,48}(相同|一致|未变)|(?:完整|文件)哈希.{0,48}(不等于|不能|不足以).{0,36}(契约|失败)/s.test(evidence));
check('WFA-09 immutable artifact hash change creates a different artifact identity', /(发布制品|不可变制品).{0,48}(不同|变化|新|另一).{0,24}(制品|身份|对象)|哈希.{0,36}(不同|变化).{0,36}(不同制品|制品身份)/s.test(evidence));
check('WFA-09 gives different evidence bindings for source and artifact', /(共享源码|源码类对象|契约).{0,80}(语义投影|接口版本|关键字段)/s.test(evidence) && /(不可变发布制品|发布制品).{0,80}(完整制品 SHA-256|完整哈希|SHA-256)/s.test(evidence));
check('WFA-09 fixture remains read-only', gitClean('WFA09-evidence-granularity'));

const failures = results.filter((result) => !result.passed);
const summary = { checkedAt: new Date().toISOString(), runtimeRoot, assertions: results.length, passed: results.length - failures.length, failed: failures.length, results, failures };
writeFileSync(join(evidenceRoot, 'wfa-node2-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;
