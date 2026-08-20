package eu.infolead.llmhp.cache;

import eu.infolead.llmhp.cache.types.*;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

final class SemanticCacheTest {

    private static int passed = 0;
    private static int failed = 0;

    void main(String[] args) throws Exception {
        testEmbeddingSimilarity();
        testEmbeddingDissimilarity();
        testEmbeddingEmpty();
        testEmbeddingIdentical();
        testEmbeddingSerialization();
        testCacheStoreAndLookup();
        testCacheMiss();
        testCacheExpiration();
        testCacheInvalidation();
        testCacheStats();
        testInvalidationEngine();
        testCacheSerializationRoundtrip();
        testCacheEviction();
        testHashKey();
        testMultiLinePromptSerialization();
        testDaemonProtocol();
        testDaemonIdleExit();
        testStatsInstrumentation();

        System.out.println("\n---");
        System.out.println("Passed: " + passed + "  Failed: " + failed);
        if (failed > 0) System.exit(1);
    }

    void testEmbeddingSimilarity() {
        var e = new Embedder();
        var a = e.embed("How do I write a unit test in Java?");
        var b = e.embed("What is the best way to write unit tests in Java?");
        var sim = a.cosineSimilarity(b);
        assertThat(sim > 0.7, "similar prompts should have high cosine similarity, got " + sim);
    }

    void testEmbeddingDissimilarity() {
        var e = new Embedder();
        var a = e.embed("Write a unit test for authentication");
        var b = e.embed("Banana pancakes recipe with blueberries");
        var sim = a.cosineSimilarity(b);
        assertThat(sim < 0.5, "dissimilar prompts should have low cosine similarity, got " + sim);
    }

    void testEmbeddingEmpty() {
        var e = new Embedder();
        var a = e.embed("");
        var b = e.embed("hello");
        var sim = a.cosineSimilarity(b);
        assertThat(sim == 0.0, "empty vs non-empty should have zero similarity, got " + sim);
    }

    void testEmbeddingIdentical() {
        var e = new Embedder();
        var a = e.embed("The quick brown fox jumps over the lazy dog");
        var b = e.embed("The quick brown fox jumps over the lazy dog");
        var sim = a.cosineSimilarity(b);
        assertThat(Math.abs(sim - 1.0) < 0.0001, "identical text should have similarity ~1.0, got " + sim);
    }

    void testEmbeddingSerialization() throws Exception {
        var e = new Embedder();
        var emb = e.embed("test serialization");
        var serialized = emb.toSerialized();
        assertThat(serialized.contains(","), "serialized embedding should contain commas");
        var restored = Embedding.fromSerialized(serialized, Embedder.DIMENSION);
        var sim = emb.cosineSimilarity(restored);
        assertThat(Math.abs(sim - 1.0) < 0.0001, "serialized then deserialized should match, got " + sim);
    }

    void testCacheStoreAndLookup() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("What is the capital of France?", "Paris");
            var result = store.lookup("what is the capital of france");
            assertThat(result.hit(), "similar prompt should be a cache hit");
            assertThat(result.response().equals("Paris"), "should return cached response");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testCacheMiss() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("Write a React component", "React component code here");
            var result = store.lookup("Explain quantum computing in simple terms");
            assertThat(!result.hit(), "dissimilar prompt should be a cache miss");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testCacheExpiration() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir, new Embedder(), 0.85f, 0, 1000);
            store.store("test prompt", "test response");
            var result = store.lookup("test prompt");
            assertThat(!result.hit(), "entry with 0 TTL should be expired immediately");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testCacheInvalidation() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("prompt about java streams", "response about streams");
            var result1 = store.lookup("prompt about java streams");
            assertThat(result1.hit(), "should hit after store");

            store.invalidate("prompt about java streams");
            var result2 = store.lookup("prompt about java streams");
            assertThat(!result2.hit(), "should miss after invalidation");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testCacheStats() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("prompt one", "response one");
            store.store("prompt two", "response two");
            var stats = store.stats();
            assertThat(stats.entryCount() == 2, "should have 2 entries, got " + stats.entryCount());
            assertThat(stats.totalSizeBytes() > 0, "totalSizeBytes should be > 0");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testInvalidationEngine() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("edit the file UserService.java to add logging", "ok done");

            var engine = new InvalidationEngine(tmpDir);
            var changed = List.of(Path.of("UserService.java"));
            engine.invalidateForFiles(changed);

            var stats = store.stats();
            assertThat(stats.entryCount() == 0, "should invalidate entries referencing changed files, got " + stats.entryCount());
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testCacheSerializationRoundtrip() {
        var embVec = new float[Embedder.DIMENSION];
        for (int i = 0; i < embVec.length; i++) embVec[i] = (float) i / embVec.length;
        var emb = new Embedding(embVec, Embedder.DIMENSION);
        var original = new CacheEntry("abc123", "test prompt", "test response",
            emb, Instant.parse("2026-07-29T12:00:00Z"), 86400);

        var json = CacheStore.serializeEntry(original);
        var restored = CacheStore.deserializeEntry(json);

        assertThat(restored != null, "deserialized entry should not be null");
        assertThat(restored.key().equals("abc123"), "key mismatch");
        assertThat(restored.prompt().equals("test prompt"), "prompt mismatch");
        assertThat(restored.response().equals("test response"), "response mismatch");
        assertThat(restored.ttlSeconds() == 86400, "ttl mismatch");
        assertThat(restored.timestamp().equals(Instant.parse("2026-07-29T12:00:00Z")), "timestamp mismatch");
    }

    void testCacheEviction() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-test");
        try {
            var store = new CacheStore(tmpDir, new Embedder(), 0.85f, 86400, 5);
            for (int i = 0; i < 10; i++) {
                store.store("prompt number " + i, "response " + i);
            }
            var stats = store.stats();
            assertThat(stats.entryCount() <= 5, "should evict to stay under maxEntries=5, got " + stats.entryCount());
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testHashKey() {
        var key1 = CacheStore.hashKey("hello world");
        var key2 = CacheStore.hashKey("hello world");
        var key3 = CacheStore.hashKey("different");
        assertThat(key1.equals(key2), "same prompt should produce same hash");
        assertThat(!key1.equals(key3), "different prompts should produce different hashes");
    }

    void testMultiLinePromptSerialization() {
        var embVec = new float[Embedder.DIMENSION];
        for (int i = 0; i < embVec.length; i++) embVec[i] = (float) i / embVec.length;
        var emb = new Embedding(embVec, Embedder.DIMENSION);
        var multiLinePrompt = "line one\nline two\nline three";
        var multiLineResponse = "response line a\nresponse line b";
        var original = new CacheEntry("ml123", multiLinePrompt, multiLineResponse,
            emb, Instant.parse("2026-07-29T12:00:00Z"), 86400);

        var json = CacheStore.serializeEntry(original);
        var restored = CacheStore.deserializeEntry(json);

        assertThat(restored != null, "deserialized multi-line entry should not be null");
        assertThat(restored.prompt().equals(multiLinePrompt),
            "multi-line prompt should roundtrip, got: " + restored.prompt());
        assertThat(restored.response().equals(multiLineResponse),
            "multi-line response should roundtrip, got: " + restored.response());
    }

    void testDaemonProtocol() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-daemon-test");
        try {
            var b64 = java.util.Base64.getEncoder();
            var write = new java.io.PrintWriter(tmpDir.resolve("cmds").toFile());
            write.println("store\t" + b64.encodeToString("what is the capital of france".getBytes()) + "\t" + b64.encodeToString("Paris".getBytes()) + "\tauto");
            write.println("lookup\t" + b64.encodeToString("What is the capital of France?".getBytes()));
            write.println("lookup\t" + b64.encodeToString("make a martini".getBytes()));
            write.println("stats");
            write.println("invalidate-files\t" + b64.encodeToString("what is the capital of france".getBytes()));
            write.println("lookup\t" + b64.encodeToString("What is the capital of France?".getBytes()));
            write.println("stats");
            write.println("quit");
            write.flush();
            var result = runDaemon(tmpDir, java.nio.file.Files.readString(tmpDir.resolve("cmds")));
            assertThat(result.contains("\"hit\":true,\"cached_response\":\"Paris\""),
                "daemon lookup should hit and return Paris, got: " + result);
            assertThat(result.contains("\"hit\":false"),
                "daemon lookup should miss for dissimilar prompt, got: " + result);
            assertThat(result.contains("\"lookups\":3"),
                "stats should report 3 lookups (2 initial + 1 after invalidate), got: " + result);
            assertThat(result.contains("\"storesAuto\":1"),
                "stats should attribute the store to the auto source, got: " + result);
            assertThat(result.contains("\"hits\":1"),
                "stats should report 1 hit (second lookup after invalidate misses), got: " + result);
            assertThat(result.contains("\"savedResponseBytes\":"),
                "stats should report saved response bytes, got: " + result);
        } finally {
            deleteDir(tmpDir);
        }
    }

    private String runDaemon(Path cacheDir, String input) throws Exception {
        var classPath = System.getProperty("java.class.path");
        var pb = new ProcessBuilder("java", "--class-path", classPath,
            "eu.infolead.llmhp.cache.SemanticCacheDaemon", cacheDir.toString());
        pb.redirectErrorStream(false);
        var proc = pb.start();
        try (var w = new java.io.OutputStreamWriter(proc.getOutputStream(), java.nio.charset.StandardCharsets.UTF_8)) {
            w.write(input);
        }
        var sb = new StringBuilder();
        try (var r = new java.io.BufferedReader(new java.io.InputStreamReader(proc.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        proc.waitFor();
        return sb.toString();
    }

    void testDaemonIdleExit() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-idle-test");
        try {
            var classPath = System.getProperty("java.class.path");
            var pb = new ProcessBuilder("java", "--class-path", classPath,
                "eu.infolead.llmhp.cache.SemanticCacheDaemon", tmpDir.toString(), "300");
            pb.redirectErrorStream(true);
            var proc = pb.start();

            // Hold stdin OPEN (never close it) to simulate an orphaned parent that
            // died without EOF. Only the idle timeout should terminate the daemon.
            var stdin = proc.getOutputStream();
            try {
                var b64 = java.util.Base64.getEncoder();
                stdin.write(("stats\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                stdin.flush();
            } finally {
                // deliberately do NOT close stdin
            }

            var exited = proc.waitFor(3, java.util.concurrent.TimeUnit.SECONDS);
            stdin.close();
            if (!exited) {
                proc.destroyForcibly();
                proc.waitFor();
            }
            assertThat(exited, "daemon with open stdin should self-exit on idle timeout");
        } finally {
            deleteDir(tmpDir);
        }
    }

    void testStatsInstrumentation() throws Exception {
        var tmpDir = Files.createTempDirectory("semantic-cache-stats-test");
        try {
            var store = new CacheStore(tmpDir);
            store.store("What is the capital of France?", "Paris", eu.infolead.llmhp.cache.StatsStore.SOURCE_AUTO);
            // hit
            var hit = store.lookup("what is the capital of france");
            // clean miss
            store.lookup("how to knit a sweater");
            // near-miss (similar to stored, below threshold)
            store.lookup("what is the capital of France and its population density");

            var json = store.statsJson();
            assertThat(json.contains("\"hits\":1"), "stats should count 1 hit, got: " + json);
            assertThat(json.contains("\"misses\":2"), "stats should count 2 misses, got: " + json);
            assertThat(json.contains("\"storesAuto\":1"), "stats should attribute store to auto, got: " + json);
            assertThat(json.contains("\"hitRate\":0.3333"), "stats should compute hit rate, got: " + json);
            assertThat(hit.hit() && hit.response().equals("Paris"), "instrumented store/lookup should still work");

            // Persistence: a fresh store over the same dir reloads the counters.
            var reloaded = new CacheStore(tmpDir);
            var reloadedJson = reloaded.statsJson();
            assertThat(reloadedJson.contains("\"hits\":1") && reloadedJson.contains("\"storesAuto\":1"),
                "stats should persist across a fresh store instance, got: " + reloadedJson);
        } finally {
            deleteDir(tmpDir);
        }
    }

    void assertThat(boolean condition, String message) {
        if (condition) {
            System.out.println("  PASS: " + message);
            passed++;
        } else {
            System.out.println("  FAIL: " + message);
            failed++;
        }
    }

    void deleteDir(Path dir) throws IOException {
        if (Files.exists(dir)) {
            try (var stream = Files.walk(dir)) {
                stream.sorted(Comparator.reverseOrder()).forEach(p -> {
                    try { Files.delete(p); } catch (IOException ignored) {}
                });
            }
        }
    }
}
