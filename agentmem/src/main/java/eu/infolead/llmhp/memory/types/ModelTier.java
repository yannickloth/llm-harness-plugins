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

    public static ModelTier fromModelId(String modelId) {
        var lower = modelId.toLowerCase();
        if (lower.contains("opus") || lower.contains("gpt-5")) return S;
        if ((lower.contains("sonnet") || lower.contains("gpt-4o")) && !lower.contains("mini")
            || lower.contains("gemini-2.5-pro")) return A;
        if (lower.contains("haiku") || lower.contains("gpt-4o-mini")
            || lower.contains("deepseek-v4")) return B;
        if (lower.contains("deepseek-v3") || lower.contains("llama")
            || lower.contains("mistral")) return C;
        return UNKNOWN;
    }
}
