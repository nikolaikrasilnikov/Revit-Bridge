---
name: pyrevit-scripting
description: "Author and maintain portable pyRevit ribbon buttons, bundle metadata and reusable Python API recipes."
---


# pyRevit scripting

Read `pyrevit-script-assistant` for engine compatibility and transaction ownership. Preserve an existing extension's naming and structure.

- Keep UTF-8 source. If the engine is unknown, write IronPython 2.7-compatible code and use `.format()`; do not infer engines from Revit years.
- For CPython-only scripts use `#! python3` first and the encoding header second. `engine.clean` clears reused state; it does not select CPython.
- Resolve current `revit.doc` and `revit.uidoc` on every invocation. Shared helpers must not cache document objects across clicks.
- Collect, preview, allow cancellation, transact, read back and report. Destructive reusable buttons need a preview/cancel flow for future users.
- UI text follows the requested language. Bundle metadata may include English and Russian title/tooltip entries.
- Keep related edits atomic. Report independent partial success explicitly. Do not suppress all warnings or claim external side effects are rolled back.

References: [bundle metadata](references/bundles.md), [API recipes](references/recipes.md), [button template](assets/script_template.py). Replace template hooks with the requested implementation before delivery.
