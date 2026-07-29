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
