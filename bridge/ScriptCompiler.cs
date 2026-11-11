using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
#if LEGACY
using System.CodeDom.Compiler;
using Microsoft.CSharp;
#else
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
#endif

namespace RevitWorkspace {
    public sealed class CompiledScript {
        public MethodInfo Method;
#if !LEGACY
        public AssemblyLoadContext Context;
#endif
        public void Retire() {
            Method = null;
#if !LEGACY
            if (Context != null) Context.Unload();
            Context = null;
#endif
        }
    }
    public sealed class PreparedScript {
        public CompiledScript Script;
        public bool CacheHit;
        public long CompileMs;
    }
    // Only strings/metadata enter this worker. No Document, Element or geometry is read here.
    public static class CodeCompiler {
        private const int Capacity = 32;
        private static readonly object gate = new object();
        private static readonly Dictionary<string, CompiledScript> cache = new Dictionary<string, CompiledScript>();
        private static readonly LinkedList<string> order = new LinkedList<string>();
        private static string[] apiPaths;
        private static long hits, misses, evictions;
#if !LEGACY
        private static MetadataReference[] references;
        private sealed class ScriptContext : AssemblyLoadContext {
            public ScriptContext() : base(true) { }
            protected override Assembly Load(AssemblyName name) {
                return AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a =>
                    !a.IsDynamic && AssemblyName.ReferenceMatchesDefinition(a.GetName(), name) &&
                    AssemblyLoadContext.GetLoadContext(a) != this && !AssemblyLoadContext.GetLoadContext(a).IsCollectible);
            }
        }
        private sealed class GuardRewriter : CSharpSyntaxRewriter {
            private readonly SemanticModel model;
            public GuardRewriter(SemanticModel semantic) { model = semantic; }
            private static ExpressionSyntax Track(ExpressionSyntax value) {
                return SyntaxFactory.InvocationExpression(SyntaxFactory.ParseExpression("global::RevitWorkspace.ScriptScope.Track"),
                    SyntaxFactory.ArgumentList(SyntaxFactory.SingletonSeparatedList(SyntaxFactory.Argument(value))));
            }
            private static bool IsTransaction(ITypeSymbol type) {
                string name = type == null ? "" : type.ToDisplayString();
                return name == "Autodesk.Revit.DB.Transaction" || name == "Autodesk.Revit.DB.SubTransaction" || name == "Autodesk.Revit.DB.TransactionGroup";
            }
            public override SyntaxNode VisitObjectCreationExpression(ObjectCreationExpressionSyntax node) {
                var rewritten = (ExpressionSyntax)base.VisitObjectCreationExpression(node);
                return IsTransaction(model.GetTypeInfo(node).Type) ? Track(rewritten) : rewritten;
            }
            public override SyntaxNode VisitImplicitObjectCreationExpression(ImplicitObjectCreationExpressionSyntax node) {
                var type = model.GetTypeInfo(node).Type;
                if (!IsTransaction(type)) return base.VisitImplicitObjectCreationExpression(node);
                var visited=(ImplicitObjectCreationExpressionSyntax)base.VisitImplicitObjectCreationExpression(node);
                return Track(SyntaxFactory.ObjectCreationExpression(SyntaxFactory.ParseTypeName(type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)))
                    .WithArgumentList(visited.ArgumentList).WithInitializer(visited.Initializer));
            }
            public override SyntaxNode VisitInvocationExpression(InvocationExpressionSyntax node) {
                var method = model.GetSymbolInfo(node).Symbol as IMethodSymbol;
                string operation = null;
                if (method != null) {
                    string owner = method.ContainingType.ToDisplayString();
                    if (owner == "Autodesk.Revit.DB.Document") {
                        switch(method.Name) {
                            case "Save":operation="save";break;case "SaveAs":operation="save_as";break;
                            case "SynchronizeWithCentral":operation="sync";break;case "Close":operation="close";break;
                            case "Export":operation="export";break;case "EditFamily":operation="edit_family";break;
                        }
                    } else if (owner == "Autodesk.Revit.ApplicationServices.Application" &&
                        (method.Name == "NewProjectDocument" || method.Name == "NewFamilyDocument" || method.Name == "OpenDocumentFile")) operation="document_lifecycle";
                    else if(owner=="Autodesk.Revit.UI.UIApplication" && method.Name=="OpenAndActivateDocument")operation="document_activation";
                }
                if(operation==null)return base.VisitInvocationExpression(node);
                string generic=method.ReturnsVoid?"":"<"+method.ReturnType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)+">";
                return SyntaxFactory.ParseExpression("global::RevitWorkspace.ScriptScope.BlockOperation"+generic+"(\""+operation+"\")").WithTriviaFrom(node);
            }
        }
#endif
        public static void Initialize(string[] paths) { apiPaths = paths; }
        public static object Stats() {
            if (!Monitor.TryEnter(gate)) return new { preparing = true };
            try { return new { entries = cache.Count, capacity = Capacity, hits = hits, misses = misses,
                evictions = evictions,
#if LEGACY
                collectible = false
#else
                collectible = true
#endif
            }; } finally { Monitor.Exit(gate); }
        }
        public static PreparedScript Compile(string body) {
            if (string.IsNullOrWhiteSpace(body) || body.Length > 200000) throw new ArgumentException("Expected code up to 200000 characters");
            var watch = Stopwatch.StartNew();
            lock (gate) {
                CompiledScript cached;
                if (cache.TryGetValue(body, out cached)) {
                    hits++; order.Remove(body); order.AddLast(body);
                    return new PreparedScript { Script = cached, CacheHit = true, CompileMs = watch.ElapsedMilliseconds };
                }
                misses++;
                string source = "using System; using System.Linq; using System.Collections.Generic; using Autodesk.Revit.DB; using Autodesk.Revit.UI; public static class WorkspaceScript { public static object Execute(UIApplication uiapp, Document document, string[] parameters) { " + body + "\n} }";
                Assembly assembly;
                var script = new CompiledScript();
#if LEGACY
                using (var provider = new CSharpCodeProvider()) {
                    var options = new CompilerParameters { GenerateInMemory = true, GenerateExecutable = false };
                    options.ReferencedAssemblies.Add("System.dll");
                    options.ReferencedAssemblies.Add("System.Core.dll");
                    foreach (string file in apiPaths) options.ReferencedAssemblies.Add(file);
                    var result = provider.CompileAssemblyFromSource(options, source);
                    if (result.Errors.HasErrors) throw new InvalidOperationException(string.Join("\n", result.Errors.Cast<CompilerError>().Where(e => !e.IsWarning).Select(e => e.ToString()).ToArray()));
                    assembly = result.CompiledAssembly;
                }
#else
                if (references == null) {
                    var paths = new HashSet<string>(apiPaths, StringComparer.OrdinalIgnoreCase);
                    paths.Add(typeof(ScriptScope).Assembly.Location);
                    string platform = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
                    if (platform != null) foreach (string file in platform.Split(Path.PathSeparator)) paths.Add(file);
                    references = paths.Select(p => MetadataReference.CreateFromFile(p)).ToArray();
                }
                var tree = CSharpSyntaxTree.ParseText(source);
                var compilation = CSharpCompilation.Create("WorkspaceScript_" + Guid.NewGuid().ToString("N"),
                    new [] { tree }, references,
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release));
                // Bind original symbols first: aliases and fully-qualified API names have the same protection.
                var rewritten = new GuardRewriter(compilation.GetSemanticModel(tree)).Visit(tree.GetRoot());
                compilation = compilation.ReplaceSyntaxTree(tree, CSharpSyntaxTree.Create((CSharpSyntaxNode)rewritten));
                using (var buffer = new MemoryStream()) {
                    var emitted = compilation.Emit(buffer);
                    if (!emitted.Success) throw new InvalidOperationException(string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString())));
                    buffer.Position = 0;
                    var context = new ScriptContext();
                    try { assembly = context.LoadFromStream(buffer); script.Context = context; }
                    catch { context.Unload(); throw; }
                }
#endif
                script.Method = assembly.GetType("WorkspaceScript").GetMethod("Execute");
                cache.Add(body, script); order.AddLast(body);
                if (cache.Count > Capacity) {
                    string oldest = order.First.Value; order.RemoveFirst();
                    cache[oldest].Retire(); cache.Remove(oldest); evictions++;
                }
                return new PreparedScript { Script = script, CacheHit = false, CompileMs = watch.ElapsedMilliseconds };
            }
        }
    }
}
