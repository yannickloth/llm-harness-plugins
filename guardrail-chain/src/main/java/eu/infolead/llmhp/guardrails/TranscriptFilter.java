package eu.infolead.llmhp.guardrails;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class TranscriptFilter {
    static final int MAX_INPUT_BYTES = 10_000_000;
    static final int MAX_MESSAGES = 1000;

    public record FilterResult(String json, int originalCount, int filteredCount, int strippedCount,
                                boolean error, String errorMessage) {
        public static FilterResult ok(String json, int originalCount, int filteredCount, int strippedCount) {
            return new FilterResult(json, originalCount, filteredCount, strippedCount, false, null);
        }
        public static FilterResult err(String message) {
            return new FilterResult("[]", 0, 0, 0, true, message);
        }
    }

    public record Message(String role, String rawJson, boolean hasRole) {}

    public FilterResult filter(String transcriptJson) {
        if (transcriptJson == null || transcriptJson.isBlank()) {
            return FilterResult.ok("[]", 0, 0, 0);
        }

        if (transcriptJson.getBytes(StandardCharsets.UTF_8).length > MAX_INPUT_BYTES) {
            return FilterResult.err("input exceeds max size %d bytes".formatted(MAX_INPUT_BYTES));
        }

        var ctx = new ParseContext(transcriptJson);
        var messages = parseArray(ctx);
        if (ctx.error != null) {
            return FilterResult.err(ctx.error);
        }

        if (messages.size() > MAX_MESSAGES) {
            return FilterResult.err("too many messages: %d (max %d)".formatted(messages.size(), MAX_MESSAGES));
        }

        int originalCount = messages.size();

        var filtered = new ArrayList<Message>();
        for (var msg : messages) {
            if (!msg.hasRole()) {
                continue;
            }
            if (!"assistant".equals(msg.role())) {
                filtered.add(msg);
            }
        }

        int filteredCount = filtered.size();
        int strippedCount = originalCount - filteredCount;

        var sb = new StringBuilder("[");
        for (int i = 0; i < filtered.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(filtered.get(i).rawJson());
        }
        sb.append("]");

        return FilterResult.ok(sb.toString(), originalCount, filteredCount, strippedCount);
    }

    static class ParseContext {
        final String json;
        int pos;
        String error;

        ParseContext(String json) { this.json = json; }

        char peek() { return pos < json.length() ? json.charAt(pos) : 0; }
        void advance() { pos++; }
    }

    private List<Message> parseArray(ParseContext ctx) {
        var messages = new ArrayList<Message>();
        skipWhitespace(ctx);
        if (ctx.peek() != '[') {
            ctx.error = "expected JSON array, got '%s'".formatted(peekStr(ctx));
            return messages;
        }
        ctx.advance();
        skipWhitespace(ctx);

        while (ctx.pos < ctx.json.length() && ctx.peek() != ']') {
            if (messages.size() >= MAX_MESSAGES) break;
            if (ctx.peek() != '{') {
                ctx.error = "expected object in array, got '%s'".formatted(peekStr(ctx));
                return messages;
            }
            int objStart = ctx.pos;
            skipObject(ctx);
            if (ctx.error != null) return messages;
            int objEnd = ctx.pos;

            String rawJson = ctx.json.substring(objStart, objEnd);
            String role = extractRole(rawJson);
            boolean hasRole = role != null;
            if (role == null) role = "";
            messages.add(new Message(role, rawJson, hasRole));

            skipWhitespace(ctx);
            if (ctx.peek() == ',') {
                ctx.advance();
                skipWhitespace(ctx);
            }
        }
        if (ctx.peek() == ']') ctx.advance();
        skipWhitespace(ctx);
        if (ctx.pos < ctx.json.length()) {
            ctx.error = "trailing content after JSON array";
            return messages;
        }
        return messages;
    }

    private String extractRole(String obj) {
        var ctx = new ParseContext(obj);
        skipWhitespace(ctx);
        if (ctx.peek() != '{') return null;
        ctx.advance();

        String lastRole = null;
        while (ctx.pos < ctx.json.length() && ctx.peek() != '}') {
            skipWhitespace(ctx);
            if (ctx.peek() != '"') { skipValue(ctx); }
            else {
                String key = parseString(ctx);
                skipWhitespace(ctx);
                if (ctx.peek() != ':') { skipValue(ctx); }
                else {
                    ctx.advance();
                    skipWhitespace(ctx);
                    if ("role".equals(key)) {
                        if (ctx.peek() == '"') {
                            String val = parseString(ctx);
                            lastRole = val;
                        }
                    } else {
                        skipValue(ctx);
                    }
                }
            }
            skipWhitespace(ctx);
            if (ctx.peek() == ',') ctx.advance();
        }
        if (lastRole != null) {
            lastRole = lastRole.strip().toLowerCase();
        }
        return lastRole;
    }

    private String parseString(ParseContext ctx) {
        if (ctx.peek() != '"') return "";
        ctx.advance();
        var sb = new StringBuilder();
        while (ctx.pos < ctx.json.length()) {
            char c = ctx.peek();
            ctx.advance();
            if (c == '"') return sb.toString();
            if (c == '\\' && ctx.pos < ctx.json.length()) {
                char esc = ctx.peek();
                ctx.advance();
                switch (esc) {
                    case '"', '\\', '/' -> sb.append(esc);
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> {
                        if (ctx.pos + 4 <= ctx.json.length()) {
                            String hex = ctx.json.substring(ctx.pos, ctx.pos + 4);
                            ctx.pos += 4;
                            try { sb.append((char) Integer.parseInt(hex, 16)); } catch (NumberFormatException e) { sb.append('?'); }
                        }
                    }
                    default -> sb.append(esc);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private void skipString(ParseContext ctx) {
        if (ctx.peek() == '"') {
            ctx.advance();
            while (ctx.pos < ctx.json.length()) {
                char c = ctx.peek();
                ctx.advance();
                if (c == '"') return;
                if (c == '\\' && ctx.pos < ctx.json.length()) ctx.advance();
            }
        }
    }

    private void skipValue(ParseContext ctx) {
        skipWhitespace(ctx);
        char c = ctx.peek();
        switch (c) {
            case '"' -> skipString(ctx);
            case '{' -> skipObject(ctx);
            case '[' -> skipArray(ctx);
            case 't', 'f' -> ctx.pos += c == 't' ? 4 : 5;
            case 'n' -> ctx.pos += 4;
            default -> {
                while (ctx.pos < ctx.json.length() && !",}]".contains(String.valueOf(ctx.peek()))) ctx.advance();
            }
        }
    }

    private void skipObject(ParseContext ctx) {
        if (ctx.peek() != '{') return;
        ctx.advance();
        int depth = 1;
        boolean inString = false;
        while (ctx.pos < ctx.json.length() && depth > 0) {
            char c = ctx.peek();
            ctx.advance();
            if (inString) {
                if (c == '\\' && ctx.pos < ctx.json.length()) ctx.advance();
                else if (c == '"') inString = false;
                continue;
            }
            switch (c) {
                case '"' -> inString = true;
                case '{' -> depth++;
                case '}' -> depth--;
            }
        }
    }

    private void skipArray(ParseContext ctx) {
        if (ctx.peek() != '[') return;
        ctx.advance();
        int depth = 1;
        boolean inString = false;
        while (ctx.pos < ctx.json.length() && depth > 0) {
            char c = ctx.peek();
            ctx.advance();
            if (inString) {
                if (c == '\\' && ctx.pos < ctx.json.length()) ctx.advance();
                else if (c == '"') inString = false;
                continue;
            }
            switch (c) {
                case '"' -> inString = true;
                case '[' -> depth++;
                case ']' -> depth--;
            }
        }
    }

    private String readBareValue(ParseContext ctx) {
        var sb = new StringBuilder();
        while (ctx.pos < ctx.json.length() && !",}]".contains(String.valueOf(ctx.peek()))) {
            sb.append(ctx.peek());
            ctx.advance();
        }
        return sb.toString().strip();
    }

    private void skipWhitespace(ParseContext ctx) {
        while (ctx.pos < ctx.json.length() && Character.isWhitespace(ctx.peek())) ctx.advance();
    }

    private String peekStr(ParseContext ctx) {
        return ctx.pos < ctx.json.length() ? String.valueOf(ctx.peek()) : "EOF";
    }

    public static String readStdin() throws IOException {
        try (var reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            var sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString().strip();
        }
    }
}
