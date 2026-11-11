import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Manager,atomicJson,readJson,inside} from '../core.mjs';
import {BatchManager,batchOptions,nextBatchSize,runBatch,itemWrapper} from '../batches.mjs';

async function fixture(t, overrides={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'revit-chunks-test-'));
  t.after(async()=>{assert(inside(os.tmpdir(),root));await fs.rm(root,{recursive:true,force:true});});
  const manager=new Manager({stateRoot:root},root),sessionId=randomUUID(),documentId=randomUUID();
  await fs.mkdir(manager.sessionDir(sessionId),{recursive:true});
  await atomicJson(path.join(manager.sessionDir(sessionId),'session.json'),{sessionId,pid:process.pid,
    heartbeatUtc:new Date().toISOString(),bridgeVersion:'0.4.0',capabilities:{atomicJobClaims:true,chunkWarningRollback:true,warningDialogGroupRollback:true,guardedExecution:true,preservation:true},documents:[{documentId}]});
  let launches=0;
  const batches=new BatchManager(manager,{launchWorker:async()=>{launches++;}});
  const options=batchOptions({documentId,code:'return itemIndex;',items:Array.from({length:8},(_,i)=>JSON.stringify(i)),
    initialBatchSize:2,maxBatchSize:2,yieldMs:50,...overrides});
  const result=await batches.start(sessionId,options);
  return {manager,batches,root,sessionId,documentId,options,batchId:result.batchId,dir:batches.dir(sessionId,result.batchId),launches:()=>launches};
}

function simulator(f, behavior={}) {
  const jobs=new Map(),calls=[];
  let chunk=0;
  return {
    calls,
    async submit(session,operation,args,jobId) {
      calls.push({operation,args,jobId});
      let result={jobId,status:'completed',result:{}};
      if(operation==='check_preservation')result={jobId,status:'completed',result:{ok:!behavior.preservationFailure,checkedCount:args.preserveElements.length}};
      else if(operation==='execute_code' && !['none','query'].includes(args.transactionMode)) {
        chunk++;
        if(behavior.chunk)result=await behavior.chunk(chunk,args,jobId,f);
        else {
          const items=JSON.parse(args.parameters[0]);
          result={jobId,status:'completed',timings:{executionMs:20,commitMs:5},
            result:{transactionStatus:args.transactionMode==='preview'?'RolledBack':'Committed',
              value:{processed:items.length,values:items.map(x=>JSON.parse(x))}}};
        }
      } else if(operation==='execute_code') {
        result={jobId,status:behavior.verifyFailure?'failed':'completed',result:{value:!behavior.verifyFailure},error:behavior.verifyFailure?'check failed':undefined};
      }
      if(operation==='execute_code'&&result.status==='completed') {
        result.timings??={};
        result.timings.guard??={cleanupComplete:true,created:[],preservationFinal:{ok:true,checkedCount:args.preserveElements?.length??0}};
      }
      jobs.set(jobId,result);
      return {jobId,status:'queued'};
    },
    async job(session,id){if(behavior.pollError)throw new Error('disk failure');return jobs.get(id);},
    async cancel(session,id){jobs.set(id,{jobId:id,status:'cancelled'});return {status:'cancelled'};}
  };
}

test('a short batch records committed chunks and returns control between them',async t=>{
  const f=await fixture(t,{verifyCode:'return true;'}), sim=simulator(f);
  const start=Date.now(); const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'completed');assert.equal(r.committedItems,8);assert.equal(r.completedChunks,4);
  assert.equal(r.verification,'passed');assert(Date.now()-start>=150);
  assert.equal((await f.batches.results(f.sessionId,f.batchId,1,2)).chunks.length,2);
  assert.equal((await f.batches.results(f.sessionId,f.batchId,1,2)).nextOffset,3);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code'&&c.args.transactionMode==='transaction').length,4);
});

test('preview reports processed items without claiming any commits',async t=>{
  const f=await fixture(t,{mode:'preview',verifyCode:'return true;'});
  const r=await runBatch(simulator(f),f.dir,{pollMs:1});
  assert.equal(r.status,'completed');assert.equal(r.committedItems,0);assert.equal(r.previewedItems,8);
  assert((await f.batches.results(f.sessionId,f.batchId)).chunks.every(c=>c.transactionStatus==='RolledBack'&&c.verification==='skipped_preview'));
});

test('an intermediate bridge without dialog group rollback cannot run new modelling batches',async t=>{
  const f=await fixture(t),file=path.join(f.manager.sessionDir(f.sessionId),'session.json');
  const s=await readJson(file);delete s.capabilities.warningDialogGroupRollback;await atomicJson(file,s);
  await assert.rejects(f.batches.start(f.sessionId,f.options,randomUUID()),/warningDialogGroupRollback/);
  assert.equal(f.launches(),1);
});

test('a failed chunk retains previous confirmed commits and stops before later items',async t=>{
  const f=await fixture(t);
  const sim=simulator(f,{chunk:async(n,args,jobId)=>n===1?
    {jobId,status:'completed',result:{transactionStatus:'Committed',value:{processed:2,values:[0,1]}}}:
    {jobId,status:'failed',error:'bad item',timings:{transactionStatus:'RolledBack'}}});
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'failed');assert.equal(r.committedItems,2);assert.equal(r.currentChunkRolledBack,true);
  assert.equal(r.failedChunkFromIndex,2);assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,2);
});

test('verification failure never reports an already committed chunk as rolled back',async t=>{
  const f=await fixture(t,{verifyCode:'return false;'});
  const r=await runBatch(simulator(f,{verifyFailure:true}),f.dir,{pollMs:1});
  assert.equal(r.status,'verification_failed');assert.equal(r.committedItems,2);assert.equal(r.completedChunks,1);
  assert.equal((await f.batches.results(f.sessionId,f.batchId)).chunks[0].verification,'failed');
});

test('native warning stops the batch with confirmed rollback and diagnostic element IDs',async t=>{
  const f=await fixture(t);
  const sim=simulator(f,{chunk:async(n,args,jobId)=>({jobId,status:'failed',error:'MCP_WARNING_ROLLBACK',
    timings:{transactionStatus:'RolledBack',warningCount:1,warnings:[{failureId:'overlap',elements:['123']} ]}})});
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'failed');assert.equal(r.committedItems,0);assert(r.currentChunkRolledBack);
  assert(r.failedLeafJobId);assert.equal(r.warningCount,1);assert.deepEqual(r.warnings[0].elements,['123']);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,1);
});

test('all prior created IDs and UniqueIds reach the next chunk and a durable checkpoint',async t=>{
  const f=await fixture(t),seen=[];
  const sim=simulator(f,{chunk:async(n,args,jobId)=>{
    seen.push(args.preserveElements.length);
    const items=JSON.parse(args.parameters[0]);
    return {jobId,status:'completed',timings:{executionMs:1,guard:{cleanupComplete:true,
      created:items.map((_,i)=>({id:String(n*10+i),uniqueId:'u-'+n+'-'+i})),preservationFinal:{ok:true}}},
      result:{transactionStatus:'Committed',value:{processed:items.length,values:items}}};
  }});
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'completed');assert.deepEqual(seen,[0,2,4,6]);assert.equal(r.protectedElementCount,8);
  assert.equal((await readJson(path.join(f.dir,'preservation.json'))).elements.length,8);
  assert.equal((await f.batches.checkpoint(f.sessionId,f.batchId,2,3)).elements.length,3);
  assert.equal((await f.batches.checkpoint(f.sessionId,f.batchId,2,3)).nextOffset,5);
  assert.equal((await f.batches.checkpoint(f.sessionId,f.batchId)).checkedUtc,r.finishedUtc);
  assert(sim.calls.some(c=>c.operation==='check_preservation'&&c.args.preserveElements.length===8));
});

test('missing committed elements stop a batch before another write or automatic recreation',async t=>{
  const f=await fixture(t,{preserveElements:[{id:'99',uniqueId:'baseline'}]});
  const sim=simulator(f,{preservationFailure:true});
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'preservation_failed');assert(r.requiresReconciliation);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,1);
  assert.equal(r.committedItems,2);
  await assert.rejects(f.batches.checkpoint(f.sessionId,f.batchId),/confirmed preservation/);
});

test('an unavailable final preservation read cannot publish completion or a trusted checkpoint',async t=>{
  const f=await fixture(t,{items:['0'],preserveElements:[{id:'99',uniqueId:'baseline'}]});
  const sim=simulator(f),submit=sim.submit;let checks=0;
  sim.submit=async(session,operation,args,jobId)=>{
    if(operation==='check_preservation'&&++checks===2)throw new Error('registry unavailable');
    return submit(session,operation,args,jobId);
  };
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'preservation_failed');assert.equal(r.preservation,'unknown');assert(r.requiresReconciliation);
  assert.equal(r.committedItems,1);
  await assert.rejects(f.batches.checkpoint(f.sessionId,f.batchId),/confirmed preservation/);
});

test('cancellation before first chunk performs no API work',async t=>{
  const f=await fixture(t),sim=simulator(f);await f.batches.cancel(f.sessionId,f.batchId);
  const r=await runBatch(sim,f.dir,{pollMs:1});assert.equal(r.status,'cancelled');assert.equal(sim.calls.length,0);
});

test('cancellation after a committed chunk retains that chunk and never starts another',async t=>{
  const f=await fixture(t);
  const sim=simulator(f,{chunk:async(n,args,jobId)=>{
    await atomicJson(path.join(f.dir,'cancel.json'),{requestedUtc:new Date().toISOString()});
    return {jobId,status:'completed',result:{transactionStatus:'Committed',value:{processed:2,values:[0,1]}}};
  }});
  const r=await runBatch(sim,f.dir,{pollMs:1});assert.equal(r.status,'cancelled');assert.equal(r.committedItems,2);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,1);
});

test('item-boundary cancellation confirms rollback of the current chunk',async t=>{
  const f=await fixture(t);
  const sim=simulator(f,{chunk:async(n,args,jobId)=>{
    await atomicJson(path.join(f.dir,'cancel.json'),{});
    return {jobId,status:'failed',error:'MCP_CHUNK_CANCELLED',timings:{transactionStatus:'RolledBack'}};
  }});
  const r=await runBatch(sim,f.dir,{pollMs:1});assert.equal(r.status,'cancelled');assert.equal(r.committedItems,0);assert(r.currentChunkRolledBack);
});

test('unknown leaf outcome is not replayed or followed by automatic lease release',async t=>{
  const f=await fixture(t),sim=simulator(f,{chunk:async(n,args,jobId)=>({jobId,status:'unknown'})});
  const r=await runBatch(sim,f.dir,{pollMs:1});assert.equal(r.status,'unknown');assert.equal(r.requiresReconciliation,true);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,1);
  assert.equal(sim.calls.filter(c=>c.args.action==='release').length,0);
  await assert.rejects(runBatch(sim,f.dir),/EEXIST/);
});

test('polling I/O failure cannot turn an uncertain write into a failed or replayable one',async t=>{
  const f=await fixture(t),sim=simulator(f,{pollError:true});
  const r=await runBatch(sim,f.dir,{pollMs:1});assert.equal(r.status,'unknown');assert.equal(sim.calls.length,1);
});

test('concurrent identical submissions start one worker and survive manager restart',async t=>{
  const f=await fixture(t),id=randomUUID();
  await Promise.all(Array.from({length:16},()=>f.batches.start(f.sessionId,f.options,id)));
  assert.equal(f.launches(),2); // The fixture's original batch plus exactly one concurrent batch.
  const restarted=new BatchManager(f.manager,{launchWorker:()=>{throw new Error('must not launch');}});
  assert.equal((await restarted.start(f.sessionId,f.options,id)).batchId,id);
  assert.equal((await restarted.start(f.sessionId,Object.fromEntries(Object.entries(f.options).reverse()),id)).batchId,id);
  await assert.rejects(restarted.start(f.sessionId,{...f.options,items:['999']},id),/different batch/);
});

test('stale worker heartbeat makes unfinished progress unknown without changing persisted commits',async t=>{
  const f=await fixture(t);
  await atomicJson(path.join(f.dir,'state.json'),{sessionId:f.sessionId,batchId:f.batchId,status:'running',createdUtc:'2000-01-01T00:00:00Z',totalItems:8,processedItems:2,committedItems:2});
  const r=await f.batches.status(f.sessionId,f.batchId);assert.equal(r.status,'unknown');assert.equal(r.committedItems,2);
  assert.equal((await readJson(path.join(f.dir,'state.json'))).status,'running');
});

test('batch rejects invalid DTOs, oversized requests and inconsistent size controls',()=>{
  const base={documentId:randomUUID(),code:'return 1;',items:['{}']};
  assert.throws(()=>batchOptions({...base,items:['broken json']}));
  assert.throws(()=>batchOptions({...base,initialBatchSize:10,maxBatchSize:2}),/exceeds/);
  assert.throws(()=>batchOptions({...base,yieldMs:0}),/yieldMs/);
  assert.throws(()=>batchOptions({...base,items:Array(40).fill(JSON.stringify('x'.repeat(250000)))}),/8 MB/);
});

test('adaptive size includes commit time, shrinks to one on an overrun, and caps growth',()=>{
  const o={targetChunkMs:500,maxBatchSize:20};
  assert.equal(nextBatchSize(10,10,{executionMs:100,commitMs:10000},o),1);
  assert.equal(nextBatchSize(2,2,{executionMs:1,commitMs:1},o),4);
  assert.equal(nextBatchSize(16,16,{executionMs:1},o),20);
  assert.equal(nextBatchSize(10,10,{executionMs:1,commitMs:1,dispatchMs:10000},o),1);
});

test('batch completion is withheld until workflow cleanup is durable',async t=>{
  const f=await fixture(t);
  const state={...await readJson(path.join(f.dir,'state.json')),status:'completed',phase:'releasing_workflow',processedItems:8};
  await atomicJson(path.join(f.dir,'state.json'),state);
  assert.equal((await f.batches.status(f.sessionId,f.batchId)).status,'running');
  assert.equal((await f.batches.status(f.sessionId,f.batchId)).outcomePending,'completed');
  await atomicJson(path.join(f.dir,'state.json'),{...state,phase:'finished',finishedUtc:new Date().toISOString()});
  assert.equal((await f.batches.status(f.sessionId,f.batchId)).status,'completed');
});

test('lost persistence after a successful commit requires reconciliation and stops further writes',async t=>{
  const f=await fixture(t);
  const sim=simulator(f,{chunk:async(n,args,jobId)=>{
    assert(inside(f.root,f.dir));await fs.rename(path.join(f.dir,'chunks'),path.join(f.dir,'chunks-hidden'));
    return {jobId,status:'completed',result:{transactionStatus:'Committed',value:{processed:2,values:[0,1]}}};
  }});
  const r=await runBatch(sim,f.dir,{pollMs:1});
  assert.equal(r.status,'unknown');assert.equal(r.requiresReconciliation,true);
  assert.equal(sim.calls.filter(c=>c.operation==='execute_code').length,1);
  assert.equal(sim.calls.filter(c=>c.args.action==='release').length,0);
});

test('an interrupted batch reservation is reported without starting a replacement worker',async t=>{
  const f=await fixture(t);
  await fs.rm(path.join(f.dir,'state.json'));
  assert.equal((await f.batches.start(f.sessionId,f.options,f.batchId)).status,'submission_incomplete');
  assert.equal(f.launches(),1);
});
