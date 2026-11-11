import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Manager, atomicJson, modelPath, discoverModels, validId, retryFileIO } from '../core.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revit-mcp-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { workspaceRoot: path.join(root, 'WORK'), stateRoot: path.join(root, 'state') };
  await fs.mkdir(config.workspaceRoot);
  const manager = new Manager(config, root);
  const sessionId = randomUUID(), sessionId2 = randomUUID();
  for (const id of [sessionId, sessionId2]) {
    const dir = manager.sessionDir(id);
    for (const sub of ['pending', 'running', 'submitted', 'results']) await fs.mkdir(path.join(dir, sub), { recursive: true });
    await atomicJson(path.join(dir, 'session.json'), { sessionId: id, pid: process.pid, heartbeatUtc: new Date().toISOString(),capabilities:{atomicJobClaims:true} });
  }
  return { root, config, manager, sessionId, sessionId2 };
}
test('WORK containment, Unicode names and sibling path escape', async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(path.join(config.workspaceRoot, 'Корпус.rvt'), 'test');
  await fs.writeFile(path.join(root, 'outside.rvt'), 'test');
  assert.equal(await modelPath(config, 'Корпус.rvt'), await fs.realpath(path.join(config.workspaceRoot, 'Корпус.rvt')));
  await assert.rejects(modelPath(config, '../outside.rvt'), /inside/);
  await assert.rejects(modelPath(config, 'missing.rvt'));
  assert.throws(() => validId('../session'), /UUID/);
});
test('directory junction cannot escape workspace', async t => {
  const { root, config } = await fixture(t);
  const external = path.join(root, 'external'); await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'model.rvt'), 'test');
  await fs.symlink(external, path.join(config.workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(modelPath(config, 'linked/model.rvt'), /Links/);
  assert.equal((await discoverModels(config)).total, 0);
});
test('model discovery skips numbered backup models and paginates', async t => {
  const { config } = await fixture(t);
  for (const name of ['A.rvt', 'A.0001.rvt', 'B.RVT', 'notes.txt']) await fs.writeFile(path.join(config.workspaceRoot, name), 'test');
  const result = await discoverModels(config, { limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.models.length, 1); assert.equal(result.nextOffset, 1);
  assert.equal((await discoverModels(config, { includeBackups: true })).total, 3);
});
test('concurrent MCP clients reserve exactly one request per session', async t => {
  const { manager, sessionId, sessionId2 } = await fixture(t);
  const requestId = randomUUID();
  await Promise.all(Array.from({ length: 16 }, () => manager.submit(sessionId, 'list_documents', {}, requestId)));
  assert.equal((await fs.readdir(path.join(manager.sessionDir(sessionId), 'pending'))).length, 1);
  assert.equal((await fs.readdir(path.join(manager.sessionDir(sessionId), 'submitted'))).length, 1);
  assert.equal((await fs.readdir(path.join(manager.sessionDir(sessionId2), 'pending'))).length, 0);
  await assert.rejects(manager.submit(sessionId, 'execute_code', {}, requestId), /different operation/);
});
test('completed jobs survive MCP restart; no automatic replay', async t => {
  const { manager, config, root, sessionId } = await fixture(t);
  const submitted = await manager.submit(sessionId, 'list_documents');
  const result = { sessionId, jobId: submitted.jobId, status: 'completed', result: { documents: [] } };
  await atomicJson(path.join(manager.sessionDir(sessionId), 'results', `${submitted.jobId}.json`), result);
  assert.deepEqual(await new Manager(config, root).job(sessionId, submitted.jobId), result);
});
test('stale running job is unknown, not failed or canceled', async t => {
  const { manager, sessionId } = await fixture(t);
  const job = await manager.submit(sessionId, 'list_documents');
  const dir = manager.sessionDir(sessionId);
  await fs.rename(path.join(dir, 'pending', `${job.jobId}.json`), path.join(dir, 'running', `${job.jobId}.json`));
  await atomicJson(path.join(dir, 'session.json'), { sessionId, pid: process.pid, heartbeatUtc: '2000-01-01T00:00:00Z' });
  assert.equal((await manager.job(sessionId, job.jobId)).status, 'unknown');
  await assert.rejects(manager.submit(sessionId, 'list_documents'), /unavailable/);
});
test('a transient registry replacement gap does not lose the live session or submit a second job', async t => {
  const {manager,sessionId}=await fixture(t);
  const file=path.join(manager.sessionDir(sessionId),'session.json'), temporary=file+'.replacement';
  await fs.rename(file,temporary);
  const restore=new Promise((resolve,reject)=>setTimeout(()=>fs.rename(temporary,file).then(resolve,reject),30));
  const requestId=randomUUID();
  const submitted=await manager.submit(sessionId,'list_documents',{},requestId);
  await restore;
  assert.equal(submitted.jobId,requestId);
  assert.equal((await fs.readdir(path.join(manager.sessionDir(sessionId),'pending'))).length,1);
});
test('events remain readable with stalled UI, partial append and rotation', async t => {
  const { manager, sessionId } = await fixture(t);
  const dir = manager.sessionDir(sessionId);
  await fs.writeFile(path.join(dir, 'events.previous.jsonl'), '{"sequence":10,"kind":"failure"}\n');
  await fs.writeFile(path.join(dir, 'events.jsonl'), '{"sequence":11,"kind":"dialog_shown"}\n{"sequence":');
  const events = await manager.events(sessionId, 0, 1);
  assert.equal(events.events[0].kind, 'failure'); assert.equal(events.nextSequence, 10);
  assert.equal(events.historyMayBeTruncated, true);
  assert.equal((await manager.events(sessionId, 10)).events[0].kind, 'dialog_shown');
});
test('launch reuses a connected year instead of starting a second process', async t => {
  const { manager, config, root, sessionId } = await fixture(t);
  config.autodeskRoot = path.join(root, 'Autodesk');
  config.supportedVersions = ['2026'];
  await fs.mkdir(path.join(config.autodeskRoot, 'Revit 2026'), { recursive: true });
  await fs.writeFile(path.join(config.autodeskRoot, 'Revit 2026', 'Revit.exe'), 'not an executable');
  await atomicJson(path.join(manager.sessionDir(sessionId), 'session.json'), {
    sessionId, pid: process.pid, version: '2026', heartbeatUtc: new Date().toISOString()
  });
  const result = await manager.launch('2026');
  assert.equal(result.status, 'already_running');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, sessionId);
});

test('single-session status does not scan unrelated corrupt historical registries', async t => {
  const { manager, sessionId, sessionId2 } = await fixture(t);
  await fs.writeFile(path.join(manager.sessionDir(sessionId2), 'session.json'), 'invalid');
  assert.equal((await manager.requireSession(sessionId)).sessionId, sessionId);
  await assert.rejects(manager.session(sessionId2));
});

test('available-session filtering omits stale history without deleting it', async t => {
  const { manager, sessionId, sessionId2 } = await fixture(t);
  await atomicJson(path.join(manager.sessionDir(sessionId2), 'session.json'), {
    sessionId: sessionId2, pid: process.pid, heartbeatUtc: '2000-01-01T00:00:00Z'
  });
  assert.deepEqual((await manager.sessions({ includeUnavailable: false })).map(s => s.sessionId), [sessionId]);
  assert.equal((await manager.sessions()).length, 2);
});

test('a queued cancellation is durable, idempotent and never replays', async t => {
  const { manager, sessionId } = await fixture(t);
  const job = await manager.submit(sessionId, 'list_documents');
  assert.equal((await manager.cancel(sessionId, job.jobId)).status, 'cancelled');
  assert.equal((await manager.cancel(sessionId, job.jobId)).cancellationAccepted, true);
  const retried = await manager.submit(sessionId, 'list_documents', {}, job.jobId);
  assert.equal(retried.status, 'cancelled');
  assert.equal((await manager.queue(sessionId)).pendingCount, 0);
});

test('running cancellation is refused and does not change durable execution state', async t => {
  const { manager, sessionId } = await fixture(t);
  const job = await manager.submit(sessionId, 'list_documents');
  const dir = manager.sessionDir(sessionId);
  await fs.rename(path.join(dir, 'pending', `${job.jobId}.json`), path.join(dir, 'running', `${job.jobId}.json`));
  const result = await manager.cancel(sessionId, job.jobId);
  assert.equal(result.cancellationAccepted, false);
  assert.equal(result.status, 'running');
  assert.equal((await manager.job(sessionId, job.jobId)).status, 'running');
});

test('bridge claim and cancellation race has one owner', async t => {
  const { manager, sessionId } = await fixture(t);
  const dir = manager.sessionDir(sessionId);
  for (let i = 0; i < 20; i++) {
    const job = await manager.submit(sessionId, 'list_documents');
    const [claim, cancellation] = await Promise.allSettled([
      (async()=>{const won=await manager.reserveJobClaim(sessionId,job.jobId,'running','list_documents');if(won)await fs.rename(path.join(dir,'pending',`${job.jobId}.json`),path.join(dir,'running',`${job.jobId}.json`));return won;})(),
      manager.cancel(sessionId, job.jobId)
    ]);
    assert.equal(cancellation.status, 'fulfilled');
    assert.equal(claim.status,'fulfilled');
    assert.equal(cancellation.value.cancellationAccepted,!claim.value);
    assert.equal((await manager.job(sessionId, job.jobId)).status, claim.value ? 'running' : 'cancelled');
  }
});

test('long polling returns a completed result without resubmission', async t => {
  const { manager, sessionId } = await fixture(t);
  const job = await manager.submit(sessionId, 'list_documents');
  const result = { sessionId, jobId: job.jobId, status: 'completed' };
  const completion = new Promise(resolve => setTimeout(async () => {
    await atomicJson(path.join(manager.sessionDir(sessionId), 'results', `${job.jobId}.json`), result); resolve();
  }, 40));
  assert.deepEqual(await manager.waitJob(sessionId, job.jobId, 1000), result);
  await completion;
});

test('same request can recover a completed result after session loss', async t => {
  const { manager, sessionId } = await fixture(t);
  const job = await manager.submit(sessionId, 'list_documents');
  const result = { sessionId, jobId: job.jobId, status: 'completed' };
  await atomicJson(path.join(manager.sessionDir(sessionId), 'results', `${job.jobId}.json`), result);
  await atomicJson(path.join(manager.sessionDir(sessionId), 'session.json'), {
    sessionId, pid: process.pid, heartbeatUtc: '2000-01-01T00:00:00Z'
  });
  assert.deepEqual(await manager.submit(sessionId, 'list_documents', {}, job.jobId), result);
  await assert.rejects(manager.submit(sessionId, 'list_documents'), /unavailable/);
});

test('UUID case is normalized before durable reservation', async t => {
  const { manager, sessionId } = await fixture(t);
  const id = randomUUID();
  await manager.submit(sessionId.toUpperCase(), 'list_documents', {}, id.toUpperCase());
  assert.equal((await manager.job(sessionId, id)).status, 'queued');
});

test('transient Windows handle contention is retried without masking missing files', async () => {
  let calls = 0;
  assert.equal(await retryFileIO(async () => {
    if (++calls < 3) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
    return 'read result';
  }), 'read result');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryFileIO(async () => { calls++; throw Object.assign(new Error('missing'), { code:'ENOENT' }); }), /missing/);
  assert.equal(calls, 1);
});

test('older bridges cannot report a safe cancellation without shared claim support',async t=>{
  const {manager,sessionId}=await fixture(t);
  const job=await manager.submit(sessionId,'list_documents');
  await atomicJson(path.join(manager.sessionDir(sessionId),'session.json'),{sessionId,pid:process.pid,heartbeatUtc:new Date().toISOString(),bridgeVersion:'0.2.0'});
  const cancelled=await manager.cancel(sessionId,job.jobId);
  assert.equal(cancelled.cancellationAccepted,false);assert.equal(cancelled.status,'queued');
  assert.equal((await manager.job(sessionId,job.jobId)).status,'queued');
});
