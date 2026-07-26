package eu.infolead.llmhp.insights;

import java.nio.file.*;
import java.util.*;

public class CacheManagerTest {
    static int passed = 0, failed = 0;
    static Path tmpDir;

    public static void main(String[] args) throws Exception {
        tmpDir = Files.createTempDirectory("agentinsights-test-");
        try {
            testInitCreatesDirs();
            testSaveAndLoadMeta();
            testSaveAndLoadFacets();
            testLoadAbsentReturnsEmpty();
            testDeleteFacets();
            testClearAll();
            testInsightsDirPath();
        } finally {
            deleteRecursive(tmpDir);
        }

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testInitCreatesDirs() throws Exception {
        var insightsDir = tmpDir.resolve("empty");
        var paths = CacheManager.init(insightsDir);
        assertResult("meta dir created", Files.isDirectory(paths.sessionMetaDir()));
        assertResult("facets dir created", Files.isDirectory(paths.facetsDir()));
    }

    static void testSaveAndLoadMeta() throws Exception {
        var insightsDir = tmpDir.resolve("meta-save");
        var paths = CacheManager.init(insightsDir);

        CacheManager.saveSessionMeta(paths.sessionMetaDir(), "s123", "{\"data\":1}");
        var loaded = CacheManager.loadCachedSessionMeta(paths.sessionMetaDir(), "s123");
        assertResult("meta saved and loaded", loaded.isPresent());
        assertResult("meta content correct", loaded.orElse("").contains("data"));
    }

    static void testSaveAndLoadFacets() throws Exception {
        var insightsDir = tmpDir.resolve("facets-save");
        var paths = CacheManager.init(insightsDir);

        CacheManager.saveFacets(paths.facetsDir(), "s456", "{\"facets\":\"test\"}");
        var loaded = CacheManager.loadCachedFacets(paths.facetsDir(), "s456");
        assertResult("facets saved and loaded", loaded.isPresent());
        assertResult("facets content correct", loaded.orElse("").contains("facets"));
    }

    static void testLoadAbsentReturnsEmpty() throws Exception {
        var insightsDir = tmpDir.resolve("absent");
        var paths = CacheManager.init(insightsDir);

        assertResult("absent meta empty", CacheManager.loadCachedSessionMeta(paths.sessionMetaDir(), "nonexist").isEmpty());
        assertResult("absent facets empty", CacheManager.loadCachedFacets(paths.facetsDir(), "nonexist").isEmpty());
    }

    static void testDeleteFacets() throws Exception {
        var insightsDir = tmpDir.resolve("delete-facets");
        var paths = CacheManager.init(insightsDir);

        CacheManager.saveFacets(paths.facetsDir(), "s789", "{\"f\":1}");
        CacheManager.deleteFacets(paths.facetsDir(), "s789");
        assertResult("facets deleted", CacheManager.loadCachedFacets(paths.facetsDir(), "s789").isEmpty());
    }

    static void testClearAll() throws Exception {
        var insightsDir = tmpDir.resolve("clear-all");
        var paths = CacheManager.init(insightsDir);

        CacheManager.saveSessionMeta(paths.sessionMetaDir(), "a", "{}");
        CacheManager.saveFacets(paths.facetsDir(), "b", "{}");
        Files.writeString(insightsDir.resolve("report.html"), "html");

        CacheManager.clearAll(insightsDir);
        assertResult("clear dir recreated", Files.exists(insightsDir));
        assertResult("report gone", !Files.exists(insightsDir.resolve("report.html")));
        assertResult("meta dir gone", !Files.exists(insightsDir.resolve("session-meta")));
    }

    static void testInsightsDirPath() {
        var path = CacheManager.insightsDir("/home/user/project");
        assertResult("insights dir path", path.contains(".agentmem") && path.contains("insights"));
    }

    static void assertResult(String name, boolean condition) {
        if (condition) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]\n", name);
        }
    }

    static void deleteRecursive(Path dir) throws Exception {
        try (var files = Files.walk(dir)) {
            files.sorted(Comparator.reverseOrder()).forEach(f -> {
                try { Files.delete(f); } catch (Exception ignored) {}
            });
        }
    }
}
