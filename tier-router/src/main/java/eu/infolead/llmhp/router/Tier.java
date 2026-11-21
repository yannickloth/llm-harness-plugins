package eu.infolead.llmhp.router;

/** Capability/cost bands, ascending: Haiku < Sonnet < Opus < Fable.
 *
 * Claude's real lineup puts Fable (Mythos-class) above Opus, and Haiku at
 * the bottom. An earlier version of this plugin had that inverted; keep the
 * enum in ascending order so ordinal() reads as "cheaper -> stronger". */
enum Tier {
    HAIKU, SONNET, OPUS, FABLE;

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
            case HAIKU -> 0.25;
            case SONNET -> 1.0;
            case OPUS -> 12.0;
            case FABLE -> 75.0;
        };
    }
}
