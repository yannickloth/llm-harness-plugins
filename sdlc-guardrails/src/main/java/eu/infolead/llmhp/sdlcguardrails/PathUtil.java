package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Path;

/** Glob/path matching for protected-path and test-path allowlists. */
final class PathUtil {
    private PathUtil() {}

    /** Match a repo-relative path against a glob list (best-effort glob semantics). */
    static boolean matchesAny(Path root, Path target, java.util.List<String> patterns) {
        if (patterns == null || patterns.isEmpty()) return false;
        String rel = toRelative(root, target);
        if (rel == null) return false;
        String relStr = rel.toString().replace('\\', '/');
        for (String pat : patterns) {
            if (matches(relStr, pat)) return true;
        }
        return false;
    }

    static boolean matches(String rel, String pattern) {
        String p = pattern.replace('\\', '/');
        if (p.equals(rel)) return true;
        if (rel.endsWith("/" + p)) return true;
        if (p.contains("*")) {
            var rx = PlanTracker.globToRegex(p);
            if (rx != null && rx.matcher(rel).matches()) return true;
            // also allow matching a subpath (e.g. **/generated/** matches src/gen/x)
            var rx2 = PlanTracker.globToRegex("**/" + p);
            return rx2 != null && rx2.matcher(rel).matches();
        }
        return false;
    }

    static String toRelative(Path root, Path target) {
        try {
            return root.toAbsolutePath().normalize().relativize(target.toAbsolutePath().normalize()).toString();
        } catch (Exception e) {
            return null;
        }
    }
}
