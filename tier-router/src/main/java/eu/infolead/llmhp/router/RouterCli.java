package eu.infolead.llmhp.router;

import eu.infolead.llmhp.shared.DenialTracker;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * CLI for tier-router engine. Invoked by OpenCode/Claude Code/Pi plugins via shell.
 */
final class RouterCli {

    private static final RouterEngine engine = new RouterEngine();

    static {
        loadSkillAxisConfig();
    }

    private static void loadSkillAxisConfig() {
        var configPath = skillAxisConfigPath();
        if (configPath != null) {
            var mappings = SkillAxisConfig.load(configPath);
            if (!mappings.isEmpty()) {
                engine.setSkillAxisMappings(SkillAxisConfig.toMap(mappings));
                System.err.println("[tier-router] loaded %d skill-axis mappings from %s".formatted(
                    mappings.size(), configPath));
            }
        }
    }

    private static Path skillAxisConfigPath() {
        var env = System.getenv("TIER_ROUTER_SKILL_AXIS_CONFIG");
        if (env != null && !env.isBlank()) return Path.of(env);
        var pluginRoot = System.getenv("TIER_ROUTER_PLUGIN_ROOT");
        if (pluginRoot != null && !pluginRoot.isBlank())
            return Path.of(pluginRoot, "skill-axis-mapping.json");
        var cwd = Paths.get("").toAbsolutePath();
        var local = cwd.resolve("tier-router/skill-axis-mapping.json");
        if (java.nio.file.Files.exists(local)) return local;
        local = cwd.resolve("skill-axis-mapping.json");
        if (java.nio.file.Files.exists(local)) return local;
        return null;
    }

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: RouterCli <classify|route|rewrite|ambiguity|budget-check|budget-accumulate|budget-reset|memory-load|memory-extract|breaker-classifier-fail|breaker-classifier-ok|breaker-fleet-fail|breaker-fleet-ok|breaker-fleet-check|breaker-denial|breaker-denial-allow|breaker-save|breaker-status|breaker-session> [args...]");
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
            case "breaker-classifier-fail" -> breakerClassifierFail();
            case "breaker-classifier-ok" -> breakerClassifierOk();
            case "breaker-fleet-fail" -> breakerFleetFail();
            case "breaker-fleet-ok" -> breakerFleetOk();
            case "breaker-fleet-check" -> breakerFleetCheck();
            case "breaker-denial" -> breakerDenial();
            case "breaker-denial-allow" -> breakerDenialAllow();
            case "breaker-save" -> breakerSave();
            case "breaker-status" -> breakerStatus();
            case "breaker-session" -> {
                if (args.length < 2) {
                    System.err.println("breaker-session requires <session-id>");
                    System.exit(1);
                }
                breakerSession(args[1]);
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

    private void breakerClassifierFail() {
        engine.recordClassifierFailure();
        var state = engine.classifierBreaker().state();
        System.out.printf(
            "{\"status\":\"%s\",\"consecutiveFailures\":%d,\"totalFailures\":%d,\"maxConsecutive\":%d,\"maxTotal\":%d}%n",
            state.tripped() ? "tripped" : "ok",
            state.consecutiveFailures(), state.totalFailures(),
            engine.classifierBreaker().consecutiveMax(), engine.classifierBreaker().totalMax());
    }

    private void breakerClassifierOk() {
        engine.recordClassifierSuccess();
        var state = engine.classifierBreaker().state();
        System.out.printf(
            "{\"status\":\"ok\",\"consecutiveFailures\":%d,\"totalFailures\":%d}%n",
            state.consecutiveFailures(), state.totalFailures());
    }

    private void breakerFleetFail() {
        engine.recordFleetFailure();
        var state = engine.fleetBreaker().state();
        System.out.printf(
            "{\"status\":\"%s\",\"consecutiveFailures\":%d,\"totalFailures\":%d,\"maxConsecutive\":%d,\"maxTotal\":%d}%n",
            state.tripped() ? "tripped" : "ok",
            state.consecutiveFailures(), state.totalFailures(),
            engine.fleetBreaker().consecutiveMax(), engine.fleetBreaker().totalMax());
    }

    private void breakerFleetOk() {
        engine.recordFleetSuccess();
        var state = engine.fleetBreaker().state();
        System.out.printf(
            "{\"status\":\"ok\",\"consecutiveFailures\":%d,\"totalFailures\":%d}%n",
            state.consecutiveFailures(), state.totalFailures());
    }

    private void breakerFleetCheck() {
        var tripped = engine.fleetTripped();
        System.out.printf("{\"tripped\":%s}%n", tripped);
    }

    private void breakerDenial() {
        var aborted = engine.denialTracker().recordDenial();
        var state = engine.denialTracker().state();
        System.out.printf(
            "{\"status\":\"%s\",\"justAborted\":%s,\"consecutiveDenials\":%d,\"totalDenials\":%d,\"maxConsecutive\":%d,\"maxTotal\":%d}%n",
            engine.denialTracker().isAborted() ? "aborted" : "tracking",
            aborted,
            state.consecutiveFailures(), state.totalFailures(),
            DenialTracker.DEFAULT_CONSECUTIVE_MAX, DenialTracker.DEFAULT_TOTAL_MAX);
    }

    private void breakerDenialAllow() {
        engine.recordToolAllow();
        var state = engine.denialTracker().state();
        System.out.printf(
            "{\"status\":\"tracking\",\"consecutiveDenials\":%d,\"totalDenials\":%d}%n",
            state.consecutiveFailures(), state.totalFailures());
    }

    private void breakerSave() throws Exception {
        engine.saveBreakers();
        System.out.println("{\"status\":\"saved\"}");
    }

    private void breakerStatus() {
        var cb = engine.classifierBreaker().state();
        var fb = engine.fleetBreaker().state();
        var dt = engine.denialTracker().state();
        System.out.printf("""
            {"classifier":{"tripped":%s,"consecutive":%d,"total":%d,"maxConsecutive":%d,"maxTotal":%d},"fleet":{"tripped":%s,"consecutive":%d,"total":%d,"maxConsecutive":%d,"maxTotal":%d},"denial":{"aborted":%s,"consecutive":%d,"total":%d,"maxConsecutive":%d,"maxTotal":%d}}
            """.strip(),
            cb.tripped(), cb.consecutiveFailures(), cb.totalFailures(),
            engine.classifierBreaker().consecutiveMax(), engine.classifierBreaker().totalMax(),
            fb.tripped(), fb.consecutiveFailures(), fb.totalFailures(),
            engine.fleetBreaker().consecutiveMax(), engine.fleetBreaker().totalMax(),
            engine.denialTracker().isAborted(),
            dt.consecutiveFailures(), dt.totalFailures(),
            DenialTracker.DEFAULT_CONSECUTIVE_MAX, DenialTracker.DEFAULT_TOTAL_MAX);
    }

    private void breakerSession(String sessionId) {
        engine.setSessionId(sessionId);
        System.out.printf("{\"status\":\"session-set\",\"sessionId\":\"%s\"}%n", sessionId);
    }
}
