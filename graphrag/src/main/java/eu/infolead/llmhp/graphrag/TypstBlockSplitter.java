package eu.infolead.llmhp.graphrag;

import java.util.*;
import java.util.regex.*;
import eu.infolead.llmhp.graphrag.types.SemanticBlock;
import eu.infolead.llmhp.graphrag.types.SemanticBlock.Kind;

public final class TypstBlockSplitter {

    private static final Map<String, Kind> ENV_MAP = new LinkedHashMap<>();

    static {
        ENV_MAP.put("theorem", Kind.THEOREM);
        ENV_MAP.put("proposition", Kind.PROPOSITION);
        ENV_MAP.put("lemma", Kind.LEMMA);
        ENV_MAP.put("corollary", Kind.COROLLARY);
        ENV_MAP.put("conjecture", Kind.CONJECTURE);
        ENV_MAP.put("definition", Kind.DEFINITION);
        ENV_MAP.put("axiom", Kind.AXIOM);
        ENV_MAP.put("axiom-env", Kind.AXIOM);
        ENV_MAP.put("principle", Kind.PRINCIPLE);
        ENV_MAP.put("assumption", Kind.ASSUMPTION);
        ENV_MAP.put("assumption-env", Kind.ASSUMPTION);
        ENV_MAP.put("guideline", Kind.GUIDELINE);
        ENV_MAP.put("guideline-env", Kind.GUIDELINE);
        ENV_MAP.put("correspondence", Kind.CORRESPONDENCE);
        ENV_MAP.put("remark", Kind.REMARK);
        ENV_MAP.put("remark-env", Kind.REMARK);
        ENV_MAP.put("observation", Kind.OBSERVATION);
        ENV_MAP.put("example", Kind.EXAMPLE);
        ENV_MAP.put("example-env", Kind.EXAMPLE);
        ENV_MAP.put("key-insight", Kind.KEY_INSIGHT);
        ENV_MAP.put("counterexample-env", Kind.COUNTEREXAMPLE);
        ENV_MAP.put("proof", Kind.PROOF);
        ENV_MAP.put("solution", Kind.SOLUTION);
        ENV_MAP.put("solution-env", Kind.SOLUTION);
        ENV_MAP.put("solution-to", Kind.SOLUTION);
        ENV_MAP.put("exercise", Kind.EXERCISE);
        ENV_MAP.put("exercise-env", Kind.EXERCISE);
        ENV_MAP.put("common-confusion", Kind.CONFUSION);
    }

    private static final Pattern REF_PATTERN =
        Pattern.compile("@([a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)*)");
    private static final Pattern LABEL_PATTERN =
        Pattern.compile("<([a-zA-Z][a-zA-Z0-9_:-]+)>");
    private static final Pattern HEADING_PATTERN =
        Pattern.compile("^(=+)\\s+(.+)$");

    public record SplitResult(List<SemanticBlock> blocks, List<String> labels) {}

    public SplitResult split(String rawContent, String relPath) {
        var content = stripNoise(rawContent);
        var blocks = new ArrayList<SemanticBlock>();
        var labels = new ArrayList<String>();
        var prose = new StringBuilder();
        int proseStartLine = 1;
        int i = 0;
        int line = 1;

        while (i < content.length()) {
            var envMatch = findEnvCall(content, i);
            if (envMatch == null) {
                prose.append(content, i, content.length());
                break;
            }
            if (envMatch.start() > i) {
                prose.append(content, i, envMatch.start());
            }
            line = lineAt(content, envMatch.start());

            if (!prose.toString().isBlank()) {
                blocks.addAll(proseBlocks(prose.toString(), relPath, proseStartLine));
            }
            prose = new StringBuilder();
            proseStartLine = line;

            var parsed = parseEnvCall(content, envMatch.start(), envMatch.kind());
            labels.addAll(parsed.labels());
            blocks.add(new SemanticBlock(
                parsed.kind(),
                parsed.labels().isEmpty() ? null : parsed.labels().getFirst(),
                parsed.name(),
                parsed.body(),
                relPath,
                line,
                extractRefs(parsed.body())
            ));
            line = lineAt(content, parsed.end());
            proseStartLine = line;
            i = parsed.end();
        }

        if (!prose.toString().isBlank()) {
            blocks.addAll(proseBlocks(prose.toString(), relPath, proseStartLine));
        }

        var trailingLabels = LABEL_PATTERN.matcher(rawContent);
        while (trailingLabels.find()) {
            if (!labels.contains(trailingLabels.group(1))) labels.add(trailingLabels.group(1));
        }

        return new SplitResult(List.copyOf(blocks), List.copyOf(labels));
    }

    private String stripNoise(String content) {
        var sb = new StringBuilder();
        for (var line : content.split("\n", -1)) {
            var trimmed = line.strip();
            if (trimmed.startsWith("#import ")) { sb.append('\n'); continue; }
            if (trimmed.startsWith("#include ")) { sb.append('\n'); continue; }
            if (trimmed.startsWith("//")) { sb.append('\n'); continue; }
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private List<SemanticBlock> proseBlocks(String prose, String relPath, int startLine) {
        var result = new ArrayList<SemanticBlock>();
        var current = new StringBuilder();
        String currentHeading = null;
        int currentLine = startLine;
        int line = startLine;

        for (var l : prose.split("\n", -1)) {
            var m = HEADING_PATTERN.matcher(l);
            if (m.matches()) {
                flushProse(result, current, currentHeading, relPath, currentLine);
                currentHeading = m.group(2).strip();
                current = new StringBuilder();
                currentLine = line;
            } else {
                current.append(l).append('\n');
            }
            line++;
        }
        flushProse(result, current, currentHeading, relPath, currentLine);
        return result;
    }

    private void flushProse(List<SemanticBlock> out, StringBuilder text, String heading,
                            String relPath, int line) {
        var body = text.toString().strip();
        if (body.isEmpty()) return;
        var kind = heading != null ? Kind.SECTION : Kind.PROSE;
        var name = heading != null ? heading : null;
        out.add(new SemanticBlock(kind, null, name, body, relPath, line, extractRefs(body)));
    }

    private record EnvHit(int start, Kind kind) {}

    private EnvHit findEnvCall(String content, int from) {
        int best = -1;
        Kind bestKind = null;
        for (var e : ENV_MAP.entrySet()) {
            var name = e.getKey();
            int idx = from;
            while ((idx = content.indexOf("#" + name, idx)) >= 0) {
                int after = idx + 1 + name.length();
                if (after < content.length()) {
                    var c = content.charAt(after);
                    if (Character.isLetterOrDigit(c) || c == '-' || c == '_') { idx = after; continue; }
                }
                if (idx > 0) {
                    var before = content.charAt(idx - 1);
                    if (Character.isLetterOrDigit(before) || before == '-' || before == '_') { idx = after; continue; }
                }
                if (best < 0 || idx < best) { best = idx; bestKind = e.getValue(); }
                break;
            }
        }
        return best < 0 ? null : new EnvHit(best, bestKind);
    }

    private record ParsedEnv(Kind kind, String name, String body, List<String> labels, int end) {}

    private ParsedEnv parseEnvCall(String content, int start, Kind kind) {
        int i = start;
        while (i < content.length() && content.charAt(i) != '#' ) i++;
        i++;

        while (i < content.length() && (Character.isLetterOrDigit(content.charAt(i))
                || content.charAt(i) == '-')) i++;

        String name = null;
        String bodyText = null;
        var argContent = new StringBuilder();

        while (i < content.length() && Character.isWhitespace(content.charAt(i))) i++;

        if (i < content.length() && content.charAt(i) == '(') {
            int close = matchBalanced(content, i, '(', ')');
            argContent.append(content, i + 1, close);
            i = close + 1;
            while (i < content.length() && Character.isWhitespace(content.charAt(i))) i++;
        }

        if (i < content.length() && content.charAt(i) == '[') {
            int close = matchBalanced(content, i, '[', ']');
            bodyText = content.substring(i + 1, close);
            i = close + 1;
        }

        if (bodyText == null && !argContent.isEmpty()) {
            bodyText = extractArgBody(argContent.toString());
        }
        if (name == null) {
            name = extractArg(argContent.toString(), "name");
        }
        var strategy = extractArg(argContent.toString(), "strategy");
        if (strategy != null && bodyText != null) {
            bodyText = "[strategy: " + strategy + "]\n" + bodyText;
        }
        var hypotheses = extractArg(argContent.toString(), "hypotheses");
        if (hypotheses != null && !hypotheses.equals("none") && bodyText != null) {
            bodyText = "[hypotheses: " + hypotheses + "]\n" + bodyText;
        }

        var labels = new ArrayList<String>();
        int j = i;
        while (j < content.length() && Character.isWhitespace(content.charAt(j))) j++;
        if (j < content.length() && content.charAt(j) == '<') {
            var m = LABEL_PATTERN.matcher(content.substring(j, Math.min(j + 200, content.length())));
            if (m.find() && m.start() == 0) {
                labels.add(m.group(1));
                i = j + m.end();
            }
        }

        if (bodyText == null) bodyText = "";
        return new ParsedEnv(kind, name, bodyText.strip(), labels, i);
    }

    private int matchBalanced(String s, int open, char openChar, char closeChar) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            var c = s.charAt(i);
            if (c == '\\') { i++; continue; }
            if (c == openChar) depth++;
            else if (c == closeChar) {
                depth--;
                if (depth == 0) return i;
            }
        }
        return s.length() - 1;
    }

    private String extractArg(String args, String key) {
        var pattern = Pattern.compile(key + "\\s*:\\s*");
        var m = pattern.matcher(args);
        if (!m.find()) return null;
        int i = m.end();
        while (i < args.length() && Character.isWhitespace(args.charAt(i))) i++;
        if (i >= args.length()) return null;
        if (args.charAt(i) == '[') {
            int close = matchBalanced(args, i, '[', ']');
            return args.substring(i + 1, close).strip();
        }
        if (args.charAt(i) == '(') {
            int close = matchBalanced(args, i, '(', ')');
            return extractArgBody(args.substring(i + 1, close));
        }
        int end = i;
        while (end < args.length() && args.charAt(end) != ',' && args.charAt(end) != ')') end++;
        var value = args.substring(i, end).strip();
        return value.equals("none") ? "none" : value;
    }

    private String extractArgBody(String args) {
        var claimPattern = Pattern.compile("claim\\s*:\\s*");
        var m = claimPattern.matcher(args);
        if (m.find()) {
            int i = m.end();
            while (i < args.length() && Character.isWhitespace(args.charAt(i))) i++;
            if (i < args.length() && args.charAt(i) == '(') {
                int close = matchBalanced(args, i, '(', ')');
                var inner = args.substring(i + 1, close);
                var sb = new StringBuilder();
                int k = 0;
                while (k < inner.length()) {
                    if (inner.charAt(k) == '[') {
                        int close2 = matchBalanced(inner, k, '[', ']');
                        if (sb.length() > 0) sb.append("\n");
                        sb.append(inner, k + 1, close2);
                        k = close2 + 1;
                    } else {
                        k++;
                    }
                }
                return sb.toString().strip();
            }
            if (i < args.length() && args.charAt(i) == '[') {
                int close = matchBalanced(args, i, '[', ']');
                return args.substring(i + 1, close).strip();
            }
        }
        var sb = new StringBuilder();
        int k = 0;
        while (k < args.length()) {
            if (args.charAt(k) == '[') {
                int close = matchBalanced(args, k, '[', ']');
                if (sb.length() > 0) sb.append("\n");
                sb.append(args, k + 1, close);
                k = close + 1;
            } else {
                k++;
            }
        }
        return sb.toString().strip();
    }

    private List<String> extractRefs(String body) {
        var refs = new LinkedHashSet<String>();
        var m = REF_PATTERN.matcher(body);
        while (m.find()) refs.add(m.group(1));
        return List.copyOf(refs);
    }

    private int lineAt(String content, int pos) {
        int line = 1;
        for (int i = 0; i < Math.min(pos, content.length()); i++) {
            if (content.charAt(i) == '\n') line++;
        }
        return line;
    }
}
