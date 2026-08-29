package eu.infolead.llmhp.sdlcguardrails;

/**
 * Exception signalling a guardrail check that could not complete. Callers treat
 * this as a fail-safe "pass" — a broken contract must never block work.
 */
public final class SdlcGuardrailsException extends RuntimeException {
    public SdlcGuardrailsException(String message) {
        super(message);
    }

    public SdlcGuardrailsException(String message, Throwable cause) {
        super(message, cause);
    }
}
