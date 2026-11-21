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
 * Primary classifier: a single call to the LiteLLM rank gateway
 * ({@code http://server-nike.bee-blues.ts.net:4000/v1}, rank
 * {@code sergeant}), so routing never depends on a direct provider account.
 * The endpoint is fully overridable, so any OpenAI-compatible provider works:
 *
 *   TIER_ROUTER_LLM_BASE_URL   default http://server-nike.bee-blues.ts.net:4000/v1
 *   TIER_ROUTER_LLM_MODEL      default sergeant
 *   TIER_ROUTER_LLM_API_KEY    else ~/.config/opencode/keys/litellm-proxy.key
 *   TIER_ROUTER_SKIP_LLM=true  disable this classifier entirely
 *
 * The rank name is a pure abstraction: the proxy owns model behaviour
 * parameters, so no provider-specific fields are sent in the request. A
 * missing key disables the classifier (returns null) so the caller degrades
 * to keyword routing rather than failing.
 */
final class LlmClassifier {

    private static final String CLASSIFICATION_PROMPT = """
        Classify this task by reasoning complexity. Output ONLY one word: HAIKU, SONNET, OPUS, or ESCALATE.

        HAIKU: mechanical edits with clear scope (fix typo, rename, format, lint, close bracket, add semicolon)
        SONNET: reasoning/analysis required (analyze, implement, refactor, review, debug, explain)
        OPUS: deep formal reasoning (prove, formalize, math theorems, algorithm design, verify correctness)
        ESCALATE: ambiguous, unclear scope, multiple competing goals, or genuinely uncertain

        Task: %s""";

    private static final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    private LlmClassifier() {}

    record Classification(Tier tier, Decision decision, double confidence, String reason) {}

    static Classification classify(String prompt) {
        if ("true".equalsIgnoreCase(System.getenv("TIER_ROUTER_SKIP_LLM"))) return null;

        var baseUrl = envOr("TIER_ROUTER_LLM_BASE_URL", "http://server-nike.bee-blues.ts.net:4000/v1").replaceAll("/+$", "");
        var model = envOr("TIER_ROUTER_LLM_MODEL", "sergeant");
        var apiKey = apiKey();

        if (apiKey == null || apiKey.isBlank()) return null;

        try {
            var jsonContent = CLASSIFICATION_PROMPT.formatted(prompt)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n");
            var body = """
                {"model":"%s","max_tokens":16,"temperature":0.0,"messages":[{"role":"user","content":"%s"}]}"""
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

    /** Resolve the API key: explicit env, then the LiteLLM rank gateway key
     * file materialized on every host by the Nix client config. */
    private static String apiKey() {
        var explicit = System.getenv("TIER_ROUTER_LLM_API_KEY");
        if (explicit != null && !explicit.isBlank()) return explicit.trim();
        try {
            var keyFile = Path.of(System.getProperty("user.home"),
                ".config", "opencode", "keys", "litellm-proxy.key");
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
