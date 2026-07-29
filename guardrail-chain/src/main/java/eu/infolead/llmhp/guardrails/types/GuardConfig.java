package eu.infolead.llmhp.guardrails.types;

public record GuardConfig(
    boolean enableSecretScan,
    boolean enablePathValidation,
    boolean enablePromptGuard,
    boolean enableSizeBounds,
    boolean blockOnCritical
) {
    public static GuardConfig all() {
        return new GuardConfig(true, true, true, true, true);
    }

    public static GuardConfig warnOnly() {
        return new GuardConfig(true, true, true, true, false);
    }

    public static GuardConfig none() {
        return new GuardConfig(false, false, false, false, false);
    }
}
