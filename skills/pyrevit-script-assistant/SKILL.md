---
name: pyrevit-script-assistant
description: Build, debug, and review pyRevit buttons and Revit API automation; handle engine compatibility, pyRevit 7 agent runs, parameters, cleanup, rooms, and IFC validation. Use for Revit scripts and extension authoring, not as an instruction to install pyRevit or replace an existing MCP connection.
---

# pyRevit Script Assistant

Deliver a runnable script or button in the user's existing structure. For a review, report concrete defects and fixes without creating an extension unnecessarily.

## Establish the execution contract

- Identify the execution surface: ribbon button, Python Shell, pyRevit agent, Revit Workspace MCP, Dynamo, or standalone Python. A standalone syntax check cannot execute the Revit API.
- Read the actual Revit version, pyRevit build, attached clone and interpreter before choosing syntax or overloads. Do not infer the engine from the Revit year. CPython availability is separate from the currently selected engine.
- Preserve existing project structure and Russian UI conventions. Default to IronPython 2.7-compatible syntax for a reusable button whose engine is unknown: UTF-8 source, Unicode strings, `.format()`. For CPython buttons, put `#! python3` first and the encoding declaration second. `engine.clean: true` clears reused state; it does **not** select CPython.
- Reuse an existing connection. Read the bundled `revit-bridge` skill for a live-model task. Do not enable pyRevit's optional agent host, change policies, install MCP entries, or switch transports merely to use this skill.
- For pyRevit 7 agent/Shell work or extension packaging, read [runtime-and-buttons.md](references/runtime-and-buttons.md). It distinguishes shipped features, actual availability and transaction ownership.

## Implement and verify

1. Inspect existing code and the target document. Bind element IDs to a document/session identity; refresh after restart, reopen or document switch.
2. Collect the intended categories and phases first, then materialize the work list before editing. Resolve built-ins by `BuiltInParameter`, shared parameters by GUID when known; disambiguate duplicate names and instance/type scope. Check storage type, writability and units before `Set`.
3. Provide a useful preview for model-changing tools: intended changes, counts, IDs, exclusions and deletion cascades where relevant. Respect authorization already given; do not add repeated chat confirmations to an authorized fix. A reusable destructive button needs its own preview/cancel flow because later clicks have no chat context.
4. Put writes in the transaction boundary owned by the execution surface. Ribbon/pyRevit agent scripts open their own transaction; another host may already own one. Choose atomic rollback for dependent edits. Partial success needs independent units, rollback per failed unit and an explicit partial-result report. Do not silently swallow exceptions.
5. Check `Commit()` status before counting anything as applied. Reacquire elements after commit and independently compare the required parameters, geometry or relationships. A script's own counter or lack of exceptions is insufficient.
6. For long work, use bounded batches and cancellation between independent items. Keep the Revit API on a valid main-thread context. Move parsing and heavy external calculations outside the callback; never wait for an external process or sleep inside it. A native API call may outlast a cooperative timeout.
7. On timeout, lost response or unknown outcome, inspect the existing run/job and read the model before any retry. Preserve completed commits and reconcile IDs plus UniqueIds; do not recreate elements blindly.

Use `UnitUtils` with the target version's unit types. `AsDouble()` is in internal units for its quantity; lengths, areas and angles require different conversions. For cross-version IDs, use `.Value` on Revit 2024+ with `.IntegerValue` fallback only for older versions; do not narrow 64-bit IDs to Int32.

Model rollback does not undo file, network, configuration or process side effects. Keep Save/SaveAs/Sync/export as distinct operations within the user's scope; a committed in-memory edit is not proof of a saved RVT or updated IFC.

## Task-specific lessons

Read [lessons-from-work.md](references/lessons-from-work.md) for duplicates/clashes, rooms/apartments/areas, classification/IFC, reference geometry or mass edits. Preserve the useful distinctions: candidate versus confirmed defect, identity versus geometry preservation, in-memory versus saved/exported state, rule pass versus coverage.

## Button scaffold and delivery

Use `scripts/scaffold_pyrevit_button.py` for a new extension/button scaffold; run `--help` for engine and context options. It creates a read-only selection report and refuses existing bundles. Replace that example with the requested behavior before calling the user's tool complete.

For an existing button, edit it in place as requested. Before promoting an agent script, replace injected globals with button imports/input/output, bring helper modules into the extension's `lib`, and recheck the button's actual interpreter. Read `revit.doc` inside shared helper functions to avoid cached references to a previously active document.

Verify syntax for the intended engine, metadata, cancellation and a representative readback where available. State whether validation was static, simulated or performed in Revit. Report paths, use, outcome and any untested runtime boundary. Distinguish modified, saved and exported artifacts explicitly.

If a separate application instance is launched for testing, record PID, full EXE path and start time; use `try/finally` cleanup and recheck identity before closing it or confirmed descendants. Never close pre-existing user processes or save/sync during cleanup without authorization. For UI tests use a free diagnostic port and confirm WebView ownership. Report cleanup; leave a test instance open only at the user's explicit request.
