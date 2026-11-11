using System;

namespace RevitWorkspace {
    // Accessed only by the serialized API dispatcher. Manual Revit edits are outside this lease.
    public sealed class WorkflowLease {
        private string token, owner;
        private DateTime expires;
        private void Expire(DateTime now) { if (token != null && expires <= now) { token = null; owner = null; } }
        public object Snapshot(DateTime now) {
            Expire(now);
            return token == null ? null : new { workflowId = token, owner = owner, expiresUtc = expires.ToString("o") };
        }
        public void Check(string requested, DateTime now) {
            Expire(now);
            if (token != null && !string.Equals(token, requested, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("workflow_conflict: process is reserved by " + owner + " until " + expires.ToString("o"));
            if (token == null && requested != null)
                throw new InvalidOperationException("workflow_expired: acquire a new lease and refresh the model baseline");
        }
        public object Apply(string action, string id, string label, int ttl, DateTime now) {
            Guid parsed;
            if (!Guid.TryParse(id, out parsed)) throw new ArgumentException("Expected workflowId UUID");
            id = parsed.ToString(); Expire(now);
            if (action != "acquire" && action != "renew" && action != "release") throw new ArgumentException("Unknown workflow action");
            if (token != null && token != id) throw new InvalidOperationException("workflow_conflict: process is reserved by " + owner);
            if (action == "release") { token = null; owner = null; return new { released = true }; }
            if (action == "renew" && token == null) throw new InvalidOperationException("workflow_expired: refresh baseline before reacquiring");
            if (ttl < 30 || ttl > 900) throw new ArgumentException("Lease TTL must be 30..900 seconds");
            token = id; owner = string.IsNullOrEmpty(label) ? "MCP client" : label;
            expires = now.AddSeconds(ttl);
            return Snapshot(now);
        }
    }
}
