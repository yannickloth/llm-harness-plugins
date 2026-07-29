package eu.infolead.llmhp.router;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.time.Instant;
import java.util.UUID;

final class BudgetTracker {

    static final long DEFAULT_CEILING = 500_000L;
    private static final String ENV_CEILING = "TIER_ROUTER_BUDGET_CEILING";

    static long readCeiling() {
        var env = System.getenv(ENV_CEILING);
        if (env != null && !env.isBlank()) {
            try {
                return Long.parseLong(env.strip());
            } catch (NumberFormatException e) {
                System.err.println("[budget] Invalid " + ENV_CEILING + "='" + env + "'; using default " + DEFAULT_CEILING);
            }
        }
        return DEFAULT_CEILING;
    }

    static Path sessionFile(Path metricsDir, String sessionId) {
        return metricsDir.resolve(".sessions").resolve(sessionId + ".json");
    }

    static BudgetState load(Path metricsDir, String sessionId) throws IOException {
        var file = sessionFile(metricsDir, sessionId);
        if (!Files.exists(file)) return BudgetState.fresh(sessionId, readCeiling());
        var raw = Files.readString(file).strip();
        return parse(raw, sessionId);
    }

    static BudgetState loadOrFresh(Path metricsDir, String sessionId) {
        try {
            return load(metricsDir, sessionId);
        } catch (IOException e) {
            var ceiling = readCeiling();
            System.err.println("[budget] Load failed for " + sessionId + ": " + e.getMessage() + "; fresh start with " + ceiling);
            return BudgetState.fresh(sessionId, ceiling);
        }
    }

    static void save(Path metricsDir, BudgetState state) throws IOException {
        var sessionsDir = metricsDir.resolve(".sessions");
        Files.createDirectories(sessionsDir);
        var target = sessionFile(metricsDir, state.sessionId());

        var tmpDir = sessionsDir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("%s.%s".formatted(state.sessionId(), UUID.randomUUID()));

        Files.writeString(tmpFile, toJson(state));
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
            ch.force(true);
        }
        Files.move(tmpFile, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    static BudgetState accumulate(BudgetState state, long tokens) {
        if (tokens < 0) throw new IllegalArgumentException("tokens must be non-negative, got: " + tokens);
        var ceiling = state.ceiling();
        var newTotal = state.tokensUsed() + tokens;
        var exhausted = newTotal >= ceiling;
        return new BudgetState(state.sessionId(), newTotal, ceiling, state.startTime(), exhausted);
    }

    static boolean isExhausted(BudgetState state) {
        return state.exhausted() || state.tokensUsed() >= state.ceiling();
    }

    static String toJson(BudgetState state) {
        var escapedSessionId = state.sessionId()
            .replace("\\", "\\\\")
            .replace("\"", "\\\"");
        return """
            {"sessionId":"%s","tokensUsed":%d,"ceiling":%d,"startTime":"%s","exhausted":%s}
            """.formatted(
            escapedSessionId,
            state.tokensUsed(),
            state.ceiling(),
            state.startTime().toString(),
            state.exhausted()
        );
    }

    static BudgetState parse(String json, String sessionId) {
        long tokensUsed = 0;
        long ceiling = DEFAULT_CEILING;
        var startTime = Instant.now();
        boolean exhausted = false;

        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            return BudgetState.fresh(sessionId, DEFAULT_CEILING);
        }
        var inner = trimmed.substring(1, trimmed.length() - 1);
        for (var pair : inner.split(",")) {
            var kv = pair.split(":", 2);
            if (kv.length < 2) continue;
            var key = kv[0].strip().replace("\"", "");
            var val = kv[1].strip().replace("\"", "").strip();
            switch (key) {
                case "tokensUsed" -> tokensUsed = Long.parseLong(val);
                case "ceiling" -> ceiling = Long.parseLong(val);
                case "startTime" -> startTime = Instant.parse(val);
                case "exhausted" -> exhausted = Boolean.parseBoolean(val);
            }
        }
        return new BudgetState(sessionId, tokensUsed, ceiling, startTime, exhausted);
    }
}
