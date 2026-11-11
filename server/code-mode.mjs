import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

export const CODE_LIMITS = Object.freeze({ codeChars: 64000, calls: 32, wireBytes: 1048576, resultBytes: 262144, timeoutMs: 30000 });

// Call the original validated handlers. Code Mode never implements a second path
// into the native queue and never retries a submission.
export function runCodeMode(registry, { code, timeoutMs = 10000 }) {
  if (typeof code !== 'string' || !code.trim() || code.length > CODE_LIMITS.codeChars) throw new Error('Expected 1..64000 characters of JavaScript');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > CODE_LIMITS.timeoutMs) throw new Error('timeoutMs must be 100..30000');
  const runId = randomUUID(), calls = [];
  return new Promise(resolve => {
    let finished = false, chain = Promise.resolve();
    const worker = new Worker(new URL('./code-mode-worker.mjs', import.meta.url), {
      workerData: { code, limits: CODE_LIMITS },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
      stdout: true, stderr: true
    });
    // Never allow worker output to corrupt the MCP stdio stream.
    worker.stdout.resume(); worker.stderr.resume();
    const finish = (status, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ runId, status, ...extra,
        calls: calls.map(c => ({ ...c, status: c.status === 'running' ? 'unknown' : c.status })),
        note: 'Script completion is not Revit job completion. Timeout does not cancel, roll back or replay submitted jobs. Reconcile the recorded sessionId/requestId/jobId before retrying. This run receipt is not a durable workflow.' });
    };
    const timer = setTimeout(() => finish('timed_out', { error: 'Code Mode deadline exceeded' }), timeoutMs);
    worker.on('error', error => finish('failed', { error: error.message }));
    worker.on('exit', code => { if (!finished) finish('failed', { error: `Code Mode worker exited (${code})` }); });
    worker.on('message', message => {
      if (finished) return;
      if (message.type === 'done') return finish(message.ok ? 'completed' : 'failed', message.ok ? { value: message.value } : { error: message.error });
      if (message.type !== 'call') return;
      // Serial dispatch also covers Promise.all: never race native mutations in
      // one script. Revit's own queue remains authoritative across all clients.
      chain = chain.then(async () => {
        if (finished) return;
        if (calls.length >= CODE_LIMITS.calls) return finish('failed', { error: 'Code Mode call limit exceeded (32)' });
        const entry = { index: calls.length, tool: message.name, status: 'running' };
        calls.push(entry);
        try {
          const operation = registry.get(message.name);
          if (!operation) throw new Error(`Unknown operation: ${message.name}. Use revit_tools.`);
          const args = operation.schema.parse(message.args);
          if ('requestId' in operation.schema.shape && args.requestId === undefined) args.requestId = randomUUID();
          for (const key of ['sessionId', 'documentId', 'requestId', 'jobId', 'batchId', 'workflowId']) if (args[key]) entry[key] = args[key];
          // The queue uses requestId as jobId (or batchId for model chunks).
          // Keep it even if a deadline expires during submission.
          const result = await operation.run(args);
          entry.status = 'returned';
          if (result && typeof result === 'object') {
            for (const key of ['sessionId', 'jobId', 'batchId']) if (result[key]) entry[key] = result[key];
          }
          const wire = JSON.stringify({ id: message.id, ok: true, value: result ?? null });
          if (Buffer.byteLength(wire) > CODE_LIMITS.wireBytes) throw new Error('Operation response exceeds 1 MiB; use pagination');
          if (!finished) worker.postMessage(wire);
        } catch (error) {
          entry.status = 'failed'; entry.error = String(error.message).slice(0, 2000);
          if (!finished) worker.postMessage(JSON.stringify({ id: message.id, ok: false, error: entry.error }));
        }
      }).catch(error => finish('failed', { error: error.message }));
    });
  });
}
