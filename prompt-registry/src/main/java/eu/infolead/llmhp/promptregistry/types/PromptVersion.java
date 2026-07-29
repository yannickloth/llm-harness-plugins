package eu.infolead.llmhp.promptregistry.types;

import java.time.Instant;
import java.util.regex.Pattern;

public record PromptVersion(
    String name,
    int version,
    String content,
    String author,
    Instant timestamp
) {
    public String slug() {
        return "v%d".formatted(version);
    }

    public String toJson() {
        return """
            {"name":"%s","version":%d,"content":"%s","author":"%s","timestamp":"%s"}"""
            .formatted(escapeJson(name), version, escapeJson(content), escapeJson(author), timestamp.toString());
    }

    public static String escapeJson(String s) {
        if (s == null) return "null";
        var sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\u2028' -> sb.append("\\u2028");
                case '\u2029' -> sb.append("\\u2029");
                default -> {
                    if (c < 0x20) {
                        sb.append("\\u%04x".formatted((int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }

    static final Pattern VALID_NAME = Pattern.compile("[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}");

    public static boolean isValidName(String name) {
        return name != null && VALID_NAME.matcher(name).matches();
    }
}
