package eu.infolead.llmhp.router;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

final class Classifier {

    private static final Set<String> COMPLEXITY_KEYWORDS = Set.of(
        "complex", "subtle", "nuanced", "judgment",
        "trade-off", "best approach", "design", "architecture",
        "should I", "which is better", "recommend", "decide",
        "strategy"
    );

    private static final Set<String> DESTRUCTIVE_OPS = Set.of("delete", "remove", "drop");
    private static final Set<String> BULK_MARKERS = Set.of("all", "multiple", "*", "every");

    private static final Set<String> FILE_OPERATIONS = Set.of(
        "edit", "modify", "change", "update", "delete", "remove"
    );

    private static final Set<String> CREATION_KEYWORDS = Set.of(
        "new", "create", "design", "build", "implement"
    );

    private static final List<Pattern> FILE_PATTERNS = List.of(
        Pattern.compile("\\b\\w+\\.\\w{2,4}\\b"),
        Pattern.compile("[./][\\w/.-]+"),
        Pattern.compile("\\w+/\\w+"),
        Pattern.compile("~[\\w/.-]+")
    );

    private static final Set<String> META_ROUTING_VERBS = Set.of(
        "which agent", "how should i route", "route this to",
        "delegate to", "what model", "which tier"
    );

    Classifier() {}

    boolean hasComplexitySignal(String request) {
        var lower = request.toLowerCase();
        return COMPLEXITY_KEYWORDS.stream().anyMatch(lower::contains);
    }

    boolean isBulkDestructive(String request) {
        var lower = request.toLowerCase();
        boolean destructive = DESTRUCTIVE_OPS.stream().anyMatch(lower::contains);
        boolean bulk = BULK_MARKERS.stream().anyMatch(lower::contains);
        return destructive && bulk;
    }

    boolean isFileOpWithoutPath(String request) {
        var lower = request.toLowerCase();
        boolean hasFileOp = FILE_OPERATIONS.stream().anyMatch(lower::contains);
        if (!hasFileOp) return false;
        if (request.contains("/")) return false;
        if (explicitFileMentioned(request)) return false;

        for (var op : FILE_OPERATIONS) {
            int idx = lower.indexOf(op);
            if (idx < 0) continue;
            var after = lower.substring(idx + op.length()).strip();
            if (after.startsWith("the ")) {
                var nextWord = after.substring(4).split("\\s+", 2)[0];
                if (nextWord.matches(".*[./\\\\].*")) continue;
            }
            return true;
        }
        return false;
    }

    boolean modifiesAgentFiles(String request) {
        var lower = request.toLowerCase();
        if (!request.contains(".claude/agents")) return false;
        return FILE_OPERATIONS.stream().anyMatch(lower::contains);
    }

    long countObjectives(String request) {
        var normalized = request.toLowerCase()
            .replace(" and ", " | ")
            .replace(", then ", " | ")
            .replace(" after ", " | ")
            .replace(" before ", " | ");
        // Split on ";" first, then reassemble with canonical separator
        normalized = normalized.replace(";", " | ");
        return normalized.codePoints().filter(c -> c == '|').count();
    }

    boolean isCreationTask(String request) {
        var lower = request.toLowerCase();
        boolean hasCreation = CREATION_KEYWORDS.stream().anyMatch(lower::contains);
        if (!hasCreation) return false;
        return !(lower.contains("new file") && explicitFileMentioned(request));
    }

    boolean isMetaRouting(String request) {
        var lower = request.toLowerCase();
        return META_ROUTING_VERBS.stream().anyMatch(lower::contains);
    }

    boolean explicitFileMentioned(String request) {
        return FILE_PATTERNS.stream().anyMatch(p -> p.matcher(request).find());
    }

    Tier keywordMatch(String request) {
        var lower = request.toLowerCase();
        var hasFile = explicitFileMentioned(request);

        var haikuHighConf = List.of(
            Pattern.compile("fix\\s+(typo|spelling|syntax)"),
            Pattern.compile("format\\s+(code|file)"),
            Pattern.compile("lint\\s+"),
            Pattern.compile("rename\\s+\\w+\\s+\\w*\\s*to\\s+\\w+"),
            Pattern.compile("add\\s+(semicolon|comma|bracket|import)"),
            Pattern.compile("remove\\s+(trailing\\s+whitespace|unused)"),
            Pattern.compile("correct\\s+(spelling|typo)"),
            Pattern.compile("sort\\s+(imports|lines)")
        );
        for (var p : haikuHighConf) {
            if (p.matcher(lower).find() && hasFile) {
                return Tier.HAIKU;
            }
        }

        var opusKeywords = List.of(
            "prove", "formalize", "verify correctness", "mathematical",
            "theorem", "algorithm design", "proof"
        );
        if (opusKeywords.stream().anyMatch(lower::contains)) return Tier.OPUS;

        var sonnetKeywords = List.of(
            "analyze", "implement", "refactor", "integrate",
            "review", "optimize", "debug", "investigate"
        );
        if (sonnetKeywords.stream().anyMatch(lower::contains)) return Tier.SONNET;

        var fablePatterns = List.of(
            Pattern.compile("\\b(add|close)\\s+(semicolon|bracket|paren|brace)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(append|prepend)\\b")
        );
        for (var p : fablePatterns) {
            if (p.matcher(lower).find() && hasFile) return Tier.FABLE;
        }

        if (hasFile) return Tier.HAIKU;
        return null;
    }

    double keywordConfidence(String request, Tier matched) {
        var lower = request.toLowerCase();
        return switch (matched) {
            case FABLE -> countMatches(lower, Set.of(
                "add semicolon", "close bracket", "close paren", "close brace",
                "append", "prepend"
            )) > 0 ? 0.9 : 0.0;
            case HAIKU -> {
                var matches = countMatches(lower, Set.of(
                    "fix", "typo", "syntax", "format", "lint", "rename",
                    "correct", "spelling", "sort", "import",
                    "add semicolon", "add comma", "add bracket", "add import",
                    "remove trailing whitespace", "remove unused"
                ));
                yield matches > 0 ? Math.min(0.9, 0.6 + matches * 0.1) : 0.5;
            }
            case SONNET -> {
                var matches = countMatches(lower, Set.of(
                    "analyze", "implement", "refactor", "integrate",
                    "review", "optimize", "debug", "investigate"
                ));
                yield matches > 0 ? Math.min(0.95, 0.65 + matches * 0.1) : 0.0;
            }
            case OPUS -> {
                var matches = countMatches(lower, Set.of(
                    "prove", "formalize", "verify", "mathematical",
                    "theorem", "proof"
                ));
                yield matches > 0 ? Math.min(0.95, 0.7 + matches * 0.1) : 0.0;
            }
        };
    }

    private int countMatches(String text, Set<String> keywords) {
        return (int) keywords.stream().filter(text::contains).count();
    }

    record MemorySignalMatch(Signal signal, String domain, double confidence) {}

    private static java.util.Map<String, Pattern> domainPatterns = new java.util.concurrent.ConcurrentHashMap<>();

    private static Pattern domainBoundaryPattern(String domain) {
        return domainPatterns.computeIfAbsent(domain,
            k -> Pattern.compile("\\b" + Pattern.quote(k) + "\\b", Pattern.CASE_INSENSITIVE));
    }

    List<MemorySignalMatch> matchUserMemorySignals(String prompt, List<UserMemorySignal> signals) {
        if (signals.isEmpty()) return List.of();
        var matches = new ArrayList<MemorySignalMatch>();
        var lower = prompt.toLowerCase();
        for (var s : signals) {
            if (!domainBoundaryPattern(s.domain()).matcher(prompt).find()) continue;
            double confidence = switch (s.signal()) {
                case LEARNING -> 0.7;
                case EXPERT -> 0.6;
                case PREFERENCE -> 0.5;
            };
            matches.add(new MemorySignalMatch(s.signal(), s.domain(), confidence));
        }
        return matches;
    }
}
