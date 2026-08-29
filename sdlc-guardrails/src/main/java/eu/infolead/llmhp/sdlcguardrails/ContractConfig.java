package eu.infolead.llmhp.sdlcguardrails;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-repo contract configuration. Loaded from {@code {root}/.sdlc-guardrails/config.json}.
 * Fail-safe: a missing or malformed config yields defaults with {@code enabled=false}
 * unless a {@code plan.md} exists in the repo (which opts the plan-sync rule in).
 */
public final class ContractConfig {
    public static final String CONFIG_REL = ".sdlc-guardrails/config.json";

    public boolean enabled;
    public boolean requirePlan;
    public boolean requireVerification;
    public String verifyEvidenceRel;
    public long verifyFreshnessMs;
    public List<String> protectedPaths;
    public String planArtifact;
    public String specArtifact;
    public String intentArtifact;
    public String auditLogRel;
    public List<String> testPaths;

    private ContractConfig() {
        // defaults (safe)
        this.enabled = false;
        this.requirePlan = true;
        this.requireVerification = false;
        this.verifyEvidenceRel = "tmp/eval-loop-score.md";
        this.verifyFreshnessMs = 30 * 60 * 1000; // 30 minutes
        this.protectedPaths = new ArrayList<>();
        this.planArtifact = "plan.md";
        this.specArtifact = "spec.md";
        this.intentArtifact = "intent.md";
        this.auditLogRel = ".sdlc-guardrails/audit.jsonl";
        this.testPaths = List.of("**/test/**", "**/tests/**", "**/*.test.*", "**/*_test.*");
    }

    public static ContractConfig load(Path root) {
        ContractConfig cfg = new ContractConfig();
        Path cfgPath = root.resolve(CONFIG_REL);
        if (!Files.exists(cfgPath)) {
            // Opt-in: a plan.md present with no config enables plan-sync only.
            cfg.enabled = ArtifactDetector.exists(root, cfg.planArtifact);
            return cfg;
        }
        try {
            String text = Files.readString(cfgPath, StandardCharsets.UTF_8);
            Map<?, ?> map = Json.parseObject(text);
            cfg.enabled = Json.bool(map, "enabled", cfg.enabled);
            cfg.requirePlan = Json.bool(map, "requirePlan", cfg.requirePlan);
            cfg.requireVerification = Json.bool(map, "requireVerification", cfg.requireVerification);
            cfg.verifyEvidenceRel = Json.string(map, "verifyEvidence", cfg.verifyEvidenceRel);
            if (map.containsKey("verifyFreshnessMs")) {
                Object fs = map.get("verifyFreshnessMs");
                if (fs instanceof Number n) cfg.verifyFreshnessMs = n.longValue();
            }
            cfg.protectedPaths = Json.strings(map, "protectedPaths", cfg.protectedPaths);
            cfg.planArtifact = Json.string(map, "planArtifact", cfg.planArtifact);
            cfg.specArtifact = Json.string(map, "specArtifact", cfg.specArtifact);
            cfg.intentArtifact = Json.string(map, "intentArtifact", cfg.intentArtifact);
            cfg.auditLogRel = Json.string(map, "auditLog", cfg.auditLogRel);
            cfg.testPaths = Json.strings(map, "testPaths", cfg.testPaths);
        } catch (IOException | SdlcGuardrailsException e) {
            // malformed config -> safe defaults (enabled=false unless plan.md)
            cfg = new ContractConfig();
            cfg.enabled = ArtifactDetector.exists(root, cfg.planArtifact);
        }
        return cfg;
    }

    public Path auditLog(Path root) {
        return root.resolve(auditLogRel);
    }
}

/** Minimal JSON reader (objects, arrays, strings, booleans, numbers) — no dependency. */
final class Json {
    private Json() {}

    static Map<String, Object> parseObject(String text) {
        JsonParser p = new JsonParser(text);
        p.skipWs();
        return p.object();
    }

    static boolean bool(Map<?, ?> m, String key, boolean def) {
        Object v = m.get(key);
        if (v instanceof Boolean b) return b;
        return def;
    }

    static String string(Map<?, ?> m, String key, String def) {
        Object v = m.get(key);
        if (v instanceof String s) return s;
        return def;
    }

    static List<String> strings(Map<?, ?> m, String key, List<String> def) {
        Object v = m.get(key);
        if (v instanceof List<?> list) {
            List<String> out = new ArrayList<>();
            for (Object o : list) if (o instanceof String s) out.add(s);
            return out;
        }
        return def;
    }

    private static final class JsonParser {
        private final String s;
        private int i;

        JsonParser(String s) {
            this.s = s;
        }

        void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<>();
            expect('{');
            skipWs();
            if (peek() == '}') {
                i++;
                return out;
            }
            while (true) {
                skipWs();
                String key = string();
                skipWs();
                expect(':');
                skipWs();
                Object val = value();
                out.put(key, val);
                skipWs();
                char c = next();
                if (c == ',') continue;
                if (c == '}') break;
                throw new SdlcGuardrailsException("Expected , or } at " + (i - 1));
            }
            return out;
        }

        Object value() {
            skipWs();
            char c = peek();
            if (c == '{') return object();
            if (c == '[') {
                List<Object> list = new ArrayList<>();
                expect('[');
                skipWs();
                if (peek() == ']') {
                    i++;
                    return list;
                }
                while (true) {
                    list.add(value());
                    skipWs();
                    char d = next();
                    if (d == ',') continue;
                    if (d == ']') break;
                    throw new SdlcGuardrailsException("Expected , or ] at " + (i - 1));
                }
                return list;
            }
            if (c == '"') return string();
            if (c == 't') {
                literal("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                literal("false");
                return Boolean.FALSE;
            }
            return number();
        }

        String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = s.charAt(i++);
                    sb.append(switch (e) {
                        case 'n' -> '\n';
                        case 't' -> '\t';
                        case 'r' -> '\r';
                        case 'b' -> '\b';
                        case 'f' -> '\f';
                        case '"' -> '"';
                        case '\\' -> '\\';
                        case '/' -> '/';
                        case 'u' -> {
                            int code = Integer.parseInt(s.substring(i, i + 4), 16);
                            i += 4;
                            yield (char) code;
                        }
                        default -> throw new SdlcGuardrailsException("Bad escape \\" + e);
                    });
                } else {
                    sb.append(c);
                }
            }
            throw new SdlcGuardrailsException("Unterminated string");
        }

        Object number() {
            int start = i;
            while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '-' || s.charAt(i) == '.' || s.charAt(i) == 'e' || s.charAt(i) == 'E' || s.charAt(i) == '+')) i++;
            String num = s.substring(start, i);
            try {
                return Long.parseLong(num);
            } catch (NumberFormatException e) {
                return Double.parseDouble(num);
            }
        }

        void literal(String lit) {
            if (!s.startsWith(lit, i)) throw new SdlcGuardrailsException("Expected literal " + lit);
            i += lit.length();
        }

        char peek() {
            if (i >= s.length()) throw new SdlcGuardrailsException("Unexpected end");
            return s.charAt(i);
        }

        char next() {
            char c = peek();
            i++;
            return c;
        }

        void expect(char c) {
            char got = next();
            if (got != c) throw new SdlcGuardrailsException("Expected " + c + " got " + got);
        }
    }
}
