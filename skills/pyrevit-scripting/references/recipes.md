# pyRevit API recipes

These are button-side examples. Another host may own its transaction. Use the actual Revit API signature and engine; do not paste Python into a C# MCP endpoint.

## Collection and identity

```python
walls = list(DB.FilteredElementCollector(doc)
             .OfCategory(DB.BuiltInCategory.OST_Walls)
             .WhereElementIsNotElementType())

def get_id_value(element_id):
    try:
        return element_id.Value
    except AttributeError:
        return element_id.IntegerValue
```

Materialize before deletion. Use `.Value` without narrowing to Int32 in Revit 2024+; keep the fallback only for older versions. Pair IDs/UniqueIds with document identity when results outlive one invocation.

## Parameters and units

Prefer `get_Parameter(BuiltInParameter.X)` for built-ins and `get_Parameter(System.Guid(...))` for a known shared parameter. If only a visible name is available, `GetParameters(name)` reveals ambiguity; do not silently pick the first. Distinguish type and instance parameters, check `IsReadOnly`, `StorageType`, `HasValue`, and preserve nonempty values unless replacement is intended.

Read String/Double/Integer/ElementId with the matching `As*` method. `Set` must receive the correct type. Read the committed value back before reporting success.

```python
length_ft = DB.UnitUtils.ConvertToInternalUnits(mm, DB.UnitTypeId.Millimeters)
area_m2 = DB.UnitUtils.ConvertFromInternalUnits(area_internal, DB.UnitTypeId.SquareMeters)
```

`UnitTypeId` is available from Revit 2021; use the correct API for older targets only if requested. Do not convert all doubles as lengths. Choose geometric tolerances for the task and units; coordinate rounding is candidate grouping, not proof of duplicates.

## Atomic transaction

```python
t = DB.Transaction(doc, "Изменение параметров")
if t.Start() != DB.TransactionStatus.Started:
    raise RuntimeError("Не удалось начать транзакцию")
try:
    for item in work:
        apply_change(item)
    status = t.Commit()
    if status != DB.TransactionStatus.Committed:
        raise RuntimeError("Транзакция не подтверждена: {}".format(status))
except Exception:
    if t.GetStatus() == DB.TransactionStatus.Started:
        t.RollBack()
    raise
finally:
    t.Dispose()
```

Reacquire changed elements and verify task-specific results afterwards. For independent partial success, isolate each unit using subtransactions or batches, catch/report its failure after rollback, and count success after the containing transaction commits. Use a TransactionGroup only when its owner and rollback semantics are understood. Do not erase warnings indiscriminately; inspect their IDs, severity and consequences.

For long tools use `forms.ProgressBar(cancellable=True)` and check cancellation between independent units. State whether the current unit was rolled back and earlier batches retained. On a timeout/unknown outcome, inspect the existing job/model before replaying any write.

## Selection, output and cancellation

```python
selected = [doc.GetElement(eid) for eid in revit.uidoc.Selection.GetElementIds()]
choice = forms.SelectFromList.show(items, title="Выберите элементы", multiselect=True)
if not choice:
    script.exit()
output.print_table(rows, columns=["Элемент", "Результат"])
```

Use `output.linkify(element.Id)` for element rows. Catch `Autodesk.Revit.Exceptions.OperationCanceledException` for Esc during selection; do not label every API exception as cancellation. Surface failures users must act on. pyRevit 7 uses WebView2 for output: test custom HTML behavior rather than relying on obsolete renderer assumptions.

For destructive operations needing crash diagnosis, an explicit UTF-8 log may record intent before mutation and the committed result afterwards, with flush/fsync as appropriate. A log entry before commit does not prove success. Close log handles in `finally`. Ordinary parameter edits do not need heavy per-element IO.
