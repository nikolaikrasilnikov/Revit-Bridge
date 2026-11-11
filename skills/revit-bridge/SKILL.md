---
name: revit-bridge
description: "Operate Revit Bridge MCP: sessions, documents, protected C# queries and edits, durable jobs, batches and independent result verification."
---


# Revit Bridge

Use the already connected Revit Bridge MCP server. Consult the current schemas; never enable a second transport just to run a task.

Start with the default Code Mode interface. `revit_tools` searches the operation catalog and returns JSON schemas; `revit_code_mode` runs a JavaScript async function body using `await revit.call('revit_sessions', {})`. All operation names below are called through this facade unless the client explicitly enables the full direct toolset. JavaScript orchestrates; C# belongs inside the `code` argument of query/edit operations. Await every call and return a concise JSON result. Inspect native job states separately from script completion. A JS deadline does not cancel native work or replay it: retain the receipt's request/job IDs and reconcile unknown outcomes. Keep stable request IDs for writes if the response could be lost.

1. Discover `revit_sessions`, then `revit_documents`. Poll the returned job and retain exact session/document UUIDs. Refresh after a restart, reopen or document switch.
2. Inspect the document, selected categories, levels, phases, types and warnings. Resolve uncertain overloads with `revit_api_lookup` against that session.
3. Read using `revit_query`. Supply a C# body using `document`, `uiapp`, `parameters`; return JSON-compatible values. This is not a Python endpoint.
4. For changes, establish scope and a useful preview. `revit_execute_code` owns the outer transaction: use SubTransaction for an atomic subset. `preview` rolls back model changes. Do not open a nested top-level Transaction.
5. For independent repeated items use `revit_model_chunks`, then batch status/results. It yields between chunks; prior committed chunks survive failure or cancellation. Use `preserveElements` and page every checkpoint needed by later tasks.
6. Follow commit with a separate query of parameters, geometry, identities and warnings relevant to the task. An execution counter or unchanged ID alone does not prove the intended result.
7. On timeout or unknown outcome inspect the same durable job and the model before any retry. Never replay writes blindly. Cancel pending jobs explicitly; running native API calls cannot be forcibly interrupted.
8. Save and generic IFC export are separate explicit lifecycle tools. Do not call Save/Sync/Close/Export through arbitrary C#. Report in-memory, saved and exported state separately.

Keep API work on Revit's valid main-thread callback. Parse source files and perform heavy independent calculations outside it. Model rollback does not undo external file, network or process effects. Respect existing user authorization without adding repetitive approval prompts.
