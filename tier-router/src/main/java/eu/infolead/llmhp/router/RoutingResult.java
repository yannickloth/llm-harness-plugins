package eu.infolead.llmhp.router;

import java.util.List;

record RoutingResult(
    Decision decision,
    Tier tier,
    List<String> fleetModels,
    String reason,
    double confidence,
    String rewrittenPrompt
) {
    RoutingResult(Decision decision, Tier tier, String fleetModel, String reason, double confidence, String rewrittenPrompt) {
        this(decision, tier, fleetModel != null ? List.of(fleetModel) : null, reason, confidence, rewrittenPrompt);
    }

    RoutingResult(Decision decision, Tier tier, String reason, double confidence, String rewrittenPrompt) {
        this(decision, tier, (List<String>) null, reason, confidence, rewrittenPrompt);
    }

    String toJson() {
        var escapedReason = reason
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t");
        var escapedPrompt = rewrittenPrompt
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n");
        var tierStr = tier != null ? tier.name().toLowerCase() : "null";
        var fleetField = "";
        if (fleetModels != null && !fleetModels.isEmpty()) {
            var models = fleetModels.stream()
                .map(m -> "\"" + m + "\"")
                .reduce((a, b) -> a + ", " + b).orElse("");
            fleetField = "\"fleet_models\": [%s],\n  ".formatted(models);
        }
        return """
            {
              %s"decision": "%s",
              "tier": "%s",
              "reason": "%s",
              "confidence": %.2f,
              "rewritten_prompt": "%s"
            }
            """.formatted(
            fleetField,
            decision.name().toLowerCase(),
            tierStr,
            escapedReason,
            confidence,
            escapedPrompt
        );
    }
}
