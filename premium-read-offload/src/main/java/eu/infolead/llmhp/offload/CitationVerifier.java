package eu.infolead.llmhp.offload;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Mechanically verifies the citations a worker embeds in its answer.
 *
 * <p>The bulk-reader contract requires every claim to end with a citation of
 * the form {@code [cite: <path>:<start>[-<end>] "<quote>"]}. This class resolves
 * the cited path against the corpus the worker was actually given, checks the
 * line range exists, and (when a quote is present) checks the quoted text
 * appears in that range. Citations that do not resolve are annotated
 * {@code [unverified]} in the returned answer, so the main agent can discount a
 * claim instead of trusting a lossy summary blindly — the design doc's #1 risk.
 *
 * <p>Verification is mechanical and deterministic: it checks that a citation
 * <em>resolves</em>, not that the claim it supports is true. A verified citation
 * means "this text really is at these lines"; it does not mean the worker drew
 * the right conclusion.
 */
public final class CitationVerifier {

    /**
     * {@code [cite: path:start[-end] "quote"]}. The quote is optional; path and
     * line range are not. Both straight quotes and backticks are accepted as
     * quote delimiters. The path is matched against the corpus, so a relative
     * path or a bare basename also resolves when unambiguous.
     */
    private static final Pattern CITE = Pattern.compile(
        "\\[cite:\\s*(.+?):(\\d+)(?:-(\\d+))?\\s*(?:[\"`]([^\"`]*)[\"`])?\\s*\\]");

    /** Verdict for one citation. */
    public record Citation(String path, int start, int end, String quote, String status) {}

    /** Annotated answer plus the per-citation verdicts. */
    public record Result(String answer, List<Citation> citations, int total, int verified,
                         int unverified, boolean hasCitations) {}

    private CitationVerifier() {}

    public static Result verify(String answer, List<Path> corpus) {
        var text = answer == null ? "" : answer;
        var citations = new ArrayList<Citation>();
        var lineCache = new HashMap<Path, List<String>>();
        var m = CITE.matcher(text);
        var sb = new StringBuilder();
        int last = 0;
        while (m.find()) {
            int start = Integer.parseInt(m.group(2));
            int end = m.group(3) != null ? Integer.parseInt(m.group(3)) : start;
            var c = check(m.group(1), start, end, m.group(4), corpus, lineCache);
            citations.add(c);
            sb.append(text, last, m.end());
            if (!"verified".equals(c.status())) sb.append(" [unverified]");
            last = m.end();
        }
        sb.append(text.substring(last));
        var annotated = sb.toString();
        boolean has = !citations.isEmpty();
        if (!has && !text.isBlank()) annotated = annotated + "\n\n[unverified: no citations found]";
        int verified = 0;
        for (var c : citations) if ("verified".equals(c.status())) verified++;
        return new Result(annotated, citations, citations.size(), verified, citations.size() - verified, has);
    }

    private static Citation check(String cited, int start, int end, String quote,
                                  List<Path> corpus, Map<Path, List<String>> lineCache) {
        var path = resolve(cited, corpus);
        if (path == null) return new Citation(cited, start, end, quote, "unknown_path");
        List<String> lines;
        try {
            lines = lineCache.computeIfAbsent(path, CitationVerifier::readLines);
        } catch (RuntimeException e) {
            return new Citation(cited, start, end, quote, "unreadable");
        }
        if (lines == null) return new Citation(cited, start, end, quote, "unreadable");
        if (start < 1 || end < start || end > lines.size()) {
            return new Citation(cited, start, end, quote, "missing_lines");
        }
        if (quote == null || quote.isBlank()) {
            return new Citation(cited, start, end, quote, "no_quote");
        }
        var range = String.join("\n", lines.subList(start - 1, end));
        var status = normalize(range).contains(normalize(quote)) ? "verified" : "quote_mismatch";
        return new Citation(cited, start, end, quote, status);
    }

    /** Exact path, then relative suffix, then a unique basename match. */
    static Path resolve(String cited, List<Path> corpus) {
        var c = cited == null ? "" : cited.trim();
        if (c.isEmpty()) return null;
        for (var p : corpus) if (p.toString().equals(c)) return p;
        for (var p : corpus) if (p.toString().endsWith("/" + c)) return p;
        Path byName = null;
        int hits = 0;
        for (var p : corpus) {
            var name = p.getFileName();
            if (name != null && name.toString().equals(c)) { byName = p; hits++; }
        }
        return hits == 1 ? byName : null;
    }

    private static List<String> readLines(Path p) {
        try {
            return Files.readAllLines(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    /** Collapse whitespace runs so reflowed quotes still match. */
    private static String normalize(String s) {
        return s.replaceAll("\\s+", " ").trim();
    }
}
