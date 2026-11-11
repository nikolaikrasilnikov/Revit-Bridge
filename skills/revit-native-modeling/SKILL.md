---
name: revit-native-modeling
description: "Create and verify native Revit elements from a confirmed geometry specification through Revit Bridge MCP."
---


# Native Revit modeling

Read the bundled `revit-bridge` skill for the execution contract.

1. Establish document identity, model units, phases, levels, reference transforms, element types and existing targets from a fresh query.
2. Prepare dimensions with explicit units. Derive geometry from the approved source; never infer a missing section or level offset from an old project convention.
3. Prefer native category-appropriate elements and FamilyInstances. Reuse or duplicate a type deliberately; a shared type change affects all its instances.
4. Resolve materials, hosts, locations, offsets and constraints separately. A type name is not proof of actual dimensions or material.
5. Give each operation a unique correlation tag and retain IDs plus UniqueIds. Before a retry, reconcile existing results and duplicates.
6. Use managed transactions and bounded independent batches. Keep parsing, coordinate fitting and array preparation outside the API callback.
7. Reacquire after commit. Verify counts, native categories, dimensions, levels, support/host relations, geometry, retained elements and warning changes.
8. Preserve untouched document content. Save only through the explicit lifecycle operation when within the user's task.

Do not present imported meshes as native BIM elements. A successful import, created count or screenshot alone does not demonstrate correct modeling.
