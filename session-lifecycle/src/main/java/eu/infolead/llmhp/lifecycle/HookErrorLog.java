// Shared, size-capped, rotating error log for all session-lifecycle hooks.
// Driver: γ_error-policy — hooks surface errors without letting tmp/sessions
// grow unbounded, and preserve history via compressed rotation rather than
// dropping bytes.
//
// Logrotate semantics:
//   hook-errors.log          -> live file, appended, capped at MAX_BYTES
//   hook-errors.log.1.gz     -> rotated + gzip-compressed (newest rotation)
//   hook-errors.log.2.gz     -> older
//   ... up to MAX_ROTATIONS
// Writers: LogFileChange, SessionStartCommits, SessionEndCommits,
// SessionEndArchive.

import module java.base;

class HookErrorLog {

    static final long MAX_BYTES = 1024 * 1024;   // 1 MiB live cap before rotate
    static final int MAX_ROTATIONS = 3;          // keep 3 compressed archives

    /** Append a block; rotate + compress when the live file would exceed MAX_BYTES. */
    static void report(String projectDir, String origin, Throwable t) {
        try {
            var dir = projectDir;
            if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
            var sessionsDir = Path.of(dir, "tmp", "sessions");
            Files.createDirectories(sessionsDir);
            var log = sessionsDir.resolve("hook-errors.log");

            var sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            var block = ("=== " + Instant.now() + " === " + origin + "\n" + sw + "\n")
                .getBytes(StandardCharsets.UTF_8);

            long size = Files.exists(log) ? Files.size(log) : 0L;
            if (size + block.length > MAX_BYTES) rotate(sessionsDir);

            Files.write(log, block,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Throwable ignored) {}
    }

    /** Shift existing rotations down and compress the current log into the newest slot. */
    private static void rotate(Path sessionsDir) throws Exception {
        var log = sessionsDir.resolve("hook-errors.log");
        if (!Files.exists(log)) return;

        // Drop the oldest rotation first, then shift .N.gz -> .(N+1).gz.
        Files.deleteIfExists(sessionsDir.resolve("hook-errors.log." + MAX_ROTATIONS + ".gz"));
        for (int i = MAX_ROTATIONS - 1; i >= 1; i--) {
            var src = sessionsDir.resolve("hook-errors.log." + i + ".gz");
            if (!Files.exists(src)) continue;
            Files.move(src, sessionsDir.resolve("hook-errors.log." + (i + 1) + ".gz"),
                StandardCopyOption.REPLACE_EXISTING);
        }

        // Compress current log into .1.gz, then truncate live file.
        var target = sessionsDir.resolve("hook-errors.log.1.gz");
        try (var in = Files.newInputStream(log);
             var gz = new GZIPOutputStream(Files.newOutputStream(target,
                 StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING))) {
            in.transferTo(gz);
        }
        Files.deleteIfExists(log);
    }
}
