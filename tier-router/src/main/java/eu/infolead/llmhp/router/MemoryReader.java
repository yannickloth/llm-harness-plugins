package eu.infolead.llmhp.router;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

final class MemoryReader {

    private static final Set<String> DOMAIN_KEYWORDS = Set.of(
        "rust", "python", "java", "javascript", "typescript", "go", "golang",
        "c++", "cpp", "c#", "csharp", "kotlin", "swift", "scala", "haskell",
        "elixir", "clojure", "ruby", "php", "perl", "lua", "zig", "nim",
        "terraform", "docker", "kubernetes", "k8s", "helm",
        "react", "vue", "angular", "svelte", "next.js", "nextjs",
        "sql", "postgres", "postgresql", "mysql", "mongodb", "redis",
        "graphql", "grpc", "rest", "websocket",
        "linux", "bash", "shell", "git",
        "ml", "machine learning", "deep learning", "nlp", "llm",
        "android", "ios", "mobile",
        "frontend", "backend", "devops", "devsecops",
        "aws", "azure", "gcp", "cloud",
        "security", "crypto", "cryptography",
        "testing", "tdd", "ci/cd", "cicd"
    );

    private static final Pattern EXPERT_PATTERN = Pattern.compile(
        "\\b(experienced|expert|advanced|proficient|fluent|familiar|skilled|senior)\\b",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern LEARNING_PATTERN = Pattern.compile(
        "\\b(learning|beginner|new to|starting|getting started|exploring|novice|picking up|ramping)\\b",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern PREFERENCE_PATTERN = Pattern.compile(
        "\\b(prefers?|preference|likes?|enjoys?|favorite|style|editor|theme|indent)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static final java.util.Map<String, Pattern> domainPatterns = new java.util.concurrent.ConcurrentHashMap<>();

    private static final String SIGNALS_FILE = "memory-signals.json";
    private static final String FRONTMATTER_DELIM = "---";
    private static final int FRONTMATTER_DELIM_LEN = FRONTMATTER_DELIM.length();

    static List<UserMemorySignal> extract(Path memDir) {
        if (memDir == null || !Files.isDirectory(memDir)) return List.of();
        var signals = new ArrayList<UserMemorySignal>();
        try {
            try (var files = Files.list(memDir)) {
                var markdownFiles = files
                    .filter(f -> f.getFileName().toString().endsWith(".md")
                        && !f.getFileName().toString().equals("MEMORY.md")
                        && !f.getFileName().toString().equals("REVIEW.md"))
                    .toList();
                for (var f : markdownFiles) {
                    try {
                        var content = Files.readString(f);
                        extractFromContent(content, f.getFileName().toString(), signals);
                    } catch (IOException e) {
                        System.err.println("[memory-reader] Error reading " + f + ": " + e.getMessage());
                    }
                }
            }
        } catch (IOException e) {
            System.err.println("[memory-reader] Error listing files in " + memDir + ": " + e.getMessage());
        }
        return deduplicate(signals);
    }

    private static void extractFromContent(String content, String sourceName, List<UserMemorySignal> signals) {
        var frontmatter = parseFrontmatter(content);
        var type = frontmatter.getOrDefault("type", "").toLowerCase();
        if (!"user".equals(type)) return;

        var body = content;
        var bodyLower = body.toLowerCase();

        for (var domain : DOMAIN_KEYWORDS) {
            var pattern = domainBoundaryPattern(domain);
            if (!pattern.matcher(bodyLower).find()) continue;

            Signal signalType = null;
            var who = frontmatter.getOrDefault("who", "").toLowerCase();
            var context = frontmatter.getOrDefault("context", "").toLowerCase();
            var description = frontmatter.getOrDefault("description", "").toLowerCase();

            var signalScan = description + " " + context + " " + who + " " + bodyLower;

            if (LEARNING_PATTERN.matcher(signalScan).find()) {
                signalType = Signal.LEARNING;
            } else if (EXPERT_PATTERN.matcher(signalScan).find()) {
                signalType = Signal.EXPERT;
            } else if (PREFERENCE_PATTERN.matcher(signalScan).find()) {
                signalType = Signal.PREFERENCE;
            } else {
                continue;
            }

            signals.add(new UserMemorySignal(domain, signalType, sourceName));
        }
    }

    static Map<String, String> parseFrontmatter(String content) {
        var map = new HashMap<String, String>();
        if (!content.strip().startsWith(FRONTMATTER_DELIM)) return map;
        var endIdx = content.indexOf(FRONTMATTER_DELIM, FRONTMATTER_DELIM_LEN);
        if (endIdx < 0) return map;
        var fm = content.substring(FRONTMATTER_DELIM_LEN, endIdx);
        for (var line : fm.split("\n")) {
            var kv = line.split(":", 2);
            if (kv.length == 2) map.put(kv[0].strip(), kv[1].strip());
        }
        return map;
    }

    private static List<UserMemorySignal> deduplicate(List<UserMemorySignal> signals) {
        var seen = new HashSet<String>();
        var result = new ArrayList<UserMemorySignal>();
        for (var s : signals) {
            if (seen.add(s.key())) result.add(s);
        }
        return result;
    }

    static String toJson(List<UserMemorySignal> signals) {
        var sb = new StringBuilder("[");
        var first = true;
        for (var s : signals) {
            if (!first) sb.append(",");
            first = false;
            sb.append(recordToJson(s));
        }
        sb.append("]");
        return sb.toString();
    }

    private static String recordToJson(UserMemorySignal s) {
        return """
            {"domain":"%s","signal":"%s","source":"%s"}""".formatted(
            escape(s.domain()), s.signal().name().toLowerCase(), escape(s.source()));
    }

    static List<UserMemorySignal> fromJson(String json) {
        var signals = new ArrayList<UserMemorySignal>();
        if (json == null || json.isBlank()) return signals;
        var trimmed = json.strip();
        if (!trimmed.startsWith("[")) return signals;
        var inner = trimmed.substring(1, trimmed.length() - 1).strip();
        if (inner.isEmpty()) return signals;
        for (var obj : splitJsonObjects(inner)) {
            var domain = extractField(obj, "domain");
            var signalStr = extractField(obj, "signal");
            var source = extractField(obj, "source");
            if (domain.isEmpty() || signalStr.isEmpty()) continue;
            Signal signal;
            try { signal = Signal.valueOf(signalStr.toUpperCase()); }
            catch (IllegalArgumentException e) { continue; }
            signals.add(new UserMemorySignal(domain, signal, source));
        }
        return signals;
    }

    private static List<String> splitJsonObjects(String inner) {
        var objects = new ArrayList<String>();
        var depth = 0;
        var start = -1;
        for (int i = 0; i < inner.length(); i++) {
            var c = inner.charAt(i);
            if (c == '{') {
                if (depth == 0) start = i;
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0 && start >= 0) {
                    objects.add(inner.substring(start, i + 1));
                    start = -1;
                }
            }
        }
        return objects;
    }

    private static String extractField(String obj, String key) {
        var search = "\"" + key + "\":\"";
        var idx = obj.indexOf(search);
        if (idx < 0) return "";
        var start = idx + search.length();
        var end = obj.indexOf("\"", start);
        if (end < 0) return "";
        return obj.substring(start, end);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static Pattern domainBoundaryPattern(String domain) {
        return Pattern.compile("\\b" + Pattern.quote(domain) + "\\b", Pattern.CASE_INSENSITIVE);
    }

    static void saveSignals(Path metricsDir, List<UserMemorySignal> signals) {
        try {
            Files.createDirectories(metricsDir);
            var tmpDir = metricsDir.resolve(".tmp");
            Files.createDirectories(tmpDir);
            var tmpFile = tmpDir.resolve(SIGNALS_FILE + "." + UUID.randomUUID());
            Files.writeString(tmpFile, toJson(signals));
            Files.move(tmpFile, metricsDir.resolve(SIGNALS_FILE),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception e) {
            System.err.println("[memory-reader] Failed to save signals: " + e.getMessage());
        }
    }

    static List<UserMemorySignal> loadSignals(Path metricsDir) {
        try {
            var file = metricsDir.resolve(SIGNALS_FILE);
            if (!Files.exists(file)) return List.of();
            return fromJson(Files.readString(file).strip());
        } catch (Exception e) {
            return List.of();
        }
    }
}
