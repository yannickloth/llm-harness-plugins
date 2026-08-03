// PostToolUse hook: append a timestamped row per file edit.
// Drivers: γ_payload-shape (Claude Code stdin JSON), γ_log-format-edits (TSV layout).
// Output: tmp/sessions/<session_id>.tsv — one line per edit: <ISO-8601 ts>\t<absolute file path>
// Errors → tmp/sessions/hook-errors.log; always exit 0.

import module java.base;

void main() {
    try {
        var json = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        var sessionId = extractString(json, "session_id").orElse("unknown");
        var filePath = extractNestedString(json, "tool_input", "file_path")
            .or(() -> extractNestedString(json, "tool_input", "path"))
            .orElse(null);
        if (filePath == null) return;

        var sessionsDir = sessionsDir();
        Files.createDirectories(sessionsDir);
        var logFile = sessionsDir.resolve(sessionId + ".tsv");
        var lockFile = sessionsDir.resolve(sessionId + ".tsv.lock");
        var line = Instant.now() + "\t" + filePath + "\n";

        try (var raf = new RandomAccessFile(lockFile.toFile(), "rw");
             var _ = raf.getChannel().lock()) {
            Files.writeString(logFile, line,
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        }
    } catch (Throwable t) {
        ErrorReporter.report("LogFileChange", t);
    }
}

Path sessionsDir() {
    var dir = System.getenv("CLAUDE_PROJECT_DIR");
    if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
    return Path.of(dir, "tmp", "sessions");
}

Optional<String> extractString(String json, String key) {
    var m = Pattern.compile(
        "\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"").matcher(json);
    return m.find() ? Optional.of(m.group(1).replace("\\\"", "\"").replace("\\\\", "\\")) : Optional.empty();
}

Optional<String> extractNestedString(String json, String outer, String inner) {
    var m = Pattern.compile("\"" + Pattern.quote(outer) + "\"\\s*:\\s*\\{").matcher(json);
    if (!m.find()) return Optional.empty();
    int depth = 1, i = m.end(), start = i;
    while (i < json.length() && depth > 0) {
        char c = json.charAt(i);
        if (c == '"') {
            i++;
            while (i < json.length()) {
                char sc = json.charAt(i);
                if (sc == '\\' && i + 1 < json.length()) { i += 2; continue; }
                if (sc == '"') break;
                i++;
            }
        } else if (c == '{') depth++;
        else if (c == '}') depth--;
        i++;
    }
    return extractString(json.substring(start, Math.max(start, i - 1)), inner);
}

static class ErrorReporter {
    static void report(String origin, Throwable t) {
        try {
            var dir = System.getenv("CLAUDE_PROJECT_DIR");
            if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
            var log = Path.of(dir, "tmp", "sessions", "hook-errors.log");
            Files.createDirectories(log.getParent());
            var sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            Files.writeString(log,
                "=== " + Instant.now() + " === " + origin + "\n" + sw + "\n",
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Throwable ignored) {}
    }
}
