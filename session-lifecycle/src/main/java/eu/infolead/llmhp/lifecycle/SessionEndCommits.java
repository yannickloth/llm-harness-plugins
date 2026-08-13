// SessionEnd hook: compute commits made during this session by diffing current
// git log against the snapshot taken at SessionStart.
// Drivers: γ_commit-log-format + γ_lifecycle-event.
// Output: tmp/sessions/<session_id>.commits.end
//   line 1: start_branch -> end_branch
//   lines 2..N: <SHA>\t<unix-ts>\t<subject>   (commits not present at session start)
// Errors → tmp/sessions/hook-errors.log; always exit 0.

import module java.base;

class SessionEndCommits {

void main() {
    try {
        var json = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        var sessionId = extractString(json, "session_id").orElse("unknown");

        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        var projectDir = Path.of(dir);
        var sessionsDir = projectDir.resolve("tmp/sessions");
        var startFile = sessionsDir.resolve(sessionId + ".commits.start");
        if (!Files.exists(startFile)) return;  // no baseline; nothing to diff against.

        var startLines = Files.readAllLines(startFile, StandardCharsets.UTF_8);
        if (startLines.isEmpty()) return;
        var startBranch = startLines.getFirst();
        var startShas = startLines.stream()
            .skip(1)
            .map(l -> l.split("\t", 2)[0])
            .collect(Collectors.toCollection(HashSet::new));

        var endBranch = run(projectDir, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
        // Walk newest-first; stop at the first commit already in the start snapshot.
        // That gives exactly the commits added during the session, even when the
        // session produced more commits than the snapshot's window.
        var log = run(projectDir, "git", "log", "-n", "500",
            "--format=%H%x09%ct%x09%s", "HEAD");
        var newCommits = new StringBuilder();
        for (var line : (Iterable<String>) log.lines()::iterator) {
            var sha = line.split("\t", 2)[0];
            if (startShas.contains(sha)) break;
            if (!newCommits.isEmpty()) newCommits.append("\n");
            newCommits.append(line);
        }

        var header = startBranch + " -> " + endBranch;
        var content = newCommits.isEmpty()
            ? header + "\n"
            : header + "\n" + newCommits + "\n";
        Files.writeString(sessionsDir.resolve(sessionId + ".commits.end"), content,
            StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
    } catch (Throwable t) {
        report("SessionEndCommits", t);
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

}
