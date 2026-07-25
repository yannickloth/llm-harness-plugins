package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class GuardrailEvaluator {

    record GuardMatch(String memoryName, String trigger, String message) {}

    public static String match(Path memDir, String target) throws IOException {
        var matches = new ArrayList<String>();
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     try {
                         var raw = Files.readString(f);
                         var fm = parseFrontmatter(raw);
                         if (!"true".equalsIgnoreCase(fm.get("guard"))) return;
                         var triggers = fm.getOrDefault("guard_trigger", "").split(",\\s*");
                         for (var t : triggers) {
                             if (!t.isBlank() && target.contains(t.trim()))
                                 matches.add("GUARD: %s (%s)".formatted(f.getFileName(), fm.getOrDefault("description", "")));
                         }
                     } catch (IOException ignored) {}
                 });
        }
        return matches.isEmpty() ? "NONE" : String.join("\n", matches);
    }

    public static void listGuards(Path memDir) throws IOException {
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     try {
                         var fm = parseFrontmatter(Files.readString(f));
                         if ("true".equalsIgnoreCase(fm.get("guard")))
                             System.out.printf("%s: %s\n", f.getFileName(), fm.getOrDefault("guard_trigger", "(none)"));
                     } catch (IOException ignored) {}
                 });
        }
    }

    static Map<String, String> parseFrontmatter(String raw) {
        var result = new LinkedHashMap<String, String>();
        var lines = raw.split("\n");
        if (lines.length == 0 || !lines[0].trim().equals("---")) return result;
        for (int i = 1; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.equals("---")) break;
            var colon = line.indexOf(':');
            if (colon > 0) result.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
        }
        return result;
    }
}
