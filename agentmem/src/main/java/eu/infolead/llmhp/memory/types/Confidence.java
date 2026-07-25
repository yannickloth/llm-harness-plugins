package eu.infolead.llmhp.memory.types;

public enum Confidence {
    HIGH("high"),
    MEDIUM("medium"),
    LOW("low"),
    SPECULATIVE("speculative");

    private final String label;
    Confidence(String label) { this.label = label; }
    public String label() { return label; }

    public static Confidence fromString(String s) {
        return switch (s.toLowerCase()) {
            case "high" -> HIGH;
            case "medium" -> MEDIUM;
            case "low" -> LOW;
            case "speculative" -> SPECULATIVE;
            default -> throw new IllegalArgumentException("Unknown confidence: " + s);
        };
    }
}
