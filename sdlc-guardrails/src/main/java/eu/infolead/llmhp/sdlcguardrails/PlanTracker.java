package eu.infolead.llmhp.sdlcguardrails;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Parses a {@code plan.md} into a list of declared file paths and per-step scope
 * markers. Used by DiffGuard to check whether an edit tracks the plan.
 */
public final class PlanTracker {
    /** A declared file reference in the plan, with the plan path it came from. */
    public record PlannedPath(String raw, Path path, String sourceLine) {}

    private final Path planFile;
    private final List<PlannedPath> declaredFiles;
    private final boolean fixPlan;      // plan contains a fix-marked step
    private final boolean parseOk;

    private PlanTracker(Path planFile, List<PlannedPath> declaredFiles, boolean fixPlan, boolean parseOk) {
        this.planFile = planFile;
        this.declaredFiles = List.copyOf(declaredFiles);
        this.fixPlan = fixPlan;
        this.parseOk = parseOk;
    }

    public static PlanTracker of(Path planFile) {
        if (planFile == null) return new PlanTracker(null, List.of(), false, false);
        List<PlannedPath> files = new ArrayList<>();
        boolean fix = false;
        try {
            for (String raw : Files.readAllLines(planFile, StandardCharsets.UTF_8)) {
                String line = raw.trim();
                if (line.isEmpty()) continue;
                if (line.startsWith("-")) {
                    // bullet: "- path/to/file" or "- [fix] path" or "- **/glob"
                    Path p = extractPath(line);
                    if (p != null) files.add(new PlannedPath(line, p, raw));
                } else if (line.toLowerCase().startsWith("## ") && line.toLowerCase().contains("fix")) {
                    fix = true;
                }
            }
            return new PlanTracker(planFile, files, fix, true);
        } catch (IOException e) {
            return new PlanTracker(planFile, List.of(), false, false);
        }
    }

    public Path planFile() {
        return planFile;
    }

    public List<PlannedPath> declaredFiles() {
        return declaredFiles;
    }

    public boolean isFixPlan() {
        return fixPlan;
    }

    public boolean parseOk() {
        return parseOk;
    }

    /** A plan is relevant when it parsed and names at least one file. */
    public boolean isPlanRelevant() {
        return parseOk && !declaredFiles.isEmpty();
    }

    /** Does the plan declare {@code target} (relative to {@code root})? Glob-aware, best-effort. */
    public boolean declares(Path root, Path target) {
        if (declaredFiles.isEmpty()) return true; // empty plan => don't block
        Path rel = toRelative(root, target);
        if (rel == null) return false;
        String relStr = rel.toString().replace('\\', '/');
        for (PlannedPath dp : declaredFiles) {
            if (matches(relStr, dp.path())) return true;
        }
        return false;
    }

    private static boolean matches(String rel, Path declared) {
        String d = declared.toString().replace('\\', '/');
        // exact
        if (rel.equals(d)) return true;
        // suffix match (plan may list a path without the repo prefix)
        if (rel.endsWith("/" + d)) return true;
        // crude glob: '**/x/**' and '*'
        if (d.contains("*")) {
            Pattern p = globToRegex(d);
            return p != null && p.matcher(rel).matches();
        }
        return false;
    }

    static Pattern globToRegex(String glob) {
        StringBuilder sb = new StringBuilder("^");
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            if (c == '*') {
                if (i + 1 < glob.length() && glob.charAt(i + 1) == '*') {
                    sb.append(".*");
                    i++;
                } else {
                    sb.append("[^/]*");
                }
            } else if (c == '?') {
                sb.append("[^/]");
            } else if (c == '.') {
                sb.append("\\.");
            } else if (c == '/') {
                sb.append("/");
            } else {
                sb.append(Pattern.quote(String.valueOf(c)));
            }
        }
        sb.append("$");
        return Pattern.compile(sb.toString());
    }

    private static Path extractPath(String line) {
        String s = line;
        if (s.startsWith("-")) s = s.substring(1).trim();
        // strip "[fix]" or "files:" labels
        if (s.startsWith("[")) {
            int close = s.indexOf(']');
            if (close >= 0) s = s.substring(close + 1).trim();
        }
        if (s.startsWith("files:") || s.startsWith("Files:")) s = s.substring("files:".length()).trim();
        // take first token that looks like a path
        for (String tok : s.split("\\s+")) {
            if (tok.isEmpty() || tok.contains("|") || tok.startsWith("(") || tok.startsWith(")") || tok.startsWith("#")) continue;
            if (tok.contains("/") || tok.contains(".") || tok.contains("*")) {
                return Path.of(tok.replace("**/", "").replace("**", "").replace("`", ""));
            }
        }
        return null;
    }

    private static Path toRelative(Path root, Path target) {
        try {
            return root.toAbsolutePath().normalize().relativize(target.toAbsolutePath().normalize());
        } catch (Exception e) {
            return null;
        }
    }
}
