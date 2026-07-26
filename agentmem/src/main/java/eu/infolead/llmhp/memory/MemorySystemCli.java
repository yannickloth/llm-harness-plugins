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
                    strOpt(args, 10),
                    args[5], args[6], args[7],
                    args[8], args[9],
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
            review sync-delta bootstrap migrate inject
            path-validate path-validate-name
            """);
    }

    static Optional<String> strOpt(String[] args, int idx) {
        return (idx < args.length && !args[idx].equals("--")) ? Optional.of(args[idx]) : Optional.empty();
    }
}
