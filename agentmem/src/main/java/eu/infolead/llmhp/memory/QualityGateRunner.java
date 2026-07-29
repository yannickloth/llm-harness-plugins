package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

public final class QualityGateRunner {

    public sealed interface GateResult permits Passed, Warning, Rejected {
        String message();
    }
    public record Passed(String message) implements GateResult {}
    public record Warning(String message) implements GateResult {}
    public record Rejected(String message) implements GateResult {}

    public static void validate(Path memDir, String name, String type, String who,
                                 String context, String hook, String content) throws IOException {
        var errors = new ArrayList<GateResult>();
        errors.add(gate1Frontmatter(name, type, who, context));
        errors.add(gate2SizeBounds(hook, content));
        errors.add(gate3Exclusion(content));
        errors.add(gate4TypeConsistency(type, who, context, content));
        errors.add(gate5Duplicate(name, memDir));
        errors.add(gate6HookQuality(hook));
        errors.add(gate7Secrets(content));

        var rejections = errors.stream().filter(g -> g instanceof Rejected).toList();
        if (!rejections.isEmpty()) {
            for (var r : rejections) System.err.println("REJECTED: " + r.message());
            throw new IllegalArgumentException("Validation failed");
        }

        var warnings = errors.stream().filter(g -> g instanceof Warning).toList();
        for (var w : warnings) System.err.println("WARNING: " + w.message());
    }

    public static void health(Path memDir) throws IOException {
        var issues = new ArrayList<String>();
        var indexPath = memDir.resolve("MEMORY.md");
        var indexRefs = new HashSet<String>();

        if (Files.exists(indexPath)) {
            var index = Files.readString(indexPath).trim();
            if (!index.isEmpty()) {
                var bytes = index.getBytes(StandardCharsets.UTF_8).length;
                var lines = index.split("\n").length;
                if (lines > 150) issues.add("MEMORY.md: %d lines (hard cap 200)".formatted(lines));
                if (bytes > 20_000) issues.add("MEMORY.md: %d bytes (hard cap 25KB)".formatted(bytes));
                var m = Pattern.compile("\\(([^)]+\\.md)\\)").matcher(index);
                while (m.find()) {
                    var linkFile = m.group(1);
                    if (!Files.exists(memDir.resolve(linkFile)))
                        issues.add("Dangling pointer: " + linkFile);
                }
                m = Pattern.compile("\\(([^)]+\\.md)\\)").matcher(index);
                while (m.find()) indexRefs.add(m.group(1));
            }
        }

        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     if (!indexRefs.contains(f.getFileName().toString()))
                         issues.add("Orphaned file: " + f.getFileName());
                 });
        }

        if (issues.isEmpty()) {
            System.out.println("Memory directory healthy.");
        } else {
            System.out.println("Issues found:");
            for (var issue : issues) System.out.println("  - " + issue);
        }
    }

    static GateResult gate1Frontmatter(String name, String type, String who, String context) {
        if (name == null || name.isBlank()) return new Rejected("missing: name");
        if (type == null || type.isBlank()) return new Rejected("missing: type");
        if (who == null || who.isBlank()) return new Rejected("missing: who");
        if (context == null || context.isBlank()) return new Rejected("missing: context");
        return new Passed("OK");
    }

    static GateResult gate2SizeBounds(String hook, String content) {
        if (hook != null && hook.length() > 150)
            return new Rejected("hook %d chars, limit 150".formatted(hook.length()));
        if (content != null && content.getBytes(StandardCharsets.UTF_8).length > 250_000)
            return new Rejected("content exceeds 250KB");
        return new Passed("OK");
    }

    static GateResult gate3Exclusion(String content) {
        if (content == null || content.isBlank()) return new Passed("OK");
        var codePatterns = Pattern.compile("(function\\s+\\w+|class\\s+\\w+\\s*\\{|import\\s+\\{.*}\\s+from|export\\s+(default\\s+)?(function|class|const|let|var))");
        if (codePatterns.matcher(content).find())
            return new Warning("Body may contain code patterns — save only non-obvious decisions");
        return new Passed("OK");
    }

    static GateResult gate4TypeConsistency(String type, String who, String context, String content) {
        if ("user".equalsIgnoreCase(type) && !who.toLowerCase().contains("human"))
            return new Rejected("type: user requires who: Human");
        if ("feedback".equalsIgnoreCase(type)) {
            if (who == null || who.isBlank()) return new Rejected("type: feedback requires who");
            if (context == null || context.isBlank()) return new Rejected("type: feedback requires context");
        }
        if ("reference".equalsIgnoreCase(type) && content != null && !content.matches(".*https?://.*"))
            return new Warning("type: reference should contain a URL");
        return new Passed("OK");
    }

    static GateResult gate5Duplicate(String name, Path memDir) throws IOException {
        if (Files.exists(memDir.resolve(name + ".md")))
            return new Rejected("File %s.md already exists — use contradicts:".formatted(name));
        return new Passed("OK");
    }

    static GateResult gate6HookQuality(String hook) {
        if (hook == null || hook.isBlank()) return new Passed("OK");
        if (hook.length() > 150) return new Rejected("hook %d chars, limit 150".formatted(hook.length()));
        if (hook.contains("```")) return new Warning("Hook should not contain code snippets");
        return new Passed("OK");
    }

    static GateResult gate7Secrets(String content) {
        if (content == null) return new Passed("OK");
        var result = new eu.infolead.llmhp.guardrails.SecretScanner().scan(content);
        if (result instanceof eu.infolead.llmhp.guardrails.types.GuardResult.Block b) {
            return new Rejected("Secret detected — " + b.message());
        }
        return new Passed("OK");
    }
}
