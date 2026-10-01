import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCliHostProbe } from './prepare-cli-host-probe.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore, sha256File, digest } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';
import { notifyWhenReady } from '../模板交付包/scripts/cli/cli-notify.mjs';

const time = () => new Date().toISOString();
async function until(condition) { const deadline = Date.now()+12000; for (;;) { const value=condition(); if (value) return value; if(Date.now()>deadline) throw new Error('fixture timed out'); await new Promise(r=>setTimeout(r,20)); } }
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'beyond-cli-loop-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const prepared=prepareCliHostProbe(path.join(root,'probe'));
  const controlRoot=prepared.controlRoot, executionRoot=prepared.executionRoot, ownerThreadId='probe-owner', ownerTurnId='turn-one';
  const home=path.join(root,'cli-home'); fs.mkdirSync(home);
  const fake=path.join(root,'cli.cjs');
  fs.writeFileSync(fake, `const fs=require('node:fs');const a=process.argv.slice(2),resume=a.includes('resume');console.log(JSON.stringify({type:'thread.started',thread_id:resume?a[a.indexOf('resume')+1]:'retained-session'}));let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(resume){if(!fs.readFileSync('sum.cjs','utf8').includes('Math.abs'))throw Error('first artifact missing');fs.writeFileSync('sum.cjs','module.exports=(a,b)=>a+b;\\n');}else fs.writeFileSync('sum.cjs','module.exports=(a,b)=>Math.abs(a)+Math.abs(b);\\n');fs.writeFileSync(a[a.indexOf('--output-last-message')+1],resume?'fixed based on first artifact':'partial implementation only');console.log(JSON.stringify({type:'turn.completed'}));});`);
  const profilePath=path.join(root,'profile.json'); fs.writeFileSync(profilePath,JSON.stringify({schemaVersion:1,runner:{command:process.execPath,args:[fake]},codexHome:home,model:'isolated-test'}));
  const binding={projectId:prepared.projectId,taskId:'one-goal',ownerThreadId,ownerTurnId,taskMode:'formal',executionRoot,profilePath,contract:{goal:'sum works for positive and negative numbers',boundaries:'temporary sample only',acceptance:'all existing sample tests pass',factEntries:[],skillEntries:[]}};
  const store=new CliTaskStore({controlRoot}), context={controlRoot,executionRoot,ownerThreadId,ownerTurnId};
  const call=(action,input)=>executeRuntimeRequest({schemaVersion:1,requestId:`request-${input.operationId??input.taskId}`,action,input},context);
  const register=(taskId=binding.taskId)=>call('workbench.register',{projectId:binding.projectId,taskId,task:taskId,execution:{kind:'cli',ownerThreadId,stateLocator:store.locator({...binding,taskId})},status:'进行中',progress:'CLI goal',pause:'无',updatedAt:time()});
  const launch=(requestId,action,input)=>launchCliRequest({schemaVersion:1,requestId,action,input},context);
  const review=(run,decision,conclusion)=>store.recordReview({projectId:binding.projectId,taskId:run.taskId,ownerThreadId,runNumber:run.runNumber,resultSha256:sha256File(run.resultPath),decision,evidenceLocator:path.join(executionRoot,'sum.test.cjs'),conclusion,reviewedAt:time()});
  const state=()=>JSON.parse(fs.readFileSync(path.join(controlRoot,'local/runtime/workbench/workbench-state.json')));
  const testSample=()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;return spawnSync(process.execPath,['--test','sum.test.cjs'],{cwd:executionRoot,env,encoding:'utf8',windowsHide:true});};
  return {root,prepared,binding,store,context,call,register,launch,review,state,testSample};
}
test('two-round goal loop keeps the session, verifies real code, archives once and creates no Worker pending',async t=>{
  const f=fixture(t); f.register();
  const first=await f.launch('first','cli.start',{...f.binding,prompt:'first implementation'}); await until(()=>fs.existsSync(first.resultPath));
  assert.equal(f.store.readResult(f.binding,1).status,'completed'); const failing=f.testSample(); assert.equal(failing.status,1, failing.stdout+'\n'+failing.stderr+'\n'+fs.readFileSync(path.join(f.prepared.executionRoot,'sum.cjs'),'utf8'));
  assert.equal(f.state().tasks['one-goal'].status,'进行中');
  const sent=[]; const host={waitForSourceTurnEnd:async()=>{},checkCapability:async()=>({available:true}),send:async message=>{sent.push(message);return {status:'delivered'};}};
  await notifyWhenReady({store:f.store,identity:f.binding,runNumber:1,host});
  assert.equal(f.store.readReview(f.binding,1),null); assert.equal(f.state().tasks['one-goal'].status,'进行中');
  assert.equal((await notifyWhenReady({store:f.store,identity:f.binding,runNumber:1,host})).status,'duplicate-suppressed');
  f.review(first,'continue','negative inputs fail; fix the saved implementation');
  const second=await f.launch('second','cli.resume',{...f.binding,prompt:'fix negatives then complete',expectedRunNumber:1,expectedSessionId:'retained-session'}); await until(()=>fs.existsSync(second.resultPath));
  assert.equal(f.store.readResult(f.binding,2).sessionId,'retained-session'); assert.equal(f.testSample().status,0);
  await notifyWhenReady({store:f.store,identity:f.binding,runNumber:2,host}); f.review(second,'accept','sample tests actually pass');
  const input={projectId:f.binding.projectId,taskId:'one-goal',ownerThreadId:f.binding.ownerThreadId,operationId:'accept-goal',expectedStatus:'进行中',runNumber:2,resultSha256:sha256File(second.resultPath),affectsMainline:true,pendingDependencies:[]};
  assert.deepEqual(f.call('workbench.accept-cli',input).result,f.call('workbench.accept-cli',input).result);
  assert.equal(f.state().tasks['one-goal'],undefined);
  const history=JSON.parse(fs.readFileSync(path.join(f.prepared.controlRoot,'local/history/workbench',`${time().slice(0,7)}.json`)));
  assert.equal(history.records.length,1); assert.equal(history.records[0].runNumber,2); assert.equal(sent.length,2);
  assert.equal(fs.existsSync(path.join(f.prepared.controlRoot,'local/runtime/worker-results')),false);
});
test('user changes goal: explicitly closed task cannot be resumed or accepted by its old result',async t=>{
  const f=fixture(t); f.register(); const run=await f.launch('first','cli.start',{...f.binding,prompt:'partial'}); await until(()=>fs.existsSync(run.resultPath));
  f.review(run,'continue','partial');
  f.call('workbench.close',{projectId:f.binding.projectId,taskId:'one-goal',ownerThreadId:f.binding.ownerThreadId,operationId:'close-goal',expectedStatus:'进行中',businessState:'已关闭',ownerDirective:'explicit-owner-instruction',closedBy:f.binding.ownerThreadId,closedAt:time(),closureReason:'user selected another goal',taskLocator:f.store.locator(f.binding),authorizationLocator:'thread:owner/explicit-choice',stateSha256:digest(f.store.read(f.binding))});
  await assert.rejects(()=>f.launch('late','cli.resume',{...f.binding,prompt:'old continuation',expectedRunNumber:1,expectedSessionId:'retained-session'}),/registration|active|archived/);
  f.register('new-goal'); assert.equal(f.state().tasks['new-goal'].status,'进行中');
});
test('two goals may notify out of order without mixing results or treating delivery as review',async t=>{
  const f=fixture(t), messages=[];
  const host={waitForSourceTurnEnd:async()=>{},checkCapability:async()=>({available:true}),send:async m=>{messages.push(m.prompt);return {status:'delivered'};}};
  for(const taskId of ['goal-a','goal-b']) {
    f.register(taskId); const binding={...f.binding,taskId};f.store.create(binding);
    const run=f.store.beginRun(binding,{requestId:'first',prompt:'work',expectedRunNumber:0,expectedSessionId:null}); f.store.bindSession(run,`session-${taskId}`);f.store.finishRun(run,{status:'completed',exitCode:0,finalText:taskId});
  }
  for(const taskId of ['goal-b','goal-a'])await notifyWhenReady({store:f.store,identity:{...f.binding,taskId},runNumber:1,host});
  assert.match(messages[0],/goal-b/);assert.match(messages[1],/goal-a/);
  for(const taskId of ['goal-a','goal-b']) {assert.equal(f.store.readResult({...f.binding,taskId},1).finalText,taskId); assert.equal(f.store.readReview({...f.binding,taskId},1),null);assert.equal(f.state().tasks[taskId].status,'进行中');}
});
