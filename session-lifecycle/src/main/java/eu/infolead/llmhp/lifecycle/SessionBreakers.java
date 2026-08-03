// SessionStart/PostToolUse: track auto-compact failure counts via CircuitBreaker.
// Wire-in #3 from claude-code-features.md — auto-compact breaker.
// After 3 consecutive compaction failures, stop compacting, keep original.
// Written as a single-file main entry via SessionLifecycle dispatch.

import module java.base;

import eu.infolead.llmhp.shared.CircuitBreaker;
import java.nio.file.Files;
import java.nio.file.Path;

void main() {
    var subcommand = arg(0, "record");
    var projectDir = arg(1, System.getProperty("user.dir"));
    var persistDir = Path.of(projectDir, "tmp", "sessions", ".breakers");

    try { Files.createDirectories(persistDir); } catch (IOException ignored) {}

    switch (subcommand) {
        case "fail" -> recordFail(persistDir);
        case "success" -> recordSuccess(persistDir);
        case "check" -> check(persistDir);
        case "reset" -> reset(persistDir);
        default -> { System.err.println("session-breakers: unknown subcommand: " + subcommand); System.exit(1); }
    }
}

private static String arg(int idx, String fallback) {
    var raw = System.getProperty("sun.java.command", "");
    var parts = raw.split("\\s+");
    if (parts.length > idx) return parts[idx];
    return fallback;
}

static CircuitBreaker<String> breaker(Path persistDir) {
    return CircuitBreaker.loadOrFresh(
        persistDir, "auto-compact",
        3, 50,  // 3 consecutive failures max, 50 total
        ctx -> "[BREAKER-TRIPPED: auto-compact failures — keeping original]");
}

void recordFail(Path persistDir) {
    var b = breaker(persistDir);
    b.recordFailure();
    var state = b.state();
    try { b.save(persistDir); } catch (IOException ignored) {}
    System.out.printf(
        "{\"tripped\":%s,\"consecutive\":%d,\"total\":%d,\"maxConsecutive\":%d,\"maxTotal\":%d}%n",
        state.tripped(), state.consecutiveFailures(), state.totalFailures(),
        b.consecutiveMax(), b.totalMax());
}

void recordSuccess(Path persistDir) {
    var b = breaker(persistDir);
    b.recordSuccess();
    var state = b.state();
    try { b.save(persistDir); } catch (IOException ignored) {}
    System.out.printf(
        "{\"tripped\":%s,\"consecutive\":%d,\"total\":%d}%n",
        state.tripped(), state.consecutiveFailures(), state.totalFailures());
}

void check(Path persistDir) {
    var b = breaker(persistDir);
    var state = b.state();
    System.out.printf(
        "{\"tripped\":%s,\"consecutive\":%d,\"total\":%d,\"maxConsecutive\":%d,\"maxTotal\":%d}%n",
        state.tripped(), state.consecutiveFailures(), state.totalFailures(),
        b.consecutiveMax(), b.totalMax());
}

void reset(Path persistDir) {
    var b = breaker(persistDir);
    b.reset();
    try { b.save(persistDir); } catch (IOException ignored) {}
    System.out.println("{\"status\":\"reset\"}");
}
