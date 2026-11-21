package eu.infolead.llmhp.router;

/** Tier bands, ascending: sergeant < warrant-officer < lieutenant.
 *
 * The band names are the ranks the gateway serves; there is no band without a
 * rank behind it. Keep the enum in ascending order so ordinal() reads as
 * "cheaper -> stronger". */
enum Tier {
    SERGEANT, WARRANT_OFFICER, LIEUTENANT;

    static Tier from(String s) {
        return switch (s.toLowerCase()) {
            case "sergeant" -> SERGEANT;
            case "warrant-officer", "warrant_officer" -> WARRANT_OFFICER;
            case "lieutenant" -> LIEUTENANT;
            default -> WARRANT_OFFICER;
        };
    }

    /** The proxy/agent name: the rank name as the gateway spells it. */
    String proxyName() {
        return switch (this) {
            case SERGEANT -> "sergeant";
            case WARRANT_OFFICER -> "warrant-officer";
            case LIEUTENANT -> "lieutenant";
        };
    }

    double relativeCost() {
        return switch (this) {
            case SERGEANT -> 0.25;
            case WARRANT_OFFICER -> 1.0;
            case LIEUTENANT -> 12.0;
        };
    }
}
