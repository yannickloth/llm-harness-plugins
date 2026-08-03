package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.memory.types.*;

public class MemorySystemCli {

    public static void main(String[] args) throws Exception {
        if (args.length < 2) { usage(); return; }
        var cmd = args[0];
        var memDir = Path.of(args[1]);

        switch (cmd) {
            case "save" -> {
                var input = new MemoryStore.SaveInput(
                    args[2], args[3], args[4],
                    strOpt(args, 5),
                    args[6], args[7], args[8],
                    args[9], args[10],
                    strOpt(args, 11),
                    strOpt(args, 12),
                    strOpt(args, 13));
                MemoryStore.save(memDir, input);
            }
            case "read" -> System.out.println(MemoryStore.read(memDir, args[2]));
            case "delete" -> MemoryStore.delete(memDir, args[2]);
            case "index" -> System.out.println(MemoryStore.showIndex(memDir));

            case "entity-rebuild" -> EntityIndex.rebuild(memDir);
            case "entity-lookup" -> System.out.println(EntityIndex.lookup(memDir, args[2]));
            case "entity-query" -> System.out.println(EntityIndex.query(memDir, args[2]));

            case "graph-build" -> EntityGraph.build(memDir);
            case "graph-expand" -> System.out.println(EntityGraph.expand(memDir, args[2]));

            case "quality-validate" -> QualityGateRunner.validate(memDir, args[2], args[3], args[4], args[5], args[6], args[7]);
            case "quality-health" -> QualityGateRunner.health(memDir);

            case "lifecycle-stale" -> {
                var type = args.length > 2 ? args[2] : "project";
                var conf = args.length > 3 ? Confidence.fromString(args[3]) : Confidence.MEDIUM;
                var tier = args.length > 4 ? ModelTier.valueOf(args[4].toUpperCase()) : ModelTier.UNKNOWN;
                System.out.printf("DAYS_UNTIL_STALE=%d\n", MemoryLifecycle.daysUntilStale(type, conf, tier));
            }
            case "lifecycle-decay" -> {
                var type = args.length > 2 ? args[2] : "project";
                var conf = args.length > 3 ? Confidence.fromString(args[3]) : Confidence.MEDIUM;
                var tier = args.length > 4 ? ModelTier.valueOf(args[4].toUpperCase()) : ModelTier.UNKNOWN;
                System.out.printf("DAYS_UNTIL_PRUNE=%d\n", MemoryLifecycle.daysUntilPrune(type, conf, tier));
            }
            case "lifecycle-prune" -> MemoryLifecycle.listPruneCandidates(memDir);

            case "lock-check" -> ConsolidationLock.check(memDir);
            case "lock-acquire" -> ConsolidationLock.acquire(memDir);
            case "lock-release" -> ConsolidationLock.release(memDir);
            case "lock-status" -> ConsolidationLock.status(memDir);

            case "history-snapshot" -> HistoryManager.snapshot(memDir, args[2]);
            case "history-list" -> HistoryManager.list(memDir, args.length > 2 ? args[2] : null);
            case "history-prune" -> HistoryManager.prune(memDir, args.length > 2 ? Integer.parseInt(args[2]) : 90);

            case "guardrail-match" -> System.out.println(GuardrailEvaluator.match(memDir, args.length > 2 ? args[2] : ""));
            case "guardrail-list" -> GuardrailEvaluator.listGuards(memDir);

            case "scoped-resolve" -> ScopedMemoryLoader.resolve(Path.of(args[2]), args.length > 3 ? Path.of(args[3]) : Path.of(args[2]));

            case "digest-episode" -> DigestWriter.writeEpisode(memDir, args[2], args.length > 3 ? args[3] : "");

            case "model-tier" -> System.out.println(ModelTrustTracker.lookupTier(args[2]));
            case "model-trust" -> System.out.println(ModelTrustTracker.computeTrust(memDir, args[2]));
            case "model-record" -> ModelTrustTracker.recordMemory(memDir, args[2]);
            case "model-correct" -> ModelTrustTracker.recordCorrection(memDir, args[2]);

            case "review" -> ReviewGenerator.generate(memDir);

            case "sync-delta" -> {
                var delta = SyncClient.computeDelta(memDir);
                if (delta.isEmpty()) System.out.println("NONE");
                else delta.values().forEach(System.out::println);
            }

            case "bootstrap" -> Bootstrap.run(Path.of(args.length > 2 ? args[2] : "."), memDir);
            case "migrate" -> Migration.migrate(memDir);

            case "inject" -> {
                var sb = new StringBuilder();
                if (!Files.exists(memDir)) { System.out.println("{}"); return; }
                var indexPath = memDir.resolve("MEMORY.md");
                if (Files.exists(indexPath)) {
                    var indexContent = Files.readString(indexPath).trim();
                    if (!indexContent.isEmpty())
                        sb.append(indexContent).append("\n\n");
                }
                try (var files = Files.list(memDir)) {
                    files.filter(f -> f.getFileName().toString().endsWith(".md")
                        && !f.getFileName().toString().equals("MEMORY.md")
                        && !f.getFileName().toString().equals("REVIEW.md"))
                        .sorted()
                        .forEach(f -> {
                            try {
                                var content = Files.readString(f);
                                var truncated = content.length() > 8000
                                    ? content.substring(0, 8000) + "\n... [truncated]"
                                    : content;
                                sb.append("<!-- memory: ").append(f.getFileName()).append(" -->\n");
                                sb.append(truncated).append("\n\n");
                            } catch (IOException ignored) {}
                        });
                }
                if (sb.isEmpty()) return;
                var contextText = sb.toString();
                var escaped = contextText
                    .replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t");
                var cap = Math.min(escaped.length(), 10000);
                System.out.print("{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"");
                System.out.print(escaped.substring(0, cap));
                System.out.print("\"}}");
                System.out.println();
            }
            case "scoped-inject" -> {
                // args: agentmemDir filePath
                var agentmemDir = memDir;
                var projectRoot = agentmemDir.getParent();
                if (projectRoot == null) { System.exit(0); }
                var filePath = Path.of(args[2]);
                var sb = new StringBuilder();
                var current = filePath.toAbsolutePath();
                while (current.startsWith(projectRoot)) {
                    var memFile = current.resolve("MEMORY.md");
                    if (Files.exists(memFile) && !current.equals(agentmemDir)) {
                        var content = Files.readString(memFile).trim();
                        if (!content.isEmpty()) {
                            var relDir = projectRoot.relativize(current).toString();
                            if (relDir.isEmpty()) relDir = "root";
                            sb.append("### Scoped memory: ").append(relDir).append("\n");
                            sb.append(content).append("\n");
                        }
                    }
                    if (current.equals(projectRoot)) break;
                    current = current.getParent();
                }
                if (sb.isEmpty()) System.exit(0);
                var contextText = "## Scoped Memory for " + filePath.getFileName() + "\n\n" + sb.toString();
                var escaped = contextText
                    .replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t");
                var cap = Math.min(escaped.length(), 5000);
                System.out.print("{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"");
                System.out.print(escaped.substring(0, cap));
                System.out.print("\"}}");
                System.out.println();
            }
            case "path-validate" -> PathValidator.validate(Path.of(args[2]), memDir);
            case "path-validate-name" -> PathValidator.validateName(args[2]);

            case "budget-inject" -> {
                var projectRoot = args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".";
                var sessionId = args.length > 3 ? args[3] : "default";
                var result = MemoryBudget.buildBudgetedInjection(memDir, projectRoot);
                var output = new StringBuilder();
                output.append("---\n");
                output.append("type: budgeted-inject\n");
                output.append("total_tokens: ").append(result.totalTokens()).append("\n");
                output.append("tokens_available: ").append(result.tokensAvailable()).append("\n");
                output.append("sections_budgeted: ").append(result.sectionsBudgeted()).append("\n");
                output.append("sections_excluded: ").append(result.sectionsExcluded()).append("\n");
                output.append("---\n\n");
                output.append(result.output());
                try {
                    var budget = MemoryBudget.loadBudgetOrFresh(memDir, sessionId);
                    budget = MemoryBudget.accumulate(budget, result.totalTokens());
                    MemoryBudget.saveBudget(memDir, budget);
                } catch (IOException e) {
                    System.err.println("[budget] Save failed: " + e.getMessage());
                }
                System.out.print(output.toString());
            }
            case "budget-inject-nosave" -> {
                var projectRoot = args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".";
                var sessionId = args.length > 3 ? args[3] : "default";
                var result = MemoryBudget.buildBudgetedInjectionForReinject(memDir, projectRoot, sessionId);
                var output = new StringBuilder();
                output.append("---\n");
                output.append("type: budgeted-inject-nosave\n");
                output.append("total_tokens: ").append(result.totalTokens()).append("\n");
                output.append("tokens_available: ").append(result.tokensAvailable()).append("\n");
                output.append("sections_budgeted: ").append(result.sectionsBudgeted()).append("\n");
                output.append("sections_excluded: ").append(result.sectionsExcluded()).append("\n");
                output.append("---\n\n");
                output.append(result.output());
                System.out.print(output.toString());
            }
            case "budget-inject-delta" -> {
                var projectRoot = args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".";
                var sessionId = args.length > 3 ? args[3] : "default";
                try {
                    var result = MemoryBudget.buildBudgetedInjection(memDir, projectRoot);
                    var budget = MemoryBudget.loadBudgetOrFresh(memDir, sessionId);
                    if (budget.exhausted()) {
                        System.err.println("[budget] Budget exhausted, no injection");
                        System.out.println("");
                        return;
                    }
                    var delta = Math.max(0, result.totalTokens() - budget.tokensInjected());
                    budget = MemoryBudget.accumulate(budget, delta);
                    MemoryBudget.saveBudget(memDir, budget);
                    var output = new StringBuilder();
                    output.append("---\n");
                    output.append("type: budgeted-inject-delta\n");
                    output.append("total_tokens: ").append(result.totalTokens()).append("\n");
                    output.append("delta_tokens: ").append(delta).append("\n");
                    output.append("tokens_available: ").append(result.tokensAvailable()).append("\n");
                    output.append("sections_budgeted: ").append(result.sectionsBudgeted()).append("\n");
                    output.append("sections_excluded: ").append(result.sectionsExcluded()).append("\n");
                    output.append("---\n\n");
                    output.append(result.output());
                    System.out.print(output.toString());
                } catch (IOException e) {
                    System.err.println("[budget] delta-inject failed: " + e.getMessage());
                    System.out.println("");
                }
            }
            case "budget-init" -> {
                var sessionId = args.length > 2 ? args[2] : "default";
                long ceiling = MemoryBudget.MAX_TOTAL_TOKENS;
                if (args.length > 3) {
                    try {
                        ceiling = Long.parseLong(args[3]);
                    } catch (NumberFormatException e) {
                        System.err.println("[budget] Invalid ceiling '" + args[3] + "', using default " + ceiling);
                    }
                }
                var budget = MemoryBudget.SessionBudget.fresh(sessionId, ceiling);
                MemoryBudget.saveBudget(memDir, budget);
                System.out.println("INITIALIZED session=" + sessionId + " ceiling=" + ceiling);
            }
            case "budget-status" -> {
                var sessionId = args.length > 2 ? args[2] : "default";
                var budget = MemoryBudget.loadBudgetOrFresh(memDir, sessionId);
                System.out.println("session=" + budget.sessionId());
                System.out.println("tokensInjected=" + budget.tokensInjected());
                System.out.println("ceiling=" + budget.ceiling());
                System.out.println("exhausted=" + budget.exhausted());
                System.out.println("startTime=" + budget.startTime());
            }
            case "budget-accumulate" -> {
                var sessionId = args.length > 2 ? args[2] : "default";
                if (args.length < 4) {
                    System.err.println("[budget] Missing token count argument");
                    System.exit(1);
                }
                var tokens = Long.parseLong(args[3]);
                var budget = MemoryBudget.loadBudgetOrFresh(memDir, sessionId);
                budget = MemoryBudget.accumulate(budget, tokens);
                MemoryBudget.saveBudget(memDir, budget);
                System.out.println("ACCUMULATED session=" + sessionId + " tokensInjected=" + budget.tokensInjected() + " exhausted=" + budget.exhausted());
            }
            case "budget-reset" -> {
                var sessionId = args.length > 2 ? args[2] : "default";
                var budgetFile = MemoryBudget.budgetFile(memDir, sessionId);
                try {
                    Files.deleteIfExists(budgetFile);
                    System.out.println("RESET session=" + sessionId);
                } catch (IOException e) {
                    System.err.println("[budget] Reset failed: " + e.getMessage());
                }
            }

            case "verify" -> {
                var projectRoot = Path.of(args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".");
                var result = MemoryVerifier.verify(memDir, projectRoot);
                System.out.println("total_file_refs=" + result.totalFiles());
                System.out.println("stale_files=" + result.staleFiles());
                System.out.println("outside_project=" + result.outsideProject());
                System.out.print(result.staleAnnotation());
            }
            case "verify-inject" -> {
                var projectRoot = args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".";
                var output = MemoryVerifier.injectWithVerification(memDir, projectRoot);
                System.out.println(output);
            }
            case "verify-report" -> {
                var projectRoot = Path.of(args.length > 2 ? args[2] : memDir.getParent() != null ? memDir.getParent().toString() : ".");
                var report = MemoryVerifier.buildVerifiedInjection(memDir, projectRoot);
                System.out.print(report);
            }

            case "tiered-inject" -> {
                var projectRoot = Path.of(args.length > 2 ? args[2] : ".");
                var tiers = new LinkedHashSet<Path>();
                var teamShared = Path.of("/etc/agentmem/shared");
                var global = Path.of(System.getProperty("user.home"), ".agentmem", "global");
                var projectMem = projectRoot.resolve(".agentmem");
                String projKey;
                try {
                    projKey = projectRoot.toRealPath().toString().replace("/", "_");
                } catch (IOException e) {
                    projKey = projectRoot.toAbsolutePath().normalize().toString().replace("/", "_");
                }
                var personal = Path.of(System.getProperty("user.home"), ".agentmem", projKey);

                for (var t : new Path[]{teamShared, global, projectMem, personal}) {
                    var idx = t.resolve("MEMORY.md");
                    if (Files.exists(idx)) tiers.add(t);
                }

                var sb = new StringBuilder();
                for (var t : tiers) {
                    var tierLabel = t.toString().replace(System.getProperty("user.home"), "~");
                    var indexPath = t.resolve("MEMORY.md");
                    if (Files.exists(indexPath)) {
                        var indexContent = Files.readString(indexPath).trim();
                        if (!indexContent.isEmpty()) {
                            sb.append("### Tier: ").append(tierLabel).append("\n");
                            sb.append(indexContent).append("\n\n");
                        }
                    }
                    try (var files = Files.list(t)) {
                        files.filter(f -> f.getFileName().toString().endsWith(".md")
                            && !f.getFileName().toString().equals("MEMORY.md")
                            && !f.getFileName().toString().equals("REVIEW.md"))
                            .sorted()
                            .forEach(f -> {
                                try {
                                    var content = Files.readString(f);
                                    var truncated = content.length() > 4000
                                        ? content.substring(0, 4000) + "\n... [truncated]"
                                        : content;
                                    sb.append("<!-- memory: ").append(f.getFileName()).append(" -->\n");
                                    sb.append(truncated).append("\n\n");
                                } catch (IOException ignored) {}
                            });
                    }
                }
                if (sb.isEmpty()) { System.out.println("{}"); return; }
                var contextText = sb.toString();
                var escaped = contextText
                    .replace("\\", "\\\\")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n")
                    .replace("\r", "\\r")
                    .replace("\t", "\\t");
                var cap = Math.min(escaped.length(), 12000);
                System.out.print("{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"");
                System.out.print(escaped.substring(0, cap));
                System.out.print("\"}}");
                System.out.println();
            }

            default -> { System.err.println("Unknown: " + cmd); System.exit(1); }
        }
    }

    static void usage() {
        System.err.println("""
            MemorySystem <cmd> <memDir> [args...]
            Commands: save read delete index
            entity-rebuild entity-lookup entity-query
            graph-build graph-expand
            quality-validate quality-health
            lifecycle-stale lifecycle-decay lifecycle-prune
            lock-check lock-acquire lock-release lock-status
            history-snapshot history-list history-prune
            guardrail-match guardrail-list
            scoped-resolve digest-episode
            model-tier model-trust model-record model-correct
            review sync-delta bootstrap migrate inject scoped-inject
            tiered-inject path-validate path-validate-name
            budget-inject budget-init budget-status budget-accumulate
            budget-inject-nosave budget-inject-delta budget-reset
            verify verify-inject verify-report
            """);
    }

    static Optional<String> strOpt(String[] args, int idx) {
        return (idx < args.length && !args[idx].equals("--")) ? Optional.of(args[idx]) : Optional.empty();
    }
}
