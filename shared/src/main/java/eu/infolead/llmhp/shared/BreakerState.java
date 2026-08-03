package eu.infolead.llmhp.shared;

import java.time.Instant;

public record BreakerState(
    String breakerId,
    int consecutiveFailures,
    int totalFailures,
    int totalActivations,
    boolean tripped,
    Instant lastChange,
    Instant createdAt,
    Instant resetAt
) {
    static BreakerState fresh(String breakerId) {
        var now = Instant.now();
        return new BreakerState(breakerId, 0, 0, 0, false, now, now, null);
    }

    BreakerState recordFailure(int consecutiveMax, int totalMax) {
        var con = consecutiveFailures + 1;
        var tot = totalFailures + 1;
        var tripped = con >= consecutiveMax || tot >= totalMax;
        return new BreakerState(breakerId, con, tot, totalActivations, tripped, Instant.now(), createdAt, resetAt);
    }

    BreakerState reset() {
        return new BreakerState(breakerId, 0, 0, totalActivations, false, Instant.now(), createdAt, Instant.now());
    }

    BreakerState resetFailuresKeepTripState() {
        return new BreakerState(breakerId, 0, totalFailures, totalActivations, tripped, Instant.now(), createdAt, resetAt);
    }
}
