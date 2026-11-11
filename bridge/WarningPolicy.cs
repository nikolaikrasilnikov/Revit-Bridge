using System;

namespace RevitWorkspace {
    // Job-scoped explicit user authorization; errors can never be accepted by this policy.
    public static class WarningPolicy {
        public static bool Validate(string policy, string approval, bool readOnly) {
            if (string.IsNullOrEmpty(policy) || policy == "rollback") return false;
            if (policy != "allow_warnings") throw new ArgumentException("Unknown warningPolicy");
            if (readOnly) throw new ArgumentException("Read-only queries cannot authorize warnings");
            if (string.IsNullOrWhiteSpace(approval) || approval.Length > 2000)
                throw new ArgumentException("Explicit warningApproval text is required (1..2000 characters)");
            return true;
        }
        public static bool MayAccept(bool authorized, bool isTarget, bool isWarning) {
            return authorized && isTarget && isWarning;
        }
    }
}
