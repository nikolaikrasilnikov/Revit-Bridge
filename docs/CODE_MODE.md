# Code Mode

[Русский](CODE_MODE.ru.md)

Code Mode is the default agent interface implemented in Revit Bridge. It is JavaScript orchestration inside the MCP server, not a separate installation. It was newly implemented for this product; no recovered legacy Code Mode source is claimed.

| Layer | Responsibility |
| --- | --- |
| `revit_tools` | Search 28 operations and retrieve their exact JSON schemas, five per page by default |
| `revit_code_mode` | Execute a JavaScript async function body with loops, awaits and JSON processing |
| `revit.call(name, args)` | Validate arguments and call the existing operation handler |
| Revit bridge | Queue native API work on the Revit main thread and enforce transaction/document guards |

Call `revit_tools` with `{"query":"revit_query"}` before writing an unfamiliar operation. An empty query lists the catalog; follow `nextOffset` or request `limit:28` when the whole catalog is needed. Tools do not recursively call Code Mode.

## Examples

Pass this function body as the `code` argument to `revit_code_mode`:

```javascript
const sessions = await revit.call('revit_sessions', {});
return sessions.map(s => ({ sessionId: s.sessionId, year: s.year }));
```

For an exact session UUID previously returned by discovery:

```javascript
const sessionId = '12345678-1234-4234-8234-123456789abc'; // replace with the actual UUID
const queued = await revit.call('revit_documents', { sessionId });
const job = await revit.call('revit_job', { sessionId, jobId: queued.jobId, waitMs: 1000 });
return job; // inspect status; queued/running is not completion
```

JavaScript is the outer language. C# goes in the `code` field of `revit_query` or `revit_execute_code`, together with exact session/document IDs and the existing transaction options. `examples/code-mode-discover.json` is a ready read-only probe input:

```powershell
node server/probe.mjs revit_code_mode examples/code-mode-discover.json
```

## Execution and recovery

- Await every `revit.call`. Calls are dispatched serially, including those created with `Promise.all`. Prefer ordinary loops for dependent work.
- Arguments use the original Zod schemas and original handlers. Preview, preservation, warnings, leases and explicit lifecycle authorizations remain enforced. A submitted operation receives a request UUID if one was omitted.
- The returned receipt contains `runId`, script `status`, JSON `value` or `error`, and a compact call trace with session/request/job/batch IDs. Script `completed` means the JavaScript returned; inspect native job/batch states separately.
- Limits: 64,000 code characters, 32 calls, 10 seconds by default (100–30,000 ms configurable), 1 MiB per operation response and 256 KiB final return. Page large operation results and return summaries. The worker has a 64 MiB old-generation heap limit; this is not a total process memory cap.
- Deadline/worker failure stops further JS dispatch. It does **not** cancel native work, roll back earlier commits, release a workflow lease, or retry anything. An in-flight call is marked `unknown`; retain its IDs and reconcile with `revit_job`, batch status and the model. Queue request IDs are job IDs; chunk request IDs are batch IDs.
- The JS run and its receipt are not persisted. Already submitted Revit jobs remain durable. After a lost MCP response or disconnect, inspect the queue and model; do not blindly resubmit the workflow. Supply explicit stable request IDs when recovery must survive a lost receipt.
- Each call has its own transaction contract. Several calls in one script are not one atomic transaction. Long modeling work belongs in `revit_model_chunks`, followed by status/results/checkpoint reads.

Only trusted agent-authored JavaScript should run here. A worker and VM context provide execution limits and expose only the `revit` facade; no `process`, modules, filesystem or network API is provided. Node's VM is not an adversarial security sandbox. C# external effects retain the limitations in [Execution](EXECUTION.md).

Each synchronous JavaScript evaluation is additionally capped at one second. Move heavy computation to external preprocessing; Revit jobs have their own native execution contract.

## Compatibility

The default MCP tool list contains only `revit_tools` and `revit_code_mode`. Set `REVIT_BRIDGE_TOOLSET=full` in the MCP server environment to expose the original 28 direct tools plus these two. `code` is the default value. Reconnect the MCP client after changing its server environment. No new pyRevit or .NET component is needed; the native bridge is unchanged.
