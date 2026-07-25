package eu.infolead.llmhp.memory;

import eu.infolead.llmhp.memory.types.Confidence;
import eu.infolead.llmhp.memory.types.ModelTier;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

public final class MemoryLifecycle {

    public static int daysUntilStale(String type, Confidence confidence, ModelTier tier) {
        int base = switch (type.toLowerCase()) {
            case "user" -> 90;
            case "feedback" -> 60;
            case "project" -> 14;
            case "reference" -> 30;
            default -> 30;
        };
        return applyModifiers(base, confidence, tier);
    }

    public static int daysUntilPrune(String type, Confidence confidence, ModelTier tier) {
        int base = switch (type.toLowerCase()) {
            case "user" -> 365;
            case "feedback" -> 180;
            case "project" -> 60;
            case "reference" -> 90;
            case "failure", "anomaly" -> 365;
            case "serendipity" -> 180;
            default -> 90;
        };
        return applyModifiers(base, confidence, tier);
    }

    public static void listPruneCandidates(Path memDir) throws IOException {
        var now = Instant.now();
        var pruned = new ArrayList<String>();

        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     try {
                         var raw = Files.readString(f);
                         var fm = parseFrontmatter(raw);
                         var type = fm.getOrDefault("type", "project");
                         var conf = Confidence.fromString(fm.getOrDefault("confidence", "medium"));
                         var tier = parseTier(fm.get("model_tier"));
                         var modified = fm.get("modified");
                         if (modified != null) {
                             var age = Duration.between(Instant.parse(modified), now).toDays();
                             var threshold = daysUntilPrune(type, conf, tier);
                             if (age > threshold)
                                 pruned.add(f.getFileName() + " (age: %dd, threshold: %dd)".formatted(age, threshold));
                         }
                     } catch (Exception ignored) {}
                 });
        }

        if (pruned.isEmpty()) {
            System.out.println("NONE");
        } else {
            for (var p : pruned) System.out.println(p);
        }
    }

    private static int applyModifiers(int baseDays, Confidence confidence, ModelTier tier) {
        double days = baseDays;
        days = switch (confidence) {
            case HIGH -> days * 1.2;
            case MEDIUM -> days;
            case LOW -> days * 0.5;
            case SPECULATIVE -> days * 0.2;
        };
        days = switch (tier) {
            case S -> days;
            case A, B -> days * 0.75;
            case C -> days * 0.3;
            case UNKNOWN -> days * 0.5;
        };
        return Math.max(1, (int) days);
    }

    private static ModelTier parseTier(String s) {
        if (s == null) return ModelTier.UNKNOWN;
        try { return ModelTier.valueOf(s.toUpperCase()); }
        catch (IllegalArgumentException e) { return ModelTier.UNKNOWN; }
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
