package eu.infolead.llmhp.insights;

import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;

public class InsightsCli {

    static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30))
        .build();

    public static void main(String[] args) throws Exception {
        if (args.length < 1) { usage(); return; }
        var cmd = args[0];

        switch (cmd) {
            case "run" -> {
                var sessionDir = Path.of(argVal(args, "--session-dir", "."));
                var insightsDir = Path.of(argVal(args, "--insights-dir",
                    sessionDir.resolve(".agentmem").resolve("insights").toString()));
                var platform = argVal(args, "--platform", "generic");

                var config = new InsightsRunner.Config(sessionDir, insightsDir, platform,
                    (sys, usr, max) -> invokeLlm(sys, usr, max));

                var output = InsightsRunner.run(config, p -> {
                    System.err.println(p.toLine());
                });
                System.out.println(output);
            }
            case "status" -> {
                var insightsDir = Path.of(args[1]);
                status(insightsDir);
            }
            case "clear" -> {
                var insightsDir = Path.of(args[1]);
                CacheManager.clearAll(insightsDir);
                System.out.println("CLEARED " + insightsDir);
            }
            default -> { System.err.println("Unknown: " + cmd); System.exit(1); }
        }
    }

    static void status(Path insightsDir) throws IOException {
        if (!Files.exists(insightsDir)) {
            System.out.println("NO_CACHE");
            return;
        }
        var metaDir = insightsDir.resolve("session-meta");
        var facetsDir = insightsDir.resolve("facets");
        int metaCount = 0, facetsCount = 0;
        if (Files.exists(metaDir)) {
            try (var s = Files.list(metaDir)) { metaCount = (int) s.count(); }
        }
        if (Files.exists(facetsDir)) {
            try (var s = Files.list(facetsDir)) { facetsCount = (int) s.count(); }
        }
        var reportPath = insightsDir.resolve("report.html");
        var hasReport = Files.exists(reportPath);

        System.out.printf("SESSIONS_SCANNED=%d\n", metaCount);
        System.out.printf("SESSIONS_FACETED=%d\n", facetsCount);
        System.out.printf("REPORT_EXISTS=%s\n", hasReport);
        if (hasReport) System.out.printf("REPORT_PATH=%s\n", reportPath.toAbsolutePath());
    }

    static String invokeLlm(String systemPrompt, String userPrompt, int maxTokens) {
        var env = System.getenv();
        var anthropicKey = env.getOrDefault("ANTHROPIC_API_KEY", "");
        var openaiKey = env.getOrDefault("OPENAI_API_KEY", "");
        var model = env.getOrDefault("INSIGHTS_MODEL", "");
        boolean isOpenAI = !openaiKey.isBlank() && anthropicKey.isBlank();
        var apiKey = isOpenAI ? openaiKey : anthropicKey;

        if (apiKey.isBlank()) {
            System.err.println("WARNING: No API key found (ANTHROPIC_API_KEY or OPENAI_API_KEY)");
            return "{}";
        }

        String body;
        if (isOpenAI) {
            body = buildOpenAiBody(systemPrompt, userPrompt, maxTokens, model);
        } else {
            body = buildAnthropicBody(systemPrompt, userPrompt, maxTokens, model);
        }

        try {
            var baseUrl = env.getOrDefault("INSIGHTS_API_URL",
                isOpenAI ? "https://api.openai.com/v1/chat/completions"
                         : "https://api.anthropic.com/v1/messages");
            var uri = URI.create(baseUrl);

            var reqBuilder = HttpRequest.newBuilder()
                .uri(uri)
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(300))
                .POST(HttpRequest.BodyPublishers.ofString(body));

            if (isOpenAI) {
                reqBuilder.header("Authorization", "Bearer " + apiKey);
            } else {
                reqBuilder.header("x-api-key", apiKey);
                reqBuilder.header("anthropic-version", "2023-06-01");
            }

            var resp = HTTP.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());
            var text = resp.body();

            if (isOpenAI) return extractOpenAiContent(text);
            return extractAnthropicContent(text);
        } catch (Exception e) {
            System.err.println("LLM invoke failed: " + e.getMessage());
            return "{}";
        }
    }

    static String buildAnthropicBody(String sys, String usr, int maxTokens, String model) {
        var sb = new StringBuilder();
        if (!sys.isBlank()) {
            sb.append("{\"system\":\"");
            sb.append(ManualJson.escape(sys));
            sb.append("\",\"messages\":[");
        } else {
            sb.append("{\"messages\":[");
        }
        sb.append("{\"role\":\"user\",\"content\":\"");
        sb.append(ManualJson.escape(usr));
        sb.append("\"}],\"max_tokens\":").append(maxTokens);
        if (!model.isBlank()) sb.append(",\"model\":\"").append(model).append("\"");
        sb.append("}");
        return sb.toString();
    }

    static String buildOpenAiBody(String sys, String usr, int maxTokens, String model) {
        var sb = new StringBuilder();
        sb.append("{\"messages\":[");
        if (!sys.isBlank()) {
            sb.append("{\"role\":\"system\",\"content\":\"");
            sb.append(ManualJson.escape(sys));
            sb.append("\"},");
        }
        sb.append("{\"role\":\"user\",\"content\":\"");
        sb.append(ManualJson.escape(usr));
        sb.append("\"}],\"max_tokens\":").append(maxTokens);
        if (!model.isBlank()) sb.append(",\"model\":\"").append(model).append("\"");
        sb.append("}");
        return sb.toString();
    }

    static String extractAnthropicContent(String text) {
        if (text == null || text.isBlank()) return text;
        var parsed = ManualJson.parse(text);
        if (parsed instanceof Map<?, ?> map) {
            var content = map.get("content");
            if (content instanceof List<?> blocks) {
                for (var block : blocks) {
                    if (block instanceof Map<?, ?> bm) {
                        var blockType = bm.get("type");
                        if ("text".equals(blockType) && bm.get("text") instanceof String t) return t;
                    }
                }
            }
        }
        return text;
    }

    static String extractOpenAiContent(String text) {
        if (text == null || text.isBlank()) return text;
        var parsed = ManualJson.parse(text);
        if (parsed instanceof Map<?, ?> map) {
            var choices = map.get("choices");
            if (choices instanceof List<?> cl && !cl.isEmpty() && cl.getFirst() instanceof Map<?, ?> choice) {
                var message = choice.get("message");
                if (message instanceof Map<?, ?> msg && msg.get("content") instanceof String s) return s;
            }
        }
        return text;
    }

    static String argVal(String[] args, String flag, String defaultVal) {
        for (int i = 0; i < args.length - 1; i++) {
            if (flag.equals(args[i])) return args[i + 1];
        }
        return defaultVal;
    }

    static void usage() {
        System.err.println("""
            Insights <cmd> [args...]
            Commands:
              run    --session-dir <path> --insights-dir <path> --platform <name>
              status <insightsDir>
              clear  <insightsDir>
            """);
    }
}
