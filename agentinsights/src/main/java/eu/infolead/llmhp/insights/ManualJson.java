package eu.infolead.llmhp.insights;

import java.util.*;

public final class ManualJson {

    public static Object parse(String json) {
        json = json.trim();
        if (json.startsWith("{")) {
            var result = new HashMap<String, Object>();
            parseObject(new CharIter(json), result);
            return result;
        }
        if (json.startsWith("[")) {
            var arr = new ArrayList<Object>();
            parseArray(new CharIter(json), arr);
            return arr;
        }
        return null;
    }

    public static String toJson(Object value) {
        if (value instanceof Map<?, ?> m) return toJson(value, 0);
        return toJson(value, 0);
    }

    static String toJson(Object value, int indent) {
        if (value == null) return "null";
        if (value instanceof String s) return "\"" + escape(s) + "\"";
        if (value instanceof Number n) return n.toString();
        if (value instanceof Boolean b) return b.toString();
        if (value instanceof Map<?, ?> m) {
            var sb = new StringBuilder();
            sb.append("{");
            if (!m.isEmpty()) sb.append("\n");
            var first = true;
            var sorted = new TreeMap<String, Object>();
            for (var e : m.entrySet()) sorted.put(e.getKey().toString(), e.getValue());
            for (var entry : sorted.entrySet()) {
                if (!first) sb.append(",\n");
                first = false;
                sb.append("  ".repeat(indent + 1));
                sb.append("\"").append(escape(entry.getKey())).append("\": ");
                sb.append(toJson(entry.getValue(), indent + 1));
            }
            if (!m.isEmpty()) { sb.append("\n"); sb.append("  ".repeat(indent)); }
            sb.append("}");
            return sb.toString();
        }
        if (value instanceof List<?> l) {
            var sb = new StringBuilder();
            sb.append("[");
            var first = true;
            for (var item : l) {
                if (!first) sb.append(", ");
                first = false;
                sb.append(toJson(item, indent + 1));
            }
            sb.append("]");
            return sb.toString();
        }
        return "\"" + escape(value.toString()) + "\"";
    }

    static void parseObject(CharIter it, Map<String, Object> map) {
        it.expect('{');
        while (it.pos < it.chars.length && it.peek() != '}') {
            skipWhitespace(it);
            if (it.peek() == '}') break;
            var key = parseString(it);
            skipWhitespace(it);
            it.expect(':');
            skipWhitespace(it);
            var val = parseValue(it);
            map.put(key, val);
            skipWhitespace(it);
            if (it.pos < it.chars.length && it.peek() == ',') { it.next(); skipWhitespace(it); }
        }
        it.expect('}');
    }

    static Object parseValue(CharIter it) {
        skipWhitespace(it);
        var c = it.peek();
        if (c == '"') return parseString(it);
        if (c == '{') {
            var obj = new HashMap<String, Object>();
            parseObject(it, obj);
            return obj;
        }
        if (c == '[') {
            var arr = new ArrayList<Object>();
            parseArray(it, arr);
            return arr;
        }
        if (c == 't' || c == 'f') return parseBool(it);
        if (c == 'n') { parseNull(it); return null; }
        return parseNumber(it);
    }

    static String parseString(CharIter it) {
        it.expect('"');
        var sb = new StringBuilder();
        var surrogates = new ArrayList<Character>();
        while (it.pos < it.chars.length && it.peek() != '"') {
            if (it.peek() == '\\') {
                it.next();
                var esc = it.next();
                switch (esc) {
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        char u = parseUnicodeRaw(it);
                        if (Character.isHighSurrogate(u)) {
                            surrogates.add(u);
                        } else if (Character.isLowSurrogate(u) && !surrogates.isEmpty()) {
                            sb.append(surrogates.removeLast());
                            sb.append(u);
                        } else {
                            sb.append(u);
                        }
                    }
                    default -> { sb.append('\\'); sb.append(esc); }
                }
            } else {
                sb.append(it.next());
            }
        }
        it.expect('"');
        return sb.toString();
    }

    static char parseUnicodeRaw(CharIter it) {
        if (it.pos + 4 > it.chars.length) {
            throw new RuntimeException("truncated unicode escape at pos " + it.pos);
        }
        var hex = new char[4];
        for (int i = 0; i < 4; i++) hex[i] = it.next();
        try {
            return (char) Integer.parseInt(new String(hex), 16);
        } catch (NumberFormatException e) {
            throw new RuntimeException("invalid unicode escape at pos " + (it.pos - 4));
        }
    }

    static void parseArray(CharIter it, List<Object> arr) {
        it.expect('[');
        skipWhitespace(it);
        while (it.pos < it.chars.length && it.peek() != ']') {
            arr.add(parseValue(it));
            skipWhitespace(it);
            if (it.pos < it.chars.length && it.peek() == ',') { it.next(); skipWhitespace(it); }
        }
        it.expect(']');
    }

    static Object parseNumber(CharIter it) {
        var sb = new StringBuilder();
        while (it.pos < it.chars.length
            && (Character.isDigit(it.peek()) || it.peek() == '.' || it.peek() == '-' || it.peek() == 'e' || it.peek() == 'E' || it.peek() == '+')) {
            sb.append(it.next());
        }
        var s = sb.toString();
        if (s.contains(".") || s.contains("e") || s.contains("E")) return Double.parseDouble(s);
        try { return Long.parseLong(s); } catch (NumberFormatException e) { return Double.parseDouble(s); }
    }

    static boolean parseBool(CharIter it) {
        ensureRemaining(it, "boolean", 4);
        if (it.peek() == 't') { it.next(); it.next(); it.next(); it.next(); return true; }
        ensureRemaining(it, "boolean", 5);
        it.next(); it.next(); it.next(); it.next(); it.next(); return false;
    }

    static void parseNull(CharIter it) {
        ensureRemaining(it, "null", 4);
        it.next(); it.next(); it.next(); it.next();
    }

    static void ensureRemaining(CharIter it, String label, int needed) {
        if (it.pos + needed > it.chars.length) {
            throw new RuntimeException("truncated " + label + " literal at pos " + it.pos);
        }
    }

    static void skipWhitespace(CharIter it) {
        while (it.pos < it.chars.length && Character.isWhitespace(it.peek())) it.next();
    }

    static String escape(String s) {
        var sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }

    static class CharIter {
        final char[] chars;
        int pos;
        CharIter(String s) { this.chars = s.toCharArray(); this.pos = 0; }
        char peek() {
            if (pos >= chars.length) throw new RuntimeException("unexpected end of JSON at " + pos);
            return chars[pos];
        }
        char next() {
            if (pos >= chars.length) throw new RuntimeException("unexpected end of JSON at " + pos);
            return chars[pos++];
        }
        void expect(char c) {
            var actual = next();
            if (actual != c) throw new RuntimeException("expected '" + c + "' at pos " + (pos - 1) + " got '" + actual + "'");
        }
    }
}
