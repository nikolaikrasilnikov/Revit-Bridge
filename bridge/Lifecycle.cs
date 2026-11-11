using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;
using System.Security.Cryptography;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitWorkspace {
    // Fixed lifecycle operations, never invoked by the arbitrary-script compiler.
    internal static class Lifecycle {
        internal static string FilePath(string root, string input, string extension, bool existing) {
            if (string.IsNullOrWhiteSpace(input)) throw new ArgumentException("Explicit file path required");
            root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
            string full=Path.GetFullPath(Path.IsPathRooted(input)?input:Path.Combine(root,input));
            if (!full.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetExtension(full),extension,StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Expected "+extension+" inside workspaceRoot");
            foreach(var segment in full.Substring(root.Length+1).Split(Path.DirectorySeparatorChar))
                if(segment.EndsWith(".")||segment.EndsWith(" ")||segment.IndexOfAny(new[]{':','<','>','"','|','?','*'})>=0)
                    throw new ArgumentException("Invalid output path component");
            if (!Directory.Exists(Path.GetDirectoryName(full))) throw new ArgumentException("Output parent must already exist");
            if (Directory.Exists(full) || (existing && !File.Exists(full))) throw new ArgumentException("Expected file: "+full);
            for(string p=full;p!=null;p=Path.GetDirectoryName(p)) {
                if((File.Exists(p)||Directory.Exists(p))&&(File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)
                    throw new ArgumentException("Links and junctions are not permitted");
                if(string.Equals(p,root,StringComparison.OrdinalIgnoreCase))break;
            }
            return full;
        }
        internal static void VerifyDocument(Document doc, Arguments args, string root) {
            if(args.expectedPath==null)throw new ArgumentException("expectedPath is required");
            string expected=args.expectedPath==""?"":FilePath(root,args.expectedPath,".rvt",true);
            if(!string.Equals(doc.PathName,expected,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Document path changed; refresh session/document identity");
            if(doc.IsReadOnly||doc.IsLinked||doc.IsFamilyDocument||doc.IsModifiable)
                throw new InvalidOperationException("Expected writable project without an open transaction");
        }
        private static string Hash(string file) {
            using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))using(var sha=SHA256.Create())return Convert.ToHexString(sha.ComputeHash(stream));
        }
        private static object Receipt(string operation,string documentId,string source,string file,bool modified) {
            var info=new FileInfo(file);
            return new {operation,documentId,sourcePath=source,path=file,bytes=info.Length,sha256=Hash(file),
                modifiedUtc=info.LastWriteTimeUtc.ToString("o"),completedUtc=DateTime.UtcNow.ToString("o"),isModified=modified};
        }
        internal static object Save(UIApplication app,Document doc,Arguments args,string root,string documentId) {
            if(!args.authorizeSave)throw new ArgumentException("authorizeSave:true is required");
            VerifyDocument(doc,args,root);
            if(doc.IsWorkshared)throw new InvalidOperationException("Workshared save/synchronization is not supported by this command");
            string source=doc.PathName;
            string output=string.IsNullOrEmpty(args.path)?source:FilePath(root,args.path,".rvt",false);
            if(string.IsNullOrEmpty(output))throw new ArgumentException("Unsaved project requires a SaveAs path");
            if(string.Equals(source,output,StringComparison.OrdinalIgnoreCase)) {
                using(var options=new SaveOptions())doc.Save(options);
            } else {
                if(File.Exists(output)&&!args.overwrite)throw new IOException("SaveAs destination exists; overwrite was not authorized");
                using(var options=new SaveAsOptions { OverwriteExistingFile=args.overwrite })doc.SaveAs(output,options);
            }
            if(!File.Exists(output)||new FileInfo(output).Length==0||doc.IsModified || !string.Equals(doc.PathName,output,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Save did not produce the expected on-disk RVT; inspect disk before retrying");
            return Receipt("save_model",documentId,source,output,doc.IsModified);
        }
        private static void Set(Type type,object config,string name,object value) {
            var p=type.GetProperty(name);if(p==null||!p.CanWrite)throw new InvalidOperationException("IFC exporter property unavailable: "+name);
            if(value!=null&&!p.PropertyType.IsInstanceOfType(value))value=p.PropertyType.IsEnum?Enum.ToObject(p.PropertyType,value):Convert.ChangeType(value,p.PropertyType);
            p.SetValue(config,value);
        }
        internal static string State(Document doc) {
            string elements=string.Join("|",new FilteredElementCollector(doc).WhereElementIsNotElementType().Select(e=>e.Id.Value+":"+e.UniqueId).OrderBy(s=>s));
            string warnings=string.Join("|",doc.GetWarnings().Select(w=>w.GetFailureDefinitionId().Guid+":"+w.GetDescriptionText()+":"+string.Join(",",w.GetFailingElements().Select(i=>i.Value).OrderBy(i=>i))).OrderBy(s=>s));
            return doc.IsModified+";"+elements+";"+warnings;
        }
        internal static object ExportIfc(UIApplication app,Document doc,Arguments args,string root,string documentId,string jobId,
            JobTimings timings,Func<Document,string> identify,Action<string,object> log) {
            if(!args.authorizeExport)throw new ArgumentException("authorizeExport:true is required");
            VerifyDocument(doc,args,root);
            string output=FilePath(root,args.path,".ifc",false);
            string receiptPath=FilePath(root,output+".receipt.json",".json",false);
            if(File.Exists(output)&&!args.overwrite)throw new IOException("IFC destination exists; overwrite was not authorized");
            long viewNumber;
            if(!long.TryParse(args.viewId,out viewNumber)||viewNumber<=0)throw new ArgumentException("Explicit 3D viewId required");
            var view=doc.GetElement(new ElementId(viewNumber)) as View3D;
            if(view==null||view.IsTemplate)throw new ArgumentException("viewId must identify a 3D view in the target document");
            Assembly ui=AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a=>a.GetName().Name=="Autodesk.IFC.Export.UI");
            if(ui==null)ui=Assembly.LoadFrom(Path.Combine(Path.GetDirectoryName(typeof(Document).Assembly.Location),"AddIns","IFCExporterUI","Autodesk.IFC.Export.UI.dll"));
            var type=ui.GetType("BIM.IFC.Export.UI.IFCExportConfiguration",true);
            object config=Activator.CreateInstance(type);
            if(!string.IsNullOrEmpty(args.configurationPath)) {
                string jsonPath=FilePath(root,args.configurationPath,".json",true);
                var method=type.GetMethod("DeserializeFromJson");var ps=method.GetParameters();
                var parse=ps[0].ParameterType.GetMethods().Single(m=>m.Name=="Parse"&&m.GetParameters().Length==1&&m.GetParameters()[0].ParameterType==typeof(string));
                object json=parse.Invoke(null,new object[]{File.ReadAllText(jsonPath)});
                object serializer=ps[1].ParameterType.GetMethod("Create",Type.EmptyTypes).Invoke(null,null);
                method.Invoke(config,new[]{json,serializer});
            } else Set(type,config,"IFCVersion",IFCVersion.IFC4DTV);
            foreach(string field in new[]{"ExportUserDefinedPsetsFileName","ExportUserDefinedParameterMappingFileName"}) {
                string flag=field=="ExportUserDefinedPsetsFileName"?"ExportUserDefinedPsets":"ExportUserDefinedParameterMapping";
                if((bool)type.GetProperty(flag).GetValue(config))Set(type,config,field,FilePath(root,(string)type.GetProperty(field).GetValue(config),".txt",true));
            }
            Set(type,config,"StoreIFCGUID",false);Set(type,config,"ExportLinkedFiles",0);
            Set(type,config,"ActiveViewId",view.Id);
            Set(type,config,"ActivePhaseId",view.get_Parameter(BuiltInParameter.VIEW_PHASE).AsElementId().Value);
            string effectiveConfiguration=(string)type.GetMethod("SerializeConfigToJson").Invoke(config,null);
            var command=ui.GetType("BIM.IFC.Export.UI.IFCCommandOverrideApplication",true);
            var documentProperty=command.GetProperty("TheDocument",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic);
            object previousDocument=documentProperty.GetValue(null);
            string state=State(doc),source=doc.PathName;
            string stage=Path.Combine(Path.GetDirectoryName(output),".ifc-"+jobId);
            if(Directory.Exists(stage))throw new IOException("Export staging directory already exists; inspect previous job");
            Directory.CreateDirectory(stage);
            string staged=Path.Combine(stage,Path.GetFileName(output));
            var guard=new ExecutionGuard(app,doc,false,args.preserveElements,identify,log,"MCP IFC "+jobId,true);
            try {
                documentProperty.SetValue(null,doc);
                using(var transaction=new Transaction(doc,"Temporary IFC export state")) {
                    transaction.Start();timings.transactionStatus="Started";
                    var failureOptions=transaction.GetFailureHandlingOptions();failureOptions.SetFailuresPreprocessor(guard);failureOptions.SetClearAfterRollback(true);transaction.SetFailureHandlingOptions(failureOptions);
                    try {
                        if(args.disableSectionBox)view.IsSectionBoxActive=false;
                        using(var options=new IFCExportOptions()) {
                            type.GetMethod("UpdateOptions").Invoke(config,new object[]{options,view.Id});
                            if(!doc.Export(stage,Path.GetFileNameWithoutExtension(output),options))throw new InvalidOperationException("Native IFC exporter returned false");
                        }
                    } finally {
                        if(transaction.GetStatus()==TransactionStatus.Started)transaction.RollBack();
                    }
                }
                guard.Finish(false);
            } finally {
                try { guard.Dispose(); } finally { documentProperty.SetValue(null,previousDocument); }
                timings.guard=guard.Report;timings.transactionStatus=guard.TargetStatus;timings.warningCount=guard.WarningCount;timings.warnings=guard.Report.failures;
            }
            if(!guard.Report.cleanupComplete)throw new InvalidOperationException("MCP_GUARD_CLEANUP_FAILED: "+string.Join("; ",guard.Report.cleanupErrors));
            if(state!=State(doc))throw new InvalidOperationException("Export changed model state; IFC remains in staging for inspection");
            if(!File.Exists(staged)||new FileInfo(staged).Length==0)throw new IOException("No nonempty IFC was produced");
            string backup=null;
            if(File.Exists(output)) {
                if(!args.overwrite)throw new IOException("IFC destination appeared during export; staged file retained");
                backup=output+"."+jobId+".bak";
                if(File.Exists(backup)||Directory.Exists(backup))throw new IOException("Backup path already exists; staged IFC retained");
                File.Replace(staged,output,backup);
            } else File.Move(staged,output);
            var receipt=new {file=Receipt("export_ifc",documentId,source,output,doc.IsModified),configurationPath=args.configurationPath,
                viewId=args.viewId,disableSectionBox=args.disableSectionBox,modelStatePreserved=true,rvtSaved=false,backupPath=backup,stagingDirectory=stage,
                effectiveConfiguration,exporterAssembly=ui.Location,exporterVersion=ui.GetName().Version.ToString()};
            Json.Atomic(receiptPath,receipt);
            return receipt;
        }
    }
}
