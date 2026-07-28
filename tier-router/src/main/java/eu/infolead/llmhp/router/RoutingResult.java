package eu.infolead.llmhp.router;

record RoutingResult(
    Decision decision,
    Tier tier,
    String reason,
    double confidence,
    String rewrittenPrompt
) {
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
        return """
            {
              "decision": "%s",
              "tier": "%s",
              "reason": "%s",
              "confidence": %.2f,
              "rewritten_prompt": "%s"
            }
            """.formatted(
            decision.name().toLowerCase(),
            tierStr,
            escapedReason,
            confidence,
            escapedPrompt
        );
    }
}
