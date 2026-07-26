package eu.infolead.llmhp.insights;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public final class CacheManager {

    public record CachePaths(Path sessionMetaDir, Path facetsDir) {}

    public static CachePaths init(Path insightsDir) throws IOException {
        var metaDir = insightsDir.resolve("session-meta");
        var facetsDir = insightsDir.resolve("facets");
        Files.createDirectories(metaDir);
        Files.createDirectories(facetsDir);
        cleanStaleTmpFiles(facetsDir);
        return new CachePaths(metaDir, facetsDir);
    }

    static void cleanStaleTmpFiles(Path dir) {
        try (var files = Files.list(dir)) {
            files.filter(f -> f.getFileName().toString().contains(".tmp"))
                .forEach(f -> {
                    try { Files.deleteIfExists(f); } catch (IOException ignored) {}
                });
        } catch (IOException ignored) {}
    }

    public static Optional<String> loadCachedSessionMeta(Path metaDir, String sessionId) throws IOException {
        var file = metaDir.resolve(sessionId + ".json");
        if (!Files.exists(file)) return Optional.empty();
        return Optional.of(Files.readString(file));
    }

    public static void saveSessionMeta(Path metaDir, String sessionId, String json) throws IOException {
        var file = metaDir.resolve(sessionId + ".json");
        Files.writeString(file, json);
        setPrivate(file);
    }

    public static Optional<String> loadCachedFacets(Path facetsDir, String sessionId) throws IOException {
        var file = facetsDir.resolve(sessionId + ".json");
        if (!Files.exists(file)) return Optional.empty();
        var content = Files.readString(file);
        if (content.isBlank()) {
            try { Files.delete(file); } catch (IOException ignored) {}
            return Optional.empty();
        }
        return Optional.of(content);
    }

    public static void saveFacets(Path facetsDir, String sessionId, String json) throws IOException {
        var file = facetsDir.resolve(sessionId + ".json");
        var tmpFile = facetsDir.resolve(sessionId + ".tmp." + UUID.randomUUID());
        Files.writeString(tmpFile, json);
        try {
            Files.move(tmpFile, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmpFile, file, StandardCopyOption.REPLACE_EXISTING);
        }
        setPrivate(file);
    }

    public static void deleteFacets(Path facetsDir, String sessionId) throws IOException {
        var file = facetsDir.resolve(sessionId + ".json");
        Files.deleteIfExists(file);
    }

    public static void clearAll(Path insightsDir) throws IOException {
        if (Files.exists(insightsDir)) {
            try (var walk = Files.walk(insightsDir)) {
                walk.sorted(Comparator.reverseOrder())
                    .forEach(f -> { try { Files.delete(f); } catch (IOException ignored) {} });
            }
        }
        Files.createDirectories(insightsDir);
    }

    static void setPrivate(Path file) {
        try {
            var f = file.toFile();
            if (!f.setReadable(false, false) || !f.setReadable(true) || !f.setWritable(true)) {
                System.err.println("WARN: Failed to set permissions on " + file);
            }
        } catch (Exception ignored) {}
    }

    public static String insightsDir(String baseDir) {
        return Path.of(baseDir, ".agentmem", "insights").toString();
    }
}
