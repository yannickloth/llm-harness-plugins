package eu.infolead.llmhp.cache.types;

import java.time.Instant;

public record CacheEntry(
    String key,
    String prompt,
    String response,
    Embedding embedding,
    Instant timestamp,
    long ttlSeconds
) {
    public boolean isExpired() {
        return Instant.now().isAfter(timestamp.plusSeconds(ttlSeconds));
    }

    public boolean isExpired(long maxAgeSeconds) {
        return Instant.now().isAfter(timestamp.plusSeconds(maxAgeSeconds));
    }

    public boolean isExpiredAt(Instant now) {
        return now.isAfter(timestamp.plusSeconds(ttlSeconds));
    }
}
