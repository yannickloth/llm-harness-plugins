package eu.infolead.llmhp.offload;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * CLI entry point for the premium-read-offload plugin. The TS shim shells out
 * to this; all deterministic logic lives in Java (repo convention).
 *
 * Subcommands:
 * <pre>
 *   decide-read   &lt;projectDir&gt; &lt;sessionID&gt; &lt;filePath&gt; [offset] [limit]
 *   decide-bash   &lt;projectDir&gt; &lt;sessionID&gt; &lt;command&gt;
 *   record-model  &lt;projectDir&gt; &lt;sessionID&gt; &lt;providerID&gt; &lt;modelID&gt;
 *   is-premium    &lt;projectDir&gt; &lt;sessionID&gt;
 *   grant-direct  &lt;projectDir&gt; &lt;sessionID&gt; &lt;filePath&gt;
 *   corpus-key    &lt;projectDir&gt; &lt;path&gt;...
 *   worker-get    &lt;projectDir&gt; &lt;path&gt;...
 *   worker-set    &lt;projectDir&gt; &lt;sessionID&gt; &lt;path&gt;...
 *   worker-list   &lt;projectDir&gt;
 *   worker-prune  &lt;projectDir&gt;
 *   record-metric &lt;projectDir&gt; &lt;json&gt;
 *   worth-offload &lt;projectDir&gt; &lt;cacheHit&gt; &lt;corpusLines&gt; &lt;question&gt;
 *   verify-answer &lt;projectDir&gt; &lt;path&gt;...      (worker answer on stdin)
 * </pre>
 */
public final class OffloadCli {

    public static void main(String... args) throws IOException {
        if (args.length < 2) {
            System.err.println("usage: premium-read-offload <subcommand> <projectDir> [...]");
            System.exit(1);
        }
        var sub = args[0];
        var projectDir = Path.of(args[1]);
        var store = new WorkerStore(projectDir);
        var decider = GateDecider.fromEnv();

        switch (sub) {
            case "decide-read" -> {
                if (args.length < 5) { usage("decide-read <projectDir> <sessionID> <filePath> [offset] [limit]"); }
                var sessionId = args[2];
                var filePath = args[3];
                var offset = optInt(args, 4);
                var limit = optInt(args, 5);

                var model = store.sessionModel(sessionId);
                if (model == null) {
                    // Unknown model: fail open. Offloading an unknown (possibly
                    // cheap) session risks spend for no benefit.
                    System.out.println(json("allow", "unknown_model", "", false));
                    return;
                }
                var path = Path.of(filePath);
                boolean exists = Files.isRegularFile(path);
                int lines = exists ? countLines(path) : -1;
                boolean permitted = exists && store.consumeDirectRead(sessionId, filePath);
                var d = decider.decideRead(model[0], model[1], filePath, offset, limit, exists, lines, permitted);
                System.out.println(json(
                    d.blocked() ? "block" : "allow",
                    d.reason().name().toLowerCase(),
                    d.detail(),
                    decider.isPremium(model[0], model[1])));
            }
            case "decide-bash" -> {
                if (args.length < 4) { usage("decide-bash <projectDir> <sessionID> <command>"); }
                var sessionId = args[2];
                var command = args[3];
                var model = store.sessionModel(sessionId);
                if (model == null || !decider.isPremium(model[0], model[1])) {
                    System.out.println(json("allow", "not_premium", "", false));
                    return;
                }
                var parsed = GateDecider.bashRead(command);
                if (parsed.path().isBlank()) {
                    System.out.println(json("allow", "unparseable_path", "", true));
                    return;
                }
                if (parsed.bounded()) {
                    System.out.println(json("allow", "targeted_read", "bounded bash read", true));
                    return;
                }
                var path = Path.of(parsed.path());
                if (!Files.isRegularFile(path)) {
                    System.out.println(json("allow", "file_not_found", "", true));
                    return;
                }
                int lines = countLines(path);
                int threshold = decider.thresholdFor(model[0]);
                if (lines > threshold) {
                    System.out.println(json("block", "bulk_read",
                        lines + " lines via bash on " + model[0] + "/" + model[1] + " (threshold " + threshold + ")", true));
                } else {
                    System.out.println(json("allow", "small_file", "", true));
                }
            }
            case "record-model" -> {
                if (args.length < 5) { usage("record-model <projectDir> <sessionID> <providerID> <modelID>"); }
                store.recordSessionModel(args[2], args[3], args[4]);
                System.out.println("{\"recorded\":true,\"premium\":" + decider.isPremium(args[3], args[4]) + "}");
            }
            case "is-premium" -> {
                if (args.length < 3) { usage("is-premium <projectDir> <sessionID>"); }
                var model = store.sessionModel(args[2]);
                System.out.println("{\"premium\":" + (model != null && decider.isPremium(model[0], model[1])) + "}");
            }
            case "grant-direct" -> {
                if (args.length < 4) { usage("grant-direct <projectDir> <sessionID> <filePath>"); }
                store.grantDirectRead(args[2], args[3]);
                System.out.println("{\"granted\":true}");
            }
            case "corpus-key" -> {
                var key = WorkerStore.corpusKey(WorkerStore.fingerprints(paths(args, 2)));
                System.out.println("{\"corpusKey\":\"" + key + "\"}");
            }
            case "worker-get" -> {
                // Look up by the corpus itself: the key is the fingerprint hash,
                // and the stored fingerprint is compared so a changed corpus is a
                // miss (never a stale session).
                if (args.length < 3) { usage("worker-get <projectDir> <path>..."); }
                var fps = WorkerStore.fingerprints(paths(args, 2));
                var key = WorkerStore.corpusKey(fps);
                var id = store.workerSession(key, fps);
                System.out.println("{\"sessionID\":" + (id == null ? "null" : "\"" + WorkerStore.safe(id) + "\"")
                    + ",\"corpusKey\":\"" + key + "\"}");
            }
            case "worker-set" -> {
                if (args.length < 4) { usage("worker-set <projectDir> <sessionID> <path>..."); }
                var fps = WorkerStore.fingerprints(paths(args, 3));
                var key = WorkerStore.corpusKey(fps);
                store.setWorkerSession(key, args[2], fps, paths(args, 3));
                System.out.println("{\"stored\":true,\"corpusKey\":\"" + key + "\"}");
            }
            case "worker-prune" -> {
                var ttlDays = envInt("LLMHP_OFFLOAD_TTL_DAYS", 14);
                var pruned = store.pruneWorkers(java.time.Duration.ofDays(Math.max(0, ttlDays)));
                var sb = new StringBuilder("{\"pruned\":[");
                for (int i = 0; i < pruned.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(WorkerStore.safe(pruned.get(i))).append("\"");
                }
                sb.append("],\"ttlDays\":").append(ttlDays).append("}");
                System.out.println(sb);
            }
            case "record-metric" -> {
                if (args.length < 3) { usage("record-metric <projectDir> <json>"); }
                store.appendMetric(args[2]);
                System.out.println("{\"recorded\":true}");
            }
            case "worth-offload" -> {
                if (args.length < 5) { usage("worth-offload <projectDir> <cacheHit> <corpusLines> <question>"); }
                boolean cacheHit = Boolean.parseBoolean(args[2]);
                int corpusLines = parseIntOr(args[3], -1);
                var question = String.join(" ", java.util.Arrays.copyOfRange(args, 4, args.length));
                boolean worth = decider.worthOffload(question, corpusLines, cacheHit);
                System.out.println("{\"worth\":" + worth
                    + ",\"trivial\":" + GateDecider.isTrivialQuestion(question)
                    + ",\"cacheHit\":" + cacheHit
                    + ",\"corpusLines\":" + corpusLines + "}");
            }
            case "verify-answer" -> {
                if (args.length < 3) { usage("verify-answer <projectDir> <path>..."); }
                var answer = new String(System.in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                var res = CitationVerifier.verify(answer, paths(args, 2));
                System.out.println(verifyJson(res));
            }
            case "worker-list" -> {
                var ids = store.workerSessionIds();
                var sb = new StringBuilder("{\"sessionIDs\":[");
                for (int i = 0; i < ids.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(WorkerStore.safe(ids.get(i))).append("\"");
                }
                sb.append("]}");
                System.out.println(sb);
            }
            default -> {
                System.err.println("unknown subcommand: " + sub);
                System.exit(1);
            }
        }
    }

    private static void usage(String msg) {
        System.err.println("usage: " + msg);
        System.exit(1);
    }

    private static List<Path> paths(String[] args, int from) {
        var out = new ArrayList<Path>();
        for (int i = from; i < args.length; i++) out.add(Path.of(args[i]));
        return out;
    }

    private static int envInt(String name, int fallback) {
        var v = System.getenv(name);
        if (v == null || v.isBlank()) return fallback;
        return parseIntOr(v, fallback);
    }

    private static int parseIntOr(String v, int fallback) {
        if (v == null || v.isBlank() || v.equals("-")) return fallback;
        try { return Integer.parseInt(v.trim()); } catch (NumberFormatException e) { return fallback; }
    }

    private static Integer optInt(String[] args, int idx) {
        if (idx >= args.length) return null;
        var v = args[idx];
        if (v == null || v.isBlank() || v.equals("-")) return null;
        try { return Integer.parseInt(v.trim()); } catch (NumberFormatException e) { return null; }
    }

    static int countLines(Path p) {
        try (var lines = Files.lines(p)) {
            return (int) Math.min(Integer.MAX_VALUE, lines.count());
        } catch (IOException e) {
            return -1;
        }
    }

    private static String verifyJson(CitationVerifier.Result r) {
        var sb = new StringBuilder();
        sb.append("{\"answer\":\"").append(WorkerStore.safe(r.answer())).append("\"");
        sb.append(",\"citations\":{\"total\":").append(r.total());
        sb.append(",\"verified\":").append(r.verified());
        sb.append(",\"unverified\":").append(r.unverified());
        sb.append(",\"hasCitations\":").append(r.hasCitations());
        sb.append(",\"items\":[");
        var items = r.citations();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(",");
            var c = items.get(i);
            sb.append("{\"path\":\"").append(WorkerStore.safe(c.path())).append("\"");
            sb.append(",\"start\":").append(c.start());
            sb.append(",\"end\":").append(c.end());
            sb.append(",\"quote\":\"").append(WorkerStore.safe(c.quote())).append("\"");
            sb.append(",\"status\":\"").append(WorkerStore.safe(c.status())).append("\"}");
        }
        sb.append("]}}");
        return sb.toString();
    }

    private static String json(String decision, String reason, String detail, boolean premium) {
        return "{\"decision\":\"" + decision + "\",\"reason\":\"" + reason
            + "\",\"detail\":\"" + WorkerStore.safe(detail) + "\",\"premium\":" + premium + "}";
    }
}
