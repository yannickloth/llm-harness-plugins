// SessionStart/PostToolUse: verify auto-mode gate access via circuit breaker.
// Wire-in #5 from claude-code-features.md — auto-mode gates.
// Returns a transform function applied against fresh context to prevent
// async stale-snapshot races. Mirrors Claude Code's verifyAutoModeGateAccess.

import eu.infolead.llmhp.shared.CircuitBreaker;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Function;

class AutoModeGate {

void main() {
    var subcommand = arg(0, "check");
    var projectDir = arg(1, System.getProperty("user.dir"));
    var persistDir = Path.of(projectDir, "tmp", "sessions", ".breakers");

    try { Files.createDirectories(persistDir); } catch (IOException ignored) {}

    switch (subcommand) {
        case "check" -> check(persistDir);
        case "disable" -> disable(persistDir);
        case "reset" -> reset(persistDir);
        case "status" -> status(persistDir);
        default -> { System.err.println("auto-mode-gate: unknown subcommand: " + subcommand); System.exit(1); }
    }
}

private static String arg(int idx, String fallback) {
    var raw = System.getProperty("sun.java.command", "");
    var parts = raw.split("\\s+");
    if (parts.length > idx) return parts[idx];
    return fallback;
}

static CircuitBreaker<String> gateBreaker(Path persistDir) {
    return CircuitBreaker.loadOrFresh(
        persistDir, "auto-mode-gate",
        1, 3,  // 1 consecutive trigger, 3 total — aggressive for safety
        ctx -> ctx + " [AUTO-MODE-GATE: stripped dangerous permissions]",
        Function.identity());
}

void check(Path persistDir) {
    var b = gateBreaker(persistDir);
    System.out.printf("{\"tripped\":%s,\"safe\":%s}%n",
        b.state().tripped(), !b.state().tripped());
}

void disable(Path persistDir) {
    var b = gateBreaker(persistDir);
    b.recordFailure();
    try { b.save(persistDir); } catch (IOException ignored) {}
    System.out.println("{\"status\":\"disabled\",\"tripped\":true}");
}

void reset(Path persistDir) {
    var b = gateBreaker(persistDir);
    b.reset(30 * 60 * 1000);  // 30-minute cooldown
    try { b.save(persistDir); } catch (IOException ignored) {}
    System.out.println("{\"status\":\"reset\",\"cooldownSecs\":1800}");
}

void status(Path persistDir) {
    var b = gateBreaker(persistDir);
    var state = b.state();
    System.out.printf("""
        {"tripped":%s,"consecutive":%d,"total":%d,"maxConsecutive":%d,"maxTotal":%d}
        """.strip(),
        state.tripped(), state.consecutiveFailures(), state.totalFailures(),
        b.consecutiveMax(), b.totalMax());
}

}
