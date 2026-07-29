package eu.infolead.llmhp.router;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

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

        var baseUrl = envOr("TIER_ROUTER_LLM_BASE_URL", "https://api.anthropic.com");
        var apiKey = envOr("TIER_ROUTER_LLM_API_KEY", System.getenv("ANTHROPIC_API_KEY"));
        var model = envOr("TIER_ROUTER_LLM_MODEL", "claude-haiku-4-5");

        if (apiKey == null || apiKey.isBlank()) return null;

        try {
            var jsonContent = CLASSIFICATION_PROMPT.formatted(prompt)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n");
            var body = """
                {"model":"%s","max_tokens":10,"temperature":0.0,"messages":[{"role":"user","content":"%s"}]}"""
                .formatted(model, jsonContent);

            var request = HttpRequest.newBuilder()
                .uri(URI.create("%s/v1/messages".formatted(baseUrl)))
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
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

    private static String extractContent(String body) {
        var start = body.indexOf("\"text\":\"");
        if (start < 0) return null;
        start += 8;
        var end = body.indexOf('"', start);
        if (end < 0) return null;
        return body.substring(start, end);
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
