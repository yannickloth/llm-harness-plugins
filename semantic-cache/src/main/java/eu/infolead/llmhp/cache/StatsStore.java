package eu.infolead.llmhp.cache;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.UUID;

/**
 * Persistent, best-effort analytics for the semantic cache.
 *
 * Records hit/miss/eviction/store counters, a token-savings proxy, a hit
 * similarity histogram, and per-request latency. Persisted to a single
 * {@code stats.json} in the cache dir via the same WAL-atomic pattern as cache
 * entries, so the numbers survive daemon restarts. Best-effort: any IO failure
 * leaves the in-memory snapshot intact rather than throwing.
 */
final class StatsStore {

    static final String SOURCE_AUTO = "auto";     // prompt->response pair cached by hooks
    static final String SOURCE_MANUAL = "manual"; // explicit cache-store tool call
    static final String SOURCE_FILEOP = "fileop"; // write/edit outcome

    private final Path file;
    private long hits, misses, nearMisses, evictions, lookups;
    private long storesAuto, storesManual, storesFileop;
    private long savedResponseBytes;
    private long sumLookupMicros;
    private long hitBucketsHigh, hitBucketsMid, hitBucketsLow; // [0.95,1], [0.9,0.95), [0.85,0.9)
    private final Instant startedAt;

    StatsStore(Path cacheDir) {
        this.file = cacheDir.resolve("stats.json");
        this.startedAt = Instant.now();
        load();
    }

    /** Record a lookup outcome. `similarity` is the best cosine sim (or -1 for a blank prompt). */
    synchronized void recordLookup(boolean hit, float similarity, long lookupMicros, int responseBytes) {
        lookups++;
        sumLookupMicros += lookupMicros;
        if (hit) {
            hits++;
            savedResponseBytes += responseBytes;
            if (similarity >= 0.95f) hitBucketsHigh++;
            else if (similarity >= 0.90f) hitBucketsMid++;
            else hitBucketsLow++;
        } else if (similarity >= CacheStore.DEFAULT_THRESHOLD - 0.05f) {
            nearMisses++;
            misses++;
        } else {
            misses++;
        }
        persist();
    }

    synchronized void recordStore(String source) {
        switch (source == null ? SOURCE_MANUAL : source) {
            case SOURCE_AUTO -> storesAuto++;
            case SOURCE_FILEOP -> storesFileop++;
            default -> storesManual++;
        }
        persist();
    }

    synchronized void recordEviction(int evicted) {
        evictions += evicted;
        persist();
    }

    /** Snapshot of the current counters as a JSON object (no leading/trailing whitespace). */
    synchronized String toJson() {
        var total = hits + misses;
        var hitRate = total == 0 ? 0.0 : (double) hits / total;
        var nearMissRate = lookups == 0 ? 0.0 : (double) nearMisses / lookups;
        var avgLookupMs = lookups == 0 ? 0.0 : sumLookupMicros / 1_000_000.0 / lookups;
        var stores = storesAuto + storesManual + storesFileop;
        return """
            {"lookups":%d,"hits":%d,"misses":%d,"nearMisses":%d,"hitRate":%.4f,"nearMissRate":%.4f,\
            "evictions":%d,"stores":%d,"storesAuto":%d,"storesManual":%d,"storesFileop":%d,\
            "savedResponseBytes":%d,"avgLookupMs":%.3f,\
            "hitSimHigh":%d,"hitSimMid":%d,"hitSimLow":%d,\
            "startedAt":"%s","lastActivityAt":"%s"}
            """.formatted(lookups, hits, misses, nearMisses, hitRate, nearMissRate,
                evictions, stores, storesAuto, storesManual, storesFileop,
                savedResponseBytes, avgLookupMs,
                hitBucketsHigh, hitBucketsMid, hitBucketsLow,
                startedAt, Instant.now());
    }

    private void load() {
        if (!Files.exists(file)) return;
        try {
            var text = Files.readString(file);
            var ts = CacheStore.deserializeStats(text);
            if (ts != null) {
                hits = ts.hits; misses = ts.misses; nearMisses = ts.nearMisses;
                evictions = ts.evictions; lookups = ts.lookups;
                storesAuto = ts.storesAuto; storesManual = ts.storesManual; storesFileop = ts.storesFileop;
                savedResponseBytes = ts.savedResponseBytes; sumLookupMicros = ts.sumLookupMicros;
                hitBucketsHigh = ts.hitBucketsHigh; hitBucketsMid = ts.hitBucketsMid; hitBucketsLow = ts.hitBucketsLow;
            }
        } catch (IOException ignored) {
            // start from zero on a corrupt/unreadable stats file
        }
    }

    private void persist() {
        try {
            Files.createDirectories(file.getParent());
            var tmp = file.resolveSibling(".tmp." + UUID.randomUUID());
            Files.writeString(tmp, toJson());
            try (var ch = FileChannel.open(tmp, StandardOpenOption.WRITE)) { ch.force(true); }
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) {
            // analytics are best-effort
        }
    }

    /** Immutable snapshot of persisted counters for reload. */
    record StatsSnapshot(long hits, long misses, long nearMisses, long evictions, long lookups,
                         long storesAuto, long storesManual, long storesFileop,
                         long savedResponseBytes, long sumLookupMicros,
                         long hitBucketsHigh, long hitBucketsMid, long hitBucketsLow) {}
}
