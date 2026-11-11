// Read-only body for revit_query. Select real session/document IDs first.
return new {
    title = document.Title,
    savedPath = document.PathName,
    instanceCount = new Autodesk.Revit.DB.FilteredElementCollector(document)
        .WhereElementIsNotElementType().GetElementCount()
};
