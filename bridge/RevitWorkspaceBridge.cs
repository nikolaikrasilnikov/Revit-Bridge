using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
#if LEGACY
using System.Web.Script.Serialization;
using Microsoft.CSharp;
using System.CodeDom.Compiler;
#else
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
#endif

namespace RevitWorkspace {
    public class Settings {
        public string workspaceRoot { get; set; }
        public string stateRoot { get; set; }
    }
    public class Arguments {
        public string path { get; set; }
        public string documentId { get; set; }
        public string mode { get; set; }
        public bool allowUpgrade { get; set; }
        public int offset { get; set; }
        public int limit { get; set; }
        public string code { get; set; }
        public string[] parameters { get; set; }
        public string transactionMode { get; set; }
        public string warningPolicy { get; set; }
        public string warningApproval { get; set; }
        public string workflowId { get; set; }
        public string action { get; set; }
        public string owner { get; set; }
        public int ttlSeconds { get; set; }
        public string units { get; set; }
        public string name { get; set; }
        public ElementReference[] preserveElements { get; set; }
        public string expectedPath { get; set; }
        public bool authorizeSave { get; set; }
        public bool authorizeExport { get; set; }
        public bool overwrite { get; set; }
        public string configurationPath { get; set; }
        public string viewId { get; set; }
        public bool disableSectionBox { get; set; }
    }
    public class Request {
        public string jobId { get; set; }
        public string sessionId { get; set; }
        public string operation { get; set; }
        public string createdUtc { get; set; }
        public string expiresUtc { get; set; }
        public Arguments args { get; set; }
    }
    public class JobTimings {
        public string transactionStatus { get; set; }
        public string innerTransactionStatus { get; set; }
        public int warningCount { get; set; }
        public object[] warnings { get; set; }
        public GuardReport guard { get; set; }
        public JobTimings() { transactionStatus = "NotStarted"; }
        public double queueWaitMs { get; set; }
        public long compileMs { get; set; }
        public bool compileCacheHit { get; set; }
        public long executionMs { get; set; }
        public long commitMs { get; set; }
        public long resultCheckMs { get; set; }
        public long dispatchMs { get; set; }
    }
    public static class Json {
        public static string Write(object value) {
#if LEGACY
            return new JavaScriptSerializer { MaxJsonLength = 8000000 }.Serialize(value);
#else
            return JsonSerializer.Serialize(value, new JsonSerializerOptions { MaxDepth = 64 });
#endif
        }
        public static T Read<T>(string text) {
#if LEGACY
            return new JavaScriptSerializer { MaxJsonLength = 8000000 }.Deserialize<T>(text);
#else
            return JsonSerializer.Deserialize<T>(text);
#endif
        }
        public static void Atomic(string path, object value) {
            string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temp, Write(value));
            try {
                for (int attempt = 0; ; attempt++) {
                    try {
                        if (File.Exists(path)) File.Replace(temp, path, null);
                        else File.Move(temp, path);
                        break;
                    } catch (IOException) {
                        if (attempt >= 5) throw;
                        Thread.Sleep(20 * (attempt + 1));
                    }
                }
            } finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    public class Bridge : IExternalApplication, IExternalEventHandler {
        private Settings settings;
        private string sessionId, sessionDir, version, startedUtc;
        private readonly object gate = new object();
        private readonly object publishGate = new object(), logGate = new object();
        private Dictionary<Document, string> documentIds = new Dictionary<Document, string>();
        private object[] documentSnapshot = new object[0];
        private ExternalEvent externalEvent;
        private Timer timer;
        private FileSystemWatcher watcher;
        private volatile Task<PreparedScript> prepareTask;
        private volatile string prepareJobId;
        private readonly WorkflowLease workflow = new WorkflowLease();
        private object workflowSnapshot;
        private readonly Stopwatch snapshotClock = Stopwatch.StartNew();
        private string lastUiIdleUtc, currentJobId, currentPhase;
        private long sequence;
        private volatile bool stopped;
        private int ticking, executing;
        private bool managedWarningGuard;
        private bool managedDialogResponded;
        private string guardFault, metadataJobId;

        public Result OnStartup(UIControlledApplication app) {
            try {
                string configPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "..", "..", "config.json"));
                settings = Json.Read<Settings>(File.ReadAllText(configPath));
                settings.workspaceRoot = Path.GetFullPath(settings.workspaceRoot).TrimEnd(Path.DirectorySeparatorChar);
                sessionId = Guid.NewGuid().ToString();
                sessionDir = Path.Combine(settings.stateRoot, "sessions", sessionId);
                foreach (string folder in new [] { "pending", "running", "results", "submitted", "claims" }) Directory.CreateDirectory(Path.Combine(sessionDir, folder));
                version = app.ControlledApplication.VersionNumber;
                startedUtc = Utc();
                CodeCompiler.Initialize(new [] { typeof(Document).Assembly.Location, typeof(UIApplication).Assembly.Location });
                externalEvent = ExternalEvent.Create(this);
                app.Idling += OnIdle;
                app.DialogBoxShowing += OnDialog;
                app.ControlledApplication.FailuresProcessing += OnFailures;
                Log("startup", new { version = version, pid = Process.GetCurrentProcess().Id });
                Publish();
                timer = new Timer(Tick, null, 1000, 1000);
                watcher = new FileSystemWatcher(Path.Combine(sessionDir, "pending"), "*.json");
                watcher.Created += OnPending;
                watcher.Renamed += OnPendingRenamed;
                watcher.Error += delegate(object sender, ErrorEventArgs e) { Log("watcher_error", new { message = e.GetException().Message }); Wake(); };
                watcher.EnableRaisingEvents = true;
                return Result.Succeeded;
            } catch (Exception ex) {
                // Startup failure is visible to Revit and kept in a local diagnostic file.
                try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "RevitWorkspaceBridge-startup.log"), Utc() + " " + ex + Environment.NewLine); } catch { }
                return Result.Failed;
            }
        }
        public Result OnShutdown(UIControlledApplication app) {
            stopped = true;
            if (watcher != null) watcher.Dispose();
            if (timer != null) {
                using (var done = new ManualResetEvent(false)) { timer.Dispose(done); done.WaitOne(2000); }
            }
            app.Idling -= OnIdle;
            app.DialogBoxShowing -= OnDialog;
            app.ControlledApplication.FailuresProcessing -= OnFailures;
            if (externalEvent != null) externalEvent.Dispose();
            Log("shutdown", new { pendingJobsAreNotReplayed = true });
            return Result.Succeeded;
        }
        private static string Utc() { return DateTime.UtcNow.ToString("o"); }
        private void OnPending(object sender, FileSystemEventArgs e) { Wake(); }
        private void OnPendingRenamed(object sender, RenamedEventArgs e) { Wake(); }
        private void Wake() {
            if (stopped || timer == null) return;
            try { timer.Change(1, 1000); } catch (ObjectDisposedException) { }
        }
        private string NextPending() {
            foreach(var file in Directory.EnumerateFiles(Path.Combine(sessionDir,"pending"),"*.json").OrderBy(File.GetCreationTimeUtc).ThenBy(f=>f,StringComparer.Ordinal)) {
                try { if(Json.Read<Request>(File.ReadAllText(file)).operation!="api_lookup")return file; }
                catch(FileNotFoundException) { }
            }
            return null;
        }
        private void Tick(object ignored) {
            if (stopped || Interlocked.Exchange(ref ticking, 1) != 0) return;
            try {
                Publish();
                RunMetadataJob();
                if (Interlocked.CompareExchange(ref executing, 0, 0) != 0) return;
                string next = NextPending();
                if (next == null) return;
                string id = Path.GetFileNameWithoutExtension(next);
                if (id != prepareJobId) {
                    Request request;
                    try { request = Json.Read<Request>(File.ReadAllText(next)); }
                    catch (FileNotFoundException) { Wake(); return; }
                    prepareJobId = id;
                    prepareTask = null;
                    if (request.operation == "execute_code" && DateTime.Parse(request.expiresUtc).ToUniversalTime() >= DateTime.UtcNow) {
                        string body = request.args == null ? null : request.args.code;
                        prepareTask = Task.Factory.StartNew(() => CodeCompiler.Compile(body), CancellationToken.None,
                            TaskCreationOptions.None, TaskScheduler.Default);
                        prepareTask.ContinueWith(t => { var observed = t.Exception; Wake(); }, TaskScheduler.Default);
                    }
                }
                if (prepareTask == null || prepareTask.IsCompleted) externalEvent.Raise();
            } catch (Exception ex) { Log("bridge_error", new { message = ex.Message }); }
            finally { Interlocked.Exchange(ref ticking, 0); }
        }
        private void Publish() {
            if (!Monitor.TryEnter(publishGate)) return;
            try {
                object snapshot;
                using (var process = Process.GetCurrentProcess()) {
                lock (gate) snapshot = new {
                sessionId = sessionId, pid = Process.GetCurrentProcess().Id, version = version,
                startedUtc = startedUtc, heartbeatUtc = Utc(), lastUiIdleUtc = lastUiIdleUtc,
                currentJobId = currentJobId, currentPhase = currentPhase, documents = documentSnapshot,
                workflow = workflowSnapshot, compiler = CodeCompiler.Stats(), bridgeVersion = "0.7.0", guardFault = guardFault, metadataJobId = metadataJobId,
                capabilities = new { atomicJobClaims = true, chunkWarningRollback = true, warningDiagnostics = true, warningDialogGroupRollback = true,
                    guardedExecution = true, protectedQueries = true, apiCatalog = true, preservation = true, saveModel = true, ifcExport = true, authorizedWarningPolicy = true },
                privateMemoryBytes = process.PrivateMemorySize64, workingSetBytes = process.WorkingSet64
                };
                }
                Json.Atomic(Path.Combine(sessionDir, "session.json"), snapshot);
            } finally { Monitor.Exit(publishGate); }
        }
        private void OnIdle(object sender, IdlingEventArgs e) {
            var app = sender as UIApplication;
            if (app == null) return;
            lock (gate) lastUiIdleUtc = Utc();
            if (snapshotClock.ElapsedMilliseconds < 2000) return;
            try { Snapshot(app); } catch (Exception ex) { Log("snapshot_error", new { message = ex.Message }); }
        }
        private string Id(Document doc) {
            string id;
            if (!documentIds.TryGetValue(doc, out id)) { id = Guid.NewGuid().ToString(); documentIds.Add(doc, id); }
            return id;
        }
        private object DocInfo(Document doc, UIApplication app) {
            return new { documentId = Id(doc), title = doc.Title, path = doc.PathName,
                isFamily = doc.IsFamilyDocument, isWorkshared = doc.IsWorkshared,
                isModified = doc.IsModified, isReadOnly = doc.IsReadOnly,
                active = app.ActiveUIDocument != null && app.ActiveUIDocument.Document.Equals(doc) };
        }
        private object ResultDocInfo(Document doc, string id, UIApplication app) {
            return doc.IsValidObject ? DocInfo(doc, app) : (object)new { documentId = id, closed = true };
        }
        private void Snapshot(UIApplication app) {
            var docs = app.Application.Documents.Cast<Document>().Where(d => d.IsValidObject && !d.IsLinked).ToArray();
            // A closed Document cannot be hashed/compared by the Revit API. Rebuild
            // from valid objects before looking up IDs, instead of Remove(closedDoc).
            documentIds = documentIds.Where(pair => pair.Key.IsValidObject && docs.Contains(pair.Key))
                .ToDictionary(pair => pair.Key, pair => pair.Value);
            var rows = docs.Select(d => DocInfo(d, app)).ToArray();
            lock (gate) { documentSnapshot = rows; lastUiIdleUtc = Utc(); }
            snapshotClock.Restart();
        }
        private Document Target(UIApplication app, string id) {
            Guid parsed;
            if (!Guid.TryParse(id, out parsed)) throw new ArgumentException("An explicit documentId UUID is required");
            foreach (Document doc in app.Application.Documents)
                if (!doc.IsLinked && Id(doc) == id) return doc;
            throw new InvalidOperationException("Document is closed or belongs to another session; active document will not be used as a fallback");
        }
        private string ModelPath(string input) {
            string full = Path.GetFullPath(Path.IsPathRooted(input) ? input : Path.Combine(settings.workspaceRoot, input));
            string prefix = settings.workspaceRoot + Path.DirectorySeparatorChar;
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !full.EndsWith(".rvt", StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                throw new ArgumentException("Expected an existing RVT inside workspaceRoot");
            // Also enforce containment in the add-in, not only in the MCP process.
            for (string check = full; check != null; check = Path.GetDirectoryName(check)) {
                if ((File.GetAttributes(check) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Links and junctions are not permitted");
                if (string.Equals(check, settings.workspaceRoot, StringComparison.OrdinalIgnoreCase)) break;
            }
            return full;
        }
        private void Log(string kind, object data, string jobOverride = null) {
            if (sessionDir == null) return;
            try {
                lock (logGate) {
                    string file = Path.Combine(sessionDir, "events.jsonl");
                    if (File.Exists(file) && new FileInfo(file).Length > 5000000) {
                        string previous = Path.Combine(sessionDir, "events.previous.jsonl");
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(file, previous);
                    }
                    File.AppendAllText(file, Json.Write(new { sequence = ++sequence, utc = Utc(),
                        kind = kind, sessionId = sessionId, jobId = jobOverride ?? currentJobId, data = data }) + "\n");
                }
            } catch (Exception ex) { Trace.WriteLine("RevitWorkspace log failed: " + ex.Message); }
        }
        private void OnDialog(object sender, DialogBoxShowingEventArgs e) {
            var task = e as TaskDialogShowingEventArgs;
            var message = e as MessageBoxShowingEventArgs;
            bool responded = false;
            // Only the known failure dialog inside our own managed transaction.
            if (managedWarningGuard && currentJobId != null && e.DialogId == "Dialog_Revit_DocWarnDialog") {
                try { responded = e.OverrideResult(2); } // dismissal alone is NOT proof of rollback
                catch (Exception ex) { Log("dialog_response_error", new { dialogId = e.DialogId, message = ex.Message }); }
                if (responded) managedDialogResponded = true;
            }
            Log("dialog_shown", new { dialogId = e.DialogId, type = e.GetType().Name,
                message = task != null ? task.Message : message != null ? message.Message : null,
                automaticResponse = responded, resultCode = responded ? (int?)2 : null,
                action = responded ? "dismiss_then_rollback_managed_group" : "unhandled" });
        }
        private static string[] ElementIds(ICollection<ElementId> ids) { return ids.Select(i => i.ToString()).ToArray(); }
        private void OnFailures(object sender, FailuresProcessingEventArgs e) {
            try {
                var accessor = e.GetFailuresAccessor();
                var document = accessor.GetDocument();
                foreach (var failure in accessor.GetFailureMessages()) Log("failure", new {
                    documentId = Id(document), documentTitle = document.Title, documentPath = document.PathName,
                    failureId = failure.GetFailureDefinitionId().Guid.ToString(), severity = failure.GetSeverity().ToString(),
                    description = failure.GetDescriptionText(), elements = ElementIds(failure.GetFailingElementIds()),
                    additionalElements = ElementIds(failure.GetAdditionalElementIds())
                });
            } catch (Exception ex) { Log("capture_error", new { message = ex.Message }); }
        }
        public string GetName() { return "Revit Workspace queued job"; }
        public void Execute(UIApplication app) {
            if (Interlocked.Exchange(ref executing, 1) != 0) return;
            try { ExecuteOne(app); }
            catch (Exception ex) { Log("dispatch_error", new { message = ex.Message }); }
            finally { Interlocked.Exchange(ref executing, 0); Wake(); }
        }
        private void ExecuteOne(UIApplication app) {
            string pending = NextPending();
            if (pending == null) return;
            string jobId = Path.GetFileNameWithoutExtension(pending);
            Guid parsed;
            if (!Guid.TryParse(jobId, out parsed)) return;
            // Never wait for Roslyn on the UI thread. The worker will signal again.
            if (prepareJobId != jobId || (prepareTask != null && !prepareTask.IsCompleted)) return;
            string running = Path.Combine(sessionDir, "running", jobId + ".json");
            string resultFile = Path.Combine(sessionDir, "results", jobId + ".json");
            Request request = null;
            object outcome;
            var watch = Stopwatch.StartNew();
            var timings = new JobTimings();
            try {
                if (File.Exists(resultFile) || File.Exists(running)) { File.Delete(pending); return; }
                try { request = Json.Read<Request>(File.ReadAllText(pending)); }
                catch (FileNotFoundException) { return; }
                string claim = Path.Combine(sessionDir, "claims", jobId + ".json");
                if (!ClaimJob(claim, jobId, request.operation)) {
                    File.Delete(pending); return; // cancellation/another execution owns the durable claim
                }
                try { File.Move(pending, running); }
                catch (FileNotFoundException) { return; } // cancellation won the claim
                request = Json.Read<Request>(File.ReadAllText(running));
                if (request.jobId != jobId || request.sessionId != sessionId) throw new ArgumentException("Job identity mismatch");
                if (DateTime.Parse(request.expiresUtc).ToUniversalTime() < DateTime.UtcNow) {
                    Json.Atomic(resultFile, new { sessionId = sessionId, jobId = jobId, status = "expired", effectsMayHaveOccurred = false });
                    return;
                }
                lock (gate) currentJobId = jobId;
                try { Publish(); } catch (IOException ex) { Log("registry_write_error", new { message = ex.Message }); }
                DateTime created;
                if (DateTime.TryParse(request.createdUtc, out created)) timings.queueWaitMs = Math.Max(0, (DateTime.UtcNow - created.ToUniversalTime()).TotalMilliseconds);
                Log("job_started", new { operation = request.operation, queueWaitMs = timings.queueWaitMs });
                object result = Dispatch(app, request, timings);
                timings.dispatchMs = watch.ElapsedMilliseconds;
                outcome = new { sessionId = sessionId, jobId = jobId, status = "completed", finishedUtc = Utc(), timings = timings, result = result };
                Log("job_completed", new { operation = request.operation, timings = timings });
            } catch (Exception ex) {
                var actual = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                timings.dispatchMs = watch.ElapsedMilliseconds;
                outcome = new { sessionId = sessionId, jobId = jobId, status = "failed", finishedUtc = Utc(),
                    error = actual.Message, exceptionType = actual.GetType().FullName,
                    timings = timings,
                    effectsMayHaveOccurred = request != null && (request.operation == "open_model" || request.operation == "new_model" || request.operation == "execute_code" || request.operation == "save_model" || request.operation == "export_ifc") };
                Log("exception", new { message = actual.Message, type = actual.GetType().FullName, stack = actual.StackTrace });
            } finally {
                workflowSnapshot = workflow.Snapshot(DateTime.UtcNow);
                lock (gate) { currentJobId = null; currentPhase = null; managedWarningGuard = false; }
                try { Snapshot(app); Publish(); } catch (Exception ex) { Log("snapshot_error", new { message = ex.Message }); }
            }
            // Keep the durable running marker if result serialization fails: outcome is then UNKNOWN, never a false rollback.
            try { Json.Atomic(resultFile, outcome); }
            catch (Exception ex) { Log("result_write_error", new { jobId = jobId, message = ex.Message }); }
        }
        private void Phase(string value) { lock (gate) currentPhase = value; }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLink(string newName, string existingName, IntPtr reserved);
        private bool ClaimJob(string file, string id, string operation) {
            string temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temp, Json.Write(new { jobId = id, owner = "running", operation = operation }));
            try {
                if (CreateHardLink(file, temp, IntPtr.Zero)) return true;
                int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                if (error == 80 || error == 183) return false;
                throw new System.ComponentModel.Win32Exception(error, "Cannot reserve job execution");
            } finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        private object Dispatch(UIApplication app, Request request, JobTimings timings) {
            var args = request.args ?? new Arguments();
            if (request.operation == "workflow") return workflow.Apply(args.action, args.workflowId, args.owner, args.ttlSeconds, DateTime.UtcNow);
            bool readOnly = request.operation == "list_documents" || request.operation == "inspect_model" || request.operation == "warnings" || request.operation == "check_preservation" ||
                (request.operation == "execute_code" && (args.transactionMode == "query" || args.transactionMode == "none"));
            if (!readOnly) workflow.Check(args.workflowId, DateTime.UtcNow);
            Phase(request.operation);
            if (request.operation == "list_documents") {
                Snapshot(app);
                return new { documents = documentSnapshot };
            }
            if (request.operation == "inspect_model") {
                string file = ModelPath(args.path);
                using (var info = BasicFileInfo.Extract(file)) return new {
                    path = file, savedVersion = info.Format, isWorkshared = info.IsWorkshared,
                    isCentral = info.IsCentral, centralPath = info.CentralPath,
                    isSavedInLaterVersion = info.IsSavedInLaterVersion, sessionVersion = version
                };
            }
            if (request.operation == "new_model") {
                if (args.units != "Metric" && args.units != "Imperial") throw new ArgumentException("Expected Metric or Imperial units");
                var created = app.Application.NewProjectDocument(args.units == "Metric" ? UnitSystem.Metric : UnitSystem.Imperial);
                return new { document = DocInfo(created, app), saved = false };
            }
            if (request.operation == "open_model") {
                string file = ModelPath(args.path);
                if (args.mode != "normal" && args.mode != "detached_preserve_worksets") throw new ArgumentException("Unsupported open mode");
                foreach (Document opened in app.Application.Documents)
                    if (!opened.IsLinked && string.Equals(opened.PathName, file, StringComparison.OrdinalIgnoreCase))
                        return new { alreadyOpen = true, document = DocInfo(opened, app) };
                using (var info = BasicFileInfo.Extract(file)) {
                    int saved, current;
                    if (!int.TryParse(info.Format, out saved) || !int.TryParse(version, out current)) throw new InvalidOperationException("Cannot verify Revit file version");
                    if (saved > current) throw new InvalidOperationException("Model requires Revit " + info.Format + "; this session is " + version);
                    if (saved < current && !args.allowUpgrade) throw new InvalidOperationException("Version mismatch. Start Revit " + info.Format + " or explicitly request allowUpgrade");
                    if (info.IsCentral && args.mode == "normal") throw new InvalidOperationException("Central model: use detached_preserve_worksets or create/open a local copy outside this tool");
                    if (info.IsWorkshared && args.mode == "normal") throw new InvalidOperationException("Workshared model: this tool requires detached_preserve_worksets to avoid connecting an unattended agent to central");
                }
                using (var options = new OpenOptions()) {
                    if (args.mode == "detached_preserve_worksets") options.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
                    var doc = app.OpenAndActivateDocument(ModelPathUtils.ConvertUserVisiblePathToModelPath(file), options, false).Document;
                    return new { alreadyOpen = false, document = DocInfo(doc, app), saved = false };
                }
            }
            Document target = Target(app, args.documentId);
            if (request.operation == "save_model" || request.operation == "export_ifc") {
                if(guardFault!=null)throw new InvalidOperationException("MCP_GUARD_FAULT: "+guardFault);
                try {
                    if(request.operation=="save_model")return Lifecycle.Save(app,target,args,settings.workspaceRoot,args.documentId);
                    return Lifecycle.ExportIfc(app,target,args,settings.workspaceRoot,args.documentId,request.jobId,timings,Id,(kind,data)=>Log(kind,data));
                } finally {
                    if(timings.guard!=null&&!timings.guard.cleanupComplete)guardFault="Lifecycle protection cleanup incomplete for job "+request.jobId;
                }
            }
            if (request.operation == "close_model") {
                if (app.ActiveUIDocument != null && SameDocument(app.ActiveUIDocument.Document,target)) throw new InvalidOperationException("Cannot close the active UI document through this background operation");
                if (target.IsModifiable) throw new InvalidOperationException("Document has an open transaction");
                return new {documentId=args.documentId,closed=target.Close(false),saved=false};
            }
            if (request.operation == "check_preservation") return Preservation.Check(target,args.preserveElements);
            if (request.operation == "warnings") {
                int limit = Math.Max(1, Math.Min(500, args.limit));
                var warnings = target.GetWarnings();
                return new { document = DocInfo(target, app), total = warnings.Count,
                    groups = warnings.GroupBy(w => w.GetFailureDefinitionId().Guid).Select(g => new {
                        failureId = g.Key.ToString(), description = g.First().GetDescriptionText(), count = g.Count() }).ToArray(),
                    warnings = warnings.Skip(Math.Max(0, args.offset)).Take(limit).Select(w => new {
                        failureId = w.GetFailureDefinitionId().Guid.ToString(), severity = w.GetSeverity().ToString(),
                        description = w.GetDescriptionText(), elements = ElementIds(w.GetFailingElements()),
                        additionalElements = ElementIds(w.GetAdditionalElements()) }).ToArray(),
                    nextOffset = args.offset + limit < warnings.Count ? (int?)(args.offset + limit) : null
                };
            }
            if (request.operation == "execute_code") return ExecuteScript(app,target,request,args,timings);
            throw new ArgumentException("Unknown operation: " + request.operation);
        }
        private static bool SameDocument(Document a, Document b) { return ReferenceEquals(a,b) || a.Equals(b); }
        private object ExecuteScript(UIApplication app,Document target,Request request,Arguments args,JobTimings timings) {
            string mode=args.transactionMode=="none"?"query":args.transactionMode;
            if(mode!="query" && mode!="transaction" && mode!="preview")throw new ArgumentException("Unknown transaction mode");
            if(guardFault!=null)throw new InvalidOperationException("MCP_GUARD_FAULT: "+guardFault+"; inspect the model and restart this worker");
            if(prepareTask==null||prepareJobId!=request.jobId||!prepareTask.IsCompleted)throw new InvalidOperationException("Script preparation is not ready");
            if(target.IsReadOnly && mode!="query")throw new InvalidOperationException("Document is read-only");
            var prepared=prepareTask.GetAwaiter().GetResult();
            timings.compileMs=prepared.CompileMs;timings.compileCacheHit=prepared.CacheHit;
            var guard=new ExecutionGuard(app,target,mode=="query",args.preserveElements,Id,(kind,data)=>Log(kind,data),"MCP "+request.jobId,
                warningPolicy:args.warningPolicy,warningApproval:args.warningApproval);
            object value=null;var watch=Stopwatch.StartNew();managedDialogResponded=false;managedWarningGuard=true;
            try {
                if(target.IsReadOnly) {
                    Phase("executing_query");value=prepared.Script.Method.Invoke(null,new object[]{app,target,args.parameters??new string[0]});
                    guard.CloseScriptTransactions();value=CheckResult(value);guard.Finish(false);
                } else using(var transaction=new Transaction(target,"MCP "+request.jobId)) {
                    try {
                        transaction.Start();timings.transactionStatus="Started";
                        var options=transaction.GetFailureHandlingOptions();options.SetFailuresPreprocessor(guard);options.SetClearAfterRollback(true);transaction.SetFailureHandlingOptions(options);
                        Phase(mode=="query"?"executing_query":"executing");
                        value=prepared.Script.Method.Invoke(null,new object[]{app,target,args.parameters??new string[0]});
                        timings.executionMs=watch.ElapsedMilliseconds;watch.Restart();
                        if(guard.CloseScriptTransactions()>0)throw new InvalidOperationException("MCP_TRANSACTION_LEFT_OPEN: script transactions were rolled back");
                        Phase("checking_result");value=CheckResult(value);timings.resultCheckMs=watch.ElapsedMilliseconds;watch.Restart();
                        Phase(mode=="preview"?"rolling_back":"committing");
                        var status=mode=="preview"?transaction.RollBack():transaction.Commit();
                        timings.innerTransactionStatus=status.ToString();timings.commitMs=watch.ElapsedMilliseconds;
                        if(managedDialogResponded)throw new InvalidOperationException("MCP_DIALOG_ROLLBACK: dialog dismissed; rolling back protected scope");
                        var expected=mode=="preview"?TransactionStatus.RolledBack:TransactionStatus.Committed;
                        if(status!=expected)throw new InvalidOperationException(guard.WarningCount>0?"MCP_WARNING_ROLLBACK: inspect timings.guard.failures":"MCP_REVIT_FAILURE: "+status);
                    } catch {
                        guard.CloseScriptTransactions();
                        if(transaction.GetStatus()==TransactionStatus.Started)transaction.RollBack();
                        throw;
                    }
                }
                if(!target.IsReadOnly)guard.Finish(mode=="transaction");
            } finally {
                guard.Dispose();managedWarningGuard=false;
                timings.guard=guard.Report;timings.transactionStatus=guard.TargetStatus;timings.warningCount=guard.WarningCount;timings.warnings=guard.Report.failures;
                if(!guard.Report.cleanupComplete){guardFault="Protection cleanup incomplete for job "+request.jobId;throw new InvalidOperationException("MCP_GUARD_CLEANUP_FAILED: "+string.Join("; ",guard.Report.cleanupErrors));}
            }
            return new {value=value,transactionStatus=guard.TargetStatus,document=ResultDocInfo(target,args.documentId,app)};
        }
        private void RunMetadataJob() {
            foreach(string file in Directory.EnumerateFiles(Path.Combine(sessionDir,"pending"),"*.json").OrderBy(File.GetCreationTimeUtc)) {
                Request request;
                try {request=Json.Read<Request>(File.ReadAllText(file));}catch(FileNotFoundException){continue;}
                if(request.operation!="api_lookup")continue;
                Guid id;
                if(!Guid.TryParse(request.jobId,out id)||request.sessionId!=sessionId)continue;
                if(!ClaimJob(Path.Combine(sessionDir,"claims",request.jobId+".json"),request.jobId,request.operation)){File.Delete(file);continue;}
                File.Move(file,Path.Combine(sessionDir,"running",request.jobId+".json"));
                lock(gate)metadataJobId=request.jobId;
                var clock=Stopwatch.StartNew();object outcome;
                try {
                    if(DateTime.Parse(request.expiresUtc).ToUniversalTime()<DateTime.UtcNow)outcome=new {sessionId=sessionId,jobId=request.jobId,status="expired",effectsMayHaveOccurred=false};
                    else {
                        var args=request.args??new Arguments();
                        object result=ApiCatalog.Lookup(args.name,args.offset,args.limit);
                        outcome=new {sessionId=sessionId,jobId=request.jobId,status="completed",finishedUtc=Utc(),result=result,
                            timings=new {executionMs=clock.ElapsedMilliseconds,metadataOnly=true}};
                        Log("api_lookup_completed",new {elapsedMs=clock.ElapsedMilliseconds},request.jobId);
                    }
                } catch(Exception ex){outcome=new {sessionId=sessionId,jobId=request.jobId,status="failed",error=ex.Message,effectsMayHaveOccurred=false};}
                finally{lock(gate)metadataJobId=null;}
                Json.Atomic(Path.Combine(sessionDir,"results",request.jobId+".json"),outcome);
                return;
            }
        }
        private static object CheckResult(object result) {
            string json = Json.Write(result);
            if (json.Length > 4000000) throw new InvalidOperationException("Result too large. Return a summary or page the data.");
            // Detach anonymous script types so durable results do not pin collectible assemblies.
            return Json.Read<object>(json);
        }
        private class RollbackErrors : IFailuresPreprocessor {
            private readonly Bridge bridge;
            private readonly Document document;
            public int WarningCount { get; private set; }
            public readonly List<object> Warnings = new List<object>();
            public RollbackErrors(Bridge owner, Document target) { bridge = owner; document = target; }
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor) {
                bool error = false;
                foreach (var failure in accessor.GetFailureMessages()) {
                    var detail = new { documentId = bridge.Id(document),
                        failureId = failure.GetFailureDefinitionId().Guid.ToString(), severity = failure.GetSeverity().ToString(),
                        description = failure.GetDescriptionText(), elements = ElementIds(failure.GetFailingElementIds()),
                        additionalElements = ElementIds(failure.GetAdditionalElementIds()), automaticAction = "rollback_transaction" };
                    bridge.Log("transaction_failure", detail);
                    if (failure.GetSeverity() == FailureSeverity.Warning) {
                        WarningCount++;
                        if (Warnings.Count < 100) Warnings.Add(detail);
                    }
                    if (failure.GetSeverity() != FailureSeverity.None) error = true;
                }
                return error ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }
    }
}
