package eu.infolead.llmhp.memory.types;

public enum ModelTier {
    S("frontier"),
    A("strong"),
    B("capable"),
    C("light"),
    UNKNOWN("unknown");

    private final String label;
    ModelTier(String label) { this.label = label; }
    public String label() { return label; }

    /** Rank-first: the gateway serves rank names, so match the ladder before
     * the legacy explicit model ids. */
    public static ModelTier fromModelId(String modelId) {
        var lower = modelId.toLowerCase();
        // Frontier
        if (lower.contains("brigadier") || lower.contains("k3.1")
            || lower.contains("fable") || lower.contains("opus")
            || lower.contains("gpt-5")) return S;
        // Strong
        if (lower.contains("major") || lower.contains("lieutenant-colonel")
            || (lower.contains("lieutenant") && !lower.contains("second-lieutenant"))
            || lower.contains("k3") || lower.contains("kimi-for-coding")
            || lower.contains("glm-5")
            || lower.contains("sonnet")
            || (lower.contains("gpt-4o") && !lower.contains("mini"))
            || lower.contains("gemini-2.5-pro")) return A;
        // Capable
        if (lower.contains("warrant-officer") || lower.contains("second-lieutenant")
            || lower.contains("haiku") || lower.contains("gpt-4o-mini")
            || lower.contains("deepseek-v4")) return B;
        // Light
        if (lower.contains("sergeant") || lower.contains("deepseek-v3")
            || lower.contains("llama") || lower.contains("mistral")) return C;
        return UNKNOWN;
    }
}
