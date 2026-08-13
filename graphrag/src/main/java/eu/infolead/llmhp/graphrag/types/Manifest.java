package eu.infolead.llmhp.graphrag.types;

import java.util.*;

public record Manifest(
    String commit,
    String timestamp,
    String graphragVersion,
    String graphragBinary,
    List<String> dirty
) {

    public String toJson() {
        var sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"commit\": ").append(jsonString(commit)).append(",\n");
        sb.append("  \"timestamp\": ").append(jsonString(timestamp)).append(",\n");
        sb.append("  \"graphrag_version\": ").append(jsonString(graphragVersion)).append(",\n");
        sb.append("  \"graphrag_binary\": ").append(jsonString(graphragBinary)).append(",\n");
        sb.append("  \"dirty\": [");
        for (int i = 0; i < dirty.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(jsonString(dirty.get(i)));
        }
        sb.append("]\n}");
        return sb.toString();
    }

    public static Manifest fromJson(String json) {
        return new Manifest(
            extract(json, "commit"),
            extract(json, "timestamp"),
            extract(json, "graphrag_version"),
            extract(json, "graphrag_binary"),
            extractList(json, "dirty")
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
