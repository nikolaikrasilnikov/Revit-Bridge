using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitWorkspace {
    // Compiler-injected callbacks for accidental lifecycle calls and abandoned transactions.
    // This is not a security sandbox for arbitrary C#, reflection or external IO.
    public static class ScriptScope {
        [ThreadStatic] private static Action<object> track;
        [ThreadStatic] private static Action<string> blocked;
        internal static void Enter(Action<object> onTrack, Action<string> onBlocked) {
            if (track != null) throw new InvalidOperationException("Nested script scope");
            track = onTrack; blocked = onBlocked;
        }
        internal static void Exit() { track = null; blocked = null; }
        public static T Track<T>(T value) { if (track != null) track(value); return value; }
        public static void BlockOperation(string operation) {
            if (blocked != null) blocked(operation);
            throw new InvalidOperationException("MCP_BLOCKED_OPERATION: " + operation);
        }
        public static T BlockOperation<T>(string operation) { BlockOperation(operation); return default(T); }
    }

    public class ElementReference {
        public string id { get; set; }
        public string uniqueId { get; set; }
    }
    public static class Preservation {
        public const int Limit = 20000;
        public static ElementReference[] Validate(ElementReference[] input) {
            var references = input ?? new ElementReference[0];
            if (references.Length > Limit) throw new ArgumentException("Preservation limit: " + Limit);
            var seen = new Dictionary<string, string>();
            foreach (var item in references) {
                long id;
                if (item == null || !long.TryParse(item.id, out id) || id <= 0 || string.IsNullOrWhiteSpace(item.uniqueId) || item.uniqueId.Length > 128)
                    throw new ArgumentException("Expected positive element id and UniqueId");
                string prior;
                if (seen.TryGetValue(item.id, out prior) && prior != item.uniqueId) throw new ArgumentException("Conflicting preservation identity");
                seen[item.id] = item.uniqueId;
            }
            return references;
        }
        public static object Check(Document document, ElementReference[] input) {
            var references = Validate(input);
            var missing = new List<string>(); var replaced = new List<string>();
            int missingCount = 0, replacedCount = 0;
            foreach (var item in references) {
#if LEGACY
                var element = document.GetElement(new ElementId(int.Parse(item.id)));
#else
                var element = document.GetElement(new ElementId(long.Parse(item.id)));
#endif
                if (element == null) { missingCount++; if (missing.Count < 50) missing.Add(item.id); }
                else if (element.UniqueId != item.uniqueId) { replacedCount++; if (replaced.Count < 50) replaced.Add(item.id); }
            }
            return new PreservationResult { ok = missingCount == 0 && replacedCount == 0, checkedCount = references.Length,
                missingCount = missingCount, replacedCount = replacedCount, missing = missing.ToArray(), replaced = replaced.ToArray() };
        }
    }
    public class PreservationResult {
        public bool ok { get; set; }
        public int checkedCount { get; set; }
        public int missingCount { get; set; }
        public int replacedCount { get; set; }
        public string[] missing { get; set; }
        public string[] replaced { get; set; }
    }
}
