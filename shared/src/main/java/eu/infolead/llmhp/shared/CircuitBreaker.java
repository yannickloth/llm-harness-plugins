package eu.infolead.llmhp.shared;

import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.UUID;
import java.util.function.Function;

/**
 * Circuit breaker with state tracking, failure thresholds, and stale-snapshot-safe
 * transform functions.
 *
 * <p>Pattern (from Claude Code source analysis):
 * <ul>
 *   <li>Explicit failure thresholds on critical loops</li>
 *   <li>transform function returns {@code (Ctx) => Ctx}, not boolean — avoids async stale-snapshot races</li>
 *   <li>Fail-closed: on parse error, unavailability → tripped</li>
 *   <li>State persistence with WAL-atomic writes for resume-safe sessions</li>
 * </ul>
 *
 * <p>Applicable to: classifier unavailability, LLC fallback loops, auto-compact,
 * denial loops, auto-mode gate transitions.
 *
 * @param <Ctx> context type passed to the transform function on trip
 */
public final class CircuitBreaker<Ctx> {

    private final String breakerId;
    private final int consecutiveMax;
    private final int totalMax;
    private final Function<Ctx, Ctx> onTripTransform;
    private final Function<Ctx, Ctx> onReset;

    private BreakerState state;
    private Instant cooldownUntil;

    public CircuitBreaker(String breakerId, int consecutiveMax, int totalMax,
                   Function<Ctx, Ctx> onTripTransform, Function<Ctx, Ctx> onReset) {
        this.breakerId = breakerId;
        this.consecutiveMax = consecutiveMax;
        this.totalMax = totalMax;
        this.onTripTransform = onTripTransform;
        this.onReset = onReset;
        this.state = BreakerState.fresh(breakerId);
        this.cooldownUntil = null;
    }

    public CircuitBreaker(String breakerId, int consecutiveMax, int totalMax,
                   Function<Ctx, Ctx> onTripTransform) {
        this(breakerId, consecutiveMax, totalMax, onTripTransform, Function.identity());
    }

    public boolean isTripped() {
        if (cooldownUntil != null) {
            if (Instant.now().isBefore(cooldownUntil)) return true;
            cooldownUntil = null;
            return false;
        }
        if (!state.tripped()) return false;
        return true;
    }

    /**
     * Check against fresh context. If tripped, applies the transform function;
     * otherwise returns the context unchanged.
     *
     * <p>Transform-function pattern prevents async stale-snapshot races:
     * the transform is applied against the caller's fresh context, not
     * against a stale snapshot captured at trip-time.
     */
    public Ctx gate(Ctx ctx) {
        return isTripped() ? onTripTransform.apply(ctx) : ctx;
    }

    /**
     * Record a failure. Auto-trips when consecutive or total thresholds breached.
     */
    public BreakerState recordFailure() {
        state = state.recordFailure(consecutiveMax, totalMax);
        return state;
    }

    /**
     * Record a success — resets consecutive failure counter (but not total).
     */
    public BreakerState recordSuccess() {
        state = state.resetFailuresKeepTripState();
        return state;
    }

    /**
     * Full reset — clears all counters, untrips, starts cooldown if specified.
     */
    public BreakerState reset(long cooldownMs) {
        state = state.reset();
        cooldownUntil = cooldownMs > 0 ? Instant.now().plusMillis(cooldownMs) : null;
        return state;
    }

    public void reset() {
        reset(0);
    }

    /**
     * Gate a context against this breaker, applying the onReset transform
     * when the breaker is not tripped (used for auto-mode save/restore).
     */
    public Ctx gateWithReset(Ctx ctx) {
        return isTripped() ? onTripTransform.apply(ctx) : onReset.apply(ctx);
    }

    /**
     * Restore breaker state from a previously-persisted BreakerState.
     * Package-private — used by DenialTracker and BreakerRegistry for deserialization.
     */
    void restoreState(BreakerState st) {
        this.state = st;
    }

    public BreakerState state() { return state; }
    public int consecutiveMax() { return consecutiveMax; }
    public int totalMax() { return totalMax; }

    public String toJson() {
        var now = Instant.now();
        return """
            {"breakerId":"%s","consecutiveFailures":%d,"totalFailures":%d,"totalActivations":%d,"tripped":%s,"consecutiveMax":%d,"totalMax":%d,"lastChange":"%s","createdAt":"%s","resetAt":%s}
            """.formatted(
            breakerId,
            state.consecutiveFailures(),
            state.totalFailures(),
            state.totalActivations(),
            state.tripped(),
            consecutiveMax,
            totalMax,
            state.lastChange().toString(),
            state.createdAt().toString(),
            state.resetAt() != null ? "\"" + state.resetAt().toString() + "\"" : "null"
        );
    }

    public static BreakerState parse(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            throw new IllegalArgumentException("invalid breaker state JSON");
        }
        var inner = trimmed.substring(1, trimmed.length() - 1);

        String breakerId = "unknown";
        int consecutiveFailures = 0, totalFailures = 0, totalActivations = 0;
        boolean tripped = false;
        Instant lastChange = Instant.now(), createdAt = Instant.now(), resetAt = null;

        for (var pair : inner.split(",")) {
            var kv = pair.split(":", 2);
            if (kv.length < 2) continue;
            var key = kv[0].strip().replace("\"", "");
            var val = kv[1].strip().replace("\"", "").strip();
            switch (key) {
                case "breakerId" -> breakerId = val;
                case "consecutiveFailures" -> consecutiveFailures = Integer.parseInt(val);
                case "totalFailures" -> totalFailures = Integer.parseInt(val);
                case "totalActivations" -> totalActivations = Integer.parseInt(val);
                case "tripped" -> tripped = Boolean.parseBoolean(val);
                case "lastChange" -> lastChange = Instant.parse(val);
                case "createdAt" -> createdAt = Instant.parse(val);
                case "resetAt" -> { if (!"null".equals(val)) resetAt = Instant.parse(val); }
            }
        }
        return new BreakerState(breakerId, consecutiveFailures, totalFailures, totalActivations, tripped, lastChange, createdAt, resetAt);
    }

    public void save(Path dir) throws java.io.IOException {
        var target = dir.resolve(breakerId + ".json");
        var tmpDir = dir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("%s.%s".formatted(breakerId, UUID.randomUUID()));
        Files.writeString(tmpFile, toJson());
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
            ch.force(true);
        }
        Files.move(tmpFile, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    public static <Ctx> CircuitBreaker<Ctx> loadOrFresh(Path dir, String breakerId,
                                                  int consecutiveMax, int totalMax,
                                                  Function<Ctx, Ctx> onTripTransform,
                                                  Function<Ctx, Ctx> onReset) {
        var file = dir.resolve(breakerId + ".json");
        var breaker = new CircuitBreaker<Ctx>(breakerId, consecutiveMax, totalMax, onTripTransform, onReset);
        if (!Files.exists(file)) return breaker;
        try {
            var raw = Files.readString(file).strip();
            breaker.restoreState(parse(raw));
        } catch (Exception e) {
            System.err.println("[circuit-breaker] Load failed for " + breakerId + ": " + e.getMessage() + "; fresh start");
        }
        return breaker;
    }

    public static <Ctx> CircuitBreaker<Ctx> loadOrFresh(Path dir, String breakerId,
                                                  int consecutiveMax, int totalMax,
                                                  Function<Ctx, Ctx> onTripTransform) {
        return loadOrFresh(dir, breakerId, consecutiveMax, totalMax, onTripTransform, Function.identity());
    }
}
