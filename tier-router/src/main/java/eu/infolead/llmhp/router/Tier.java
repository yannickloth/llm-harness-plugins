package eu.infolead.llmhp.router;

enum Tier {
    FABLE, HAIKU, SONNET, OPUS;

    static Tier from(String s) {
        return switch (s.toLowerCase()) {
            case "fable" -> FABLE;
            case "haiku" -> HAIKU;
            case "sonnet" -> SONNET;
            case "opus" -> OPUS;
            default -> SONNET;
        };
    }

    double relativeCost() {
        return switch (this) {
            case FABLE -> 0.25;
            case HAIKU -> 1.0;
            case SONNET -> 12.0;
            case OPUS -> 75.0;
        };
    }
}
