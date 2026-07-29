package eu.infolead.llmhp.guardrails.types;

public sealed interface GuardResult permits GuardResult.Pass, GuardResult.Warn, GuardResult.Block {
    String message();
    String source();

    record Pass(String source) implements GuardResult {
        public String message() { return "passed"; }
    }
    record Warn(String source, String message) implements GuardResult {}
    record Block(String source, String message) implements GuardResult {}
}
