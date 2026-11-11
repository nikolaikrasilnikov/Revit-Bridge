# Changelog

## 0.2.0 - Code Mode

- Make Code Mode the default MCP interface: operation discovery and JavaScript orchestration over the existing 28 validated handlers.
- Add bounded worker execution, compact call receipts, generated request IDs and explicit timeout recovery; no automatic replay or native cancellation.
- Preserve the direct tools with REVIT_BRIDGE_TOOLSET=full.
- Update bilingual documentation, the main agent skill and architecture figures to place Code Mode inside the MCP server.
- The native Revit bridge is unchanged; live model execution has not been revalidated in this release.

## 0.1.0 — packaging preview

- Extract the generic guarded bridge and 28-tool MCP server.
- Remove specialized adapters and machine-specific settings.
- Add portable installation, build and diagnostics scripts.
- Package seven bilingual generic skills with twelve Python helpers.
- Add Russian/English documentation and neutral architecture figures.
- Keep Code Mode explicitly planned until its source is verified.

The release is a packaging preview. See docs/VALIDATION.md for fresh checks and remaining runtime limits.
