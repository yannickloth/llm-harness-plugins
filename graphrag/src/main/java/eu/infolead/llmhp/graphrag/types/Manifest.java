package eu.infolead.llmhp.graphrag.types;

import java.util.*;

/**
 * Lifecycle record of one GraphRAG index, persisted as {@code manifest.json}.
 *
 * <p>Schema 2 adds the completion-gate fields ({@code status} and its companions).
 * Java writes them after a run; the plugin host merges its own fields read-modify-write.
 * A schema-1 manifest (no {@code schema} key) is still readable: every new field
 * falls back to a default, and no optional key is required.
 */
public record Manifest(
    int schema,
    String commit,
    String timestamp,
    String graphragVersion,
    String graphragBinary,
    List<String> dirty,
    List<String> removed,
    boolean fullReindex,
    String status,
    String lastGoodBuild,
    String partialReason,
    String failureReason,
    int consecutiveFailures,
    List<String> artifactsPresent
) {

    /** Schema written by this class. */
    public static final int SCHEMA_VERSION = 2;
    /** Schema of a manifest written before the gate fields existed. */
    public static final int LEGACY_SCHEMA_VERSION = 1;
    /** Status reported for a manifest that carries no status of its own. */
    public static final String STATUS_UNKNOWN = "unknown";

    public Manifest {
        Objects.requireNonNull(dirty, "dirty");
        Objects.requireNonNull(removed, "removed");
        Objects.requireNonNull(artifactsPresent, "artifactsPresent");
        dirty = List.copyOf(dirty);
        removed = List.copyOf(removed);
        artifactsPresent = List.copyOf(artifactsPresent);
    }

    /**
     * Legacy five-field view. Callers that predate the gate fields keep working;
     * the gate fields take their "nothing recorded yet" defaults.
     */
    public Manifest(String commit, String timestamp, String graphragVersion,
                    String graphragBinary, List<String> dirty) {
        this(SCHEMA_VERSION, commit, timestamp, graphragVersion, graphragBinary, dirty,
            List.of(), false, STATUS_UNKNOWN, null, null, null, 0, List.of());
    }

    public String toJson() {
        return """
            {
              "schema": %d,
              "commit": %s,
              "timestamp": %s,
              "graphrag_version": %s,
              "graphrag_binary": %s,
              "dirty": %s,
              "removed": %s,
              "full_reindex": %s,
              "status": %s,
              "last_good_build": %s,
              "partial_reason": %s,
              "failure_reason": %s,
              "consecutive_failures": %d,
              "artifacts_present": %s
            }""".formatted(
                schema,
                jsonString(commit),
                jsonString(timestamp),
                jsonString(graphragVersion),
                jsonString(graphragBinary),
                jsonArray(dirty),
                jsonArray(removed),
                String.valueOf(fullReindex),
                jsonString(status == null || status.isBlank() ? STATUS_UNKNOWN : status),
                jsonNullable(lastGoodBuild),
                jsonNullable(partialReason),
                jsonNullable(failureReason),
                consecutiveFailures,
                jsonArray(artifactsPresent));
    }

    public static Manifest fromJson(String json) {
        return new Manifest(
            extractInt(json, "schema", LEGACY_SCHEMA_VERSION),
            extract(json, "commit"),
            extract(json, "timestamp"),
            extract(json, "graphrag_version"),
            extract(json, "graphrag_binary"),
            extractList(json, "dirty"),
            extractList(json, "removed"),
            extractBoolean(json, "full_reindex"),
            extractString(json, "status", STATUS_UNKNOWN),
            extractNullable(json, "last_good_build"),
            extractNullable(json, "partial_reason"),
            extractNullable(json, "failure_reason"),
            extractInt(json, "consecutive_failures", 0),
            extractList(json, "artifacts_present")
        );
    }

    private static String jsonString(String s) {
        if (s == null) return "\"\"";
        var sb = new StringBuilder("\"");
        for (var c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** Absent values are written as the JSON literal {@code null}, not as an empty string. */
    private static String jsonNullable(String s) {
        return s == null ? "null" : jsonString(s);
    }

    private static String jsonArray(List<String> values) {
        var sb = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(jsonString(values.get(i)));
        }
        return sb.append(']').toString();
    }

    private static String extract(String json, String key) {
        var pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return "";
        int colon = json.indexOf(':', idx + pattern.length());
        if (colon < 0) return "";
        int start = json.indexOf('"', colon + 1);
        if (start < 0) return "";
        int end = findClosingQuote(json, start);
        return unescape(json.substring(start + 1, end));
    }

    /** Value of a quoted key, or {@code null} when the key is absent or holds the {@code null} literal. */
    private static String extractNullable(String json, String key) {
        var pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return null;
        int colon = json.indexOf(':', idx + pattern.length());
        if (colon < 0) return null;
        int i = skipWhitespace(json, colon + 1);
        if (i >= json.length()) return null;
        if (json.charAt(i) == 'n') return null; // null literal
        if (json.charAt(i) != '"') return null;
        int end = findClosingQuote(json, i);
        var value = unescape(json.substring(i + 1, end));
        return value.isBlank() ? null : value;
    }

    private static String extractString(String json, String key, String fallback) {
        var value = extractNullable(json, key);
        return value == null ? fallback : value;
    }

    private static boolean extractBoolean(String json, String key) {
        var pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return false;
        int colon = json.indexOf(':', idx + pattern.length());
        if (colon < 0) return false;
        int i = skipWhitespace(json, colon + 1);
        return json.startsWith("true", i);
    }

    private static int extractInt(String json, String key, int fallback) {
        var pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return fallback;
        int colon = json.indexOf(':', idx + pattern.length());
        if (colon < 0) return fallback;
        int start = skipWhitespace(json, colon + 1);
        int i = start;
        while (i < json.length() && (Character.isDigit(json.charAt(i)) || json.charAt(i) == '-')) i++;
        if (i == start) return fallback;
        try {
            return Integer.parseInt(json.substring(start, i));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static int skipWhitespace(String json, int from) {
        int i = from;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        return i;
    }

    private static List<String> extractList(String json, String key) {
        var pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return List.of();
        int open = json.indexOf('[', idx);
        int close = json.indexOf(']', open);
        if (open < 0 || close < 0) return List.of();
        var inner = json.substring(open + 1, close);
        var result = new ArrayList<String>();
        int i = 0;
        while (i < inner.length()) {
            int start = inner.indexOf('"', i);
            if (start < 0) break;
            int end = findClosingQuote(inner, start);
            result.add(unescape(inner.substring(start + 1, end)));
            i = end + 1;
        }
        return List.copyOf(result);
    }

    private static int findClosingQuote(String s, int openQuote) {
        for (int i = openQuote + 1; i < s.length(); i++) {
            if (s.charAt(i) == '\\') { i++; continue; }
            if (s.charAt(i) == '"') return i;
        }
        return s.length() - 1;
    }

    private static String unescape(String s) {
        var sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                switch (s.charAt(i + 1)) {
                    case '"' -> { sb.append('"'); i++; }
                    case '\\' -> { sb.append('\\'); i++; }
                    case 'n' -> { sb.append('\n'); i++; }
                    case 't' -> { sb.append('\t'); i++; }
                    default -> sb.append(c);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
