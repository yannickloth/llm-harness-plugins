package eu.infolead.llmhp.guardrails;

import eu.infolead.llmhp.guardrails.types.GuardResult;
import java.util.regex.Pattern;

public final class SecretScanner {
    static final Pattern[] SECRET_PATTERNS = {
        Pattern.compile("\\bsk-[a-zA-Z0-9_-]{30,}", Pattern.CASE_INSENSITIVE),
        Pattern.compile("\\bAKIA[A-Z0-9]{16}\\b"),
        Pattern.compile("\\bghp_[a-zA-Z0-9]{36,}\\b"),
        Pattern.compile("\\bgithub_pat_[a-zA-Z0-9_]{22,}\\b"),
        Pattern.compile("\\bxox[bprs]-[a-zA-Z0-9-]+\\b"),
        Pattern.compile("-----BEGIN( RSA| DSA| EC| OPENSSH)? PRIVATE KEY"),
        Pattern.compile("\\bAIza[0-9A-Za-z_-]{35}\\b"),
        Pattern.compile("\\bya29\\.[0-9A-Za-z_-]+\\b"),
    };

    public GuardResult scan(String content) {
        if (content == null) return new GuardResult.Pass("SecretScanner");
        for (var p : SECRET_PATTERNS) {
            var m = p.matcher(content);
            if (m.find()) {
                return new GuardResult.Block("SecretScanner",
                    "Secret detected — never store credentials");
            }
        }
        return new GuardResult.Pass("SecretScanner");
    }
}
