package eu.infolead.llmhp.router;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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
    private Map<SkillAxis, SkillAxisMapping> axisModelMap = Map.of();
    private List<UserMemorySignal> memorySignals = List.of();

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

    void setMemorySignals(List<UserMemorySignal> signals) {
        this.memorySignals = signals;
    }

    void setSkillAxisMappings(Map<SkillAxis, SkillAxisMapping> mappings) {
        this.axisModelMap = mappings;
    }

    /**
     * Main entry point. Analyzes the raw user prompt and returns a routing decision
     * with rewritten prompt.
     *
     * Decision procedure (in escalation order):
     *   0. User memory signals — LEARNING domain → escalate, EXPERT → keep tier
     *   1. If ambiguous → ask user for clarification (DIRECT with empty prompt)
     *   2. Skill-axis keyword match → DIRECT with fleet model
     *   3. LLM classification (primary fallback)
     *   4. If meta-routing → ESCALATE (let router agent handle it)
     *   5. If complexity signal → ESCALATE
     *   6. If bulk destructive → ESCALATE
     *   7. If file op without path → ESCALATE
     *   8. If agent definition edit → ESCALATE
     *   9. If multiple objectives → ESCALATE
     *   10. If creation task → ESCALATE
     *   11. Keyword tier match → DIRECT with confidence
     *   12. No match → ESCALATE
     *
     * @param prompt The raw user prompt (1–10000 chars)
     * @return RoutingResult with decision, tier, fleetModel, reason, confidence, rewritten prompt
     */
    RoutingResult route(String prompt) {
        validate(prompt);
        var trimmed = prompt.strip();

        // Step 0: User memory signals — LEARNING domain → escalate; else attach hint
        var memMatches = classifier.matchUserMemorySignals(trimmed, memorySignals);
        var memoryHint = "";
        var forceEscalate = false;
        Classifier.MemorySignalMatch matchedSignal = null;
        if (!memMatches.isEmpty()) {
            matchedSignal = memMatches.getFirst();
            memoryHint = " [memory-hint: %s (%s) from %s]".formatted(
                matchedSignal.domain(), matchedSignal.signal().name().toLowerCase(), matchedSignal.confidence());
            if (matchedSignal.signal() == Signal.LEARNING) {
                forceEscalate = true;
            }
        }

        // Step 1: Ambiguity detection — ask user to clarify (runs before LLM classification)
        if (reformatter.needsUserClarification(trimmed)) {
            if (forceEscalate) {
                return result(Decision.ESCALATE, null,
                    "Request ambiguous" + memoryHint + " — escalate for judgment", 0.6, trimmed);
            }
            var questions = reformatter.generateClarificationQuestions(trimmed);
            return new RoutingResult(
                Decision.DIRECT,
                Tier.SONNET,
                "Request ambiguous — clarification needed: " + String.join(" | ", questions) + memoryHint,
                0.3,
                trimmed
            );
        }

        // Step 2: Skill-axis keyword match — primary fleet model routing with retry pool
        var axisMatch = classifier.skillAxisMatch(trimmed);
        if (axisMatch.isPresent() && !axisModelMap.isEmpty()) {
            var axis = axisMatch.get();
            var mapping = SkillAxisConfig.lookup(axisModelMap, axis);
            if (mapping.isPresent()) {
                var m = mapping.get();
                var models = new ArrayList<String>();
                var matchConfidence = m.matchType() == SkillAxisMapping.MatchType.direct ? 0.9 : 0.75;

                if (m.initial() != null) {
                    models.add(m.initial());
                    models.add(m.model());
                } else {
                    models.add(m.model());
                }

                var fleetReason = "Skill-axis match: %s → primary=%s".formatted(
                    axis.name().toLowerCase(), m.model());
                if (m.initial() != null) {
                    fleetReason += " (try initial=%s first)".formatted(m.initial());
                }
                fleetReason += " (%s) — %s".formatted(m.matchType().name(), m.note());
                return new RoutingResult(
                    Decision.DIRECT, null, models, fleetReason + memoryHint, matchConfidence, trimmed);
            }
        }

        // Step 3 (fallback): LLM classification (primary)
        var llmResult = LlmClassifier.classify(trimmed);
        if (llmResult != null) {
            var reason = llmResult.reason();
            if (llmResult.decision() == Decision.ESCALATE) {
                return result(Decision.ESCALATE, null, reason + memoryHint, llmResult.confidence(), trimmed);
            }
            if (forceEscalate && matchedSignal != null) {
                return result(Decision.ESCALATE, null,
                    "LLM routed but user is learning %s — escalating for judgment".formatted(matchedSignal.domain()) + memoryHint,
                    matchedSignal.confidence(), trimmed);
            }
            return result(llmResult.decision(), llmResult.tier(), reason + memoryHint, llmResult.confidence(), trimmed);
        }

        // Step 4 (fallback): Keyword-based classification

        // Meta-routing — handle by router
        if (classifier.isMetaRouting(trimmed)) {
            return result(Decision.ESCALATE, null, "Meta-routing request" + memoryHint, 0.9, trimmed);
        }

        // Complexity signal
        if (classifier.hasComplexitySignal(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Complexity keyword detected" + memoryHint, COMPLEXITY_CONFIDENCE, trimmed);
        }

        // Bulk destructive
        if (classifier.isBulkDestructive(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Bulk destructive operation requires judgment" + memoryHint, BULK_DESTRUCTIVE_CONFIDENCE, trimmed);
        }

        // File operation without path
        if (classifier.isFileOpWithoutPath(trimmed)) {
            return result(Decision.ESCALATE, null,
                "File operation without explicit path needs file discovery" + memoryHint, SOFT_SIGNAL_CONFIDENCE, trimmed);
        }

        // Agent definition modification
        if (classifier.modifiesAgentFiles(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Agent definition changes require careful judgment" + memoryHint, COMPLEXITY_CONFIDENCE, trimmed);
        }

        // Multiple objectives
        long objectives = classifier.countObjectives(trimmed);
        if (objectives >= 2) {
            return result(Decision.ESCALATE, null,
                "Multiple objectives (%d) require coordination".formatted(objectives) + memoryHint,
                SOFT_SIGNAL_CONFIDENCE, trimmed);
        }

        // Creation task
        if (classifier.isCreationTask(trimmed)) {
            return result(Decision.ESCALATE, null,
                "Creation/design task requires planning and judgment" + memoryHint,
                CREATION_CONFIDENCE, trimmed);
        }

        // Keyword-based tier matching
        var tier = classifier.keywordMatch(trimmed);
        if (tier != null) {
            double confidence = classifier.keywordConfidence(trimmed, tier);
            if (confidence >= DIRECT_CONFIDENCE_THRESHOLD) {
                return result(Decision.DIRECT, tier,
                    "High-confidence keyword match" + memoryHint, confidence, trimmed);
            } else if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
                return result(Decision.DIRECT, Tier.SONNET,
                    "Moderate confidence match — escalating to sonnet for verification" + memoryHint,
                    confidence, trimmed);
            }
        }

        // Memory learning signal → force escalate when no direct match
        if (forceEscalate) {
            return result(Decision.ESCALATE, null,
                "No tier match + user is learning %s — escalate for judgment".formatted(matchedSignal.domain()) + memoryHint,
                matchedSignal.confidence(), trimmed);
        }

        // No match — escalate
        return result(Decision.ESCALATE, null,
            "No match in keyword fallback — needs intelligent routing" + memoryHint, 1.0, trimmed);
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
