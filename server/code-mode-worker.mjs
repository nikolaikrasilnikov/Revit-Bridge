import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const { code, limits } = workerData;
// Only JSON strings cross this context boundary: no host functions, promises,
// errors, modules or process handles are given to the workflow. Node vm is still
// not a security boundary for hostile code; run trusted agent-authored scripts.
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
const evaluate = source => vm.runInContext(source, context, { timeout: 1000 });
let stopped = false;
function fail(error) {
  if (stopped) return;
  stopped = true;
  parentPort.postMessage({ type: 'done', ok: false, error: String(error.message ?? error).slice(0, 2000) });
}
function pump() {
  if (stopped) return;
  try {
    const wire = evaluate('JSON.stringify(__bridge.snapshot())');
    if (Buffer.byteLength(wire) > limits.wireBytes) throw new Error('Code Mode message exceeds 1 MiB');
    const state = JSON.parse(wire);
    if (state.done) {
      if (state.pending) throw new Error('Await every revit.call before returning; outstanding calls are not dispatched further');
      if (Buffer.byteLength(JSON.stringify(state.outcome)) > limits.resultBytes) throw new Error('Return value exceeds 256 KiB; return a summary');
      stopped = true;
      parentPort.postMessage({ type: 'done', ...state.outcome });
      return;
    }
    for (const request of state.requests) parentPort.postMessage({ type: 'call', ...request });
  } catch (error) { fail(error); }
}

try {
  evaluate(`
    'use strict';
    globalThis.__bridge = (() => {
      let next = 0, done = false, outcome = null;
      const requests = [], pending = new Map();
      const call = (name, args = {}) => {
        if (typeof name !== 'string' || !args || Array.isArray(args) || typeof args !== 'object') throw new Error('revit.call requires an operation name and arguments object');
        if (next >= ${limits.calls}) throw new Error('Code Mode call limit exceeded (32)');
        const id = next++;
        const request = JSON.parse(JSON.stringify({ id, name, args }));
        return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); requests.push(request); });
      };
      globalThis.revit = Object.freeze({ call });
      return Object.freeze({
        settle(wire) {
          const response = JSON.parse(wire), item = pending.get(response.id);
          if (!item) return;
          pending.delete(response.id);
          if (response.ok) item.resolve(response.value); else item.reject(new Error(response.error));
        },
        complete(value) {
          // Require a serializable return; undefined is an intentional null.
          outcome = JSON.parse(JSON.stringify({ ok: true, value: value ?? null })); done = true;
        },
        fail(error) { outcome = { ok: false, error: String(error.message ?? error).slice(0, 2000) }; done = true; },
        snapshot() { return { done, outcome, pending: pending.size, requests: requests.splice(0) }; }
      });
    })();
  `);
  new vm.Script(`(async () => { 'use strict';\n${code}\n})().then(value => __bridge.complete(value)).catch(error => __bridge.fail(error));`, { filename: 'revit-code-mode.js' }).runInContext(context, { timeout: 1000 });
  parentPort.on('message', wire => {
    if (stopped) return;
    try { context.__wire = wire; evaluate('__bridge.settle(__wire); __wire = undefined;'); pump(); }
    catch (error) { fail(error); }
  });
  pump();
} catch (error) { fail(error); }
