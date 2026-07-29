package eu.infolead.llmhp.cache.types;

public record CacheStats(
    long hits,
    long misses,
    long evictions,
    int entryCount,
    long totalSizeBytes
) {
    public static CacheStats empty() {
        return new CacheStats(0, 0, 0, 0, 0);
    }

    public CacheStats withHit() {
        return new CacheStats(hits + 1, misses, evictions, entryCount, totalSizeBytes);
    }

    public CacheStats withMiss() {
        return new CacheStats(hits, misses + 1, evictions, entryCount, totalSizeBytes);
    }

    public CacheStats withEviction(int newCount, long newSizeBytes) {
        return new CacheStats(hits, misses, evictions + 1, newCount, newSizeBytes);
    }

    public CacheStats withEntry(int newCount, long newSizeBytes) {
        return new CacheStats(hits, misses, evictions, newCount, newSizeBytes);
    }

    public double hitRate() {
        var total = hits + misses;
        return total == 0 ? 0.0 : (double) hits / total;
    }

    public String toJson() {
        return """
            {"hits":%d,"misses":%d,"evictions":%d,"entryCount":%d,"totalSizeBytes":%d,"hitRate":%.4f}
            """.formatted(hits, misses, evictions, entryCount, totalSizeBytes, hitRate());
    }
}
