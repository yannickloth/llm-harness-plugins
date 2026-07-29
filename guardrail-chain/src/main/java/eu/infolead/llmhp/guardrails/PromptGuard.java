package eu.infolead.llmhp.guardrails;

import eu.infolead.llmhp.guardrails.types.GuardResult;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

public final class PromptGuard {
    static final int MAX_PROMPT_BYTES = 500_000;

    static final Pattern[] INJECTION_PATTERNS = {
        Pattern.compile("ignore\\s+(all\\s+)?(previous|prior|above)\\s+(instructions?|prompts?|directives?|rules?)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("you\\s+are\\s+(now\\s+)?(DAN|jailbroken|uncensored)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("pretend\\s+(you\\s+are|to\\s+be)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("start\\s+every\\s+(response|answer|reply)\\s+with", Pattern.CASE_INSENSITIVE),
        Pattern.compile("system\\s*:\\s*(you\\s+must|ignore|override)", Pattern.CASE_INSENSITIVE),
    };

    static final Pattern ZERO_WIDTH_CHARS = Pattern.compile("[\\u200B\\u200C\\u200D\\u00AD\\uFEFF\\u2060]");

    public GuardResult scan(String prompt) {
        if (prompt == null || prompt.isBlank()) return new GuardResult.Pass("PromptGuard");

        if (ZERO_WIDTH_CHARS.matcher(prompt).find()) {
            return new GuardResult.Warn("PromptGuard",
                "Zero-width Unicode characters detected — possible injection bypass attempt");
        }

        for (var p : INJECTION_PATTERNS) {
            var m = p.matcher(prompt);
            if (m.find()) {
                return new GuardResult.Warn("PromptGuard",
                    "Possible prompt injection pattern: \"%s\"".formatted(m.group()));
            }
        }
        return new GuardResult.Pass("PromptGuard");
    }

    public GuardResult checkSizeBounds(String content) {
        if (content == null) return new GuardResult.Pass("PromptGuard");
        if (content.getBytes(StandardCharsets.UTF_8).length > MAX_PROMPT_BYTES) {
            return new GuardResult.Warn("PromptGuard",
                "Content exceeds %d bytes".formatted(MAX_PROMPT_BYTES));
        }
        return new GuardResult.Pass("PromptGuard");
    }

    public GuardResult checkSizeBounds(String content, int maxBytes) {
        if (content == null) return new GuardResult.Pass("PromptGuard");
        if (content.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            return new GuardResult.Block("PromptGuard",
                "Content exceeds %d bytes (max: %d)".formatted(content.getBytes(StandardCharsets.UTF_8).length, maxBytes));
        }
        return new GuardResult.Pass("PromptGuard");
    }
}
