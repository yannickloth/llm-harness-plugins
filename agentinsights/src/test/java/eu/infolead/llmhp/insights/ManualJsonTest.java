package eu.infolead.llmhp.insights;

import java.nio.file.*;
import java.util.*;

public class ManualJsonTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testParseSimple();
        testParseNested();
        testParseArray();
        testParseArrayTopLevel();
        testParseNumbers();
        testParseBooleans();
        testParseNull();
        testParseEscapes();
        testParseUnicode();
        testParseSurrogatePair();
        testParseEmpty();
        testParseInvalidReturnsNull();
        testRoundTrip();
        testEscapeQuotes();
        testEscapeBackslash();
        testEscapeNewline();
        testToJsonMap();
        testToJsonList();
        testToJsonNull();
        testToJsonRecursiveEscaping();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testParseSimple() {
        var result = ManualJson.parse("{\"a\": 1, \"b\": \"hello\"}");
        assertResult("parse simple", result instanceof Map<?, ?> m && m.get("a") instanceof Number n && n.intValue() == 1);
    }

    static void testParseNested() {
        var result = ManualJson.parse("{\"outer\": {\"inner\": 42}}");
        assertResult("parse nested", result instanceof Map<?, ?> m
            && m.get("outer") instanceof Map<?, ?> inner
            && inner.get("inner") instanceof Number n && n.intValue() == 42);
    }

    static void testParseArray() {
        var result = ManualJson.parse("{\"items\": [1, 2, 3]}");
        assertResult("parse array", result instanceof Map<?, ?> m
            && m.get("items") instanceof List<?> l && l.size() == 3);
    }

    static void testParseArrayTopLevel() {
        var result = ManualJson.parse("[1, 2, 3]");
        assertResult("parse array top-level", result instanceof List<?> l && l.size() == 3);
    }

    static void testParseNumbers() {
        var result = ManualJson.parse("{\"int\": 42, \"neg\": -5, \"float\": 3.14, \"exp\": 1e10}");
        assertResult("parse numbers", result instanceof Map<?, ?> m
            && m.get("int") instanceof Number n && n.intValue() == 42
            && m.get("neg") instanceof Number nn && nn.intValue() == -5
            && m.get("float") instanceof Double d && d > 3.13
            && m.get("exp") instanceof Double de && de > 1e9);
    }

    static void testParseBooleans() {
        var result = ManualJson.parse("{\"t\": true, \"f\": false}");
        assertResult("parse bools", result instanceof Map<?, ?> m
            && Boolean.TRUE.equals(m.get("t"))
            && Boolean.FALSE.equals(m.get("f")));
    }

    static void testParseNull() {
        var result = ManualJson.parse("{\"n\": null}");
        assertResult("parse null", result instanceof Map<?, ?> m
            && m.get("n") == null && m.containsKey("n"));
    }

    static void testParseEscapes() {
        var result = ManualJson.parse("{\"tab\": \"a\\tb\", \"newline\": \"a\\nb\", \"slash\": \"a\\/b\", \"quote\": \"a\\\"b\"}");
        assertResult("parse escapes", result instanceof Map<?, ?> m
            && "a\tb".equals(m.get("tab"))
            && "a\nb".equals(m.get("newline"))
            && "a/b".equals(m.get("slash"))
            && "a\"b".equals(m.get("quote")));
    }

    static void testParseUnicode() {
        var result = ManualJson.parse("{\"u\": \"\\u0048\\u0065\\u006c\\u006c\\u006f\"}");
        assertResult("parse unicode", result instanceof Map<?, ?> m
            && "Hello".equals(m.get("u")));
    }

    static void testParseSurrogatePair() {
        var result = ManualJson.parse("{\"emoji\": \"\\uD83D\\uDE00\"}");
        assertResult("parse surrogate pair", result instanceof Map<?, ?> m
            && "\uD83D\uDE00".equals(m.get("emoji")));
    }

    static void testParseEmpty() {
        var result = ManualJson.parse("{}");
        assertResult("parse empty object", result instanceof Map<?, ?> m && m.isEmpty());
    }

    static void testParseInvalidReturnsNull() {
        var result = ManualJson.parse("not json at all");
        assertResult("parse invalid returns null", result == null);
    }

    static void testRoundTrip() {
        var map = new LinkedHashMap<String, Object>();
        map.put("name", "test");
        map.put("count", 42);
        map.put("active", true);
        map.put("nothing", null);

        var json = ManualJson.toJson(map);
        var parsed = ManualJson.parse(json);

        assertResult("round trip", parsed instanceof Map<?, ?> m
            && "test".equals(m.get("name"))
            && m.get("count") instanceof Number n && n.intValue() == 42
            && Boolean.TRUE.equals(m.get("active")));
    }

    static void testEscapeQuotes() {
        var json = ManualJson.toJson(Map.of("key", "val\"ue"));
        assertResult("escape quotes", json.contains("\\\""));
    }

    static void testEscapeBackslash() {
        var json = ManualJson.toJson(Map.of("key", "val\\ue"));
        assertResult("escape backslash", json.contains("\\\\"));
    }

    static void testEscapeNewline() {
        var json = ManualJson.toJson(Map.of("key", "line1\nline2"));
        assertResult("escape newline", json.contains("\\n"));
    }

    static void testToJsonMap() {
        var result = ManualJson.toJson(Map.of("a", 1));
        assertResult("toJson map", result.contains("\"a\"") && result.contains("1"));
    }

    static void testToJsonList() {
        var result = ManualJson.toJson(List.of("x", 2, true));
        assertResult("toJson list", result.startsWith("[") && result.endsWith("]"));
    }

    static void testToJsonNull() {
        var result = ManualJson.toJson(null);
        assertResult("toJson null", "null".equals(result));
    }

    static void testToJsonRecursiveEscaping() {
        var inner = Map.of("inner_key", "inner\"val");
        var outer = Map.of("outer", inner);
        var result = ManualJson.toJson(outer);
        var parsed = ManualJson.parse(result);
        assertResult("recursive escaping", parsed instanceof Map<?, ?> m
            && m.get("outer") instanceof Map<?, ?> mi
            && "inner\"val".equals(mi.get("inner_key")));
    }

    static void assertResult(String name, boolean condition) {
        if (condition) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s]\n", name);
        }
    }
}
