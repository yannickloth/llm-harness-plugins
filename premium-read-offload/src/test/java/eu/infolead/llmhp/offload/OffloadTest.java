package eu.infolead.llmhp.offload;

import java.nio.file.Files;
import java.nio.file.Path;

/** Minimal test harness (repo convention: plain main() asserting, no JUnit). */
public final class OffloadTest {

    static int passed = 0, failed = 0;

    public static void main(String... args) throws Exception {
        var d = new GateDecider(1000, 400, 2000);

        // ── premium detection ──
        check(d.isPremium("kimi", "k3"), "kimi/k3 premium");
        check(d.isPremium("kimi", "k3-256k"), "kimi/k3-256k premium");
        check(d.isPremium("kimi-for-coding", "k3-256k"), "kimi-for-coding/k3-256k premium");
        check(d.thresholdFor("kimi-for-coding") == 1000, "kimi-for-coding uses kimi threshold");
        check(d.isPremium("zai-coding-plan", "glm-5.3"), "zai glm-5.3 premium");
        check(d.isPremium("zai-coding-plan", "glm-5.3-flash"), "zai glm-5.3-flash premium");
        check(!d.isPremium("deepseek", "deepseek-flash"), "deepseek not premium");
        check(!d.isPremium("deepseek", "deepseek-v4-pro"), "deepseek-v4-pro not premium");
        check(!d.isPremium(null, "k3"), "null provider not premium");
        check(!d.isPremium("kimi", null), "null model not premium");

        // ── thresholds: ZAI lower than Kimi ──
        check(d.thresholdFor("zai-coding-plan") == 400, "zai threshold 400");
        check(d.thresholdFor("kimi") == 1000, "kimi threshold 1000");

        // ── read decisions ──
        // Not premium: always allow.
        check(!d.decideRead("deepseek", "deepseek-flash", "/x", null, null, true, 5000, false).blocked(),
            "deepseek bulk read allowed");
        // Unknown model: allow (fail open).
        check(!d.decideRead(null, null, "/x", null, null, true, 5000, false).blocked(),
            "unknown model allowed");
        // Premium + big + unbounded: block.
        check(d.decideRead("kimi", "k3", "/x", null, null, true, 5000, false).blocked(),
            "kimi big read blocked");
        check(d.decideRead("zai-coding-plan", "glm-5.3", "/x", null, null, true, 5000, false).blocked(),
            "zai big read blocked");
        // Small file: allow.
        check(!d.decideRead("kimi", "k3", "/x", null, null, true, 500, false).blocked(),
            "kimi small file allowed");
        // ZAI boundary: 400 allowed, 401 blocked.
        check(!d.decideRead("zai-coding-plan", "glm-5.3", "/x", null, null, true, 400, false).blocked(),
            "zai 400 allowed");
        check(d.decideRead("zai-coding-plan", "glm-5.3", "/x", null, null, true, 401, false).blocked(),
            "zai 401 blocked");
        // Nonexistent: allow so Read can error.
        check(!d.decideRead("kimi", "k3", "/x", null, null, false, -1, false).blocked(),
            "nonexistent allowed");
        // Direct permit: allow.
        check(!d.decideRead("kimi", "k3", "/x", null, null, true, 5000, true).blocked(),
            "permitted direct read allowed");
        // Targeted read: allow.
        check(!d.decideRead("kimi", "k3", "/x", 10, 50, true, 5000, false).blocked(),
            "targeted read allowed");
        // Huge limit: block (unbounded in disguise).
        check(d.decideRead("kimi", "k3", "/x", 1, 999999, true, 5000, false).blocked(),
            "huge limit blocked");
        // offset+limit covering whole file: block.
        check(d.decideRead("kimi", "k3", "/x", 1, 5000, true, 5000, false).blocked(),
            "full-span read blocked");
        // offset-only (read to end): allowed per design.
        check(!d.decideRead("kimi", "k3", "/x", 10, null, true, 5000, false).blocked(),
            "offset-only allowed");

        // ── bash path extraction ──
        check(GateDecider.extractBashReadPath("cat foo.ts").equals("foo.ts"), "cat path");
        check(GateDecider.extractBashReadPath("cat -n foo.ts").equals("foo.ts"), "cat -n path");
        check(GateDecider.extractBashReadPath("head -100 foo.ts").equals("foo.ts"), "head -100 path");
        check(GateDecider.extractBashReadPath("tail 'foo bar.ts'").equals("foo bar.ts"), "quoted path");
        check(GateDecider.extractBashReadPath("cat foo.ts | grep x").isEmpty(), "piped not extracted");
        check(GateDecider.extractBashReadPath("cat foo.ts > out").isEmpty(), "redirect not extracted");
        check(GateDecider.extractBashReadPath("git status").isEmpty(), "non-read not extracted");
        check(GateDecider.extractBashReadPath("grep x foo.ts").isEmpty(), "grep not extracted");

        // bounded vs unbounded bash reads
        check(GateDecider.bashRead("head -100 foo.ts").bounded(), "head -100 bounded");
        check(GateDecider.bashRead("head -n 100 foo.ts").bounded(), "head -n 100 bounded");
        check(GateDecider.bashRead("tail --lines=50 foo.ts").bounded(), "tail --lines=50 bounded");
        check(GateDecider.bashRead("less foo.ts").bounded(), "less bounded (paging)");
        check(!GateDecider.bashRead("cat foo.ts").bounded(), "cat unbounded");
        check(!GateDecider.bashRead("head foo.ts").bounded(), "head no-count unbounded");
        check(GateDecider.bashRead("head -c 10 foo.ts").bounded(), "head -c bytes bounded");

        // ── WorkerStore: session model + worker sessions + permits ──
        var tmp = Files.createTempDirectory("offload-test");
        try {
            var store = new WorkerStore(tmp);
            store.recordSessionModel("ses1", "kimi", "k3");
            var model = store.sessionModel("ses1");
            check(model != null && model[0].equals("kimi") && model[1].equals("k3"), "session model roundtrip");
            check(store.sessionModel("missing") == null, "unknown session null");

            var fps = java.util.List.of("a:1:2", "b:3:4");
            var key = WorkerStore.corpusKey(fps);
            check(store.workerSession(key, fps) == null, "no worker session initially");
            store.setWorkerSession(key, "ses_worker", fps, java.util.List.of(Path.of("/a"), Path.of("/b")));
            check("ses_worker".equals(store.workerSession(key, fps)), "worker session roundtrip");
            check(store.workerSessionIds().contains("ses_worker"), "worker list");

            // Stale-summary invalidation: same key, changed fingerprint → miss.
            var changed = java.util.List.of("a:1:2", "b:3:9");
            check(store.workerSession(key, changed) == null, "changed corpus fingerprint is a miss");

            // A different corpus (different key) never resolves to this session.
            var otherFps = java.util.List.of("z:9:9");
            check(store.workerSession(WorkerStore.corpusKey(otherFps), otherFps) == null,
                "different corpus does not inherit stale session");

            // TTL pruning.
            check(store.pruneWorkers(java.time.Duration.ofDays(14)).isEmpty(), "fresh worker not pruned");
            var prunedOld = store.pruneWorkers(java.time.Duration.ZERO);
            check(prunedOld.isEmpty(), "zero TTL prunes nothing");
            check(store.workerSession(key, fps) != null, "worker survives zero-TTL prune");
            var prunedAll = store.pruneWorkers(java.time.Duration.ofMillis(-1));
            check(prunedAll.isEmpty(), "negative TTL prunes nothing");

            store.grantDirectRead("ses1", "/x/y.ts");
            check(store.consumeDirectRead("ses1", "/x/y.ts"), "permit consumed once");
            check(!store.consumeDirectRead("ses1", "/x/y.ts"), "permit not reusable");

            // Corpus key stability + sensitivity.
            check(WorkerStore.corpusKey(java.util.List.of("a")).equals(WorkerStore.corpusKey(java.util.List.of("a"))),
                "corpus key stable");
            check(!WorkerStore.corpusKey(java.util.List.of("a")).equals(WorkerStore.corpusKey(java.util.List.of("b"))),
                "corpus key sensitive");

            // ── cost telemetry ──
            store.appendMetric("{\"op\":\"offload-read\",\"cacheHit\":false}");
            store.appendMetric("{\"op\":\"offload-read\",\"cacheHit\":true}");
            var lines = store.readMetrics();
            check(lines.size() == 2, "two metric lines recorded");
            check(lines.get(0).contains("\"cacheHit\":false"), "metric order preserved");
            // A malformed line is skipped, not fatal.
            store.appendMetric("not json");
            check(store.readMetrics().size() == 2, "malformed metric line skipped");

            // ── worth-offload guard ──
            check(d.worthOffload("what does this do?", 5000, false), "real question + big corpus worth it");
            check(!d.worthOffload("how many lines are in this file?", 5000, false), "trivial question not worth it");
            check(!d.worthOffload("what does this do?", 50, false), "tiny corpus not worth a cold worker");
            check(d.worthOffload("how many lines?", 5000, true), "cache hit always worth it");
            check(d.worthOffload("what does this do?", -1, false), "unknown size + real question worth it");
            check(GateDecider.isTrivialQuestion("line count?"), "trivial: line count");
            check(GateDecider.isTrivialQuestion("which files import X"), "trivial: which files");
            check(!GateDecider.isTrivialQuestion("explain the call graph"), "non-trivial question");

            // line counting
            var f = tmp.resolve("lines.txt");
            Files.writeString(f, "1\n2\n3\n");
            check(OffloadCli.countLines(f) == 3, "countLines");

            // ── citation verification ──
            var cf = tmp.resolve("cited.txt");
            Files.writeString(cf, "alpha\nbeta\ngamma\ndelta\n");
            var corpus = java.util.List.of(cf);

            var ok = CitationVerifier.verify("claim [cite: " + cf + ":1-2 \"alpha beta\"]", corpus);
            check(ok.verified() == 1 && ok.unverified() == 0, "citation verified");
            check(ok.hasCitations(), "has citations");
            check(!ok.answer().contains("[unverified]"), "verified citation not tagged");

            var bad = CitationVerifier.verify("claim [cite: " + cf + ":3 \"WRONG\"]", corpus);
            check(bad.unverified() == 1, "quote mismatch is unverified");
            check(bad.answer().contains("[unverified]"), "unverified citation tagged");
            check(bad.citations().get(0).status().equals("quote_mismatch"), "quote mismatch status");

            check(CitationVerifier.verify("[cite: " + cf + ":9-10 \"x\"]", corpus)
                .citations().get(0).status().equals("missing_lines"), "missing lines status");
            check(CitationVerifier.verify("[cite: " + cf + ":4]", corpus)
                .citations().get(0).status().equals("no_quote"), "no quote status");
            check(CitationVerifier.verify("[cite: /nope.ts:1 \"x\"]", corpus)
                .citations().get(0).status().equals("unknown_path"), "unknown path status");
            check(CitationVerifier.verify("[cite: cited.txt:1 \"alpha\"]", corpus).verified() == 1,
                "relative path resolves");

            var none = CitationVerifier.verify("just prose", corpus);
            check(!none.hasCitations(), "no citations detected");
            check(none.answer().contains("[unverified: no citations found]"), "no-citation answer tagged");
        } finally {
            deleteRec(tmp);
        }

        System.out.println("OffloadTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    static void check(boolean cond, String name) {
        if (cond) { passed++; }
        else { failed++; System.out.println("  FAIL: " + name); }
    }

    static void deleteRec(Path p) throws Exception {
        if (!Files.exists(p)) return;
        try (var s = Files.walk(p)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(x -> {
                try { Files.deleteIfExists(x); } catch (Exception ignored) {}
            });
        }
    }
}
