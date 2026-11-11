# Reusable verification rules

- Bounding-box overlap is a candidate collision. Confirm geometry, host relations and meaning before deletion. Preview `Document.Delete` cascades in a rollback transaction.
- Pair IDs and UniqueIds with document/session identity. Identity alone does not prove unchanged position, geometry or parameters.
- Distinguish Rooms, MEP Spaces and Areas; read the relevant phase, scheme, level and boundary mode. Preserve loops, holes and islands.
- Establish coverage before filtering parameters. Include empty, partial and complete records. Type edits affect every instance of that type.
- IFC readback verifies an exported artifact only after the actual export exists. Match entity counts, GUIDs, property sets, geometry and mappings to the source scope.
- Confirm reference units, source identity, axes and transforms. Do not shift an axis to hide a source mismatch.
- One Revit process serializes API work. Use bounded batches and separate pure calculations. Previous commits can survive a later batch failure.
- At unknown completion or failed preservation, reconcile durable results before dependent writes. Do not automatically recreate missing elements.
- Never save or synchronize as a cleanup side effect. Report in-memory, saved and exported states separately.
- Quote UTF-8 paths, refuse accidental overwrites, and distinguish a generated scaffold from a finished tool.
