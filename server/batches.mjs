import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, readJson, validId } from './core.mjs';
import {references,mergeReferences} from './safety.mjs';

const terminal = new Set(['completed', 'cancelled', 'failed', 'verification_failed', 'preservation_failed', 'unknown']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => JSON.stringify(value, (key,v) => v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const exists = async file => { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function batchOptions(input) {
  const o = { parameters: [], mode: 'transaction', initialBatchSize: 1, maxBatchSize: 20,
    targetChunkMs: 500, yieldMs: 100, ...input };
  validId(o.documentId);
  if (typeof o.code !== 'string' || !o.code.trim() || o.code.length > 190000) throw new Error('Expected item code up to 190000 characters');
  if (o.verifyCode !== undefined && (typeof o.verifyCode !== 'string' || !o.verifyCode.trim() || o.verifyCode.length > 190000)) throw new Error('Invalid verifyCode');
  if (!Array.isArray(o.items) || !o.items.length || o.items.length > 10000) throw new Error('Expected 1..10000 JSON items');
  for (const item of o.items) {
    if (typeof item !== 'string' || item.length > 262144) throw new Error('Each item must be a JSON string up to 262144 characters');
    JSON.parse(item);
  }
  if (!Array.isArray(o.parameters) || o.parameters.some(p => typeof p !== 'string')) throw new Error('Expected string parameters');
  o.preserveElements=references(o.preserveElements);
  if (!['transaction', 'preview'].includes(o.mode)) throw new Error('Expected transaction or preview mode');
  for (const [key, min, max] of [['initialBatchSize',1,100],['maxBatchSize',1,100],['targetChunkMs',50,2000],['yieldMs',50,5000]])
    if (!Number.isInteger(o[key]) || o[key] < min || o[key] > max) throw new Error(`Invalid ${key}: expected ${min}..${max}`);
  if (o.initialBatchSize > o.maxBatchSize) throw new Error('initialBatchSize exceeds maxBatchSize');
  if (Buffer.byteLength(JSON.stringify(o)) > 8_000_000) throw new Error('Batch request exceeds 8 MB');
  return o;
}

// This method body is constant across chunks. Only DTOs/parameters vary, so Roslyn can reuse it.
export function itemWrapper(body) {
  return `var input = System.Text.Json.JsonSerializer.Deserialize<string[]>(parameters[0]);
int startIndex = int.Parse(parameters[1], System.Globalization.CultureInfo.InvariantCulture);
int targetMs = int.Parse(parameters[2], System.Globalization.CultureInfo.InvariantCulture);
string cancelFile = parameters[3];
parameters = parameters.Skip(4).ToArray();
Func<string,int,object> runItem = (itemJson,itemIndex) => { ${body}\n };
var values = new List<object>(); var clock = System.Diagnostics.Stopwatch.StartNew();
for (int i=0; i<input.Length; i++) {
  if (System.IO.File.Exists(cancelFile)) throw new OperationCanceledException("MCP_CHUNK_CANCELLED");
  object value;
  try { value = runItem(input[i],startIndex+i); }
  catch (Exception ex) { throw new InvalidOperationException("Item "+(startIndex+i)+": "+ex.Message,ex); }
  if (System.Text.Json.JsonSerializer.Serialize(value).Length > 16000) throw new InvalidOperationException("Item result exceeds 16000 characters; return IDs and a summary");
  values.Add(value);
  if (System.IO.File.Exists(cancelFile)) throw new OperationCanceledException("MCP_CHUNK_CANCELLED");
  if (clock.ElapsedMilliseconds >= targetMs) break;
}
return new { processed=values.Count, values=values.ToArray(), itemLoopMs=clock.ElapsedMilliseconds };`;
}

export function nextBatchSize(previous, processed, timings, options) {
  const modelMs = Math.max(1, timings?.dispatchMs ?? ((timings?.executionMs ?? 0) + (timings?.commitMs ?? 0) + (timings?.resultCheckMs ?? 0)));
  const estimate = Math.floor(processed * options.targetChunkMs * 0.7 / modelMs);
  return Math.max(1, Math.min(options.maxBatchSize, previous * 2, estimate));
}

export class BatchManager {
  constructor(manager, { launchWorker } = {}) { this.manager=manager; this.launchWorker=launchWorker ?? (dir => this.spawnWorker(dir)); }
  dir(sessionId, batchId) { return path.join(this.manager.config.stateRoot,'batches',validId(sessionId),validId(batchId)); }
  async start(sessionId, input, batchId=randomUUID()) {
    sessionId=validId(sessionId); batchId=validId(batchId);
    const options=batchOptions(input), dir=this.dir(sessionId,batchId);
    const request={sessionId,batchId,options};
    const file=path.join(dir,'request.json');
    try {
      const prior=await readJson(file);
      if (canonical(prior)!==canonical(request)) throw new Error('requestId already belongs to a different batch');
      return this.status(sessionId,batchId);
    } catch(e) { if(e.code!=='ENOENT')throw e; }
    const session=await this.manager.requireSession(sessionId);
    if (session.bridgeVersion !== '0.4.0' || !session.capabilities?.atomicJobClaims || !session.capabilities?.chunkWarningRollback || !session.capabilities?.warningDialogGroupRollback || !session.capabilities?.guardedExecution || !session.capabilities?.preservation) throw new Error('Chunk modelling requires Revit bridge 0.4.0 with guardedExecution, preservation and warningDialogGroupRollback; restart the selected worker after installing it');
    if (!session.documents?.some(d=>d.documentId===options.documentId)) throw new Error('Document is not present in this session snapshot; refresh revit_documents');
    await fs.mkdir(path.join(dir,'chunks'),{recursive:true});
    const temp=path.join(dir,randomUUID()+'.tmp');
    await fs.writeFile(temp,JSON.stringify(request),{flag:'wx'});
    let reserved=false;
    try { await fs.link(temp,file); reserved=true; }
    catch(e) { if(e.code!=='EEXIST')throw e; }
    finally { await fs.rm(temp,{force:true}); }
    if(!reserved) {
      const prior=await readJson(file);
      if(canonical(prior)!==canonical(request))throw new Error('requestId already belongs to a different batch');
      return this.status(sessionId,batchId);
    }
    await atomicJson(path.join(dir,'state.json'),{sessionId,batchId,status:'starting',phase:'starting_worker',
      totalItems:options.items.length,processedItems:0,committedItems:0,previewedItems:0,completedChunks:0,
      createdUtc:new Date().toISOString(),mode:options.mode,
      verification:options.mode==='preview'?'skipped_preview':options.verifyCode?'pending':'not_requested'});
    try { await this.launchWorker(dir); }
    catch(e) {
      await atomicJson(path.join(dir,'state.json'),{...await readJson(path.join(dir,'state.json')),status:'failed',phase:'worker_start_failed',error:e.message});
      throw e;
    }
    return this.status(sessionId,batchId);
  }
  async spawnWorker(dir) {
    const log=await fs.open(path.join(dir,'worker.log'),'a');
    try {
      const child=spawn(process.execPath,[path.join(this.manager.packageRoot,'batch-worker.mjs'),dir],
        {cwd:this.manager.packageRoot,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});
      await once(child,'spawn'); child.unref();
    } finally { await log.close(); }
  }
  async status(sessionId,batchId) {
    const dir=this.dir(sessionId,batchId);
    const request=await readJson(path.join(dir,'request.json'));
    let state;
    try { state=await readJson(path.join(dir,'state.json')); }
    catch(e) { if(e.code!=='ENOENT')throw e; return {sessionId:request.sessionId,batchId:request.batchId,status:'submission_incomplete',note:'Reserved request was not started; it is never replayed automatically.'}; }
    // Completion is public only after cleanup/lease release has finished.
    if(terminal.has(state.status) && state.status!=='unknown' && !state.finishedUtc && state.phase!=='worker_start_failed')
      state={...state,outcomePending:state.status,status:'running'};
    if(!terminal.has(state.status)) {
      let heartbeat=null;
      try { heartbeat=await readJson(path.join(dir,'heartbeat.json')); } catch(e) { if(e.code!=='ENOENT')throw e; }
      let alive=false;
      if(heartbeat)try{process.kill(heartbeat.pid,0);alive=true;}catch{}
      const fresh=heartbeat && Date.now()-Date.parse(heartbeat.utc)<15000;
      if ((!alive || !fresh) && Date.now()-Date.parse(state.createdUtc)>15000)
        state={...state,status:'unknown',phase:'worker_unavailable',effectsMayHaveOccurred:true,
          note:'Worker heartbeat was lost. Reconcile the active leaf job and model; no chunk is replayed automatically.'};
    }
    return {...state,cancellationRequested:await exists(path.join(dir,'cancel.json')),
      progress:state.totalItems ? state.processedItems/state.totalItems : 0};
  }
  async cancel(sessionId,batchId) {
    const state=await this.status(sessionId,batchId);
    if(terminal.has(state.status) && state.status!=='unknown')return {...state,cancellationAccepted:false};
    await atomicJson(path.join(this.dir(sessionId,batchId),'cancel.json'),{requestedUtc:new Date().toISOString()});
    return {...await this.status(sessionId,batchId),cancellationAccepted:true,
      note:'Cancellation is requested. Wait for terminal status: the current API call cannot be interrupted mid-call.'};
  }
  async results(sessionId,batchId,offset=0,limit=20) {
    const dir=this.dir(sessionId,batchId); await readJson(path.join(dir,'request.json'));
    const names=(await fs.readdir(path.join(dir,'chunks'))).filter(n=>/^\d{6}\.json$/.test(n)).sort();
    const chunks=[];
    for(const name of names.slice(offset,offset+limit))chunks.push(await readJson(path.join(dir,'chunks',name)));
    return {sessionId,batchId,totalChunks:names.length,chunks,nextOffset:offset+limit<names.length?offset+limit:null};
  }
  async checkpoint(sessionId,batchId,offset=0,limit=1000) {
    const state=await this.status(sessionId,batchId);
    if(!terminal.has(state.status)||state.status==='unknown'||state.preservation!=='passed')throw new Error('Checkpoint requires a finished batch with confirmed preservation; reconcile unknown/missing elements first');
    const checkpoint=await readJson(path.join(this.dir(sessionId,batchId),'preservation.json'));
    return {sessionId,batchId,documentId:checkpoint.documentId,checkedUtc:state.finishedUtc,preservationJobId:state.preservationJobId,totalElements:checkpoint.elements.length,
      elements:checkpoint.elements.slice(offset,offset+limit),nextOffset:offset+limit<checkpoint.elements.length?offset+limit:null};
  }
}

class UncertainError extends Error {}

// Out-of-process orchestration: no API object or open transaction survives between chunks.
export async function runBatch(manager,dir,{pollMs=200}={}) {
  await fs.mkdir(path.join(dir,'worker.lock')); // Deliberately never reclaimed/replayed automatically.
  const request=await readJson(path.join(dir,'request.json'));
  const {sessionId,batchId,options:o}=request;
  let state=await readJson(path.join(dir,'state.json'));
  let leased=false, heartbeatError=null;
  let protectedElements=references(o.preserveElements);
  let beat=Promise.resolve();
  const heartbeat=()=>{beat=beat.then(()=>atomicJson(path.join(dir,'heartbeat.json'),{pid:process.pid,utc:new Date().toISOString()})).catch(e=>{heartbeatError=e;});};
  heartbeat(); await beat;
  const timer=setInterval(heartbeat,1000);
  const cancelled=()=>exists(path.join(dir,'cancel.json'));
  const save=async patch=>{state={...state,...patch,updatedUtc:new Date().toISOString()};await atomicJson(path.join(dir,'state.json'),state);};
  async function checkPreservation(phase='checking_preservation') {
    const check=await leaf('check_preservation',{documentId:o.documentId,workflowId:batchId,preserveElements:protectedElements},phase);
    const ok=check.status==='completed'&&check.result?.ok===true;
    await save({preservation:ok?'passed':'failed',protectedElementCount:protectedElements.length,
      preservationJobId:check.jobId,preservationResult:check.result??check.error});
    if(!ok)await save({status:'preservation_failed',requiresReconciliation:true,error:'Previous or current committed elements are missing/replaced; no automatic recreation'});
    return ok;
  }
  async function leaf(operation,args,phase) {
    if(heartbeatError)throw new UncertainError('Cannot persist worker heartbeat: '+heartbeatError.message);
    const jobId=randomUUID();
    await save({activeJobId:jobId,activeOperation:operation,phase});
    try { await manager.submit(sessionId,operation,args,jobId); }
    catch(e) { throw new UncertainError('Leaf submission has uncertain outcome: '+e.message); }
    let cancellationSent=false;
    try { for(;;) {
      const result=await manager.job(sessionId,jobId);
      if(['completed','failed','expired','cancelled'].includes(result.status))return result;
      if(!['running','queued'].includes(result.status))throw new UncertainError('Leaf outcome is '+result.status);
      if(operation==='execute_code' && !cancellationSent && await cancelled()) {
        await manager.cancel(sessionId,jobId); cancellationSent=true;
      }
      await sleep(pollMs);
    } } catch(e) { throw e instanceof UncertainError ? e : new UncertainError('Leaf polling outcome is uncertain: '+e.message); }
  }
  try {
    if(await cancelled()){await save({status:'cancelled',phase:'finished',finishedUtc:new Date().toISOString()});return state;}
    const acquire=await leaf('workflow',{action:'acquire',workflowId:batchId,owner:'Chunk modelling '+batchId,ttlSeconds:300},'acquiring_workflow');
    if(acquire.status!=='completed')throw new Error(acquire.error??'Cannot reserve Revit workflow');
    leased=true;
    await save({status:'running'});
    let count=o.initialBatchSize;
    while(state.processedItems<o.items.length) {
      if(await cancelled()){await save({status:'cancelled'});break;}
      const renew=await leaf('workflow',{action:'renew',workflowId:batchId,owner:'Chunk modelling '+batchId,ttlSeconds:300},'renewing_workflow');
      if(renew.status!=='completed')throw new Error(renew.error??'Workflow lease lost; refresh baseline');
      const from=state.processedItems;
      const items=o.items.slice(from,from+count);
      const chunkNo=state.completedChunks+1;
      await save({chunkNumber:chunkNo,chunkFromIndex:from,plannedChunkItems:items.length});
      const result=await leaf('execute_code',{documentId:o.documentId,workflowId:batchId,code:itemWrapper(o.code),
        parameters:[JSON.stringify(items),String(from),String(o.targetChunkMs),path.join(dir,'cancel.json'),...o.parameters],
        transactionMode:o.mode,preserveElements:protectedElements},'executing_chunk');
      if(result.status!=='completed') {
        const rollback=(result.timings?.transactionStatus==='RolledBack'&&result.timings?.guard?.cleanupComplete!==false) || result.status==='cancelled' || result.status==='expired';
        if(!rollback && !['NotStarted'].includes(result.timings?.transactionStatus))throw new UncertainError(result.error??'Unconfirmed chunk transaction');
        await save({status:await cancelled() && (result.error==='MCP_CHUNK_CANCELLED'||result.status==='cancelled')?'cancelled':'failed',
          error:result.error,currentChunkRolledBack:result.timings?.transactionStatus==='RolledBack',
          failedChunkFromIndex:from,failedLeafJobId:result.jobId,
          warningCount:result.timings?.warningCount??0,warnings:result.timings?.warnings??[]});
        break;
      }
      const value=result.result?.value, processed=value?.processed;
      const guard=result.timings?.guard;
      if(!guard?.cleanupComplete||!guard.preservationFinal?.ok||!Array.isArray(guard.created))throw new UncertainError('Missing successful protection/preservation evidence; reconcile the committed transaction');
      if(!Number.isInteger(processed)||processed<1||processed>items.length||value.values?.length!==processed)
        throw new UncertainError('Malformed successful chunk result; reconcile the committed transaction');
      const expected=o.mode==='preview'?'RolledBack':'Committed';
      if(result.result.transactionStatus!==expected)throw new UncertainError('Unexpected chunk transaction status');
      const record={chunkNumber:chunkNo,fromIndex:from,processed,leafJobId:result.jobId,transactionStatus:expected,
        values:value.values,timings:result.timings,verification:o.mode==='preview'?'skipped_preview':o.verifyCode?'pending':'not_requested'};
      const recordFile=path.join(dir,'chunks',String(chunkNo).padStart(6,'0')+'.json');
      await atomicJson(recordFile,record); // Commit evidence first; never issue another chunk until persisted.
      if(o.mode==='transaction')protectedElements=mergeReferences(protectedElements,references(guard.created));
      await atomicJson(path.join(dir,'preservation.json'),{documentId:o.documentId,elements:protectedElements});
      await save({processedItems:from+processed,committedItems:o.mode==='transaction'?from+processed:0,
        previewedItems:o.mode==='preview'?from+processed:0,completedChunks:chunkNo,activeJobId:null,
        protectedElementCount:protectedElements.length,preservation:'passed',
        lastChunkMs:result.timings?.dispatchMs??((result.timings?.executionMs??0)+(result.timings?.commitMs??0)),lastChunkItems:processed});
      if(o.verifyCode && o.mode==='transaction') {
        if(await cancelled()) {
          record.verification='not_run_cancelled'; await atomicJson(recordFile,record);
          await save({status:'cancelled',verification:'not_run_cancelled'}); break;
        }
        const check=await leaf('execute_code',{documentId:o.documentId,workflowId:batchId,code:o.verifyCode,
          parameters:[JSON.stringify(value.values),JSON.stringify(items.slice(0,processed)),String(from),...o.parameters],transactionMode:'query',preserveElements:protectedElements},'verifying_chunk');
        const ok=check.status==='completed' && check.timings?.guard?.cleanupComplete===true && check.timings?.guard?.preservationFinal?.ok===true && (check.result.value===true || check.result.value?.ok===true);
        record.verification=ok?'passed':'failed'; record.verificationJobId=check.jobId; record.verificationResult=check.result?.value??check.error;
        await atomicJson(recordFile,record);
        if(!ok){await save({status:await cancelled() && check.status==='cancelled'?'cancelled':'verification_failed',
          verification:'failed',error:'Post-commit verification did not pass; committed items are retained'});break;}
        await save({verification:'passed'});
      } else if(o.mode==='transaction' && !await checkPreservation())break;
      count=nextBatchSize(count,processed,result.timings,o);
      await save({phase:'yielding',nextBatchSize:count,activeJobId:null});
      if(state.processedItems<o.items.length)await sleep(o.yieldMs);
    }
    if(state.status==='running')await save({status:await cancelled()?'cancelled':'completed'});
  } catch(e) {
    const uncertain=e instanceof UncertainError || state.activeOperation==='execute_code';
    await save({status:uncertain?'unknown':'failed',error:e.message,
      effectsMayHaveOccurred:uncertain,requiresReconciliation:uncertain});
  } finally {
    // An uncertain running write must not be followed by an automatic release/replay.
    if(leased && state.status!=='unknown') {
      if(protectedElements.length && state.status!=='preservation_failed') {
        try {await checkPreservation('final_preservation_check');}
        catch(e){await save({status:'preservation_failed',preservation:'unknown',requiresReconciliation:true,error:'Final preservation check unavailable: '+e.message});}
      }
      try {
        const release=await leaf('workflow',{action:'release',workflowId:batchId},'releasing_workflow');
        if(release.status!=='completed')await save({leaseReleaseError:release.error??release.status});
      } catch(e) { await save({leaseReleaseError:e.message}); }
    }
    clearInterval(timer); await beat;
    await save({phase:'finished',activeJobId:state.status==='unknown'?state.activeJobId:null,finishedUtc:new Date().toISOString()});
  }
  return state;
}
