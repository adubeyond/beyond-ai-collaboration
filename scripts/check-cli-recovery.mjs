import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CliTaskStore, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { launchCliRequest, readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { runNativeCli, processStart } from '../模板交付包/scripts/cli/native-cli-runner.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'beyond-cli-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'local/projects'),{recursive:true});fs.mkdirSync(path.join(root,'home'));
  fs.writeFileSync(path.join(root,'local/projects/local-test.md'),`---\nid: local-test\npath: ${root}\n---\n`);
  fs.writeFileSync(path.join(root,'AGENTS.md'),'<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const profile={schemaVersion:1,runner:{command:process.execPath,args:[]},codexHome:path.join(root,'home'),model:'test'};
  const profilePath=path.join(root,'profile.json');fs.writeFileSync(profilePath,JSON.stringify(profile));
  const binding={projectId:'local-test',taskId:'goal',ownerThreadId:'owner',ownerTurnId:'turn-one',executionRoot:root,profilePath,taskMode:'assist',contract:{goal:'task',boundaries:'temporary',acceptance:'test',factEntries:[],skillEntries:[]}};
  const store=new CliTaskStore({controlRoot:root});store.create(binding);
  const begin={requestId:'first',prompt:'work',expectedRunNumber:0,expectedSessionId:null,ownerTurnId:'turn-one'};
  const context={controlRoot:root,executionRoot:root,ownerThreadId:'owner',ownerTurnId:'turn-one'};
  const call=(action,input)=>launchCliRequest({schemaVersion:1,requestId:'recover',action,input},context);
  return {root,profile,profilePath,binding,store,begin,context,call};
}
test('same business request replays across Desktop turns without starting a second run',t=>{
  const f=fixture(t);const first=f.store.beginRun(f.binding,f.begin);
  assert.deepEqual(f.store.beginRun(f.binding,{...f.begin,ownerTurnId:'turn-two'}),first);
  assert.equal(f.store.read(f.binding).ownerTurnId,'turn-one');
});
test('paused owner review can explicitly resume while retaining the original review',t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin);f.store.bindSession(run,'same-session');f.store.finishRun(run,{status:'completed',exitCode:0,finalText:'waiting input'});
  const paused={projectId:f.binding.projectId,taskId:'goal',ownerThreadId:'owner',runNumber:1,resultSha256:sha256File(run.resultPath),decision:'pause',evidenceLocator:'file:missing-input',conclusion:'user input needed',reviewedAt:new Date().toISOString()};f.store.recordReview(paused);
  const original=fs.readFileSync(path.join(f.store.runDir(run,1),'review.json'));
  f.store.recordReview({...paused,decision:'continue',conclusion:'user supplied input',authorizationLocator:'thread:owner/user-input',supersedesReviewSha256:sha256File(path.join(f.store.runDir(run,1),'review.json'))});
  const second=f.store.beginRun(f.binding,{...f.begin,requestId:'second',expectedRunNumber:1,expectedSessionId:'same-session'});
  assert.equal(second.runNumber,2);assert.deepEqual(fs.readFileSync(path.join(f.store.runDir(run,1),'review.json')),original);
});
test('interrupted begin commits replay the same run; immutable result repairs the state index',async t=>{
  for(const faultAt of ['afterRequest','afterRun','afterInput']) {
    const f=fixture(t);assert.throws(()=>f.store.beginRun(f.binding,{...f.begin,faultAt}),/injected fault/);
    const run=f.store.beginRun(f.binding,f.begin);assert.equal(run.runNumber,1);assert.equal(f.store.read(f.binding).runNumber,1);
    f.store.bindSession(run,'same-session');assert.throws(()=>f.store.finishRun(run,{status:'completed',exitCode:0,finalText:'stable'},{faultAt:'afterResult'}),/injected fault/);
    const before=fs.readFileSync(run.resultPath);
    await f.call('cli.recover',{...f.binding,stateSha256:digest(f.store.read(f.binding)),expectedSessionId:'same-session',reason:'repair stable result index'});
    assert.equal(f.store.read(f.binding).status,'completed');assert.deepEqual(fs.readFileSync(run.resultPath),before);
  }
});
test('recovery cannot clear a surviving CLI, and PID reuse is distinguished from the old manager',async t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin);f.store.bindSession(run,'same-session');
  f.store.setProcess(run,{pid:process.pid,startedAt:'old-reused-identity',token:'manager'});
  f.store.setChildProcess(run,{pid:process.pid,startedAt:processStart(process.pid),token:'cli'});
  await assert.rejects(()=>f.call('cli.recover',{...f.binding,stateSha256:digest(f.store.read(f.binding)),expectedSessionId:'same-session',reason:'manager exited'}),/CLI.*exists|CLI.*running/);
  assert.equal(f.store.read(f.binding).status,'running');
  const file=path.join(f.store.runDir(run,1),'cli-process.json'),proof=JSON.parse(fs.readFileSync(file));proof.startedAt='also-reused';fs.writeFileSync(file,JSON.stringify(proof));
  await f.call('cli.recover',{...f.binding,stateSha256:digest(f.store.read(f.binding)),expectedSessionId:'same-session',reason:'both saved processes exited'});
  assert.equal(f.store.read(f.binding).status,'unknown');assert.equal(f.store.read(f.binding).managerPid,null);
});
test('public local status remains usable without Desktop message capability',t=>{
  const f=fixture(t);fs.cpSync(path.join(import.meta.dirname,'../模板交付包/scripts'),path.join(f.root,'scripts'),{recursive:true});
  const request=path.join(f.root,'status.json');fs.writeFileSync(request,JSON.stringify({schemaVersion:1,requestId:'status',action:'cli.status',input:{projectId:'local-test',taskId:'goal',ownerThreadId:'owner'}}));
  const env={...process.env,CODEX_THREAD_ID:'owner',CODEX_HOME:path.join(f.root,'home')};delete env.CODEX_APP_TOOLS_PIPE_PATH;
  const result=spawnSync(process.execPath,[path.join(f.root,'scripts/cli/cli-bridge.mjs'),'--request',request],{cwd:f.root,env,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).result.ownerThreadId,'owner');
});
test('default Desktop home is rejected even when CODEX_HOME is unset',t=>{
  const f=fixture(t),saved=process.env.CODEX_HOME;delete process.env.CODEX_HOME;
  try { fs.writeFileSync(f.profilePath,JSON.stringify({...f.profile,codexHome:path.join(process.env.USERPROFILE||process.env.HOME,'.codex')}));assert.throws(()=>readProfile(f.profilePath),/Desktop.*home|authentication/); }
  finally {if(saved===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=saved;}
});
test('stop submitted before thread.started still stops the exact run after its session binds',async t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin);
  f.store.setProcess(run,{pid:process.pid,startedAt:processStart(process.pid),token:'manager'});
  f.store.requestStop(f.binding,{stateSha256:digest(f.store.read(f.binding)),expectedSessionId:null,reason:'stop immediately',requestId:'stop'});
  const stopFile=path.join(f.store.runDir(run,1),'stop.json'),pending=fs.readFileSync(stopFile);fs.unlinkSync(stopFile);
  const bind=f.store.bindSession.bind(f.store);f.store.bindSession=(r,s)=>{const value=bind(r,s);fs.writeFileSync(stopFile,pending);return value;};
  const file=path.join(f.root,'late.cjs');fs.writeFileSync(file,`console.log(JSON.stringify({type:'thread.started',thread_id:'late-session'}));process.stdin.resume();setTimeout(()=>process.exit(0),2000);`);
  const result=await Promise.race([runNativeCli({binding:f.binding,run,profile:{...f.profile,runner:{command:process.execPath,args:[file]}},prompt:'work',store:f.store}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('stop race timed out')),6000);timer.unref();})]);
  assert.equal(result.status,'stopped');
});
test('log append failure becomes a stable failed result rather than crashing the manager',async t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin);
  const file=path.join(f.root,'bad-log.cjs');fs.writeFileSync(file,`const fs=require('node:fs'),path=require('node:path'),a=process.argv;const dir=path.dirname(a[a.indexOf('--output-last-message')+1]);fs.unlinkSync(path.join(dir,'events.jsonl'));fs.mkdirSync(path.join(dir,'events.jsonl'));console.log(JSON.stringify({type:'thread.started',thread_id:'one-session'}));process.stdin.resume();setTimeout(()=>process.exit(0),2000);`);
  const result=await runNativeCli({binding:f.binding,run,profile:{...f.profile,runner:{command:process.execPath,args:[file]}},prompt:'work',store:f.store});
  assert.equal(result.status,'failed');assert.match(result.error,/log|directory|EISDIR|EPERM/i);assert.equal(f.store.readResult(f.binding,1).status,'failed');
});

test('recovery retires only a verified dead lock, and an unproved launched child stays blocked',async t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin),directory=f.store.runDir(run,1);
  const lock=path.join(f.store.taskDir(f.binding),'.lock');fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:'prior-process-with-reused-pid',token:crypto.randomUUID()}));
  await f.call('cli.recover',{...f.binding,stateSha256:digest(f.store.read(f.binding)),expectedSessionId:null,reason:'verified dead lock before native launch'});
  assert.equal(fs.existsSync(lock),false);assert.equal(f.store.read(f.binding).status,'unknown');
  const g=fixture(t),other=g.store.beginRun(g.binding,g.begin);
  fs.writeFileSync(path.join(g.store.runDir(other,1),'cli-launch-intent.json'),JSON.stringify({runNumber:1,requestId:other.requestId}));
  await assert.rejects(()=>g.call('cli.recover',{...g.binding,stateSha256:digest(g.store.read(g.binding)),expectedSessionId:null,reason:'manager crashed before saved child proof'}),/child process proof unavailable/);
  assert.equal(g.store.read(g.binding).status,'starting');assert.equal(fs.existsSync(other.resultPath),false);
});

test('failed result persistence rejects without sending a terminal notification',async t=>{
  const f=fixture(t),run=f.store.beginRun(f.binding,f.begin);
  const file=path.join(f.root,'stable.cjs');fs.writeFileSync(file,`const fs=require('node:fs'),a=process.argv;console.log(JSON.stringify({type:'thread.started',thread_id:'one-session'}));process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'result');console.log(JSON.stringify({type:'turn.completed'}));});`);
  let notified=0;f.store.finishRun=()=>{throw new Error('injected disk failure');};
  await assert.rejects(()=>runNativeCli({binding:f.binding,run,profile:{...f.profile,runner:{command:process.execPath,args:[file]}},prompt:'work',store:f.store,onTerminal:()=>notified++}),/injected disk failure/);
  assert.equal(notified,0);assert.equal(fs.existsSync(run.resultPath),false);assert.equal(f.store.read(f.binding).status,'starting');
});
