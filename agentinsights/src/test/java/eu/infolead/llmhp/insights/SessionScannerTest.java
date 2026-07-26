package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public class SessionScannerTest {
    static int passed = 0, failed = 0;
    static Path tmpDir;

    public static void main(String[] args) throws Exception {
        tmpDir = Files.createTempDirectory("scanner-test-");
        try {
            testEmptyDir();
            testDiscoverSessions();
            testScanBasicSession();
            testFilterMinimalSession();
            testErrorCategorization();
            testLanguageDetection();
            testTokenCounting();
        } finally {
            deleteRecursive(tmpDir);
        }

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testEmptyDir() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("empty-dir"));
        var result = SessionScanner.discoverSessions(dir);
        assertResult("empty dir returns empty", result.isEmpty());
    }

    static void testDiscoverSessions() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("has-sessions"));
        Files.writeString(dir.resolve("session-a.jsonl"), "{}");
        Files.writeString(dir.resolve("session-b.jsonl"), "{}");
        Files.writeString(dir.resolve("not-session.txt"), "{}");

        var result = SessionScanner.discoverSessions(dir);
        assertIntEq(2, result.size(), "discovers 2 sessions");
    }

    static void testScanBasicSession() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("scan-dir"));
        var ts = Instant.parse("2026-01-01T10:00:00Z");

        var lines = new ArrayList<String>();
        lines.add(json("user", ts, msgWithText("Hello, let me edit some files")));
        lines.add(json("assistant", ts.plusSeconds(10),
            msgWithTool("Write", Map.of("file_path", "src/main/App.java", "content", "hello"), 500, 200)));
        lines.add(json("user", ts.plusSeconds(20), msgWithText("Now write a new file")));
        lines.add(json("assistant", ts.plusSeconds(30),
            msgWithTool("Write", Map.of("file_path", "src/main/Login.java", "content", "package foo;\nclass Login{}"),
                800, 400)));
        lines.add(json("user", ts.plusSeconds(60), msgWithText("Great, looks good")));

        Files.write(dir.resolve("session-001.jsonl"), lines);
        var opt = SessionScanner.scanSession(dir.resolve("session-001.jsonl"));
        assertResult("session scanned", opt.isPresent());

        var meta = opt.get();
        assertIntEq(3, meta.userMessageCount(), "user messages");
        assertIntEq(2, meta.assistantMessageCount(), "assistant messages");
        assertIntEq(2, meta.filesModified(), "files modified");
        assertResult("lines added > 0", meta.linesAdded() > 0);
        assertResult("has Read tool", meta.toolCounts().getOrDefault("Read", 0) == 0);
        assertResult("has Write tool", meta.toolCounts().getOrDefault("Write", 0) == 2);
        assertResult("Java lang", meta.languages().getOrDefault("Java", 0) == 2);
        assertResult("input tokens > 0", meta.inputTokens() > 0);
        assertResult("output tokens > 0", meta.outputTokens() > 0);
    }

    static void testFilterMinimalSession() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("skip-dir"));
        var ts = Instant.parse("2026-01-01T10:00:00Z");
        var lines = new ArrayList<String>();
        lines.add(json("user", ts, msgWithText("hi")));
        lines.add(json("assistant", ts.plusSeconds(5),
            msgWithTool("Read", Map.of("file_path", "file.java"), 10, 5)));

        Files.write(dir.resolve("tiny.jsonl"), lines);
        var opt = SessionScanner.scanSession(dir.resolve("tiny.jsonl"));
        assertResult("tiny session filtered", opt.isEmpty());
    }

    static void testErrorCategorization() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("err-dir"));
        var ts = Instant.parse("2026-01-01T10:00:00Z");
        var lines = new ArrayList<String>();
        lines.add(json("user", ts, msgWithText("Run the build")));
        lines.add(json("assistant", ts.plusSeconds(10), msgWithTool("Bash",
            Map.of("command", "make build"), 50, 10)));
        lines.add(jsonErrToolResult(ts.plusSeconds(15), "Build failed: exit code 1"));
        lines.add(json("user", ts.plusSeconds(20), msgWithText("Try again")));

        Files.write(dir.resolve("errors.jsonl"), lines);
        var opt = SessionScanner.scanSession(dir.resolve("errors.jsonl"));
        assertResult("error session scanned", opt.isPresent());
        assertResult("tool errors > 0", opt.get().toolErrors() > 0);
    }

    static void testLanguageDetection() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("lang-dir"));
        var ts = Instant.parse("2026-01-01T10:00:00Z");
        var lines = new ArrayList<String>();
        lines.add(json("user", ts, msgWithText("Review these")));
        lines.add(json("assistant", ts.plusSeconds(10),
            msgWithTool("Read", Map.of("file_path", "src/app.py"), 100, 50)));
        lines.add(json("assistant", ts.plusSeconds(20),
            msgWithTool("Edit", Map.of("file_path", "src/server.rs",
                "old_string", "x", "new_string", "y"), 200, 100)));
        lines.add(json("user", ts.plusSeconds(30), msgWithText("ok")));

        Files.write(dir.resolve("lang.jsonl"), lines);
        var opt = SessionScanner.scanSession(dir.resolve("lang.jsonl"));
        assertResult("language session scanned", opt.isPresent());
        assertIntEq(1, opt.get().languages().getOrDefault("Python", 0), "python");
        assertIntEq(1, opt.get().languages().getOrDefault("Rust", 0), "rust");
    }

    static void testTokenCounting() throws Exception {
        var dir = Files.createDirectories(tmpDir.resolve("token-dir"));
        var ts = Instant.parse("2026-01-01T10:00:00Z");

        var lines = new ArrayList<String>();
        lines.add(json("user", ts, msgWithText("Hello")));
        lines.add(json("assistant", ts.plusSeconds(10), msgWithTool("Read",
            Map.of("file_path", "f.java"), 1500, 750)));
        lines.add(json("user", ts.plusSeconds(20), msgWithText("Thanks")));

        Files.write(dir.resolve("tokens.jsonl"), lines);
        var opt = SessionScanner.scanSession(dir.resolve("tokens.jsonl"));
        assertResult("token session scanned", opt.isPresent());
        assertResult("input tokens 1500", opt.get().inputTokens() == 1500);
        assertResult("output tokens 750", opt.get().outputTokens() == 750);
    }

    static String json(String type, Instant ts, String messageJson) {
        return "{\"type\":\"" + type + "\",\"timestamp\":\"" + ts + "\",\"message\":" + messageJson + "}";
    }

    static String msgWithText(String text) {
        return "{\"content\":[{\"type\":\"text\",\"text\":\"" + esc(text) + "\"}]}";
    }

    static String msgWithTool(String tool, Map<String, Object> input, int inTokens, int outTokens) {
        var sb = new StringBuilder();
        sb.append("{\"usage\":{\"input_tokens\":").append(inTokens)
            .append(",\"output_tokens\":").append(outTokens)
            .append("},\"content\":[{\"type\":\"tool_use\",\"name\":\"")
            .append(tool).append("\",\"input\":{");
        var first = true;
        for (var e : input.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(e.getKey()).append("\":");
            var val = e.getValue();
            if (val instanceof String s) sb.append("\"").append(esc(s)).append("\"");
            else if (val instanceof Number n) sb.append(n);
            else sb.append("\"").append(esc(val.toString())).append("\"");
        }
        sb.append("}}]}");
        return sb.toString();
    }

    static String jsonErrToolResult(Instant ts, String errorContent) {
        return "{\"type\":\"user\",\"timestamp\":\"" + ts + "\",\"message\":" +
            "{\"content\":[{\"type\":\"tool_result\",\"content\":\"" + esc(errorContent) + "\",\"is_error\":true}]}}";
    }

    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    static void assertResult(String name, boolean condition) {
        if (condition) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]\n", name);
        }
    }

    static void assertIntEq(int expected, int actual, String msg) {
        if (expected == actual) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%d actual=%d\n", msg, expected, actual);
        }
    }

    static void assertIntGt(int actual, int min, String msg) {
        if (actual > min) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected >%d, actual=%d\n", msg, min, actual);
        }
    }

    static void assertEq(long expected, long actual, String msg) {
        if (expected == actual) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected=%d actual=%d\n", msg, expected, actual);
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
