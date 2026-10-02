import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const product = process.env.BEYOND_TEST_PRODUCT_ROOT ? resolve(process.env.BEYOND_TEST_PRODUCT_ROOT) : join(repo, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-worker-policy-"));
const project = join(scratch, "legacy-project"), control = join(project, "beyond-control");
const errors = []; let passed = 0;
function check(name, ok, detail = "") { if(ok) passed++; else errors.push(name + ": " + detail); }
function snapshot(root) {
  const out = {};
  function walk(dir, prefix = "") { for(const e of readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const key = prefix + e.name;
    if(e.isDirectory()) { out[key+"/"] = "directory"; walk(join(dir,e.name), key+"/"); }
    else out[key] = createHash("sha256").update(readFileSync(join(dir,e.name))).digest("hex");
  }}
  walk(root); return JSON.stringify(out);
}
function run(args, status = 0, root = control) {
  const r = spawnSync(process.execPath, [join(root,"scripts/beyond-control.mjs"),...args], {cwd:root,encoding:"utf8",windowsHide:true});
  check("exit " + args.join(" "), r.status === status, String(r.stdout) + String(r.stderr)); return r;
}
function json(args, root = control) { return JSON.parse(run(args,0,root).stdout); }
function replacePolicy(text, policy) {
  const fence = String.fromCharCode(96).repeat(3);
  return text.replace(/(<!-- BEGIN BEYOND WORKER POLICY -->)[\s\S]*?(<!-- END BEYOND WORKER POLICY -->)/,
    (_all,b,e)=>b+"\n"+fence+"json\n"+JSON.stringify(policy)+"\n"+fence+"\n"+e);
}
const mode="beyond-worker-gpt61-v5";
const defaults={
  "design-analysis":{model:"gpt-6.1-sol",thinking:"high"},
  "ordinary-engineering":{model:"gpt-6.1-sol",thinking:"high"},
  "bulk-structured":{model:"gpt-6-luna",thinking:"high"},
  "hard-analysis":{model:"gpt-6.1-sol",thinking:"xhigh"},
  "complex-high-risk":{model:"gpt-6.1-sol",thinking:"xhigh"},
};
const options={"gpt-6-luna":["low","medium","high","xhigh","max"],
  "gpt-6.1-sol":["low","medium","high","xhigh","max","ultra"],
  "gpt-6-astra":["low","medium","high","xhigh","max","ultra"]};
try {
  cpSync(join(repo,"examples/minimal-project"),project,{recursive:true}); cpSync(product,control,{recursive:true});
  writeFileSync(join(project,"AGENTS.md"),"# 原项目规则\n\n- 保留原生规则。\n\n<!-- BEGIN BEYOND PROJECT OVERRIDES -->\n- Terra / Luna / Sol 模型矩阵。\n- 保留项目覆盖。\n<!-- END BEYOND PROJECT OVERRIDES -->\n");
  check("只识别旧入口",json(["inspect-project","--project-root",project]).legacyWorkerPolicyCandidate === true);
  const oldRoot=readFileSync(join(project,"AGENTS.md"),"utf8");
  run(["install-project-entry","--project-root",project,"--confirm-fusion","yes"],2);
  check("未经选择不融合",readFileSync(join(project,"AGENTS.md"),"utf8")===oldRoot);
  const projectId=json(["register-project","--project-root",project]).project.projectId;
  const overview=join(control,"projects",projectId,"项目总览.md");
  const show=["worker-policy","--action","show","--project-id",projectId];
  const create=["worker-policy","--action","resolve","--project-id",projectId];
  const stage=["worker-policy","--action","resolve-stage","--project-id",projectId];
  const set=["worker-policy","--action","set","--project-id",projectId,"--mode",mode];
  const initial=json(show);
  check("未批准默认",!initial.policy.confirmed && initial.policy.mode==="platform-default");
  check("只有两个有效选项",Object.keys(initial.choices).sort().join(",")===[mode,"platform-default"].sort().join(","));
  check("唯一参数表",JSON.stringify(initial.choices[mode])===JSON.stringify(defaults)&&JSON.stringify(initial.selectionOptions[mode])===JSON.stringify(options)&&initial.recommendedMode===mode);
  check("Astra只作显式攻坚选项",Object.values(initial.choices[mode]).every(pair=>pair.model!=="gpt-6-astra")&&Object.hasOwn(initial.selectionOptions[mode],"gpt-6-astra"));
  const before=snapshot(control); run(set,2); check("缺批准不写入",snapshot(control)===before);
  for(const kind of Object.keys(defaults)) check("未批准不覆盖 "+kind,Object.keys(json([...create,"--task-kind",kind]).createParameters).length===0);
  const installed=json(["install-project-entry","--project-root",project,"--confirm-fusion","yes","--worker-policy-mode",mode,"--worker-policy-approved-by","用户明确启用新矩阵"]);
  check("迁移有前像",existsSync(installed.workerPolicy.backup));
  const agents=readFileSync(join(project,"AGENTS.md"),"utf8");
  check("旧入口无重复覆盖区",(agents.match(/BEGIN BEYOND PROJECT OVERRIDES/g)??[]).length===1);
  check("保留原生与非模型覆盖",agents.includes("保留原生规则")&&agents.includes("保留项目覆盖")&&!/Terra|Luna|Sol|模型矩阵/.test(agents));
  json(["install-project-entry","--project-root",project,"--confirm-fusion","yes"]);
  check("重复融合幂等",readFileSync(join(project,"AGENTS.md"),"utf8")===agents);
  const valid=readFileSync(overview,"utf8");
  const verify=()=>spawnSync(process.execPath,[join(control,"scripts/verify-install-integrity.mjs"),"--installed-skills-root",join(control,"skills"),"--project-agents",join(project,"AGENTS.md")],{cwd:project,encoding:"utf8",windowsHide:true});
  const verified=verify(); check("融合验真",verified.status===0,String(verified.stderr));
  const selected=snapshot(control);
  for(const [kind,pair] of Object.entries(defaults)) for(const [args,field] of [[create,"createParameters"],[stage,"continuationParameters"]])
    check(kind+"/"+field,JSON.stringify(json([...args,"--task-kind",kind])[field])===JSON.stringify(pair));
  check("策略不保存PM配置",!Object.hasOwn(json(show).policy,"model")&&!Object.hasOwn(json(show).policy,"thinking"));
  for(const [model,efforts] of Object.entries(options)) for(const thinking of efforts) for(const [args,field] of [[create,"createParameters"],[stage,"continuationParameters"]])
    check(model+"/"+thinking+"/"+field,JSON.stringify(json([...args,"--task-kind","design-analysis","--model",model,"--thinking",thinking])[field])===JSON.stringify({model,thinking}));
  for(const bad of [
    ["--model","gpt-6.1-sol"],["--thinking","medium"],["--model"],["--thinking"],
    ["--model","gpt-6.1-sol","--thinking","none"],["--model","gpt-6.1-sol","--thinking","minimal"],
    ["--model","gpt-6-luna","--thinking","ultra"],["--model","gpt-6-sol","--thinking","high"],
    ["--model","gpt-5.6-terra","--thinking","high"],["--model","__proto__","--thinking","medium"],
  ]) for(const args of [create,stage]) run([...args,"--task-kind","ordinary-engineering",...bad],2);
  run([...create,"--task-kind","unknown"],2); check("查询与拒绝只读",snapshot(control)===selected);
  let previous={model:"gpt-6-astra",thinking:"ultra"};
  for(const pair of [defaults["ordinary-engineering"],defaults["hard-analysis"],{model:"gpt-6-astra",thinking:"medium"},defaults["bulk-structured"],defaults["ordinary-engineering"]]) {
    previous={...previous,...json([...stage,"--task-kind","ordinary-engineering","--model",pair.model,"--thinking",pair.thinking]).continuationParameters};
    check("升降档不继承 "+pair.model+"/"+pair.thinking,JSON.stringify(previous)===JSON.stringify(pair));
  }
  writeFileSync(overview,valid.replace('"confirmed":true','"confirmed":false'));
  for(const [args,field] of [[create,"createParameters"],[stage,"continuationParameters"]]) {
    check("未批准不覆盖 "+field,Object.keys(json([...args,"--task-kind","ordinary-engineering"])[field]).length===0);
    run([...args,"--task-kind","ordinary-engineering","--model","gpt-6.1-sol","--thinking","medium"],2);
  }
  for(const legacy of ["beyond-worker-matrix-v1","beyond-worker-sweetspots-v2","beyond-worker-gpt6-v3","beyond-worker-gpt61-v4"]) {
    const historicalText = valid.replace(/本节记录当前项目的Worker运行策略及批准范围。[^\n]+/,
      "本节记录当前项目的Worker运行策略及批准范围。用户未确认时保持平台默认；旧v1仅用于新建，旧v2允许阶段切换，GPT-6 v3允许PM选择模型与强度并在同一Worker正常续接时调整。具体候选和起点以worker-policy show为准，旧批准不自动迁移；工作台、任务包和根入口不复制本节。");
    writeFileSync(overview,replacePolicy(historicalText,{schemaVersion:1,mode:legacy,scope:legacy.endsWith("v1")?"new-formal-worker":"formal-worker-stages",confirmed:true,approvedBy:"历史批准",approvedAt:"2026-10-02T00:00:00.000Z"}));
    const historical=snapshot(control), shown=json(show);
    check("旧记录只识别 "+legacy,shown.requiresSelection && !Object.hasOwn(shown.choices,legacy));
    for(const [args,field] of [[create,"createParameters"],[stage,"continuationParameters"]]) {
      const v=json([...args,"--task-kind","ordinary-engineering"]);
      check("不执行旧映射 "+legacy+"/"+field,v.requiresSelection&&Object.keys(v[field]).length===0);
      run([...args,"--task-kind","ordinary-engineering","--model","gpt-6.1-sol","--thinking","medium"],2);
    }
    run(["worker-policy","--action","set","--project-id",projectId,"--mode",legacy,"--approved-by","不得重新启用"],2);
    check("旧策略识别不写入 "+legacy,snapshot(control)===historical);
    check("验真识别旧记录 "+legacy,verify().status===0);
    json(["register-project","--project-root",project]); check("不默改旧批准 "+legacy,json(show).policy.mode===legacy);
    const migrated=json([...set,"--approved-by","用户明确迁移"]);
    check("保留旧批准前像 "+legacy,readFileSync(migrated.backup,"utf8").includes('"mode":"'+legacy+'"'));
    check("明确选择才启用 "+legacy,json(show).policy.mode===mode);
    check("迁移同步刷新旧生成说明 "+legacy,readFileSync(overview,"utf8").includes("当前只提供平台默认或GPT-6.1矩阵"));
  }
  json(["worker-policy","--action","set","--project-id",projectId,"--mode","platform-default","--approved-by","恢复平台默认"]);
  check("退出不重置原线程",Object.keys(json([...stage,"--task-kind","bulk-structured"]).continuationParameters).length===0);
  const platformDefault=snapshot(control);
  for(const args of [create,stage]) run([...args,"--task-kind","hard-analysis","--model","gpt-6-astra","--thinking","high"],2);
  check("平台默认不被自主升档覆盖",snapshot(control)===platformDefault);
  const query=join(scratch,"query-only"); cpSync(product,query,{recursive:true});
  mkdirSync(join(query,"projects",projectId),{recursive:true}); writeFileSync(join(query,"projects",projectId,"项目总览.md"),valid);
  const queryBefore=snapshot(query);
  for(const action of ["show","resolve","resolve-stage"]) { json(["worker-policy","--action",action,"--project-id",projectId,"--task-kind","bulk-structured"],query); check("查询不初始化 "+action,snapshot(query)===queryBefore); }
} finally { rmSync(scratch,{recursive:true,force:true}); }
if(errors.length) { console.error("Worker策略回归失败："+errors.length+"项\n- "+errors.join("\n- ")); process.exitCode=1; }
else console.log("Worker策略回归通过："+passed+"项");
