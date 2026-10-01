import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productRoot=path.resolve(import.meta.dirname,'../模板交付包');
export function prepareCliHostProbe(output, { profilePath = null, ownerThreadId = null } = {}) {
  const absolute=path.resolve(output), relative=path.relative(fs.realpathSync(os.tmpdir()),absolute);
  if(!relative || relative.startsWith('..') || path.isAbsolute(relative))throw new Error('probe must use a new operating-system temporary directory');
  if(fs.existsSync(absolute))throw new Error('probe output already exists; no overwrite');
  // Validate the existing parent before writing; an output parent junction must not escape TEMP.
  let parent=path.dirname(absolute);while(!fs.existsSync(parent))parent=path.dirname(parent);
  const physicalRelative=path.relative(fs.realpathSync(os.tmpdir()),fs.realpathSync(parent));
  if(physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative))throw new Error('probe parent escapes temporary directory');
  fs.mkdirSync(absolute,{recursive:true});
  const executionRoot=path.join(absolute,'project'),controlRoot=path.join(absolute,'control'),projectId='local-cli-probe';
  fs.mkdirSync(executionRoot);fs.mkdirSync(path.join(controlRoot,'local/projects'),{recursive:true});
  fs.cpSync(path.join(productRoot,'scripts'),path.join(controlRoot,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(controlRoot,'local/projects',`${projectId}.md`),`---\nid: ${projectId}\npath: ${executionRoot}\n---\n`);
  fs.writeFileSync(path.join(executionRoot,'AGENTS.md'),`<!-- BEYOND-CONTROL-ROOT: ../control -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\n# Isolated CLI probe\nOnly modify sum.cjs and run existing sum.test.cjs inside this temporary project. No Git, network, installation, Desktop callbacks or business work. CLI execution is delegated by one real Desktop owner.\n`);
  fs.writeFileSync(path.join(executionRoot,'sum.cjs'),'module.exports=()=>{throw new Error("not implemented");};\n');
  fs.writeFileSync(path.join(executionRoot,'sum.test.cjs'),'const test=require("node:test"),assert=require("node:assert/strict"),sum=require("./sum.cjs");\nfor(const [a,b,expected] of [[1,1,2],[-2,1,-1],[0.5,0.25,0.75]])test(`${a}+${b}`,()=>assert.equal(sum(a,b),expected));\n');
  const start={schemaVersion:1,requestId:'probe-first',action:'cli.start',input:{projectId,taskId:'host-probe',taskMode:'assist',executionRoot,profilePath:profilePath ?? '<explicit isolated API profile>',contract:{goal:'implement sum correctly for all supplied cases',boundaries:'temporary sample only; no business files, Git, network or installation',acceptance:'all existing sum.test.cjs tests pass',factEntries:[],skillEntries:[path.join(productRoot,'skills/task-dev/SKILL.md')]},prompt:'First checkpoint: implement sum for the positive example only and report what is not verified; do not run tests yet. The owner will review and give remaining acceptance in the same session.'}};
  if(ownerThreadId)start.input.ownerThreadId=ownerThreadId;
  fs.writeFileSync(path.join(absolute,'start-request.json'),JSON.stringify(start,null,2)+'\n');
  const evidence={mode:'prepared-not-executed',apiCalled:false,automaticDelivery:'unverified',ownerReview:'unverified',businessCompletion:'unverified',projectId,executionRoot,controlRoot,startRequestPath:path.join(absolute,'start-request.json')};
  fs.writeFileSync(path.join(absolute,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  fs.writeFileSync(path.join(absolute,'README.txt'),'Preparation does not call an API or create a Desktop thread. Use the product bridge from project cwd with an explicit isolated API profile. End the dispatching Desktop turn; do not wait for CLI in that turn. On CLI_RESULT_READY inspect current result and real sample tests; record continue, then resume the exact session for the remaining acceptance. Distinguish prepared / simulated / real transport, delivery / owner processing, and process completion / business completion. Cleanup only this exact temporary probe after owned background processes and observers have exited.\n');
  return evidence;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const value=flag=>{const i=process.argv.indexOf(flag);return i<0?null:process.argv[i+1];}; const output=value('--output');if(!output)throw new Error('--output requires a fresh temporary directory');
    process.stdout.write(JSON.stringify(prepareCliHostProbe(output,{profilePath:value('--profile'),ownerThreadId:process.env.CODEX_THREAD_ID ?? null}),null,2)+'\n');
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
