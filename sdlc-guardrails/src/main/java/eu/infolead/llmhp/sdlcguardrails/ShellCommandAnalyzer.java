package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Best-effort detection of file-write operations inside a shell command.
 *
 * Coding agents routinely modify files via shell commands (`cp`, `mv`, `rm`,
 * `sed -i`, `tee`, `touch`, redirection), which would otherwise bypass the
 * edit/write path guardrails. This analyzer is deliberately conservative:
 * it extracts probable write targets so {@link DiffGuard} can gate them the
 * same way it gates an {@code edit}/{@code write} tool call. It is NOT a shell
 * parser; misses are possible, and any ambiguity resolves to "not detected".
 */
public final class ShellCommandAnalyzer {
    /** A write target detected in a command. */
    public record WriteTarget(String raw, String op) {}

    // quoted or bare path tokens
    private static final Pattern TOKEN = Pattern.compile("(?:'([^']*)'|\"([^\"]*)\"|([^\\s|&;()<>]*))");

    // operations that take a destination argument
    private static final Pattern COPY_MOVE = Pattern.compile("(?:^|[;|&\\s])(cp|mv|install)\\s+(?:-[A-Za-z]+\\s+)*([^\\s|&;()<>]+\\s+[^\\s|&;()<>]+)");

    // destructive/rewrite ops
    private static final Pattern DESTRUCTIVE = Pattern.compile("(?:^|[;|&\\s])(rm|rmdir)\\s+(?:-[A-Za-z]+\\s+)*(.+?)(?:;|&|\\||$)");

    // in-place edit: sed -i [EXPR] FILE (the target is the last operand)
    private static final Pattern IN_PLACE = Pattern.compile(
        "(?:^|[;|&\\s])sed\\s+(?:-[A-Za-z]*i[A-Za-z]*|--in-place)(?:\\s+[^\\s|&;()<>]+)*\\s+([^\\s|&;()<>]+)");

    // tee / touch
    private static final Pattern TEE = Pattern.compile("(?:^|[;|&\\s])(tee|touch)\\s+(?:-[A-Za-z]+\\s+)*(.+?)(?:;|&|\\||$)");

    // redirection: > file, >> file, 2> file, &> file (operator must contain at least one '>')
    private static final Pattern REDIRECT = Pattern.compile("(?:^|\\s)(?:[0-9]?&?>>?|&>)\\s*([^\\s|&;()<>]+)");

    private ShellCommandAnalyzer() {}

    /**
     * Extract write targets from a shell command string.
     *
     * @param command the raw command
     * @param cwd     the working directory for relative resolution (may be null)
     * @return list of resolved target paths
     */
    public static List<Path> writeTargets(String command, Path cwd) {
        List<WriteTarget> raw = writeTargetsRaw(command);
        List<Path> out = new ArrayList<>();
        for (WriteTarget wt : raw) {
            String p = stripQuotes(wt.raw());
            if (p.isBlank() || p.startsWith("-")) continue;
            if (isGlob(p)) continue; // glob: cannot resolve to one path
            if (hasVarSubstitution(p)) continue; // $VAR: ambiguous
            Path path = Path.of(p);
            out.add(path.isAbsolute() ? path : (cwd == null ? path : cwd.resolve(path)));
        }
        return out;
    }

    public static List<WriteTarget> writeTargetsRaw(String command) {
        List<WriteTarget> out = new ArrayList<>();
        if (command == null || command.isBlank()) return out;

        // cp/mv/install: the LAST operand is the destination
        Matcher cm = COPY_MOVE.matcher(command);
        while (cm.find()) {
            String op = cm.group(1);
            String operands = cm.group(2);
            String[] parts = operands.trim().split("\\s+");
            if (parts.length >= 2) {
                out.add(new WriteTarget(parts[parts.length - 1], op));
            }
        }

        Matcher dm = DESTRUCTIVE.matcher(command);
        while (dm.find()) {
            String op = dm.group(1);
            for (String p : dm.group(2).trim().split("\\s+")) {
                if (!p.isEmpty()) out.add(new WriteTarget(p, op));
            }
        }

        Matcher im = IN_PLACE.matcher(command);
        while (im.find()) {
            out.add(new WriteTarget(im.group(1), "sed-i"));
        }

        Matcher tm = TEE.matcher(command);
        while (tm.find()) {
            String op = tm.group(1);
            for (String p : tm.group(2).trim().split("\\s+")) {
                if (!p.isEmpty()) out.add(new WriteTarget(p, op));
            }
        }

        Matcher rm = REDIRECT.matcher(command);
        while (rm.find()) {
            out.add(new WriteTarget(rm.group(1), "redirect"));
        }

        return out;
    }

    private static String stripQuotes(String s) {
        String t = s.trim();
        if (t.length() >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith("\"") && t.endsWith("\"")))) {
            return t.substring(1, t.length() - 1);
        }
        return t;
    }

    private static boolean isGlob(String p) {
        return p.contains("*") || p.contains("?") || p.contains("[");
    }

    private static boolean hasVarSubstitution(String p) {
        return p.contains("$") || p.contains("$( ") || p.contains("`");
    }
}
