import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runCodeMode } from '../code-mode.mjs';

const registry = run => new Map([['revit_test', { schema: z.object({ value: z.number(), requestId: z.string().uuid().optional() }).strict(), run }]]);

test('Code Mode awaits sequential calls and returns only the requested summary', async () => {
  const seen = [];
  const result = await runCodeMode(registry(a => { seen.push(a); return { doubled: a.value * 2, detail: 'not needed' }; }), {
    code: 'let sum=0; for(const value of [2,3]) { const r=await revit.call("revit_test",{value}); sum+=r.doubled; } return {sum};'
  });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.value, { sum: 10 });
  assert.equal(seen.length, 2); assert.notEqual(seen[0].requestId, seen[1].requestId);
  assert.equal(result.calls[0].requestId, seen[0].requestId);
  assert.ok(result.calls.every(c => c.status === 'returned')); assert.ok(!JSON.stringify(result).includes('not needed'));
});

test('Code Mode rejects unknown operations and invalid/extra arguments before dispatch', async () => {
  let count = 0; const ops = registry(() => { count++; });
  for (const code of ['return await revit.call("missing",{});', 'return await revit.call("revit_test",{value:"bad"});', 'return await revit.call("revit_test",{value:1,authorizeSave:true});']) {
    const r = await runCodeMode(ops, { code }); assert.equal(r.status, 'failed');
  }
  assert.equal(count, 0);
});

test('Code Mode preserves handler errors and explicit request/job identifiers', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const r = await runCodeMode(registry(a => ({ sessionId: id, jobId: a.requestId, status: 'queued' })), {
    code: `return await revit.call('revit_test',{value:1,requestId:'${id}'});`
  });
  assert.equal(r.value.status, 'queued'); assert.equal(r.calls[0].jobId, id); assert.equal(r.calls[0].requestId, id);
  const failed = await runCodeMode(registry(() => { throw new Error('preservation guard refused'); }), { code: 'return await revit.call("revit_test",{value:1});' });
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /preservation guard refused/);
});

test('Code Mode provides no host modules or process and disables dynamic code generation', async () => {
  const r = await runCodeMode(new Map(), { code: 'return [typeof process,typeof require,typeof fetch,typeof Buffer];' });
  assert.deepEqual(r.value, ['undefined', 'undefined', 'undefined', 'undefined']);
  const blocked = await runCodeMode(new Map(), { code: 'return revit.call.constructor("return process")();' });
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error, /Code generation/);
});

test('Code Mode deadlines stop CPU and unresolved promises without blocking the host', async () => {
  for (const code of ['while(true){}', 'await new Promise(()=>{});']) {
    const r = await runCodeMode(new Map(), { code, timeoutMs: 200 });
    assert.equal(r.status, 'timed_out');
  }
  assert.equal((await runCodeMode(new Map(), { code: 'return 42;' })).value, 42);
});

test('Code Mode timeout retains in-flight request IDs and never replays a call', async () => {
  let count = 0;
  const r = await runCodeMode(registry(async () => { count++; await new Promise(resolve => setTimeout(resolve, 3000)); return {}; }), {
    code: 'return await revit.call("revit_test",{value:1});', timeoutMs: 2000
  });
  assert.equal(r.status, 'timed_out'); assert.equal(count, 1);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].status, 'unknown'); assert.ok(r.calls[0].requestId);
});

test('Code Mode refuses unawaited calls before dispatch and bounds return size and calls', async () => {
  let count = 0; const ops = registry(() => { count++; return null; });
  const unawaited = await runCodeMode(ops, { code: 'revit.call("revit_test",{value:1}); return "done";' });
  assert.equal(unawaited.status, 'failed'); assert.equal(count, 0);
  const large = await runCodeMode(ops, { code: 'return "x".repeat(300000);' });
  assert.equal(large.status, 'failed'); assert.match(large.error, /256 KiB/);
  const many = await runCodeMode(ops, { code: 'for(let i=0;i<33;i++) await revit.call("revit_test",{value:i});' });
  assert.equal(many.status, 'failed'); assert.equal(count, 32); assert.match(many.error, /call limit/);
});
