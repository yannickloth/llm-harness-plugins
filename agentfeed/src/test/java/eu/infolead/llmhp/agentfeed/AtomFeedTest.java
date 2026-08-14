import module java.base;

import java.nio.file.*;
import java.util.*;
import eu.infolead.llmhp.agentfeed.AtomFeed;

/**
 * Tests for the AtomFeed serializer. Uses the repo's source-file test harness
 * (top-level void main(); run via `java --class-path build/test-classes <fqn>`).
 */
void main() throws Exception {
    try {
        testEscapesEntities();
        testStripsInvalidControlChars();
        testKeepsTabNewlineCr();
        testParseFlatEntry();
        testParseEscapedQuotes();
        testParseUnicodeEscape();
        testParseMissingFileYieldsEmpty();
        testParseMalformedLineIgnored();
        testTitleForTypes();
        testTitleWhitespaceCollapsed();
        testBodyForEscapes();
        testSortedGlobalOrder();
        testGenerateWritesFeeds();
        testGenerateValidXml();
        testGeneratePerAgentFeeds();
        testGenerateAtomicNoTempLeftovers();
        System.out.println("AtomFeed tests: PASSED");
    } finally {
        cleanupTempDirs();
    }
}

// --- helpers ---

/** Tracked temp dirs for cleanup on exit (never leak /tmp). */
final List<Path> tempDirs = new ArrayList<>();

void cleanupTempDirs() {
    for (var d : tempDirs) {
        try {
            deleteRecursively(d);
        } catch (Exception ignored) {
            // best-effort cleanup
        }
    }
    tempDirs.clear();
}

void deleteRecursively(Path p) throws Exception {
    if (p == null || !Files.exists(p)) return;
    try (var walk = Files.walk(p)) {
        walk.sorted(Comparator.reverseOrder()).forEach(path -> {
            try {
                Files.delete(path);
            } catch (Exception ignored) {
            }
        });
    }
}

void assertTrue(boolean condition, String message) {
    if (!condition) throw new AssertionError("FAIL: " + message);
}

void assertEquals(Object expected, Object actual, String message) {
    if (!expected.equals(actual))
        throw new AssertionError("FAIL: " + message + " — expected " + expected + ", got " + actual);
}

void assertContains(String haystack, String needle, String message) {
    if (!haystack.contains(needle))
        throw new AssertionError("FAIL: " + message + " — " + needle + " not in output");
}

void assertNotContains(String haystack, String needle, String message) {
    if (haystack.contains(needle))
        throw new AssertionError("FAIL: " + message + " — " + needle + " found in output");
}

Path tmpDir(String tag) throws Exception {
    var d = Files.createTempDirectory("agentfeed-test-" + tag + "-");
    tempDirs.add(d);
    return d;
}

AtomFeed.Entry entry(String id, String host, int seq, String ts, String agent, String type,
                     String task, String text, String status, String lease, String target, String taskID) {
    return new AtomFeed.Entry(id, host, seq, ts, agent, type, task, text, status, lease, target, taskID, null, null);
}

// --- escaping ---

void testEscapesEntities() {
    assertEquals("a&amp;b&lt;c&gt;d&quot;e&apos;f", AtomFeed.esc("a&b<c>d\"e'f"), "esc should escape all five XML entities");
}

void testStripsInvalidControlChars() {
    var s = "a\u0001b\u0000c";
    assertEquals("abc", AtomFeed.esc(s), "esc should strip XML-invalid control chars");
}

void testKeepsTabNewlineCr() {
    var s = "a\tb\nc\rd";
    assertTrue(AtomFeed.esc(s).contains("\t"), "esc keeps tab");
    assertTrue(AtomFeed.esc(s).contains("\n"), "esc keeps newline");
    assertTrue(AtomFeed.esc(s).contains("\r"), "esc keeps carriage return");
}

// --- parsing ---

void testParseFlatEntry() {
    var e = AtomFeed.parse("{\"id\":\"mbp:1\",\"host\":\"mbp\",\"seq\":1,\"ts\":\"2026-08-13T22:22:05.000Z\",\"agent\":\"writer\",\"type\":\"claim\",\"task\":\"draft ch.4\",\"status\":\"open\"}");
    assertEquals("mbp:1", e.id(), "parse id");
    assertEquals("mbp", e.host(), "parse host");
    assertEquals(1, e.seq(), "parse seq");
    assertEquals("writer", e.agent(), "parse agent");
    assertEquals("claim", e.type(), "parse type");
    assertEquals("draft ch.4", e.task(), "parse task");
    assertEquals("open", e.status(), "parse status");
}

void testParseEscapedQuotes() {
    var e = AtomFeed.parse("{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"t\",\"agent\":\"x\",\"type\":\"msg\",\"text\":\"note with \\\"quotes\\\" and \\\\ backslash\"}");
    assertEquals("note with \"quotes\" and \\ backslash", e.text(), "parse should unescape \\\" and \\\\");
}

void testParseUnicodeEscape() {
    var e = AtomFeed.parse("{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"t\",\"agent\":\"x\",\"type\":\"msg\",\"text\":\"em-dash \\u2014\"}");
    assertEquals("em-dash —", e.text(), "parse should decode \\u2014");
}

void testParseMissingFileYieldsEmpty() throws Exception {
    var entries = AtomFeed.readLedger(Path.of("/nonexistent/ledger.jsonl"));
    assertTrue(entries.isEmpty(), "missing ledger file yields empty list");
}

void testParseMalformedLineIgnored() throws Exception {
    var f = tmpDir("malformed").resolve("ledger.jsonl");
    Files.writeString(f, "{\"id\":\"a:1\"}\nnot-json\n{\"id\":\"a:2\",\"host\":\"a\",\"seq\":2,\"ts\":\"t\",\"agent\":\"x\",\"type\":\"msg\"}\n");
    var entries = AtomFeed.readLedger(f);
    assertEquals(2, entries.size(), "malformed line should be skipped, valid ones parsed");
}

// --- rendering ---

void testTitleForTypes() {
    assertEquals("Claim: t1", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","claim","t1",null,null,null,null,null)), "claim title");
    assertEquals("Status: t1 → done", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","status","t1","x","done",null,null,null)), "status title");
    assertEquals("Handoff: t1 → b", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","handoff","t1",null,null,null,"b",null)), "handoff title");
    assertEquals("hello world", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","msg",null,"hello world",null,null,null,null)), "msg title from text");
    assertEquals("Resource: git commit",
            AtomFeed.titleFor(new AtomFeed.Entry("a:1","a",1,"t","agent","resource","git commit",null,null,null,null,null,"git","src/a.java")), "git resource title");
    assertEquals("Resource: src/a.java",
            AtomFeed.titleFor(new AtomFeed.Entry("a:1","a",1,"t","agent","resource","edit",null,null,null,null,null,"file","src/a.java")), "file resource title");
    assertEquals("Question: who owns ch.4?", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","ask",null,"who owns ch.4?",null,null,"writer",null)), "ask title");
    assertEquals("Answer: I do", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","answer",null,"I do",null,null,null,"a:1")), "answer title");
    assertEquals("Heartbeat: alive", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","heartbeat",null,null,null,null,null,null)), "heartbeat title");
    assertEquals("Release: t1", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","release","t1",null,null,null,null,null)), "release title");
    assertEquals("Release: a:3", AtomFeed.titleFor(entry("a:1","a",1,"t","agent","release",null,null,null,null,null,"a:3")), "release-by-id title");
}

void testTitleWhitespaceCollapsed() {
    var e = new AtomFeed.Entry("a:1","a",1,"t","agent","msg",null,"line1\nline2\t spaced",null,null,null,null,null,null);
    var t = AtomFeed.titleFor(e);
    assertTrue(!t.contains("\n") && !t.contains("\t"), "title should be single-line");
    assertEquals("line1 line2 spaced", t, "title whitespace collapsed");
}

void testBodyForEscapes() {
    var e = new AtomFeed.Entry("a:1","a",1,"t","agent","msg",null,"a < b & c > d",null,null,null,null,null,null);
    var b = AtomFeed.bodyFor(e);
    assertContains(b, "&lt;", "body escapes <");
    assertContains(b, "&amp;", "body escapes &");
}

// --- ordering ---

void testSortedGlobalOrder() {
    var entries = List.of(
        entry("mbp:2","mbp",2,"2026-08-13T22:22:05.000Z","a","msg",null,"x",null,null,null,null),
        entry("desk:1","desk",1,"2026-08-13T22:22:05.000Z","a","msg",null,"x",null,null,null,null),
        entry("mbp:1","mbp",1,"2026-08-13T22:22:05.000Z","a","msg",null,"x",null,null,null,null),
        entry("desk:2","desk",2,"2026-08-13T22:22:05.000Z","a","msg",null,"x",null,null,null,null)
    );
    var sorted = AtomFeed.sorted(entries);
    assertEquals("desk:1", sorted.get(0).id(), "sort by host then seq");
    assertEquals("desk:2", sorted.get(1).id(), "sort by host then seq");
    assertEquals("mbp:1", sorted.get(2).id(), "sort by host then seq");
    assertEquals("mbp:2", sorted.get(3).id(), "sort by host then seq");
}

// --- generation ---

void testGenerateWritesFeeds() throws Exception {
    var out = tmpDir("gen");
    var f = out.resolve("ledger.jsonl");
    Files.writeString(f, "{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"2026-08-13T22:22:05.000Z\",\"agent\":\"writer\",\"type\":\"claim\",\"task\":\"t1\",\"status\":\"open\"}\n");
    var entries = AtomFeed.readLedger(f);
    AtomFeed.generate(out.resolve("feeds"), "proj", AtomFeed.sorted(entries));
    assertTrue(Files.exists(out.resolve("feeds/feed.xml")), "aggregate feed written");
    assertTrue(Files.exists(out.resolve("feeds/feed-writer.xml")), "per-agent feed written");
}

void testGenerateValidXml() throws Exception {
    var out = tmpDir("valid");
    var f = out.resolve("ledger.jsonl");
    // includes XML-invalid control char and HTML-sensitive chars
    Files.writeString(f, "{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"2026-08-13T22:22:05.000Z\",\"agent\":\"writer\",\"type\":\"msg\",\"text\":\"bad \u0001 <ok> & \"}\n");
    var entries = AtomFeed.readLedger(f);
    AtomFeed.generate(out.resolve("feeds"), "proj", AtomFeed.sorted(entries));
    var xml = Files.readString(out.resolve("feeds/feed.xml"));
    // ensure no raw control char remains and entities are escaped
    assertNotContains(xml, "\u0001", "control char stripped from feed");
    assertContains(xml, "&lt;ok&gt;", "angle brackets escaped");
    assertContains(xml, "&amp;", "ampersand escaped");
}

void testGeneratePerAgentFeeds() throws Exception {
    var out = tmpDir("peragent");
    var f = out.resolve("ledger.jsonl");
    Files.writeString(f, ""
        + "{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"2026-08-13T22:22:05.000Z\",\"agent\":\"alice\",\"type\":\"msg\",\"text\":\"hi\"}\n"
        + "{\"id\":\"b:1\",\"host\":\"b\",\"seq\":1,\"ts\":\"2026-08-13T22:22:06.000Z\",\"agent\":\"bob\",\"type\":\"msg\",\"text\":\"hello\"}\n");
    var entries = AtomFeed.readLedger(f);
    AtomFeed.generate(out.resolve("feeds"), "proj", AtomFeed.sorted(entries));
    assertTrue(Files.exists(out.resolve("feeds/feed-alice.xml")), "alice feed exists");
    assertTrue(Files.exists(out.resolve("feeds/feed-bob.xml")), "bob feed exists");
    assertTrue(!Files.exists(out.resolve("feeds/feed-carol.xml")), "no feed for agent with no entries");
}

void testGenerateAtomicNoTempLeftovers() throws Exception {
    var out = tmpDir("atomic");
    var f = out.resolve("ledger.jsonl");
    Files.writeString(f, "{\"id\":\"a:1\",\"host\":\"a\",\"seq\":1,\"ts\":\"2026-08-13T22:22:05.000Z\",\"agent\":\"x\",\"type\":\"msg\",\"text\":\"hi\"}\n");
    var entries = AtomFeed.readLedger(f);
    var feeds = out.resolve("feeds");
    AtomFeed.generate(feeds, "proj", AtomFeed.sorted(entries));
    try (var dir = Files.list(feeds)) {
        var names = dir.map(p -> p.getFileName().toString()).toList();
        for (var n : names) {
            assertTrue(!n.endsWith(".tmp"), "no temp files left: " + n);
        }
    }
}
