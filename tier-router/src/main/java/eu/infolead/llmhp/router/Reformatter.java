package eu.infolead.llmhp.router;

import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

final class Reformatter {

    private static final Pattern HAS_FILE_EXTENSION = Pattern.compile("\\b\\w+\\.\\w{2,4}\\b");

    // --- SOTA prompt engineering rules applied BEFORE dispatch ---

    // Rule 1: Strip ambiguity — ensure has explicit action verb
    private static final List<Pattern> WEAK_OPENERS = List.of(
        Pattern.compile("^(can you|could you|would you|I want|I need|help me) "),
        Pattern.compile("^(maybe|perhaps|possibly) "),
        Pattern.compile("^(I'm |I am )trying to ")
    );

    // Rule 2: Add conciseness directive — critical for Claude Opus 5+
    private static final String CONCISENESS_DIRECTIVE = "Be concise. Answer directly. Minimize output tokens. "
        + "Do NOT use bold headers, bullet lists for exposition, excessive em-dashes, or dramatic section titles. "
        + "Write in flowing prose. Respond only to what was asked — no preamble, no postamble.";

    // Rule 3: Add explicit output format constraints
    private static final String OUTPUT_DIRECTIVE = "REQUIRED OUTPUT: Return usable results — "
        + "direct results OR file path OR action summary with specifics. Never complete silently.";

    // Rule 4: Add uncertainty permission to reduce hallucination
    private static final String UNCERTAINTY_DIRECTIVE = "If uncertain or missing info, say so explicitly. "
        + "Never invent facts or fabricate output.";

    Reformatter() {}

    String rewrite(String prompt, Tier tier) {
        var rewritten = prompt;

        // Rule 1: Convert weak openers to direct imperatives
        rewritten = strengthenOpener(rewritten);

        // Rule 2: Strip AI-style anti-patterns from user prompt
        rewritten = stripAiPatterns(rewritten);

        // Tier-specific augmentation
        var suffix = switch (tier) {
            case FABLE -> "\n\n%s".formatted(CONCISENESS_DIRECTIVE);
            case HAIKU -> "\n\n%s\n\n%s".formatted(CONCISENESS_DIRECTIVE, UNCERTAINTY_DIRECTIVE);
            case SONNET -> "\n\n%s\n\n%s".formatted(CONCISENESS_DIRECTIVE, OUTPUT_DIRECTIVE);
            case OPUS -> "\n\n%s\n\n%s\n%s".formatted(
                CONCISENESS_DIRECTIVE, OUTPUT_DIRECTIVE, UNCERTAINTY_DIRECTIVE);
        };

        return rewritten + suffix;
    }

    private String strengthenOpener(String prompt) {
        var lower = prompt.toLowerCase();
        for (var p : WEAK_OPENERS) {
            var m = p.matcher(lower);
            if (m.find()) {
                var after = prompt.substring(m.end());
                var firstUpper = after.length() > 0
                    ? Character.toUpperCase(after.charAt(0)) + after.substring(1)
                    : after;
                return firstUpper;
            }
        }
        return prompt;
    }

    private String stripAiPatterns(String prompt) {
        // Strip excessive em-dashes: replace — with comma or semicolon
        prompt = prompt.replaceAll("—{2,}", "; ").replaceAll("\\s*—\\s*", ", ");

        // Strip template language: "the relationship:" → "specifically:"
        prompt = prompt.replaceAll("(?i)\\bthe relationship:", "Specifically,");

        // Strip "This is not X—it is Y" patterns → simplify
        prompt = prompt.replaceAll(
            "(?i)this is not\\s+([^—]+)—it['’]s\\s+([^,.;]+)",
            "Rather than $1, $2"
        );

        return prompt;
    }

    boolean needsUserClarification(String prompt) {
        var lower = prompt.toLowerCase();
        var ambiguous = List.of(
            "fix the bug", "update the config", "make it better",
            "optimize the database", "improve the code", "clean this up",
            "refactor this"
        );
        for (var ambig : ambiguous) {
            if (lower.contains(ambig) && !prompt.contains("/") && !HAS_FILE_EXTENSION.matcher(prompt).find()) {
                return true;
            }
        }
        return false;
    }

    List<String> generateClarificationQuestions(String prompt) {
        var lower = prompt.toLowerCase();
        if (lower.contains("fix the bug"))
            return List.of("Which component? (login flow, auth, token refresh, permissions?)", "What is the specific symptom or error?");
        if (lower.contains("update the config"))
            return List.of("Which config file? (app.json, database.yml, nginx.conf?)", "What change? (add field, modify value, remove setting?)");
        if (lower.contains("make it better"))
            return List.of("Better in what way? (performance, UX, code quality, error handling?)");
        if (lower.contains("optimize the database"))
            return List.of("What aspect? (query speed, storage size, indexes?)", "Constraints? (can modify schema? add indexes?)");
        if (lower.contains("improve the code") || lower.contains("refactor this"))
            return List.of("What specific improvement? (performance, readability, architecture, test coverage?)");
        if (lower.contains("clean this up"))
            return List.of("What to clean? (unused files, dead code, formatting, duplicate logic?)");
        return List.of("Could you clarify the scope and specific goal?");
    }
}
