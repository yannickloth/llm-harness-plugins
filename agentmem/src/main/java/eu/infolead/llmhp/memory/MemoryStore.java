package eu.infolead.llmhp.memory;

import eu.infolead.llmhp.memory.types.ModelTier;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;

public final class MemoryStore {

    public record SaveInput(
        String name, String description, String type, Optional<String> subtype,
        String who, String context, String confidence, String content,
        String hook, Optional<String> contradicts, Optional<String> guardTrigger,
        Optional<String> modelId
    ) {
        static final Pattern VALID_NAME = Pattern.compile("[a-zA-Z0-9_-]+");
        public SaveInput {
            if (!VALID_NAME.matcher(name).matches())
                throw new IllegalArgumentException("name must match [a-zA-Z0-9_-]+");
            if (hook != null && hook.length() > 150)
                throw new IllegalArgumentException("hook <=150 chars");
        }
    }

    public static void save(Path memDir, SaveInput input) throws Exception {
        Files.createDirectories(memDir);
        var target = memDir.resolve(input.name() + ".md");
        PathValidator.validate(target, memDir);

        checkIndexSize(memDir);

        var tmpDir = memDir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("%s.%s".formatted(input.name(), UUID.randomUUID()));

        var frontmatter = buildFrontmatter(input);
        var body = input.content();
        if (isProvenanceType(input.type())) {
            body = ensureProvenance(body, input.who(), input.context());
        }

        var fullContent = frontmatter + "\n" + body + "\n";
        Files.writeString(tmpFile, fullContent);
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) { ch.force(true); }
        Files.move(tmpFile, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);

        appendToIndex(memDir, input.name(), input.hook());
        EntityIndex.update(memDir, input.name(), body);
        System.out.println("SAVED " + input.name() + ".md");
        System.out.println(input.hook());
    }

    public static String read(Path memDir, String name) throws IOException {
        var file = memDir.resolve(name.endsWith(".md") ? name : name + ".md");
        if (!Files.exists(file)) return "";
        return Files.readString(file);
    }

    public static void delete(Path memDir, String name) throws IOException {
        var file = memDir.resolve(name.endsWith(".md") ? name : name + ".md");
        if (!Files.exists(file)) throw new NoSuchFileException("NOT_FOUND: " + name);
        var coldDir = memDir.resolve(".cold");
        Files.createDirectories(coldDir);
        Files.move(file, coldDir.resolve(file.getFileName().toString()), StandardCopyOption.REPLACE_EXISTING);
        removeFromIndex(memDir, name);
        System.out.println("FORGOTTEN " + name);
    }

    public static String showIndex(Path memDir) throws IOException {
        var indexPath = memDir.resolve("MEMORY.md");
        if (!Files.exists(indexPath)) return "";
        return Files.readString(indexPath);
    }

    static String buildFrontmatter(SaveInput e) {
        var sb = new StringBuilder();
        sb.append("---\n");
        sb.append("name: %s\n".formatted(e.name()));
        sb.append("description: %s\n".formatted(e.description()));
        sb.append("type: %s\n".formatted(e.type()));
        e.subtype().ifPresent(s -> sb.append("subtype: %s\n".formatted(s)));
        sb.append("who: %s\n".formatted(e.who()));
        sb.append("context: %s\n".formatted(e.context()));
        sb.append("confidence: %s\n".formatted(e.confidence()));
        sb.append("modified: %s\n".formatted(Instant.now().toString()));
        e.contradicts().ifPresent(s -> sb.append("contradicts: %s\n".formatted(s)));
        e.guardTrigger().ifPresent(s -> sb.append("guard_trigger: %s\n".formatted(s)));
        e.modelId().ifPresent(s -> {
            sb.append("model: %s\n".formatted(s));
            sb.append("model_tier: %s\n".formatted(ModelTier.fromModelId(s).label()));
        });
        sb.append("---");
        return sb.toString();
    }

    static boolean isProvenanceType(String type) {
        return "feedback".equalsIgnoreCase(type) || "project".equalsIgnoreCase(type);
    }

    static String ensureProvenance(String content, String who, String context) {
        var lower = content.toLowerCase();
        var sb = new StringBuilder();
        if (!lower.contains("**what")) sb.append("**What:** " + extractWhat(content) + "\n\n");
        if (!lower.contains("**why")) sb.append("**Why:** (see description)\n\n");
        if (!lower.contains("**how to apply")) sb.append("**How to apply:** Apply when " + context + "\n\n");
        if (!lower.contains("**who")) sb.append("**Who:** " + who + "\n\n");
        if (!lower.contains("**context")) sb.append("**Context:** " + context + "\n\n");
        if (sb.isEmpty()) return content;
        return sb.append(content).toString();
    }

    static String extractWhat(String content) {
        var firstLine = content.lines().filter(l -> !l.isBlank()).findFirst().orElse("(see content)");
        return firstLine.length() > 200 ? firstLine.substring(0, 197) + "..." : firstLine;
    }

    static void checkIndexSize(Path memDir) throws IOException {
        var indexPath = memDir.resolve("MEMORY.md");
        if (!Files.exists(indexPath)) return;
        var raw = Files.readString(indexPath).trim();
        if (raw.isEmpty()) return;
        var lines = raw.split("\n").length;
        var bytes = raw.getBytes(StandardCharsets.UTF_8).length;
        if (lines > 200 || bytes > 25_000) {
            var reason = lines > 200 ? "%d lines (limit: 200)".formatted(lines) : "%d bytes (limit: 25KB)".formatted(bytes);
            throw new IOException("REJECTED: MEMORY.md at %s. Run /dream to consolidate.".formatted(reason));
        }
    }

    static void appendToIndex(Path memDir, String name, String hook) throws IOException {
        var indexPath = memDir.resolve("MEMORY.md");
        var line = "- [%s](%s.md) -- %s\n".formatted(capitalize(name), name, hook);
        if (!Files.exists(indexPath)) {
            Files.writeString(indexPath, "# Memory Index\n\n" + line);
        } else {
            var content = Files.readString(indexPath);
            if (content.contains("%s.md)".formatted(name))) return;
            Files.writeString(indexPath, content + line);
        }
    }

    static void removeFromIndex(Path memDir, String name) throws IOException {
        var indexPath = memDir.resolve("MEMORY.md");
        if (!Files.exists(indexPath)) return;
        var stem = name.endsWith(".md") ? name.substring(0, name.length() - 3) : name;
        var content = Files.readString(indexPath);
        var updated = content.lines()
            .filter(line -> !line.contains("(%s.md)".formatted(stem.toLowerCase())))
            .collect(java.util.stream.Collectors.joining("\n"));
        if (!updated.equals(content)) Files.writeString(indexPath, updated);
    }

    static String capitalize(String s) {
        return s.isEmpty() ? s : s.substring(0, 1).toUpperCase() + s.substring(1);
    }

    public static String sha256(String input) {
        try {
            var md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(input.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
