package eu.infolead.llmhp.promptregistry.types;

import java.time.Instant;

public record ABTestResult(
    String promptName,
    int variantA,
    int variantB,
    String comparisonDescription,
    Instant timestamp
) {
    public String toJson() {
        return """
            {"prompt_name":"%s","variant_a":%d,"variant_b":%d,"description":"%s","timestamp":"%s"}"""
            .formatted(PromptVersion.escapeJson(promptName), variantA, variantB,
                PromptVersion.escapeJson(comparisonDescription), timestamp.toString());
    }
}
