package eu.infolead.llmhp.cache;

import eu.infolead.llmhp.cache.types.CacheEntry;
import java.io.*;
import java.nio.file.*;
import java.util.*;

final class InvalidationEngine {

    private final Path cacheDir;

    InvalidationEngine(Path cacheDir) {
        this.cacheDir = cacheDir;
    }

    record FileChangeEvent(Path file, long mtime) {}

    void invalidateForFiles(Iterable<Path> changedFiles) throws IOException {
        if (!Files.exists(cacheDir)) return;

        try (var stream = Files.list(cacheDir)) {
            var toDelete = new ArrayList<Path>();
            for (var entry : (Iterable<Path>) stream::iterator) {
                var name = entry.getFileName().toString();
                if (!name.endsWith(".json")) continue;
                try {
                    var content = Files.readString(entry);
                    var cacheEntry = CacheStore.deserializeEntry(content);
                    if (cacheEntry != null && referencesAnyFile(cacheEntry, changedFiles)) {
                        toDelete.add(entry);
                    }
                } catch (IOException ignored) {}
            }
            for (var p : toDelete) {
                try { Files.delete(p); } catch (IOException ignored) {}
            }
        }
    }

    void invalidateStale(Path projectRoot, long maxAgeSeconds) throws IOException {
        if (!Files.exists(cacheDir)) return;

        try (var stream = Files.list(cacheDir)) {
            var toDelete = new ArrayList<Path>();
            for (var entry : (Iterable<Path>) stream::iterator) {
                var name = entry.getFileName().toString();
                if (!name.endsWith(".json")) continue;
                try {
                    var content = Files.readString(entry);
                    var cacheEntry = CacheStore.deserializeEntry(content);
                    if (cacheEntry == null) {
                        toDelete.add(entry);
                    } else if (cacheEntry.isExpired(maxAgeSeconds)) {
                        toDelete.add(entry);
                    }
                } catch (IOException ignored) {
                    toDelete.add(entry);
                }
            }
            for (var p : toDelete) {
                try { Files.delete(p); } catch (IOException ignored) {}
            }
        }
    }

    private boolean referencesAnyFile(CacheEntry cacheEntry, Iterable<Path> changedFiles) {
        var prompt = cacheEntry.prompt();
        if (prompt == null) return false;
        for (var f : changedFiles) {
            var fname = f.getFileName().toString();
            if (prompt.contains(fname)) return true;
        }
        return false;
    }
}
