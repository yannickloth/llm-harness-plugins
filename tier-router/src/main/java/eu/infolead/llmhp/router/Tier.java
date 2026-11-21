package eu.infolead.llmhp.router;

/** Capability/cost bands, ascending: Haiku < Sonnet < Opus.
 *
 * The bands are abstractions over the ranks the gateway serves; there is no
 * band without a rank behind it. Keep the enum in ascending order so
 * ordinal() reads as "cheaper -> stronger". */
enum Tier {
    HAIKU, SONNET, OPUS;

    static Tier from(String s) {
        return switch (s.toLowerCase()) {
            case "haiku" -> HAIKU;
            case "sonnet" -> SONNET;
            case "opus" -> OPUS;
            default -> SONNET;
        };
    }

    double relativeCost() {
        return switch (this) {
            case HAIKU -> 0.25;
            case SONNET -> 1.0;
            case OPUS -> 12.0;
        };
    }
}
