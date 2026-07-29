package eu.infolead.llmhp.router;

import java.nio.file.Path;

/**
 * CLI for tier-router engine. Invoked by OpenCode/Claude Code/Pi plugins via shell.
 */
final class RouterCli {

    private static final RouterEngine engine = new RouterEngine();

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: RouterCli <classify|route|rewrite|ambiguity|budget-check|budget-accumulate|budget-reset|memory-load|memory-extract> [args...]");
            System.exit(1);
            return;
        }

        var cmd = args[0];
        switch (cmd) {
            case "classify" -> classify();
            case "route" -> route();
            case "rewrite" -> {
                if (args.length < 2) {
                    System.err.println("rewrite requires tier argument");
                    System.exit(1);
                }
                rewrite(args[1]);
            }
            case "ambiguity" -> ambiguity();
            case "budget-check" -> {
                if (args.length < 3) {
                    System.err.println("budget-check requires <session-id> <metrics-dir>");
                    System.exit(1);
                }
                budgetCheck(args[1], args[2]);
            }
            case "budget-accumulate" -> {
                if (args.length < 4) {
                    System.err.println("budget-accumulate requires <session-id> <tokens> <metrics-dir>");
                    System.exit(1);
                }
                budgetAccumulate(args[1], Long.parseLong(args[2]), args[3]);
            }
            case "budget-reset" -> {
                if (args.length < 3) {
                    System.err.println("budget-reset requires <session-id> <metrics-dir>");
                    System.exit(1);
                }
                budgetReset(args[1], args[2]);
            }
            case "memory-load" -> {
                if (args.length < 3) {
                    System.err.println("memory-load requires <agentmem-dir> <metrics-dir>");
                    System.exit(1);
                }
                memoryLoad(args[1], args[2]);
            }
            case "memory-extract" -> {
                if (args.length < 2) {
                    System.err.println("memory-extract requires <agentmem-dir>");
                    System.exit(1);
                }
                memoryExtract(args[1]);
            }
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(1);
            }
        }
    }

    private void classify() throws Exception {
        injectSignals();
        var prompt = readStdin();
        var result = engine.route(prompt);
        System.out.println(result.toJson());
    }

    private void route() throws Exception {
        injectSignals();
        var prompt = readStdin();
        var result = engine.routeWithRewrite(prompt);
        System.out.println(result.toJson());
    }

    private void injectSignals() {
        var metricsDir = System.getenv("TIER_ROUTER_METRICS_DIR");
        if (metricsDir != null && !metricsDir.isBlank()) {
            var signals = MemoryReader.loadSignals(Path.of(metricsDir));
            engine.setMemorySignals(signals);
        }
    }

    private void rewrite(String tierStr) throws Exception {
        var reformatter = new Reformatter();
        var prompt = readStdin();
        var tier = Tier.from(tierStr);
        var rewritten = reformatter.rewrite(prompt, tier);
        System.out.println(rewritten);
    }

    private void ambiguity() throws Exception {
        var reformatter = new Reformatter();
        var prompt = readStdin();
        if (reformatter.needsUserClarification(prompt)) {
            System.out.println("ambiguous:" + String.join("\n", reformatter.generateClarificationQuestions(prompt)));
        } else {
            System.out.println("clear");
        }
    }

    private void budgetCheck(String sessionId, String metricsDir) throws Exception {
        var state = BudgetTracker.loadOrFresh(Path.of(metricsDir), sessionId);
        if (BudgetTracker.isExhausted(state)) {
            var ceiling = BudgetTracker.readCeiling();
            System.out.printf(
                "{\"status\":\"exhausted\",\"tokensUsed\":%d,\"ceiling\":%d,\"sessionId\":\"%s\"}%n",
                state.tokensUsed(), ceiling, state.sessionId());
        } else {
            System.out.printf(
                "{\"status\":\"ok\",\"tokensUsed\":%d,\"ceiling\":%d,\"sessionId\":\"%s\"}%n",
                state.tokensUsed(), state.ceiling(), state.sessionId());
        }
    }

    private void budgetAccumulate(String sessionId, long tokens, String metricsDir) throws Exception {
        var state = BudgetTracker.loadOrFresh(Path.of(metricsDir), sessionId);
        var updated = BudgetTracker.accumulate(state, tokens);
        BudgetTracker.save(Path.of(metricsDir), updated);
        var wasExhausted = state.exhausted();
        System.out.printf(
            "{\"status\":\"%s\",\"tokensUsed\":%d,\"ceiling\":%d,\"newlyExhausted\":%s,\"sessionId\":\"%s\"}%n",
            updated.exhausted() ? "exhausted" : "ok",
            updated.tokensUsed(), updated.ceiling(),
            !wasExhausted && updated.exhausted(),
            updated.sessionId());
    }

    private void budgetReset(String sessionId, String metricsDir) throws Exception {
        var ceiling = BudgetTracker.readCeiling();
        var fresh = BudgetState.fresh(sessionId, ceiling);
        BudgetTracker.save(Path.of(metricsDir), fresh);
        System.out.printf(
            "{\"status\":\"reset\",\"tokensUsed\":0,\"ceiling\":%d,\"sessionId\":\"%s\"}%n",
            ceiling, sessionId);
    }

    private void memoryLoad(String agentmemDir, String metricsDir) throws Exception {
        var memDir = Path.of(agentmemDir);
        var signals = MemoryReader.extract(memDir);
        var metricsPath = Path.of(metricsDir);
        MemoryReader.saveSignals(metricsPath, signals);
        System.out.printf("{\"status\":\"loaded\",\"count\":%d,\"signals\":%s}%n",
            signals.size(), MemoryReader.toJson(signals));
    }

    private void memoryExtract(String agentmemDir) throws Exception {
        var memDir = Path.of(agentmemDir);
        var signals = MemoryReader.extract(memDir);
        System.out.println(MemoryReader.toJson(signals));
    }

    private String readStdin() throws Exception {
        try (var reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in))) {
            var sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString().strip();
        }
    }
}
