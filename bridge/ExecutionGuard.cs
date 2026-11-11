using System;
using System.Linq;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;

namespace RevitWorkspace {
    public class GuardReport {
        public bool cleanupComplete { get; set; }
        public string targetStatus { get; set; }
        public string violation { get; set; }
        public object[] blocked { get; set; }
        public object[] failures { get; set; }
        public object[] acceptedWarnings { get; set; }
        public object[] changes { get; set; }
        public ElementReference[] created { get; set; }
        public PreservationResult preservationBefore { get; set; }
        public PreservationResult preservationAfter { get; set; }
        public PreservationResult preservationFinal { get; set; }
        public string[] cleanupErrors { get; set; }
        public string[] closedDocuments { get; set; }
    }
    public sealed class ExecutionGuard : IDisposable, IFailuresPreprocessor {
        private sealed class Watched {
            public Document Document;
            public string Id;
            public TransactionGroup Group;
            public string Status = "NotStarted";
            public bool New;
            public HashSet<string> Added = new HashSet<string>();
            public HashSet<string> Modified = new HashSet<string>();
            public HashSet<string> Deleted = new HashSet<string>();
            public bool Changed { get { return Added.Count + Modified.Count + Deleted.Count > 0; } }
        }
        private readonly UIApplication uiapp;
        private readonly Document target;
        private readonly bool query;
        private readonly bool allowIfcExport;
        private readonly bool allowWarnings;
        private readonly string warningApproval;
        private readonly Func<Document, string> identify;
        private readonly Action<string, object> log;
        private readonly ElementReference[] protectedElements;
        private readonly List<Watched> watched = new List<Watched>();
        private readonly List<object> blocked = new List<object>(), failures = new List<object>();
        private readonly List<object> acceptedWarnings = new List<object>();
        private readonly HashSet<string> failureKeys = new HashSet<string>();
        private readonly List<object> scriptTransactions = new List<object>();
        private readonly List<string> cleanupErrors = new List<string>(), closed = new List<string>();
        private Watched primary;
        private bool armed, ending, disposed, scopeEntered, uncancellable;
        private bool captured;
        public int WarningCount { get; private set; }
        public GuardReport Report { get; private set; }
        public string TargetStatus { get { return primary == null ? "NotStarted" : primary.Status; } }

        public ExecutionGuard(UIApplication app, Document document, bool readOnly, ElementReference[] preserve,
            Func<Document,string> id, Action<string,object> logger, string title, bool allowIfcExport = false,
            string warningPolicy = null, string warningApproval = null) {
            uiapp = app; target = document; query = readOnly; identify = id; log = logger;
            this.allowIfcExport = allowIfcExport;
            this.allowWarnings = WarningPolicy.Validate(warningPolicy, warningApproval, readOnly);
            this.warningApproval = warningApproval;
            protectedElements = Preservation.Validate(preserve);
            Report = new GuardReport { cleanupComplete = true, targetStatus = "NotStarted", created = new ElementReference[0] };
            Report.preservationBefore = (PreservationResult)Preservation.Check(target, protectedElements);
            if (!Report.preservationBefore.ok) throw new InvalidOperationException("MCP_PRESERVATION_FAILED: previous elements missing or replaced before execution");
            try {
                foreach (Document doc in app.Application.Documents) {
                    if (doc.IsLinked) continue;
                    if (doc.IsModifiable) throw new InvalidOperationException("MCP_GUARD_NOT_READY: an open document already has a transaction");
                    var entry = new Watched { Document = doc, Id = identify(doc) };
                    if(doc.IsReadOnly)entry.Status="ReadOnly";
                    watched.Add(entry);
                    if (Same(doc, target)) primary = entry;
                    if (!doc.IsReadOnly) {
                        entry.Group = new TransactionGroup(doc, title);
                        if (entry.Group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Cannot start protection group");
                        entry.Status = "Started";
                    }
                }
                if (primary == null) throw new InvalidOperationException("Target document closed");
                var host = uiapp.Application;
                host.DocumentChanged += OnChanged;
                host.DocumentSaving += OnSaving; host.DocumentSavingAs += OnSavingAs;
                host.DocumentSynchronizingWithCentral += OnSync; host.DocumentClosing += OnClosing;
                host.FileExporting += OnExport; host.ViewExporting += OnViewExport;
                host.DocumentCreated += OnCreated; host.DocumentOpened += OnOpened;
                host.FailuresProcessing += OnFailures;
                armed = true;
                ScriptScope.Enter(value => scriptTransactions.Add(value), operation => Blocked(operation, null, true, "compiler"));
                scopeEntered = true;
            } catch { Dispose(); throw; }
        }
        private static bool Same(Document a, Document b) { return ReferenceEquals(a,b) || (a.IsValidObject && b.IsValidObject && a.Equals(b)); }
        private Watched Find(Document doc) { return watched.FirstOrDefault(w => Same(w.Document, doc)); }
        private void OnChanged(object sender, DocumentChangedEventArgs e) {
            if (ending) return;
            var entry = Find(e.GetDocument());
            if (entry == null) return;
            foreach (var item in e.GetAddedElementIds()) entry.Added.Add(item.ToString());
            foreach (var item in e.GetModifiedElementIds()) entry.Modified.Add(item.ToString());
            foreach (var item in e.GetDeletedElementIds()) entry.Deleted.Add(item.ToString());
        }
        private void Blocked(string operation, Document doc, bool cancelled, string source) {
            if (blocked.Count < 100) blocked.Add(new { operation = operation, documentId = doc == null ? null : identify(doc), cancelled = cancelled, source = source });
            if (!cancelled) uncancellable = true;
            Report.violation = "MCP_BLOCKED_OPERATION";
        }
        private void Cancel(RevitAPIPreEventArgs e, Document doc, string operation) {
            bool cancelled = false;
            if (e.Cancellable) { e.Cancel(); cancelled = true; }
            Blocked(operation, doc, cancelled, "api_event");
        }
        private void OnSaving(object s, DocumentSavingEventArgs e) { Cancel(e,e.Document,"save"); }
        private void OnSavingAs(object s, DocumentSavingAsEventArgs e) { Cancel(e,e.Document,"save_as"); }
        private void OnSync(object s, DocumentSynchronizingWithCentralEventArgs e) { Cancel(e,e.Document,"sync"); }
        private void OnClosing(object s, DocumentClosingEventArgs e) { Cancel(e,e.Document,"close"); }
        private void OnExport(object s, FileExportingEventArgs e) { if (!allowIfcExport) Cancel(e,null,"export"); }
        private void OnViewExport(object s, ViewExportingEventArgs e) { if (!allowIfcExport) Cancel(e,null,"view_export"); }
        private void NewDocument(Document doc, bool fromDisk) {
            if (doc.IsLinked || Find(doc) != null) return;
            var entry = new Watched { Document = doc, Id = identify(doc), New = true };
            watched.Add(entry);
            Report.violation = "MCP_BACKGROUND_DOCUMENT_OPERATION";
            // A newly opened file cannot be saved; its unsaved changes are discarded on cleanup.
            // Creating/opening documents belongs to fixed lifecycle tools, not script runs.
        }
        private void OnCreated(object s, DocumentCreatedEventArgs e) { NewDocument(e.Document,false); }
        private void OnOpened(object s, DocumentOpenedEventArgs e) { NewDocument(e.Document,true); }
        public bool RecordFailures(FailuresAccessor accessor) {
            bool any = false;
            foreach (var failure in accessor.GetFailureMessages()) {
                if (failure.GetSeverity() == FailureSeverity.None) continue;
                bool accepted = WarningPolicy.MayAccept(allowWarnings, Same(accessor.GetDocument(), target), failure.GetSeverity() == FailureSeverity.Warning);
                if (!accepted) any = true;
                string[] elements = failure.GetFailingElementIds().Select(i=>i.ToString()).ToArray();
                string key = identify(accessor.GetDocument()) + failure.GetFailureDefinitionId().Guid + failure.GetSeverity() + string.Join(",",elements);
                if (!failureKeys.Add(key)) { if (accepted) accessor.DeleteWarning(failure); continue; }
                if (failure.GetSeverity() == FailureSeverity.Warning) WarningCount++;
                var detail = new { documentId = identify(accessor.GetDocument()), failureId = failure.GetFailureDefinitionId().Guid.ToString(),
                    severity = failure.GetSeverity().ToString(), description = failure.GetDescriptionText(), elements = elements,
                    additionalElements = failure.GetAdditionalElementIds().Select(i=>i.ToString()).ToArray(),
                    automaticAction = accepted ? "user_authorized_warning" : "rollback_transaction",
                    userApproval = accepted ? warningApproval : null };
                if (accepted) {
                    if (acceptedWarnings.Count < 100) acceptedWarnings.Add(detail);
                    log("authorized_warning", detail);
                    accessor.DeleteWarning(failure);
                } else {
                    if (failures.Count < 100) failures.Add(detail);
                    log("transaction_failure", detail);
                }
            }
            return any;
        }
        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor) {
            if (!RecordFailures(accessor)) return FailureProcessingResult.Continue;
            var options = accessor.GetFailureHandlingOptions(); options.SetClearAfterRollback(true); accessor.SetFailureHandlingOptions(options);
            return FailureProcessingResult.ProceedWithRollBack;
        }
        private void OnFailures(object s, FailuresProcessingEventArgs e) {
            var accessor = e.GetFailuresAccessor();
            if (Find(accessor.GetDocument()) == null) return;
            e.SetProcessingResult(PreprocessFailures(accessor));
        }
        public int CloseScriptTransactions() {
            int open = 0;
            for (int i=scriptTransactions.Count-1;i>=0;i--) {
                var item = scriptTransactions[i];
                try {
                    var transaction = item as Transaction; var sub = item as SubTransaction; var group = item as TransactionGroup;
                    if (transaction != null && transaction.IsValidObject && transaction.GetStatus() == TransactionStatus.Started) { open++; transaction.RollBack(); }
                    else if (sub != null && sub.IsValidObject && sub.GetStatus() == TransactionStatus.Started) { open++; sub.RollBack(); }
                    else if (group != null && group.IsValidObject && group.GetStatus() == TransactionStatus.Started) { open++; group.RollBack(); }
                } catch (Exception ex) { cleanupErrors.Add("script_transaction: " + ex.Message); }
            }
            scriptTransactions.Clear();
            if (open > 0) Report.violation = "MCP_TRANSACTION_LEFT_OPEN";
            return open;
        }
        private static ElementId ParseId(string id) {
#if LEGACY
            return new ElementId(int.Parse(id));
#else
            return new ElementId(long.Parse(id));
#endif
        }
        private void Capture() {
            if (captured) return;
            captured = true;
            Report.created = primary == null ? new ElementReference[0] : primary.Added.Select(i=>target.GetElement(ParseId(i)))
                .Where(e=>e!=null).Take(Preservation.Limit+1).Select(e=>new ElementReference {id=e.Id.ToString(),uniqueId=e.UniqueId}).ToArray();
            Report.acceptedWarnings = acceptedWarnings.ToArray();
            Report.changes = watched.Select(w=>(object)new { documentId=w.Id, isTarget=ReferenceEquals(w,primary), openedDuringRun=w.New,
                addedCount=w.Added.Count,modifiedCount=w.Modified.Count,deletedCount=w.Deleted.Count,
                added=w.Added.Take(500).ToArray(),modified=w.Modified.Take(500).ToArray(),deleted=w.Deleted.Take(500).ToArray() }).ToArray();
        }
        private void RollBack(Watched entry) {
            if (entry.Group == null) return;
            try {
                var state = entry.Group.GetStatus();
                if (state == TransactionStatus.Started) state = entry.Group.RollBack();
                entry.Status = state.ToString();
                if (state != TransactionStatus.RolledBack) cleanupErrors.Add("Unconfirmed rollback: " + entry.Id);
            } catch (Exception ex) { entry.Status="Unknown";cleanupErrors.Add(entry.Id+": "+ex.Message); }
        }
        public void Finish(bool commit) {
            Capture();
            Report.preservationAfter = (PreservationResult)Preservation.Check(target, protectedElements);
            if (!Report.preservationAfter.ok) Report.violation = "MCP_PRESERVATION_FAILED";
            if (Report.created.Length > Preservation.Limit) Report.violation = "MCP_CHANGE_SET_LIMIT";
            if(protectedElements.Select(e=>e.id).Union(Report.created.Select(e=>e.id)).Count()>Preservation.Limit)Report.violation="MCP_PRESERVATION_LIMIT";
            if (query && primary.Changed) Report.violation = "MCP_QUERY_MODIFIED_MODEL";
            if (watched.Any(w=>!ReferenceEquals(w,primary) && w.Changed)) Report.violation = "MCP_OTHER_DOCUMENT_MODIFIED";
            if (failures.Count>0 && Report.violation == null) Report.violation = "MCP_REVIT_FAILURE";
            ending = true;
            foreach (var entry in watched.Where(w=>!ReferenceEquals(w,primary))) RollBack(entry);
            if (cleanupErrors.Count>0) Report.violation="MCP_GUARD_CLEANUP_FAILED";
            if (commit && Report.violation == null) {
                primary.Status = primary.Group.Assimilate().ToString();
                if (primary.Status != "Committed") throw new InvalidOperationException("MCP_GUARD_COMMIT_FAILED");
            } else RollBack(primary);
            if (Report.violation != null) throw new InvalidOperationException(Report.violation+": scope rejected; inspect timings.guard");
        }
        public void Dispose() {
            if (disposed) return;
            disposed = true;
            CloseScriptTransactions();
            try { Capture(); } catch (Exception ex) { cleanupErrors.Add("capture: "+ex.Message); }
            ending = true;
            foreach (var entry in watched) if (entry.Status == "Started") RollBack(entry);
            if (scopeEntered) ScriptScope.Exit();
            if (armed) {
                var host=uiapp.Application;
                host.DocumentChanged -= OnChanged;
                host.DocumentSaving -= OnSaving;host.DocumentSavingAs -= OnSavingAs;host.DocumentSynchronizingWithCentral -= OnSync;
                host.DocumentClosing -= OnClosing;host.FileExporting -= OnExport;host.ViewExporting -= OnViewExport;
                host.DocumentCreated -= OnCreated;host.DocumentOpened -= OnOpened;host.FailuresProcessing -= OnFailures;
            }
            foreach (var entry in watched.Where(w=>w.New)) {
                try {
                    if (entry.Document.IsValidObject && !entry.Document.Close(false)) throw new InvalidOperationException("Close returned false");
                    closed.Add(entry.Id);
                } catch (Exception ex) { cleanupErrors.Add("background_document "+entry.Id+": "+ex.Message); }
            }
            foreach (var entry in watched) if (entry.Group != null) try { entry.Group.Dispose(); } catch(Exception ex) {cleanupErrors.Add(ex.Message);}
            try { Report.preservationFinal = (PreservationResult)Preservation.Check(target,protectedElements); if(!Report.preservationFinal.ok)cleanupErrors.Add("Previous elements missing after scope cleanup"); }
            catch(Exception ex) {cleanupErrors.Add("preservation: "+ex.Message);}
            Report.targetStatus=TargetStatus;Report.blocked=blocked.ToArray();Report.failures=failures.ToArray();
            Report.cleanupErrors=cleanupErrors.ToArray();Report.closedDocuments=closed.ToArray();
            Report.cleanupComplete=cleanupErrors.Count==0 && !uncancellable;
            log("scope_guard",Report);
        }
    }
}
