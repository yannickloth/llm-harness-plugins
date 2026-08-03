// SessionStart hook: snapshot the current git state so SessionEnd can compute
// the commits made during this session.
// Drivers: γ_commit-log-format + γ_lifecycle-event.
// Output: tmp/sessions/<session_id>.commits.start
//   line 1: <branch>
//   lines 2..N: <SHA>\t<unix-ts>\t<subject>   (last 50 commits, HEAD-first)
// Errors → tmp/sessions/hook-errors.log; always exit 0.

import module java.base;

void main() {
    try {
        var json = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        var sessionId = extractString(json, "session_id").orElse("unknown");

        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        var projectDir = Path.of(dir);
        var sessionsDir = projectDir.resolve("tmp/sessions");
        Files.createDirectories(sessionsDir);

        var branch = run(projectDir, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
        var log = run(projectDir, "git", "log", "-n", "50",
            "--format=%H%x09%ct%x09%s", "HEAD");

        var out = sessionsDir.resolve(sessionId + ".commits.start");
        Files.writeString(out, branch + "\n" + log,
            StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
    } catch (Throwable t) {
        report("SessionStartCommits", t);
    }
}

String run(Path cwd, String... cmd) throws IOException, InterruptedException {
    var p = new ProcessBuilder(cmd).directory(cwd.toFile()).redirectErrorStream(true).start();
    var output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    if (!p.waitFor(5, TimeUnit.SECONDS)) {
        p.destroyForcibly();
        throw new IOException("git command timed out: " + String.join(" ", cmd));
    }
    if (p.exitValue() != 0) {
        throw new IOException("git command failed (" + p.exitValue() + "): "
            + String.join(" ", cmd) + "\n" + output);
    }
    return output;
}

Optional<String> extractString(String json, String key) {
    var m = Pattern.compile(
        "\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"").matcher(json);
    return m.find() ? Optional.of(m.group(1)) : Optional.empty();
}

void report(String origin, Throwable t) {
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
