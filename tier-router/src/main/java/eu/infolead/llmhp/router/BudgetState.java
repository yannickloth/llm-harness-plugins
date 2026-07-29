package eu.infolead.llmhp.router;

import java.time.Instant;

record BudgetState(
    String sessionId,
    long tokensUsed,
    long ceiling,
    Instant startTime,
    boolean exhausted
) {
    static BudgetState fresh(String sessionId, long ceiling) {
        return new BudgetState(sessionId, 0, ceiling, Instant.now(), false);
    }
}
