# Execution contract

- Select exact live session/document IDs; refresh after restart or reopen.
- Protected queries reject writes; preview rolls back model edits. Managed writes own the outer transaction.
- Revit API work is serialized on a valid main-thread callback. External parsing can run separately.
- Batches commit independent chunks. Later failure/cancellation does not roll back earlier commits.
- Unknown completion requires reconciliation of the original job and model; never replay writes blindly.
- Preserve IDs/UniqueIds and independently verify geometry and parameters after commit.
- Save, export and close use explicit lifecycle tools, not arbitrary C#.
- Model rollback does not sandbox file, network, reflection or process effects.
- Warnings roll back by default. A supported exception carries actual user authorization; errors and preservation guards remain enforced.
- In-memory edits, saved RVT and exported IFC are distinct outcomes.

pyRevit buttons and its optional agent host have separate interpreter/transaction contracts. The C# bridge does not protect ordinary Python buttons automatically.
