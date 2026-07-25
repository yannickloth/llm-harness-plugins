package eu.infolead.llmhp.memory;

import eu.infolead.llmhp.memory.types.ModelTier;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

public final class ModelTrustTracker {

    record ModelTrust(String modelId, String tier, int written, int corrected, double rate, String trustLevel, String downgradedAt) {}

    static final double SUSPICIOUS_THRESHOLD = 0.05;
    static final double DISTRUSTED_THRESHOLD = 0.15;
    static final int MIN_MEMORIES = 20;

    public static String lookupTier(String modelId) {
        return ModelTier.fromModelId(modelId).label().toUpperCase();
    }

    public static String computeTrust(Path memDir, String modelId) throws IOException {
        var trust = loadTrust(memDir, modelId);
        if (trust.written() < MIN_MEMORIES) return "TRUSTED";
        var rate = (double) trust.corrected() / trust.written();
        if (rate > DISTRUSTED_THRESHOLD) return "DISTRUSTED";
        if (rate > SUSPICIOUS_THRESHOLD) return "SUSPICIOUS";
        return "TRUSTED";
    }

    public static void recordMemory(Path memDir, String modelId) throws IOException {
        var trust = loadTrust(memDir, modelId);
        var updated = new ModelTrust(modelId, ModelTier.fromModelId(modelId).label(),
            trust.written() + 1, trust.corrected(), trust.rate(), trust.trustLevel(), trust.downgradedAt());
        saveTrust(memDir, updated);
        System.out.println("RECORDED");
    }

    public static void recordCorrection(Path memDir, String modelId) throws IOException {
        var trust = loadTrust(memDir, modelId);
        var corrected = trust.corrected() + 1;
        var rate = trust.written() > 0 ? (double) corrected / trust.written() : 0;
        var trustLevel = rate > DISTRUSTED_THRESHOLD ? "DISTRUSTED"
            : rate > SUSPICIOUS_THRESHOLD && trust.written() >= MIN_MEMORIES ? "SUSPICIOUS" : "TRUSTED";
        var downgradedAt = !trustLevel.equals(trust.trustLevel()) ? Instant.now().toString() : trust.downgradedAt();
        var updated = new ModelTrust(modelId, ModelTier.fromModelId(modelId).label(),
            trust.written(), corrected, rate, trustLevel, downgradedAt);
        saveTrust(memDir, updated);
        System.out.printf("CORRECTED trust=%s rate=%.3f\n", trustLevel, rate);
    }

    static ModelTrust loadTrust(Path memDir, String modelId) throws IOException {
        var all = loadAllTrusts(memDir);
        return all.getOrDefault(modelId,
            new ModelTrust(modelId, ModelTier.fromModelId(modelId).label(), 0, 0, 0, "TRUSTED", ""));
    }

    static void saveTrust(Path memDir, ModelTrust trust) throws IOException {
        Map<String, ModelTrust> all;
        try { all = loadAllTrusts(memDir); } catch (IOException e) { all = new HashMap<>(); }
        all.put(trust.modelId(), trust);

        var sb = new StringBuilder("{\n");
        var first = true;
        for (var e : all.entrySet()) {
            if (!first) sb.append(",\n");
            first = false;
            var t = e.getValue();
            sb.append("  \"%s\": {".formatted(esc(t.modelId())));
            sb.append("\"tier\": \"%s\", ".formatted(t.tier()));
            sb.append("\"memories_written\": %d, ".formatted(t.written()));
            sb.append("\"memories_corrected\": %d, ".formatted(t.corrected()));
            sb.append("\"correction_rate\": %.3f, ".formatted(t.rate()));
            sb.append("\"trust_level\": \"%s\"".formatted(t.trustLevel()));
            if (!t.downgradedAt().isEmpty()) sb.append(", \"downgraded_at\": \"%s\"".formatted(t.downgradedAt()));
            sb.append("}");
        }
        sb.append("\n}\n");
        Files.writeString(memDir.resolve(".model-trust.json"), sb.toString());
    }

    static Map<String, ModelTrust> loadAllTrusts(Path memDir) throws IOException {
        var file = memDir.resolve(".model-trust.json");
        if (!Files.exists(file)) return new HashMap<>();
        return parseTrustJson(Files.readString(file));
    }

    static Map<String, ModelTrust> parseTrustJson(String raw) {
        var result = new HashMap<String, ModelTrust>();
        var currentKey = "";
        var insideObject = false;
        var buffer = new StringBuilder();
        var depth = 0;

        for (int i = 0; i < raw.length(); i++) {
            var ch = raw.charAt(i);
            if (ch == '{') {
                depth++;
                if (depth == 1) continue;
                if (depth == 2 && !insideObject) { insideObject = true; buffer.setLength(0); }
                buffer.append(ch);
            } else if (ch == '}') {
                depth--;
                if (depth == 0) continue;
                if (depth == 1 && insideObject) {
                    insideObject = false;
                    try {
                        var fields = parseObjectFields(buffer.toString());
                        result.put(currentKey, new ModelTrust(currentKey,
                            fields.getOrDefault("tier", "UNKNOWN"),
                            Integer.parseInt(fields.getOrDefault("memories_written", "0")),
                            Integer.parseInt(fields.getOrDefault("memories_corrected", "0")),
                            Double.parseDouble(fields.getOrDefault("correction_rate", "0")),
                            fields.getOrDefault("trust_level", "TRUSTED"),
                            fields.getOrDefault("downgraded_at", "")));
                    } catch (Exception e) {}
                    buffer.setLength(0);
                }
            } else if (ch == '"') {
                if (depth == 1) { currentKey = buffer.toString().trim(); buffer.setLength(0); }
                else buffer.append(ch);
            } else if (ch == ':' && depth == 1) { buffer.setLength(0); }
            else if (ch == ',' && depth == 1) { currentKey = ""; buffer.setLength(0); }
            else { buffer.append(ch); }
        }
        return result;
    }

    static Map<String, String> parseObjectFields(String raw) {
        var result = new LinkedHashMap<String, String>();
        var key = ""; var val = new StringBuilder(); var inString = false; var i = 0;
        while (i < raw.length()) {
            var ch = raw.charAt(i++);
            if (ch == '"') { inString = !inString; continue; }
            if (!inString) {
                if (ch == ':') { key = val.toString().trim(); val.setLength(0); }
                else if (ch == ',') { if (!key.isEmpty()) result.put(key, val.toString().trim().replace("\"", "")); key = ""; val.setLength(0); }
                else if (!Character.isWhitespace(ch)) val.append(ch);
            } else { val.append(ch); }
        }
        if (!key.isEmpty()) result.put(key, val.toString().trim().replace("\"", ""));
        return result;
    }

    static String esc(String s) { return s.replace("\\", "\\\\").replace("\"", "\\\""); }
}
