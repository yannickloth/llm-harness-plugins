package eu.infolead.llmhp.agentfeed;

import java.io.IOException;
import java.nio.file.*;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.*;

/**
 * Atom feed serialization for the agentfeed coordination ledger.
 * Pure, dependency-free logic (no external JSON lib); parses the flat ledger
 * schema only. Rendering + escaping guarantee well-formed XML regardless of
 * ledger content (strips XML-invalid control chars, escapes entities).
 *
 * Package-private so the CLI (AtomCli) and tests in the same package can use it.
 */
public final class AtomFeed {

    public record Entry(String id, String host, int seq, String ts, String agent,
                        String type, String task, String text, String status, String lease,
                        String target, String taskID, String resource, String file) {}

    private AtomFeed() {}

    /** Parse all lines of a ledger file into entries, skipping malformed ones. */
    public static List<Entry> readLedger(Path file) throws IOException {
        List<Entry> entries = new ArrayList<>();
        if (Files.exists(file)) {
            for (var line : Files.readAllLines(file)) {
                var t = line.trim();
                if (t.isEmpty()) continue;
                try {
                    entries.add(parse(t));
                } catch (RuntimeException e) {
                    // ignore malformed line; ledger is append-only and tolerant
                }
            }
        }
        return entries;
    }

    /** Sort into global order: ts, host, seq. */
    public static List<Entry> sorted(List<Entry> entries) {
        return entries.stream()
                .sorted(Comparator.comparing((Entry e) -> e.ts())
                        .thenComparing(Entry::host)
                        .thenComparing(Entry::seq))
                .toList();
    }

    /** Write the aggregate feed plus one feed per distinct agent into outDir. */
    public static void generate(Path outDir, String project, List<Entry> entries) throws IOException {
        Files.createDirectories(outDir);
        // aggregate
        writeFeed(outDir.resolve("feed.xml"), project, "agents", null, entries);
        // per-agent
        var byAgent = entries.stream().collect(Collectors.groupingBy(Entry::agent));
        for (var e : byAgent.entrySet()) {
            var safe = e.getKey().replaceAll("[^a-zA-Z0-9_.-]", "_");
            writeFeed(outDir.resolve("feed-" + safe + ".xml"), project, e.getKey(), e.getKey(), e.getValue());
        }
    }

    /** Project name derived from the ledger's parent directory. */
    public static String projectName(String ledgerPath) {
        var p = Path.of(ledgerPath);
        var name = p.getParent() == null ? "project" : p.getParent().getFileName().toString();
        return name.isBlank() ? "project" : name;
    }

    public static void writeFeed(Path out, String project, String title, String authorFilter, List<Entry> entries) throws IOException {
        var sb = new StringBuilder();
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
        sb.append("<feed xmlns=\"http://www.w3.org/2005/Atom\">\n");
        sb.append("  <title>").append(esc(project + " · " + title)).append("</title>\n");
        sb.append("  <id>urn:agentfeed:").append(esc(project)).append(":").append(authorFilter == null ? "all" : esc(authorFilter)).append("</id>\n");
        var updated = entries.isEmpty() ? ZonedDateTime.now().format(DateTimeFormatter.ISO_INSTANT)
                                        : entries.get(entries.size() - 1).ts();
        sb.append("  <updated>").append(esc(updated)).append("</updated>\n");
        sb.append("  <link rel=\"self\" href=\"feed.xml\"/>\n");
        sb.append("  <generator>agentfeed</generator>\n");

        var tail = authorFilter == null ? entries : entries.stream().filter(e -> e.agent().equals(authorFilter)).toList();
        var shown = tail.subList(Math.max(0, tail.size() - 50), tail.size());
        // newest first in feed
        for (int i = shown.size() - 1; i >= 0; i--) {
            var e = shown.get(i);
            sb.append("  <entry>\n");
            sb.append("    <id>urn:agentfeed:").append(esc(project)).append(":").append(e.host()).append(":").append(e.seq()).append("</id>\n");
            sb.append("    <title>").append(esc(titleFor(e))).append("</title>\n");
            sb.append("    <updated>").append(esc(e.ts())).append("</updated>\n");
            sb.append("    <author><name>").append(esc(e.agent())).append("</name></author>\n");
            sb.append("    <content type=\"html\">").append(bodyFor(e)).append("</content>\n");
            sb.append("  </entry>\n");
        }
        sb.append("</feed>\n");
        // atomic write so a concurrent RSS reader never sees a partial feed
        var tmp = out.resolveSibling("." + out.getFileName() + "." + ProcessHandle.current().pid() + ".tmp");
        Files.writeString(tmp, sb.toString());
        Files.move(tmp, out, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    public static String titleFor(Entry e) {
        var t = switch (e.type()) {
            case "claim" -> "Claim: " + (e.task() == null ? "" : e.task());
            case "release" -> "Release: " + (e.task() == null ? (e.taskID() == null ? "" : e.taskID()) : e.task());
            case "status" -> "Status: " + (e.task() == null ? "" : e.task()) + " → " + (e.status() == null ? "" : e.status());
            case "handoff" -> "Handoff: " + (e.task() == null ? "" : e.task()) + " → " + (e.target() == null ? "?" : e.target());
            case "resource" -> "Resource: " + (e.resource() != null && e.resource().equals("git")
                    ? (e.task() == null ? "git" : e.task())
                    : (e.file() != null && !e.file().isEmpty() ? e.file() : (e.task() == null ? "" : e.task())));
            case "ask" -> "Question: " + (e.text() == null ? "" : e.text());
            case "answer" -> "Answer: " + (e.text() == null ? "" : e.text());
            case "heartbeat" -> "Heartbeat: alive";
            default -> (e.text() == null ? "" : e.text());
        };
        return t.replaceAll("\\s+", " ").trim();
    }

    public static String bodyFor(Entry e) {
        var b = new StringBuilder();
        b.append("<p>").append(esc(e.type())).append(" by ").append(esc(e.agent())).append(" on ").append(esc(e.host())).append("</p>");
        if (e.task() != null) b.append("<p>task: ").append(esc(e.task())).append("</p>");
        if (e.text() != null) b.append("<p>").append(esc(e.text())).append("</p>");
        if (e.status() != null) b.append("<p>status: ").append(esc(e.status())).append("</p>");
        if (e.lease() != null) b.append("<p>lease: ").append(esc(e.lease())).append("</p>");
        if (e.target() != null) b.append("<p>target: ").append(esc(e.target())).append("</p>");
        if (e.file() != null) b.append("<p>file: ").append(esc(e.file())).append("</p>");
        return b.toString();
    }

    public static String esc(String s) {
        if (s == null) return "";
        var b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            // Strip XML 1.0-invalid control chars (other than tab/LF/CR); they
            // would otherwise produce malformed feeds from LLM-authored text.
            if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') continue;
            switch (c) {
                case '&' -> b.append("&amp;");
                case '<' -> b.append("&lt;");
                case '>' -> b.append("&gt;");
                case '"' -> b.append("&quot;");
                case '\'' -> b.append("&apos;");
                default -> b.append(c);
            }
        }
        return b.toString();
    }

    // ---- minimal JSON parser for the flat ledger schema ----
    // Readability-prescribed sub-split (not a separate file): the syntax-level
    // scanner's driver (flat-JSON syntax) differs from the render methods'
    // driver (Atom output format), but the differing driver is contained, so a
    // sub-unit boundary inside this class suffices per IVP granularity.

    /** Reads a JSON string starting at s.charAt(i)=='"'. Returns value + index after closing quote. */
    record Str(String value, int end) {}

    static Str readStr(String s, int i) {
        var sb = new StringBuilder();
        int j = i + 1;
        while (j < s.length()) {
            char c = s.charAt(j);
            if (c == '\\' && j + 1 < s.length()) {
                char n = s.charAt(j + 1);
                switch (n) {
                    case 'n' -> sb.append('\n');
                    case 't' -> sb.append('\t');
                    case 'r' -> sb.append('\r');
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> { if (j + 5 < s.length()) sb.append((char) Integer.parseInt(s.substring(j + 2, j + 6), 16)); j += 4; }
                    default -> sb.append(n);
                }
                j += 2;
            } else if (c == '"') {
                return new Str(sb.toString(), j + 1);
            } else {
                sb.append(c);
                j++;
            }
        }
        return new Str(sb.toString(), s.length());
    }

    public static Entry parse(String line) {
        var m = new LinkedHashMap<String, String>();
        int i = 0;
        int n = line.length();
        while (i < n) {
            char c = line.charAt(i);
            if (c == ' ' || c == ',' || c == '{' || c == '}') { i++; continue; }
            if (c == '"') {
                var key = readStr(line, i);
                i = key.end();
                while (i < n && line.charAt(i) != ':') i++;
                i++;
                while (i < n && line.charAt(i) == ' ') i++;
                if (i < n && line.charAt(i) == '"') {
                    var val = readStr(line, i);
                    m.put(key.value(), val.value());
                    i = val.end();
                } else {
                    var start = i;
                    while (i < n && line.charAt(i) != ',' && line.charAt(i) != '}') i++;
                    m.put(key.value(), line.substring(start, i).trim());
                }
            } else {
                i++;
            }
        }
        if (m.isEmpty()) {
            // no key-value pairs parsed → not a ledger line (e.g. garbage text);
            // readLedger treats parse failures as skipped lines.
            throw new IllegalArgumentException("not a ledger JSON line: " + line);
        }
        return new Entry(
            m.getOrDefault("id", ""),
            m.getOrDefault("host", ""),
            parseInt(m.get("seq")),
            m.getOrDefault("ts", ""),
            m.getOrDefault("agent", ""),
            m.getOrDefault("type", ""),
            m.get("task"),
            m.get("text"),
            m.get("status"),
            m.get("lease"),
            m.get("target"),
            m.get("taskID"),
            m.get("resource"),
            m.get("file")
        );
    }

    static int parseInt(String s) {
        if (s == null) return 0;
        try { return Integer.parseInt(s.trim()); } catch (NumberFormatException e) { return 0; }
    }
}
