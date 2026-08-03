package eu.infolead.llmhp.promptregistry;

import eu.infolead.llmhp.promptregistry.types.PromptVersion;
import eu.infolead.llmhp.promptregistry.types.ABTestResult;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

final class PromptRegistryTest {

    private static int passed = 0;
    private static int failed = 0;
    private Path tmpDir;

    void main(String[] args) throws Exception {
        withFreshRegistry(this::testParseVersionJson);
        withFreshRegistry(this::testCacheScopeRoundtrips);
        withFreshRegistry(this::testJsonRoundtrip);
        withFreshRegistry(this::testSpecialCharactersInPromptName);
        withFreshRegistry(this::testEscapeJsonInjection);

        withFreshRegistry(this::testCommitAndGet);
        withFreshRegistry(this::testCommitMultipleVersions);
        withFreshRegistry(this::testPullSpecificVersion);
        withFreshRegistry(this::testPullLatestViaAutoresolve);
        withFreshRegistry(this::testPullAll);
        withFreshRegistry(this::testPullAllWithToDir);
        withFreshRegistry(this::testListWithoutName);
        withFreshRegistry(this::testListWithName);
        withFreshRegistry(this::testDiff);
        withFreshRegistry(this::testTestVariants);
        withFreshRegistry(this::testActive);
        withFreshRegistry(this::testStatusWithUncommitted);
        withFreshRegistry(this::testStatusClean);
        withFreshRegistry(this::testEmptyRegistry);

        System.out.println("\n---");
        System.out.println("Passed: " + passed + "  Failed: " + failed);
        if (failed > 0) System.exit(1);
    }

    interface TestFn { void run() throws Exception; }

    void withFreshRegistry(TestFn fn) throws Exception {
        var oldDir = tmpDir;
        tmpDir = Files.createTempDirectory("prompt-registry-test");
        try {
            fn.run();
        } finally {
            deleteDir(tmpDir);
            tmpDir = oldDir;
        }
    }

    private Path registryDir() { return tmpDir.resolve("registry"); }

    void testCommitAndGet() throws Exception {
        var store = new RegistryStore(registryDir());
        var v = store.commit("greeting", "Hello, world!", "alice");
        assertThat(v != null, "commit should return version");
        assertThat(v.version() == 1, "first commit should be v1");
        assertThat(v.name().equals("greeting"), "name should be greeting");
        assertThat(v.content().equals("Hello, world!"), "content should match");
        assertThat(v.author().equals("alice"), "author should be alice");
        assertThat(v.cacheScope().equals("global"), "committed version defaults cacheScope to global");

        var fetched = store.getVersion("greeting", 1);
        assertThat(fetched != null, "should fetch v1");
        assertThat(fetched.content().equals("Hello, world!"), "fetched content should match");
        assertThat(fetched.cacheScope().equals("global"), "fetched version retains cacheScope");
    }

    void testCommitMultipleVersions() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("greeting", "v1 content", "alice");
        store.commit("greeting", "v2 content updated", "bob");
        store.commit("greeting", "v3 final", "alice");

        var latest = store.getLatest("greeting");
        assertThat(latest != null, "latest should exist");
        assertThat(latest.version() == 3, "latest should be v3, got " + latest.version());
        assertThat(latest.content().equals("v3 final"), "latest content should match");

        var all = store.versions("greeting");
        assertThat(all.size() == 3, "should have 3 versions, got " + all.size());
        assertThat(all.get(0).version() == 1, "first should be v1");
        assertThat(all.get(2).version() == 3, "third should be v3");
    }

    void testPullSpecificVersion() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("cfg", "config v1", "alice");
        store.commit("cfg", "config v2", "bob");

        var v1 = store.pull("cfg", 1);
        assertThat(v1 != null, "should pull v1");
        assertThat(v1.content().equals("config v1"), "v1 content should match");
        assertThat(v1.version() == 1, "v1 version should be 1");
    }

    void testPullLatestViaAutoresolve() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("greeting", "v1 hello", "alice");
        store.commit("greeting", "v2 hello updated", "bob");

        var v = store.pull("greeting", null);
        assertThat(v != null, "should resolve latest");
        assertThat(v.version() == 2, "should pull latest (v2), got v" + v.version());
    }

    void testPullAll() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("a", "prompt a", "alice");
        store.commit("b", "prompt b", "bob");

        var active = store.getAllActive();
        assertThat(active.size() == 2, "should have 2 active prompts, got " + active.size());
    }

    void testPullAllWithToDir() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("p-a", "prompt a content", "alice");
        store.commit("p-b", "prompt b content", "bob");

        var outDir = tmpDir.resolve("my-plugin");
        var promptsDir = outDir.resolve("prompts");
        var active = store.getAllActive();
        for (var v : active) {
            Files.createDirectories(promptsDir);
            Files.writeString(promptsDir.resolve(v.name() + ".md"), v.content());
        }

        assertThat(Files.isRegularFile(promptsDir.resolve("p-a.md")), "should write p-a.md");
        assertThat(Files.isRegularFile(promptsDir.resolve("p-b.md")), "should write p-b.md");
        assertThat(Files.readString(promptsDir.resolve("p-a.md")).strip().equals("prompt a content"),
            "p-a content should match");
    }

    void testListWithoutName() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("prompt-alpha", "content", "alice");
        store.commit("prompt-beta", "content", "bob");

        var names = store.listNames();
        assertThat(names.contains("prompt-alpha"), "should list prompt-alpha");
        assertThat(names.contains("prompt-beta"), "should list prompt-beta");
        assertThat(names.size() == 2, "should have 2 names, got " + names.size());
    }

    void testListWithName() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("tool-prompt", "v1", "alice");
        store.commit("tool-prompt", "v2", "alice");

        var versions = store.versions("tool-prompt");
        assertThat(versions.size() == 2, "should have 2 versions");
        assertThat(versions.get(0).version() == 1, "first should be v1");
    }

    void testDiff() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("diff-test", "line one\nline two\n", "alice");
        store.commit("diff-test", "line one altered\nline three\n", "alice");

        var v1 = store.getVersion("diff-test", 1);
        var v2 = store.getVersion("diff-test", 2);
        assertThat(v1 != null && v2 != null, "both versions should exist");
        assertThat(!v1.content().equals(v2.content()), "versions should differ");
    }

    void testTestVariants() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("ab-prompt", "variant A content", "alice");
        store.commit("ab-prompt", "variant B content with more details", "bob");

        var result = store.testVariants("ab-prompt", 1, 2);
        assertThat(result != null, "should produce test result");
        assertThat(result.promptName().equals("ab-prompt"), "name should match");
        assertThat(result.variantA() == 1, "variantA should be 1");
        assertThat(result.variantB() == 2, "variantB should be 2");
    }

    void testActive() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("p", "v1", "alice");
        store.commit("p", "v2", "alice");
        store.commit("p", "v3", "bob");

        store.updateActiveVersion("p", 2);
        var active = store.resolveActiveVersion("p");
        assertThat(active == 2, "active version should be 2, got " + active);
    }

    void testStatusWithUncommitted() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("status-test", "original content", "alice");

        var promptsDir = tmpDir.resolve("prompts");
        Files.createDirectories(promptsDir);
        Files.writeString(promptsDir.resolve("status-test.md"), "modified content");

        var changed = RegistryStore.hasUncommittedChanges(promptsDir, store.getLatest("status-test"));
        assertThat(changed, "should detect uncommitted changes");
    }

    void testStatusClean() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("clean-test", "exact content", "alice");

        var promptsDir = tmpDir.resolve("prompts");
        Files.createDirectories(promptsDir);
        Files.writeString(promptsDir.resolve("clean-test.md"), "exact content");

        var changed = RegistryStore.hasUncommittedChanges(promptsDir, store.getLatest("clean-test"));
        assertThat(!changed, "should report no changes for exact match");
    }

    void testEmptyRegistry() throws Exception {
        var store = new RegistryStore(registryDir());
        var names = store.listNames();
        assertThat(names.isEmpty(), "empty registry should have no names");
        assertThat(store.promptCount() == 0, "prompt count should be 0");
        assertThat(store.totalVersions() == 0, "total versions should be 0");
    }

    void testParseVersionJson() throws Exception {
        var now = Instant.now();
        var v = new PromptVersion("test", 1, "hello world", "alice", now);
        var json = v.toJson();
        var parsed = RegistryStore.parseVersionJson(json);
        assertThat(parsed != null, "should parse");
        assertThat(parsed.name().equals("test"), "name should match");
        assertThat(parsed.version() == 1, "version should match");
        assertThat(parsed.content().equals("hello world"), "content should match");
        assertThat(parsed.author().equals("alice"), "author should match");
        assertThat(parsed.cacheScope().equals("global"), "5-arg constructor defaults cacheScope to global");
    }

    void testCacheScopeRoundtrips() throws Exception {
        var org = new PromptVersion("org-test", 1, "content", "alice", Instant.now(), "org");
        var orgJson = org.toJson();
        assertThat(orgJson.contains("\"cacheScope\":\"org\""), "org cacheScope in JSON");
        var orgParsed = RegistryStore.parseVersionJson(orgJson);
        assertThat(orgParsed != null, "org should parse");
        assertThat(orgParsed.cacheScope().equals("org"), "org cacheScope roundtripped");

        var explicitNull = new PromptVersion("null-test", 1, "content", "alice", Instant.now(), null);
        var nullJson = explicitNull.toJson();
        assertThat(nullJson.contains("\"cacheScope\":\"global\""), "null cacheScope coerced to global in JSON");
        var nullParsed = RegistryStore.parseVersionJson(nullJson);
        assertThat(nullParsed != null, "null should parse");
        assertThat(nullParsed.cacheScope().equals("global"), "null cacheScope roundtripped as global");

        var jsonWithoutScope = """
            {"name":"legacy","version":1,"content":"legacy content","author":"alice","timestamp":"%s"}"""
            .formatted(Instant.now().toString());
        var legacyParsed = RegistryStore.parseVersionJson(jsonWithoutScope);
        assertThat(legacyParsed != null, "legacy JSON without cacheScope should parse");
        assertThat(legacyParsed.cacheScope().equals("global"), "legacy JSON defaults cacheScope to global");
    }

    void testJsonRoundtrip() throws Exception {
        var store = new RegistryStore(registryDir());
        var map = new LinkedHashMap<String, Object>();
        map.put("key", "value");
        map.put("num", 42);
        map.put("flag", true);

        var json = store.toJson(map);
        var parsed = RegistryStore.parseSimpleJson(json);
        assertThat("value".equals(parsed.get("key")), "string should roundtrip");
        assertThat(((Number) parsed.get("num")).longValue() == 42L, "number should roundtrip");
        assertThat(Boolean.TRUE.equals(parsed.get("flag")), "boolean should roundtrip");
    }

    void testSpecialCharactersInPromptName() throws Exception {
        var store = new RegistryStore(registryDir());
        store.commit("agent-prompt", "content with backticks `and quotes\"", "alice");
        store.commit("agent-prompt", "content with slashes\\\\and\\\"escapes", "alice");

        var v2 = store.getVersion("agent-prompt", 2);
        assertThat(v2 != null, "should retrieve v2");
        assertThat(v2.content().contains("slashes"), "should contain slashes content");
    }

    void testEscapeJsonInjection() throws Exception {
        var json = RegistryStore.parseVersionJson("""
            {"name":"test","version":1,"content":"line1\\nline2\\ttabbed","author":"al","timestamp":"2026-07-29T00:00:00Z"}""");
        assertThat(json != null, "should parse escaped content");
        assertThat(json.content().equals("line1\nline2\ttabbed"), "should unescape");
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
