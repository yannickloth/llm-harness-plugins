package eu.infolead.llmhp.router;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

/**
 * Primary classifier: a single call to an OpenAI-compatible chat-completions
 * endpoint.
 *
 * Defaults to DeepSeek ({@code https://api.deepseek.com}, model
 * {@code deepseek-flash}) so routing never depends on a local model being up or
 * on an Anthropic subscription. The endpoint is fully overridable, so any
 * OpenAI-compatible provider works:
 *
 *   TIER_ROUTER_LLM_BASE_URL   default https://api.deepseek.com
 *   TIER_ROUTER_LLM_MODEL      default deepseek-flash
 *   TIER_ROUTER_LLM_API_KEY    else DEEPSEEK_API_KEY, else
 *                              ~/.config/opencode/keys/deepseek.key
 *   TIER_ROUTER_SKIP_LLM=true  disable this classifier entirely
 *
 * deepseek-flash is a reasoning model; {@code thinking: disabled} keeps the
 * reply to the single classification word instead of spending the token budget
 * on hidden reasoning. A missing key disables the classifier (returns null) so
 * the caller degrades to keyword routing rather than failing.
 */
final class LlmClassifier {

    private static final String CLASSIFICATION_PROMPT = """
        Classify this task by reasoning complexity. Output ONLY one word: FABLE, HAIKU, SONNET, OPUS, or ESCALATE.

        FABLE: trivial single actions (close bracket, add semicolon, append text)
        HAIKU: mechanical edits with clear scope (fix typo, rename, format, lint)
        SONNET: reasoning/analysis required (analyze, implement, refactor, review, debug, explain)
        OPUS: deep formal reasoning (prove, formalize, math theorems, algorithm design)
        ESCALATE: ambiguous, unclear scope, multiple competing goals, or genuinely uncertain

        Task: %s""";

    private static final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    private LlmClassifier() {}

    record Classification(Tier tier, Decision decision, double confidence, String reason) {}

    static Classification classify(String prompt) {
        if ("true".equalsIgnoreCase(System.getenv("TIER_ROUTER_SKIP_LLM"))) return null;

        var baseUrl = envOr("TIER_ROUTER_LLM_BASE_URL", "https://api.deepseek.com").replaceAll("/+$", "");
        var model = envOr("TIER_ROUTER_LLM_MODEL", "deepseek-flash");
        var apiKey = apiKey();

        if (apiKey == null || apiKey.isBlank()) return null;

        try {
            var jsonContent = CLASSIFICATION_PROMPT.formatted(prompt)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n");
            // `thinking: disabled` is a DeepSeek extension; providers that do not
            // understand it ignore the unknown field.
            var body = """
                {"model":"%s","max_tokens":16,"temperature":0.0,"thinking":{"type":"disabled"},"messages":[{"role":"user","content":"%s"}]}"""
                .formatted(model, jsonContent);

            var request = HttpRequest.newBuilder()
                .uri(URI.create("%s/chat/completions".formatted(baseUrl)))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .timeout(Duration.ofSeconds(10))
                .build();

            var response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                System.err.println("[tier-router] LLM classification HTTP " + response.statusCode() + " — falling back to keyword");
                return null;
            }

            var text = extractContent(response.body());
            if (text == null) return null;
            return parseResponse(text);
        } catch (Exception e) {
            System.err.println("[tier-router] LLM classification failed: " + e.getMessage());
            return null;
        }
    }

    private static String envOr(String key, String fallback) {
        var value = System.getenv(key);
        return value != null && !value.isBlank() ? value : fallback;
    }

    /** Resolve the API key: explicit env, then DEEPSEEK_API_KEY, then the
     * opencode key file the other providers also use. */
    private static String apiKey() {
        var explicit = System.getenv("TIER_ROUTER_LLM_API_KEY");
        if (explicit != null && !explicit.isBlank()) return explicit.trim();
        var deepseek = System.getenv("DEEPSEEK_API_KEY");
        if (deepseek != null && !deepseek.isBlank()) return deepseek.trim();
        try {
            var keyFile = Path.of(System.getProperty("user.home"),
                ".config", "opencode", "keys", "deepseek.key");
            if (Files.isReadable(keyFile)) return Files.readString(keyFile).trim();
        } catch (IOException ignored) {
            // fall through to null → classifier disabled
        }
        return null;
    }

    /** Pull the assistant text out of the OpenAI chat-completions response.
     * Anchoring on {@code "message"} avoids matching {@code reasoning_content}
     * when a provider still emits it. */
    private static String extractContent(String body) {
        var message = body.indexOf("\"message\"");
        var from = message >= 0 ? message : 0;
        var start = body.indexOf("\"content\":\"", from);
        if (start < 0) return null;
        start += "\"content\":\"".length();
        var sb = new StringBuilder();
        for (var i = start; i < body.length(); i++) {
            var c = body.charAt(i);
            if (c == '\\' && i + 1 < body.length()) {
                sb.append(body.charAt(++i));
                continue;
            }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    static Classification parseResponse(String raw) {
        var text = raw.strip().toUpperCase().replaceAll("[^A-Z]", "");

        return switch (text) {
            case "FABLE" -> new Classification(Tier.FABLE, Decision.DIRECT, 0.9,
                "LLM: trivial mechanical task");
            case "HAIKU" -> new Classification(Tier.HAIKU, Decision.DIRECT, 0.95,
                "LLM: mechanical edit with clear scope");
            case "SONNET" -> new Classification(Tier.SONNET, Decision.DIRECT, 0.95,
                "LLM: reasoning/analysis required");
            case "OPUS" -> new Classification(Tier.OPUS, Decision.DIRECT, 0.9,
                "LLM: deep formal reasoning");
            case "ESCALATE" -> new Classification(null, Decision.ESCALATE, 0.9,
                "LLM uncertain — escalating for judgment");
            default -> {
                if (text.contains("ESCALATE"))
                    yield new Classification(null, Decision.ESCALATE, 0.7,
                        "LLM response ambiguous — escalating");
                yield null;
            }
        };
    }
}
