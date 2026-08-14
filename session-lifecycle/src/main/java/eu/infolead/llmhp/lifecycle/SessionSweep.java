// SessionStart sweep: archive stale per-session files left by crashed sessions.
// Driver: γ_lifecycle-event + γ_crash-resilience — the session.end hook normally
// archives + prunes, but a crash leaves <session>.{tsv,tsv.lock,commits.start,
// commits.end} orphaned. This sweep, run at each session start, moves stale files
// (untouched for STALE_HOURS) into the existing archive/<YYYY-MM>/<session>/ tree,
// which carries its own 30-day retention. Backup, not deletion: nothing is dropped.
//
// Invoked: session-lifecycle sweep <project-dir>

import module java.base;

class SessionSweep {

    private static final int STALE_HOURS = 24;

void main() {
    try {
        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        var sessionsDir = Path.of(dir, "tmp", "sessions");
        if (!Files.exists(sessionsDir)) return;

        var cutoff = Instant.now().minus(Duration.ofHours(STALE_HOURS));
        try (var stream = Files.list(sessionsDir)) {
            for (var file : (Iterable<Path>) stream::iterator) {
                if (!Files.isRegularFile(file)) continue;
                var name = file.getFileName().toString();
                if (!isSessionFile(name)) continue;
                if (Files.getLastModifiedTime(file).toInstant().isAfter(cutoff)) continue;
                archive(sessionsDir, name);
            }
        }
    } catch (Throwable t) {
        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        HookErrorLog.report(dir, "SessionSweep", t);
    }
}

/** A per-session scratch file (not hook-errors.log, not archive/, not .breakers/). */
boolean isSessionFile(String name) {
    return name.endsWith(".tsv") || name.endsWith(".tsv.lock")
        || name.endsWith(".commits.start") || name.endsWith(".commits.end");
}

/** Move the file into the current month's archive dir under its session id. */
void archive(Path sessionsDir, String name) throws IOException {
    var sessionId = sessionIdOf(name);
    var month = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM"));
    var archiveDir = sessionsDir.resolve("archive").resolve(month).resolve(sessionId);
    Files.createDirectories(archiveDir);
    Files.move(sessionsDir.resolve(name), archiveDir.resolve(name),
        StandardCopyOption.REPLACE_EXISTING);
}

String sessionIdOf(String name) {
    if (name.endsWith(".tsv.lock")) return name.substring(0, name.length() - ".tsv.lock".length());
    if (name.endsWith(".tsv")) return name.substring(0, name.length() - ".tsv".length());
    if (name.endsWith(".commits.start")) return name.substring(0, name.length() - ".commits.start".length());
    if (name.endsWith(".commits.end")) return name.substring(0, name.length() - ".commits.end".length());
    return name;
}

}
