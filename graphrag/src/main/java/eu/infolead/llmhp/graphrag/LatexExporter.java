package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import eu.infolead.llmhp.graphrag.types.SemanticBlock;
import eu.infolead.llmhp.graphrag.types.SemanticBlock.Kind;

public final class LatexExporter {

    private static final Map<String, Kind> ENV_MAP = Map.ofEntries(
        Map.entry("theorem", Kind.THEOREM),
        Map.entry("proposition", Kind.PROPOSITION),
        Map.entry("lemma", Kind.LEMMA),
        Map.entry("corollary", Kind.COROLLARY),
        Map.entry("conjecture", Kind.CONJECTURE),
        Map.entry("definition", Kind.DEFINITION),
        Map.entry("axiom", Kind.AXIOM),
        Map.entry("assumption", Kind.ASSUMPTION),
        Map.entry("remark", Kind.REMARK),
        Map.entry("example", Kind.EXAMPLE),
        Map.entry("proof", Kind.PROOF),
        Map.entry("exercise", Kind.PROSE),
        Map.entry("solution", Kind.SOLUTION)
    );

    private static final Pattern LABEL_PATTERN = Pattern.compile("\\\\label\\{([^}]+)\\}");
    private static final Pattern SECTION_PATTERN =
        Pattern.compile("\\\\(chapter|section|subsection|subsubsection)\\*?\\{([^}]*)\\}");
    private static final Pattern REF_PATTERN =
        Pattern.compile("\\\\(?:ref|cref|Cref|autoref)\\{([^}]+)\\}");

    private final String pandocBinary;

    public LatexExporter(String pandocBinary) {
        this.pandocBinary = pandocBinary;
    }

    public record LatexChunk(
        Kind kind, String label, String name, String latexBody, String file, int line
    ) {
        public List<String> refs() {
            var refs = new LinkedHashSet<String>();
            var m = REF_PATTERN.matcher(latexBody);
            while (m.find()) refs.add(m.group(1));
            return List.copyOf(refs);
        }
    }

    public List<LatexChunk> split(String content, String relPath) {
        var chunks = new ArrayList<LatexChunk>();
        var cleaned = stripComments(content);

        var boundaries = new ArrayList<int[]>();
        var boundaryMeta = new ArrayList<String[]>();

        var secMatcher = SECTION_PATTERN.matcher(cleaned);
        while (secMatcher.find()) {
            boundaries.add(new int[]{secMatcher.start(), secMatcher.end()});
            boundaryMeta.add(new String[]{"section", secMatcher.group(2)});
        }

        for (var e : ENV_MAP.entrySet()) {
            var begin = Pattern.compile("\\\\begin\\{" + e.getKey() + "\\}");
            var m = begin.matcher(cleaned);
            while (m.find()) {
                var endTag = "\\end{" + e.getKey() + "}";
                int end = cleaned.indexOf(endTag, m.end());
                if (end < 0) end = cleaned.length();
                else end += endTag.length();
                boundaries.add(new int[]{m.start(), end});
                boundaryMeta.add(new String[]{e.getKey(), null});
            }
        }

        if (boundaries.isEmpty()) {
            var body = cleaned.strip();
            if (!body.isEmpty()) {
                chunks.add(new LatexChunk(Kind.PROSE, null, null, body, relPath, 1));
            }
            return chunks;
        }

        var order = new Integer[boundaries.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        Arrays.sort(order, Comparator.comparingInt(a -> boundaries.get(a)[0]));

        int cursor = 0;
        for (var idx : order) {
            var span = boundaries.get(idx);
            if (span[0] < cursor) continue;

            if (span[0] > cursor) {
                var between = cleaned.substring(cursor, span[0]).strip();
                if (!between.isEmpty()) {
                    chunks.add(new LatexChunk(Kind.PROSE, null, null, between, relPath,
                        lineAt(cleaned, cursor)));
                }
            }

            var meta = boundaryMeta.get(idx);
            var text = cleaned.substring(span[0], span[1]);
            var label = extractLabel(text);
            int line = lineAt(cleaned, span[0]);

            if (meta[0].equals("section")) {
                chunks.add(new LatexChunk(Kind.SECTION, label, meta[1], text, relPath, line));
            } else {
                var kind = ENV_MAP.get(meta[0]);
                var inner = text.replaceFirst("\\\\begin\\{" + meta[0] + "\\}(\\[[^\\]]*\\])?", "")
                    .replaceFirst("\\\\end\\{" + meta[0] + "\\}\\s*$", "")
                    .strip();
                chunks.add(new LatexChunk(kind, label, null, inner, relPath, line));
            }
            cursor = span[1];
        }

        if (cursor < cleaned.length()) {
            var tail = cleaned.substring(cursor).strip();
            if (!tail.isEmpty()) {
                chunks.add(new LatexChunk(Kind.PROSE, null, null, tail, relPath, lineAt(cleaned, cursor)));
            }
        }

        return chunks;
    }

    public String toMarkdown(String latexBody) {
        try {
            var proc = new ProcessBuilder(pandocBinary, "-f", "latex", "-t", "markdown", "--wrap=none")
                .redirectErrorStream(false)
                .start();
            try (var out = proc.getOutputStream()) {
                out.write(latexBody.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            var md = new String(proc.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            int exit = proc.waitFor();
            if (exit != 0) return latexBody;
            return md.strip();
        } catch (IOException | InterruptedException e) {
            return latexBody;
        }
    }

    public SemanticBlock toBlock(LatexChunk chunk, String markdown) {
        var refs = chunk.refs();
        return new SemanticBlock(chunk.kind(), chunk.label(), chunk.name(),
            markdown, chunk.file(), chunk.line(), refs);
    }

    private String extractLabel(String text) {
        var m = LABEL_PATTERN.matcher(text);
        return m.find() ? m.group(1) : null;
    }

    private String stripComments(String content) {
        var sb = new StringBuilder();
        for (var line : content.split("\n", -1)) {
            var cleaned = new StringBuilder();
            for (int i = 0; i < line.length(); i++) {
                var c = line.charAt(i);
                if (c == '\\' && i + 1 < line.length() && line.charAt(i + 1) == '%') {
                    cleaned.append("\\%");
                    i++;
                } else if (c == '%') {
                    break;
                } else {
                    cleaned.append(c);
                }
            }
            sb.append(cleaned).append('\n');
        }
        return sb.toString();
    }

    private int lineAt(String content, int pos) {
        int line = 1;
        for (int i = 0; i < Math.min(pos, content.length()); i++) {
            if (content.charAt(i) == '\n') line++;
        }
        return line;
    }
}
