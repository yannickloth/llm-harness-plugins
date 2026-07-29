package eu.infolead.llmhp.router;

import java.nio.file.Path;

/**
 * CLI for tier-router engine. Invoked by OpenCode/Claude Code/Pi plugins via shell.
 */
final class RouterCli {

    private static final RouterEngine engine = new RouterEngine();

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: RouterCli <classify|route|rewrite|ambiguity|budget-check|budget-accumulate|budget-reset> [args...]");
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
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(1);
            }
        }
    }

    private void classify() throws Exception {
        var prompt = readStdin();
        var result = engine.route(prompt);
        System.out.println(result.toJson());
    }

    private void route() throws Exception {
        var prompt = readStdin();
        var result = engine.routeWithRewrite(prompt);
        System.out.println(result.toJson());
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
            System.out.println("{\"status\":\"exhausted\",\"tokensUsed\":" + state.tokensUsed() +
                ",\"ceiling\":" + ceiling + ",\"sessionId\":\"" + state.sessionId() + "\"}");
        } else {
            System.out.println("{\"status\":\"ok\",\"tokensUsed\":" + state.tokensUsed() +
                ",\"ceiling\":" + state.ceiling() + ",\"sessionId\":\"" + state.sessionId() + "\"}");
        }
    }

    private void budgetAccumulate(String sessionId, long tokens, String metricsDir) throws Exception {
        var state = BudgetTracker.loadOrFresh(Path.of(metricsDir), sessionId);
        var updated = BudgetTracker.accumulate(state, tokens);
        BudgetTracker.save(Path.of(metricsDir), updated);
        var wasExhausted = state.exhausted();
        System.out.println("{\"status\":\"" + (updated.exhausted() ? "exhausted" : "ok") +
            "\",\"tokensUsed\":" + updated.tokensUsed() +
            ",\"ceiling\":" + updated.ceiling() +
            ",\"newlyExhausted\":" + (!wasExhausted && updated.exhausted()) +
            ",\"sessionId\":\"" + updated.sessionId() + "\"}");
    }

    private void budgetReset(String sessionId, String metricsDir) throws Exception {
        var ceiling = BudgetTracker.readCeiling();
        var fresh = BudgetState.fresh(sessionId, ceiling);
        BudgetTracker.save(Path.of(metricsDir), fresh);
        System.out.println("{\"status\":\"reset\",\"tokensUsed\":0,\"ceiling\":" + ceiling +
            ",\"sessionId\":\"" + sessionId + "\"}");
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
