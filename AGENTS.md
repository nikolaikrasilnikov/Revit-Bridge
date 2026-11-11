# Revit Bridge

Build a portable product for AI-assisted Autodesk Revit work.

- Include the Revit bridge, MCP server, verified Code Mode implementation, generic Revit skills and pyRevit Assistant.
- Include only general-purpose Revit tooling and synthetic examples. Keep customer data and personal project history out of the product.
- Keep user-facing documentation in English and Russian: README.md and README.ru.md.
- Use neutral, minimal architecture figures from docs/architecture/.
- Code Mode is the primary MCP interface: discover operation schemas with revit_tools, then orchestrate them in JavaScript through revit_code_mode. Its implementation lives in server/code-mode*.mjs; it is newly implemented here, not recovered legacy source.
- Preserve the distinction between JavaScript orchestration and guarded C# running inside Revit. Code Mode does not make a multi-operation workflow atomic or cancel native jobs on timeout.
- Skills and pyRevit Assistant are instructions; distinguish them from executable extensions and runtime dependencies.
- Remove user-specific paths and settings from distributable files. Use configurable paths and environment discovery.
- State native-tested, built-only and unsupported Revit versions separately.
- Preserve transaction, queue, cancellation and result-verification behavior when packaging existing code.
- Reuse the existing Revit MCP connection. Packaging does not require editing or saving a live Revit model.
- Do not publish customer files or credentials. Exclude build output and runtime state from source control.

For the local source inventory and session handoff, read .local/HANDOFF.md when present. That file is private local context and must remain ignored by Git.
