import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const productRoot = path.resolve(process.env.BEYOND_TEST_PRODUCT_ROOT ?? '模板交付包');
const { readLocalWorkerFinal } = await import(pathToFileURL(path.join(productRoot,'scripts/read-local-worker-final.mjs')));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-local-final-'));
const threadId = '01000000-0000-7000-8000-000000000001', turnId = '01000000-0000-7000-8000-000000000010';
const otherTurn = '01000000-0000-7000-8000-000000000011';
const expectedCwd = path.join(scratch,'project'); fs.mkdirSync(expectedCwd);
const options = { threadId, turnId, expectedCwd, hostId:'local', turnStatus:'completed', finalUnavailable:'yes', codexHome:scratch };
const dir = path.join(scratch,'sessions/2026/09/14'); fs.mkdirSync(dir,{recursive:true});
const file = path.join(dir,`rollout-test-${threadId}.jsonl`);
const text = '进行中\n已修复1067个字段，剩余4条原范围内官方链接需要核实。';
const rows = [
 {type:'session_meta',payload:{id:threadId,cwd:expectedCwd}},
 {type:'event_msg',timestamp:'2026-09-14T03:00:00Z',payload:{type:'task_started',turn_id:turnId}},
 {type:'event_msg',timestamp:'2026-09-14T03:08:58.412Z',payload:{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{id:'final-message',type:'AgentMessage',phase:'final_answer',content:[{type:'Text',text}]}}},
 {type:'event_msg',timestamp:'2026-09-14T03:08:58.587Z',payload:{type:'task_complete',turn_id:turnId,last_agent_message:text}},
];
const put = r=>fs.writeFileSync(file,r.map(x=>JSON.stringify(x)).join('\n')+'\n');
const results=[];
async function test(name,r=rows,patch={},ok=false){put(r);const before=fs.readFileSync(file);const result=await readLocalWorkerFinal({...options,...patch});assert.equal(result.ok,ok,name+': '+JSON.stringify(result));assert.deepEqual(fs.readFileSync(file),before);results.push({name,ok:result.ok,reason:result.reason});return result;}
const good=await test('completed current turn exact text recovered',rows,{},true);assert.equal(good.finalText,text);assert.equal(good.locator.line,3);
await test('wrong thread',rows,{threadId:'01000000-0000-7000-8000-000000000099'});
await test('wrong cwd',rows,{expectedCwd:path.join(scratch,'other')});
await test('wrong turn',rows,{turnId:otherTurn});
await test('running platform state',rows,{turnStatus:'inProgress'});
await test('already readable API result',rows,{finalUnavailable:'no'});
await test('remote host',rows,{hostId:'remote'});
await test('missing local record',rows,{codexHome:path.join(scratch,'absent')});
await test('final without completion',rows.slice(0,3));
await test('completion without final',rows.filter((_,i)=>i!==2));
await test('newer running turn supersedes old final',[...rows,{type:'event_msg',payload:{type:'task_started',turn_id:otherTurn}}]);
await test('commentary not final',rows.map((r,i)=>i===2?{...r,payload:{...r.payload,item:{...r.payload.item,phase:'commentary'}}}:r));
await test('mixed non-text final is not silently truncated',rows.map((r,i)=>i===2?{...r,payload:{...r.payload,item:{...r.payload.item,content:[...r.payload.item.content,{type:'Image',url:'not-opened'}]}}}:r));
await test('invalid text payload',rows.map((r,i)=>i===2?{...r,payload:{...r.payload,item:{...r.payload.item,content:[{type:'Text',text:123}]}}}:r));
await test('conflicting completed summary',rows.map((r,i)=>i===3?{...r,payload:{...r.payload,last_agent_message:'wrong'}}:r));
await test('wrong event thread',rows.map((r,i)=>i===2?{...r,payload:{...r.payload,thread_id:'wrong'}}:r));
await test('duplicate final ambiguity',[...rows.slice(0,3),rows[2],rows[3]]);
await test('completion before final',[rows[0],rows[1],rows[3],rows[2]]);
await test('wrong meta id',rows.map((r,i)=>i===0?{...r,payload:{...r.payload,id:'wrong'}}:r));
put(rows);fs.appendFileSync(file,'{truncated');assert.equal((await readLocalWorkerFinal(options)).ok,false);results.push({name:'truncated record rejected'});
put(rows);const duplicate=path.join(dir,`rollout-duplicate-${threadId}.jsonl`);fs.copyFileSync(file,duplicate);assert.equal((await readLocalWorkerFinal(options)).reason,'ambiguous-session-file');fs.unlinkSync(duplicate);results.push({name:'duplicate session file rejected'});
const cli = path.join(productRoot,'scripts/read-local-worker-final.mjs');
const args=Object.entries({'--thread-id':threadId,'--turn-id':turnId,'--expected-cwd':expectedCwd,'--host-id':'local','--turn-status':'completed','--final-unavailable':'yes','--codex-home':scratch}).flat();
const cliResult=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true});assert.equal(cliResult.status,0,cliResult.stderr);assert.equal(JSON.parse(cliResult.stdout).finalText,text);results.push({name:'actual CLI returns exact text'});
const rejected=spawnSync(process.execPath,[cli,...args,'--turn-id',otherTurn],{encoding:'utf8',windowsHide:true});assert.equal(rejected.status,2);results.push({name:'duplicate CLI option rejected'});
console.log(JSON.stringify({passed:results.length,results,scratch,liveWrites:false},null,2));
