package eu.infolead.llmhp.shared;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Function;

/**
 * Tracks tool-use denial events in a session.
 *
 * <p>Mirrors Claude Code {@code denialTracking.ts}:
 * <ul>
 *   <li>3 consecutive denials → prompt user or {@code AbortError}</li>
 *   <li>20 total denials → hard abort</li>
 *   <li>WAL-atomic persistence per session for resume-safety</li>
 *   <li>Transform-function return on abort: {@code (ctx) => ctx} applied against fresh context</li>
 * </ul>
 *
 * @param <Ctx> context type passed to the abort transform
 */
public final class DenialTracker<Ctx> {

    public static final int DEFAULT_CONSECUTIVE_MAX = 3;
    public static final int DEFAULT_TOTAL_MAX = 20;

    final CircuitBreaker<Ctx> breaker;

    public DenialTracker(String sessionId, int consecutiveMax, int totalMax,
                  Function<Ctx, Ctx> onAbort) {
        this.breaker = new CircuitBreaker<>("denial-" + sessionId, consecutiveMax, totalMax, onAbort);
    }

    public DenialTracker(String sessionId, Function<Ctx, Ctx> onAbort) {
        this(sessionId, DEFAULT_CONSECUTIVE_MAX, DEFAULT_TOTAL_MAX, onAbort);
    }

    public static <Ctx> DenialTracker<Ctx> create(String sessionId, Function<Ctx, Ctx> onAbort) {
        return new DenialTracker<>(sessionId, onAbort);
    }

    public boolean recordDenial() {
        var wasTripped = breaker.isTripped();
        breaker.recordFailure();
        return !wasTripped && breaker.isTripped();
    }

    public void recordAllow() {
        breaker.recordSuccess();
    }

    public Ctx gate(Ctx ctx) {
        return breaker.gate(ctx);
    }

    public boolean isAborted() {
        return breaker.isTripped();
    }

    public BreakerState state() { return breaker.state(); }
    public int consecutiveDenials() { return breaker.state().consecutiveFailures(); }
    public int totalDenials() { return breaker.state().totalFailures(); }

    public String toJson() {
        return breaker.toJson();
    }

    public static <Ctx> DenialTracker<Ctx> loadOrFresh(Path dir, String sessionId,
                                                  int consecutiveMax, int totalMax,
                                                  Function<Ctx, Ctx> onAbort) {
        var tracker = new DenialTracker<Ctx>(sessionId, consecutiveMax, totalMax, onAbort);
        var file = dir.resolve("denial-" + sessionId + ".json");
        if (!Files.exists(file)) return tracker;
        try {
            var raw = Files.readString(file).strip();
            tracker.breaker.restoreState(CircuitBreaker.parse(raw));
        } catch (Exception e) {
            System.err.println("[denial-tracker] Load failed for " + sessionId + ": " + e.getMessage() + "; fresh start");
        }
        return tracker;
    }

    public void save(Path dir) throws java.io.IOException {
        breaker.save(dir);
    }
}
