package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class InjectJsonTest {
    static int passed = 0, failed = 0;
    static Path tmpDir;

    public static void main(String[] args) throws Exception {
        tmpDir = Files.createTempDirectory("agentmem-test-");
        try {
            testEmptyDir();
            testNoMemDir();
            testIndexOnly();
            testIndexAndTopicFiles();
            testTruncation();
            testEscaping();
            testEmptyIndex();
            System.out.printf("\n%d passed, %d failed\n", passed, failed);
        } finally {
            deleteRecursive(tmpDir);
        }
        if (failed > 0) System.exit(1);
    }

    static void testEmptyDir() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("empty"));
        var output = runInject(memDir);
        assertEq("", output.trim(), "empty dir returns empty string (no index, no topics)");
    }

    static void testNoMemDir() throws Exception {
        var memDir = tmpDir.resolve("nonexistent");
        var output = runInject(memDir);
        assertEq("{}", output.trim(), "nonexistent dir returns {}");
    }

    static void testIndexOnly() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("index-only"));
        Files.writeString(memDir.resolve("MEMORY.md"), "# Memory Index\n\n- [Foo](foo.md) -- a test hook", StandardCharsets.UTF_8);
        var output = runInject(memDir);
        assertContains("hookSpecificOutput", output, "contains hookSpecificOutput");
        assertContains("Foo", output, "contains index entry");
    }

    static void testIndexAndTopicFiles() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("index-and-topics"));
        Files.writeString(memDir.resolve("MEMORY.md"), "# Index\n- [Alpha](alpha.md) -- alpha hook", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("alpha.md"), "---\nname: alpha\ntype: project\n---\nContent here", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("REVIEW.md"), "should be skipped", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("beta.md"), "---\nname: beta\ntype: feedback\n---\nBeta content", StandardCharsets.UTF_8);
        var output = runInject(memDir);
        assertContains("alpha", output, "contains alpha topic");
        assertContains("beta", output, "contains beta topic");
        assertMissing("REVIEW.md", output, "REVIEW.md excluded from injection");
    }

    static void testTruncation() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("truncation"));
        var content = "x".repeat(10_000);
        Files.writeString(memDir.resolve("MEMORY.md"), "# Index\n- [big](big.md) -- big", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("big.md"), "---\nname: big\ntype: project\n---\n" + content, StandardCharsets.UTF_8);
        var output = runInject(memDir);
        assertContains("truncated", output, "truncated message present in output");
    }

    static void testEscaping() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("escaping"));
        Files.writeString(memDir.resolve("MEMORY.md"), "# Index\n- [Esc](esc.md) -- has \"quotes\" and \\backslash", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("esc.md"), "---\nname: esc\ntype: project\n---\n\"quoted\" \\path\\", StandardCharsets.UTF_8);
        var output = runInject(memDir);
        assertContains("\\\\", output, "backslashes escaped");
        assertContains("\\\"", output, "quotes escaped");
    }

    static void testEmptyIndex() throws Exception {
        var memDir = Files.createDirectories(tmpDir.resolve("empty-index"));
        Files.writeString(memDir.resolve("MEMORY.md"), "", StandardCharsets.UTF_8);
        Files.writeString(memDir.resolve("topic.md"), "---\nname: topic\n---\nbody", StandardCharsets.UTF_8);
        var output = runInject(memDir);
        assertMissing("## Memory Index", output, "empty index not included");
        assertContains("topic", output, "topic file still included");
    }

    static String runInject(Path memDir) throws Exception {
        var process = new ProcessBuilder(
            "java", "--class-path", System.getProperty("java.class.path"),
            "eu.infolead.llmhp.memory.MemorySystemCli", "inject", memDir.toString())
            .redirectErrorStream(true)
            .start();
        var output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        process.waitFor();
        return output;
    }

    static void assertEq(String expected, String actual, String msg) {
        if (expected.equals(actual)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]: expected=%s actual=%s\n", msg, expected, actual);
        }
    }

    static void assertContains(String needle, String haystack, String msg) {
        if (haystack.contains(needle)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]: '%s' not found in output\n", msg, needle);
        }
    }

    static void assertMissing(String needle, String haystack, String msg) {
        if (!haystack.contains(needle)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]: '%s' unexpectedly found in output\n", msg, needle);
        }
    }

    static void deleteRecursive(Path dir) throws IOException {
        try (var files = Files.walk(dir)) {
            files.sorted(java.util.Comparator.reverseOrder()).forEach(f -> {
                try { Files.delete(f); } catch (IOException ignored) {}
            });
        }
    }
}
