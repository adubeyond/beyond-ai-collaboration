// Reproduce the release checks from a clean, isolated public-file snapshot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const sourceGit=(...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true}).trim();
const sourceHead=sourceGit("rev-parse","HEAD"), sourceStatus=sourceGit("status","--porcelain");
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"beyond-full-validation-"));
const candidate=path.join(scratch,"candidate"); fs.mkdirSync(candidate);
const files=execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{cwd:root,encoding:"utf8",windowsHide:true}).split("\0").filter(Boolean);
const capturedFiles=[];
for(const name of [...new Set(files)].sort()) {
  const target=path.resolve(candidate,name), relative=path.relative(candidate,target);
  if(relative.startsWith("..") || path.isAbsolute(relative)) throw Error("unsafe candidate path");
  fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(path.join(root,name),target);
  capturedFiles.push([name,createHash("sha256").update(fs.readFileSync(target)).digest("hex")]);
}
if(sourceGit("rev-parse","HEAD")!==sourceHead || sourceGit("status","--porcelain")!==sourceStatus) throw Error("source changed during snapshot capture; rerun against a stable tree");
const sourceSnapshotSha256=createHash("sha256").update(JSON.stringify(capturedFiles)).digest("hex");
execFileSync("git",["init","--quiet"],{cwd:candidate,windowsHide:true});
const runtime=["check-m3-project-identity","check-project-runtime-routing","check-worker-result-receipts","check-receipt-write-concurrency","check-receipt-list-concurrency","check-accept-receipt-cache-expiry","check-m3-workbench-transaction","check-workbench-upgrade-migration","check-native-worker-return",
"check-cli-task-store","check-cli-launcher","check-cli-notification","check-cli-workbench","check-cli-routing","check-cli-recovery","check-cli-goal-loop","check-cli-interactive"].map(n=>"scripts/"+n+".mjs");
const commands=[
  {name:"runtime-and-cli",args:["--test","--test-concurrency=4",...runtime]},
  {name:"progress-decision-fixtures",args:["scripts/probe-pm-progress-decisions.mjs","--check-fixtures"]},
  ...["check-public-content","check-implementation-paths","check-worker-policy-results","check-worker-policy-approval","check-local-worker-final","check-existing-project-adoption","check-install-integrity","check-project-entry-migration","check-project-initialization-runtime","check-historical-workbench-routing","check-workbench-convergence","check-shared-workspace-git"].map(n=>({name:n,args:["scripts/"+n+".mjs",...(n==="check-public-content"?["--strict-candidate"]:[])]})),
  {name:"minimal-tests",args:["--test","test/calc.test.js"],cwd:"examples/minimal-project"},
  {name:"minimal-syntax",args:["--check","src/calc.js"],cwd:"examples/minimal-project"},
  {name:"product-content",args:["模板交付包/scripts/verify-install-integrity.mjs","--installed-skills-root","模板交付包/skills","--project-agents","模板交付包/AGENTS.md","--content-only"]},
];
const results=[];
for(const c of commands) {
  const started=Date.now();
  const env={...process.env}; delete env.NODE_TEST_CONTEXT;
  const r=spawnSync(process.execPath,c.args,{cwd:path.resolve(candidate,c.cwd??"."),env,encoding:"utf8",windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});
  const log=String(r.stdout??"")+String(r.stderr??"");
  fs.writeFileSync(path.join(scratch,c.name+".log"),log);
  results.push({name:c.name,exitCode:r.status,error:r.error?.message??null,durationMs:Date.now()-started});
  console.log(c.name+": "+(r.status===0?"PASS":"FAIL"));
}
const report={schemaVersion:1,version:JSON.parse(fs.readFileSync(path.join(candidate,"模板交付包/beyond-release.json"))).releaseVersion,
  sourceHead,sourceSnapshotSha256,testedUncommittedSnapshot:sourceStatus!=="",
  sourceChangedDuringValidation:sourceGit("rev-parse","HEAD")!==sourceHead || sourceGit("status","--porcelain")!==sourceStatus,
  platform:process.platform,node:process.version,candidate,scratch,results,passed:results.every(r=>r.exitCode===0)};
fs.writeFileSync(path.join(scratch,"results.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2)); if(!report.passed)process.exitCode=1;
// Preserve the exact tested snapshot and logs; never remove a live project.
