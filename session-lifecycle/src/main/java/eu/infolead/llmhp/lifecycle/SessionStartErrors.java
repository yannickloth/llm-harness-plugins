// SessionStart hook: surface accumulated hook errors to the assistant.
// Drivers: γ_error-policy + γ_lifecycle-event.
// If tmp/sessions/hook-errors.log is non-empty, print a summary on stdout
// (Claude Code surfaces SessionStart stdout as additional context).
// Always exits 0.

import module java.base;

void main() {
    try {
        var dir = System.getenv("CLAUDE_PROJECT_DIR");
        if (dir == null || dir.isBlank()) dir = System.getProperty("user.dir");
        var log = Path.of(dir, "tmp", "sessions", "hook-errors.log");
        if (!Files.exists(log) || Files.size(log) == 0) return;

        var content = Files.readString(log, StandardCharsets.UTF_8);
        var blocks = java.util.Arrays.stream(content.split("(?m)^=== "))
            .filter(b -> !b.isBlank())
            .toList();
        if (blocks.isEmpty()) return;

        var tail = blocks.subList(Math.max(0, blocks.size() - 3), blocks.size());
        var preview = tail.stream()
            .map(b -> "=== " + b.lines().limit(20).collect(Collectors.joining("\n")))
            .collect(Collectors.joining("\n\n"));

        System.out.println("⚠ " + blocks.size() + " hook error(s) recorded in tmp/sessions/hook-errors.log.");
        System.out.println("Most recent (up to 3):");
        System.out.println();
        System.out.println(preview);
    } catch (Throwable ignored) {}
}
