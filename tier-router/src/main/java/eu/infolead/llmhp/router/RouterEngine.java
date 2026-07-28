package eu.infolead.llmhp.router;

import java.util.List;

/**
 * RouterEngine — combines mechanical escalation, keyword-based tier matching,
 * prompt reformulation (SOTA prompt engineering criteria), and ambiguity detection.
 *
 * Ported from routing_core.py `should_escalate()` + probabilistic_router.py
 * confidence classification. Augmented with:
 *   - Bandit-theoretic second-best margin (ai-patterns ch23: routing)
 *   - SOTA prompt rewriting (Anthropic docs: clarity, conciseness, XML, CoT)
 *   - Ambiguity detection with clarification question generation
 */
final class RouterEngine {

    private final Classifier classifier;
    private final Reformatter reformatter;

    private static final double DIRECT_CONFIDENCE_THRESHOLD = 0.8;
    private static final double MEDIUM_CONFIDENCE_THRESHOLD = 0.7;
    private static final double COMPLEXITY_CONFIDENCE = 1.0;
    private static final double BULK_DESTRUCTIVE_CONFIDENCE = 1.0;
    private static final double SOFT_SIGNAL_CONFIDENCE = 0.9;
    private static final double CREATION_CONFIDENCE = 0.85;

    RouterEngine() {
        this.classifier = new Classifier();
        this.reformatter = new Reformatter();
    }

    /**
     * Main entry point. Analyzes the raw user prompt and returns a routing decision
     * with rewritten prompt.
     *
     * Decision procedure (in escalation order):
     *   1. If ambiguous → ask user for clarification (DIRECT with empty prompt)
     *   2. If meta-routing → ESCALATE (let router agent handle it)
     *   3. If complexity signal → ESCALATE
     *   4. If bulk destructive → ESCALATE
     *   5. If file op without path → ESCALATE
     *   6. If agent definition edit → ESCALATE
     *   7. If multiple objectives → ESCALATE
     *   8. If creation task → ESCALATE
     *   9. Keyword match → DIRECT with confidence
     *   10. No match → ESCALATE
     *
     * @param prompt The raw user prompt (1–10000 chars)
     * @return RoutingResult with decision, tier, reason, confidence, rewritten prompt
     */
    RoutingResult route(String prompt) {
        validate(prompt);
        var trimmed = prompt.strip();

        // Step 1: Ambiguity detection — ask user to clarify
        if (reformatter.needsUserClarification(trimmed)) {
            var questions = reformatter.generateClarificationQuestions(trimmed);
            return new RoutingResult(
                Decision.DIRECT,
                Tier.SONNET,
                "Request ambiguous — clarification needed: " + String.join(" | ", questions),
                0.3,
                trimmed  // Don't rewrite ambiguous prompts
            );
        }

        // Step 2: Meta-routing — handle by router
        if (classifier.isMetaRouting(trimmed)) {
            return result(Decision.ESCALATE, null, "Meta-routing request", 0.9, trimmed);
        }

        // Step 3: Complexity signal
        if (classifier.hasComplexitySignal(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Complexity keyword detected (design, architecture, judgment, etc.)",
                COMPLEXITY_CONFIDENCE, trimmed);
        }

        // Step 4: Bulk destructive
        if (classifier.isBulkDestructive(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Bulk destructive operation requires judgment",
                BULK_DESTRUCTIVE_CONFIDENCE, trimmed);
        }

        // Step 5: File operation without path
        if (classifier.isFileOpWithoutPath(trimmed)) {
            return result(Decision.ESCALATE, null,
                "File operation without explicit path needs file discovery",
                SOFT_SIGNAL_CONFIDENCE, trimmed);
        }

        // Step 6: Agent definition modification
        if (classifier.modifiesAgentFiles(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Agent definition changes require careful judgment",
                COMPLEXITY_CONFIDENCE, trimmed);
        }

        // Step 7: Multiple objectives
        long objectives = classifier.countObjectives(trimmed);
        if (objectives >= 2) {
            return result(Decision.ESCALATE, null,
                "Multiple objectives (%d) require coordination".formatted(objectives),
                SOFT_SIGNAL_CONFIDENCE, trimmed);
        }

        // Step 8: Creation task
        if (classifier.isCreationTask(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Creation/design task requires planning and judgment",
                CREATION_CONFIDENCE, trimmed);
        }

        // Step 9: Keyword-based tier matching
        var tier = classifier.keywordMatch(trimmed);
        if (tier != null) {
            double confidence = classifier.keywordConfidence(trimmed, tier);
            if (confidence >= DIRECT_CONFIDENCE_THRESHOLD) {
                return result(Decision.DIRECT, tier,
                    "High-confidence keyword match", confidence, trimmed);
            } else if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
                return result(Decision.DIRECT, Tier.SONNET,
                    "Moderate confidence match — escalating to sonnet for verification",
                    confidence, trimmed);
            }
        }

        // Step 10: No match — escalate
        return result(Decision.ESCALATE, null,
            "No clear tier match — needs intelligent routing", 1.0, trimmed);
    }

    /**
     * Bundle prompt rewrite into the result.
     * For ambiguous prompts (where clarification is needed), skip rewriting.
     */
    RoutingResult routeWithRewrite(String prompt) {
        var result = route(prompt);
        if (result.confidence() < 0.4 && result.rewrittenPrompt().equals(prompt.strip())) {
            return result; // ambiguous — don't rewrite
        }
        if (result.decision() == Decision.DIRECT && result.tier() != null) {
            var rewritten = reformatter.rewrite(result.rewrittenPrompt(), result.tier());
            return new RoutingResult(result.decision(), result.tier(), result.reason(),
                result.confidence(), rewritten);
        }
        return result;
    }

    private RoutingResult result(Decision decision, Tier tier, String reason,
                                  double confidence, String prompt) {
        return new RoutingResult(decision, tier, reason, confidence, prompt);
    }

    private void validate(String prompt) {
        if (prompt == null) throw new IllegalArgumentException("prompt must not be null");
        if (prompt.isBlank()) throw new IllegalArgumentException("prompt must not be empty");
        if (prompt.length() > 10000) throw new IllegalArgumentException(
            "prompt too long: " + prompt.length() + " chars (max 10000)");
    }
}
