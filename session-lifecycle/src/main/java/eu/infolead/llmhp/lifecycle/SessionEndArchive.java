// SessionEnd hook: archive this session's logs and prune old archives.
// Drivers: γ_log-format-edits + γ_lifecycle-event.
// Moves tmp/sessions/<session_id>.{tsv,tsv.lock,commits.start,commits.end}
// into tmp/sessions/archive/<YYYY-MM>/<session_id>/.
// Prunes archived sessions older than RETENTION_DAYS.
// Errors → tmp/sessions/hook-errors.log; always exit 0.

import module java.base;

class SessionEndArchive {

private static final int RETENTION_DAYS = 30;

void main() {
    try {
        var json = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        var sessionId = extractString(json, "session_id").orElse(null);
        if (sessionId == null) return;

        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        var sessionsDir = Path.of(dir, "tmp", "sessions");
        if (!Files.exists(sessionsDir)) return;

        archive(sessionsDir, sessionId);
        prune(sessionsDir);
    } catch (Throwable t) {
        report("SessionEndArchive", t);
    }
}

void archive(Path sessionsDir, String sessionId) throws IOException {
    var month = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM"));
    var archiveDir = sessionsDir.resolve("archive").resolve(month).resolve(sessionId);
    boolean moved = false;

    try (var stream = Files.list(sessionsDir)) {
        for (var file : (Iterable<Path>) stream::iterator) {
            var name = file.getFileName().toString();
            if (!name.startsWith(sessionId + ".") || !Files.isRegularFile(file)) continue;
            if (!moved) { Files.createDirectories(archiveDir); moved = true; }
            Files.move(file, archiveDir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        }
    }
}

void prune(Path sessionsDir) throws IOException {
    var archiveRoot = sessionsDir.resolve("archive");
    if (!Files.exists(archiveRoot)) return;
    var cutoff = Instant.now().minus(RETENTION_DAYS, ChronoUnit.DAYS);

    try (var months = Files.list(archiveRoot)) {
        for (var monthDir : (Iterable<Path>) months::iterator) {
            if (!Files.isDirectory(monthDir)) continue;
            try (var sessions = Files.list(monthDir)) {
                for (var sessionDir : (Iterable<Path>) sessions::iterator) {
                    if (!Files.isDirectory(sessionDir)) continue;
                    if (Files.getLastModifiedTime(sessionDir).toInstant().isBefore(cutoff)) {
                        deleteRecursively(sessionDir);
                    }
                }
            }
            try (var remaining = Files.list(monthDir)) {
                if (remaining.findAny().isEmpty()) Files.delete(monthDir);
            }
        }
    }
}

void deleteRecursively(Path path) throws IOException {
    if (!Files.exists(path)) return;
    try (var stream = Files.walk(path)) {
        stream.sorted(Comparator.reverseOrder()).forEach(p -> {
            try { Files.deleteIfExists(p); } catch (IOException ignored) {}
        });
    }
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
