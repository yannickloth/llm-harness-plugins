package eu.infolead.llmhp.cache.types;

/**
 * Snapshot of cache store size/contents for the CLI's `stats` command.
 *
 * Rich usage analytics (hits, misses, hit rate, savings, similarity buckets)
 * live in {@code StatsStore}; this record only carries the current on-disk
 * entry count and total bytes.
 */
public record CacheStats(
    int entryCount,
    long totalSizeBytes
) {
    public static CacheStats empty() {
        return new CacheStats(0, 0);
    }

    public CacheStats withEntry(int newCount, long newSizeBytes) {
        return new CacheStats(newCount, newSizeBytes);
    }

    public String toJson() {
        return """
            {"entryCount":%d,"totalSizeBytes":%d}
            """.formatted(entryCount, totalSizeBytes).strip();
    }
}
