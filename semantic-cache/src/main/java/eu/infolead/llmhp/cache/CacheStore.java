package eu.infolead.llmhp.cache;

import eu.infolead.llmhp.cache.types.CacheEntry;
import eu.infolead.llmhp.cache.types.CacheStats;
import eu.infolead.llmhp.cache.types.Embedding;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.stream.*;

final class CacheStore {

    static final float DEFAULT_THRESHOLD = 0.85f;
    static final long DEFAULT_TTL_SECONDS = 86_400L;
    static final int MAX_ENTRIES = 10_000;
    static final Path CACHE_DIR_NAME = Path.of(".agentmem", "cache");

    private final Path cacheDir;
    private final Embedder embedder;
    private final float threshold;
    private final long ttlSeconds;
    private final int maxEntries;
    private final StatsStore stats;

    CacheStore(Path cacheDir, Embedder embedder, float threshold, long ttlSeconds, int maxEntries) {
        this.cacheDir = cacheDir;
        this.embedder = embedder;
        this.threshold = threshold;
        this.ttlSeconds = ttlSeconds;
        this.maxEntries = maxEntries;
        this.stats = new StatsStore(cacheDir);
    }

    CacheStore(Path cacheDir) {
        this(cacheDir, new Embedder(), DEFAULT_THRESHOLD, DEFAULT_TTL_SECONDS, MAX_ENTRIES);
    }

    record LookupResult(CacheEntry entry, String response, boolean hit, float similarity) {
        static LookupResult miss() { return new LookupResult(null, null, false, -1f); }
    }

    LookupResult lookup(String prompt) throws IOException {
        var start = System.nanoTime();
        try {
            if (prompt == null || prompt.isBlank()) {
                stats.recordLookup(false, -1f, micros(start), 0);
                return LookupResult.miss();
            }

            var embedding = embedder.embed(prompt);
            var entries = loadAll();

            CacheEntry best = null;
            float bestSim = -1f;
            var now = Instant.now();

            for (var e : entries) {
                if (e.isExpiredAt(now)) continue;
                var sim = embedding.cosineSimilarity(e.embedding());
                if (sim > bestSim) {
                    bestSim = sim;
                    best = e;
                }
            }

            var hit = best != null && bestSim >= threshold;
            stats.recordLookup(hit, bestSim, micros(start), hit ? best.response().getBytes(StandardCharsets.UTF_8).length : 0);
            if (hit) {
                return new LookupResult(best, best.response(), true, bestSim);
            }
            return LookupResult.miss();
        } finally {
            // never let a stats persistence failure surface as a lookup error
        }
    }

    void store(String prompt, String response, String source) throws IOException {
        if (prompt == null || prompt.isBlank()) return;
        if (response == null) response = "";

        Files.createDirectories(cacheDir);
        var embedding = embedder.embed(prompt);
        var key = hashKey(prompt);
        var entry = new CacheEntry(key, prompt, response, embedding, Instant.now(), ttlSeconds);

        var tmpDir = cacheDir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("%s.%s".formatted(key, UUID.randomUUID()));

        Files.writeString(tmpFile, serializeEntry(entry));
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) { ch.force(true); }
        Files.move(tmpFile, cacheDir.resolve(key + ".json"),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);

        stats.recordStore(source);
        evictIfNeeded();
    }

    void store(String prompt, String response) throws IOException {
        store(prompt, response, StatsStore.SOURCE_MANUAL);
    }

    private static long micros(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000L;
    }

    void invalidate(String prompt) throws IOException {
        if (prompt == null || prompt.isBlank()) return;
        var key = hashKey(prompt);
        var file = cacheDir.resolve(key + ".json");
        if (Files.exists(file)) Files.delete(file);
    }

    void invalidateAll() throws IOException {
        if (!Files.exists(cacheDir)) return;
        try (var stream = Files.list(cacheDir)) {
            stream.filter(p -> p.getFileName().toString().endsWith(".json"))
                .forEach(p -> { try { Files.delete(p); } catch (IOException ignored) {} });
        }
    }

    CacheStats stats() throws IOException {
        var entries = loadAll();
        var totalSize = 0L;
        for (var e : entries) {
            var file = cacheDir.resolve(e.key() + ".json");
            try { totalSize += Files.size(file); } catch (IOException ignored) {}
        }
        return CacheStats.empty().withEntry(entries.size(), totalSize);
    }

    int entryCount() throws IOException {
        return loadAll().size();
    }

    private void evictIfNeeded() throws IOException {
        if (maxEntries <= 0) return;
        List<CacheEntry> entries;
        var evicted = 0;
        while ((entries = loadAll()).size() > maxEntries) {
            entries.sort(Comparator.comparing(CacheEntry::timestamp));
            var excess = entries.size() - maxEntries;
            for (int i = 0; i < excess; i++) {
                var file = cacheDir.resolve(entries.get(i).key() + ".json");
                try { Files.deleteIfExists(file); evicted++; } catch (IOException ignored) {}
            }
        }
        if (evicted > 0) stats.recordEviction(evicted);
    }

    private List<CacheEntry> loadAll() throws IOException {
        if (!Files.exists(cacheDir)) return List.of();
        List<CacheEntry> result;
        try (var stream = Files.list(cacheDir)) {
            result = stream
                .filter(p -> p.getFileName().toString().endsWith(".json"))
                .map(p -> {
                    try {
                        return deserializeEntry(Files.readString(p));
                    } catch (IOException e) {
                        return null;
                    }
                })
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
        }
        return result;
    }

    static String hashKey(String prompt) {
        var text = prompt.strip();
        long h = 0;
        for (int i = 0; i < text.length(); i++) {
            h = 31 * h + text.charAt(i);
        }
        return Long.toHexString(h < 0 ? -h : h);
    }

    static String serializeEntry(CacheEntry entry) {
        var b64prompt = Base64.getEncoder().encodeToString(entry.prompt().getBytes(StandardCharsets.UTF_8));
        var b64response = Base64.getEncoder().encodeToString(entry.response().getBytes(StandardCharsets.UTF_8));
        var sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"key\": \"%s\",\n".formatted(escapeJson(entry.key())));
        sb.append("  \"prompt\": \"%s\",\n".formatted(b64prompt));
        sb.append("  \"response\": \"%s\",\n".formatted(b64response));
        sb.append("  \"embedding\": \"%s\",\n".formatted(entry.embedding().toSerialized()));
        sb.append("  \"timestamp\": \"%s\",\n".formatted(entry.timestamp().toString()));
        sb.append("  \"ttlSeconds\": %d\n".formatted(entry.ttlSeconds()));
        sb.append("}");
        return sb.toString();
    }

    static CacheEntry deserializeEntry(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
        var inner = trimmed.substring(1, trimmed.length() - 1);

        String key = null, prompt = null, response = null, embeddingStr = null;
        Instant timestamp = Instant.now();
        long ttlSeconds = DEFAULT_TTL_SECONDS;

        var lines = inner.split("\n");
        for (var line : lines) {
            var stripped = line.strip();
            if (stripped.startsWith("\"key\"")) {
                key = extractValue(stripped);
            } else if (stripped.startsWith("\"prompt\"")) {
                var val = extractValue(stripped);
                prompt = new String(Base64.getDecoder().decode(val), StandardCharsets.UTF_8);
            } else if (stripped.startsWith("\"response\"")) {
                var val = extractValue(stripped);
                response = new String(Base64.getDecoder().decode(val), StandardCharsets.UTF_8);
            } else if (stripped.startsWith("\"embedding\"")) {
                embeddingStr = extractValue(stripped);
            } else if (stripped.startsWith("\"timestamp\"")) {
                try { timestamp = Instant.parse(extractValue(stripped)); } catch (Exception ignored) {}
            } else if (stripped.startsWith("\"ttlSeconds\"")) {
                try { ttlSeconds = Long.parseLong(stripped.replaceAll("[^0-9]", "")); } catch (Exception ignored) {}
            }
        }

        if (key == null || embeddingStr == null) return null;
        var embedding = Embedding.fromSerialized(embeddingStr, Embedder.DIMENSION);
        return new CacheEntry(key, prompt != null ? prompt : "", response != null ? response : "",
            embedding, timestamp, ttlSeconds);
    }

    private static String extractValue(String line) {
        var colon = line.indexOf(':');
        if (colon < 0) return "";
        var val = line.substring(colon + 1).strip();
        if (val.endsWith(",")) val = val.substring(0, val.length() - 1).strip();
        if (val.startsWith("\"") && val.endsWith("\"")) val = val.substring(1, val.length() - 1);
        return unescapeJson(val);
    }

    static String escapeJson(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    /** Snapshot of the persisted analytics counters (the enriched `stats` payload). */
    String statsJson() {
        return stats.toJson().strip();
    }

    /** Best-effort parse of a persisted stats file into a snapshot; null on failure. */
    static StatsStore.StatsSnapshot deserializeStats(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
        var inner = trimmed.substring(1, trimmed.length() - 1);
        long hits = 0, misses = 0, nearMisses = 0, evictions = 0, lookups = 0;
        long storesAuto = 0, storesManual = 0, storesFileop = 0;
        long savedResponseBytes = 0, sumLookupMicros = 0;
        long hitHigh = 0, hitMid = 0, hitLow = 0;
        for (var field : inner.split(",")) {
            var f = field.strip();
            if (f.startsWith("\"lookups\"")) lookups = longVal(f);
            else if (f.startsWith("\"hits\"")) hits = longVal(f);
            else if (f.startsWith("\"misses\"")) misses = longVal(f);
            else if (f.startsWith("\"nearMisses\"")) nearMisses = longVal(f);
            else if (f.startsWith("\"evictions\"")) evictions = longVal(f);
            else if (f.startsWith("\"storesAuto\"")) storesAuto = longVal(f);
            else if (f.startsWith("\"storesManual\"")) storesManual = longVal(f);
            else if (f.startsWith("\"storesFileop\"")) storesFileop = longVal(f);
            else if (f.startsWith("\"savedResponseBytes\"")) savedResponseBytes = longVal(f);
            else if (f.startsWith("\"sumLookupMicros\"")) sumLookupMicros = longVal(f);
            else if (f.startsWith("\"hitSimHigh\"")) hitHigh = longVal(f);
            else if (f.startsWith("\"hitSimMid\"")) hitMid = longVal(f);
            else if (f.startsWith("\"hitSimLow\"")) hitLow = longVal(f);
        }
        return new StatsStore.StatsSnapshot(hits, misses, nearMisses, evictions, lookups,
            storesAuto, storesManual, storesFileop, savedResponseBytes, sumLookupMicros,
            hitHigh, hitMid, hitLow);
    }

    private static long longVal(String field) {
        var colon = field.indexOf(':');
        if (colon < 0) return 0;
        var val = field.substring(colon + 1).strip();
        if (val.endsWith(",")) val = val.substring(0, val.length() - 1).strip();
        try { return Long.parseLong(val); } catch (NumberFormatException e) { return 0; }
    }

    static String unescapeJson(String s) {
        return s.replace("\\\"", "\"")
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t")
                .replace("\\\\", "\\");
    }
}
