package eu.infolead.llmhp.insights.types;

import java.util.*;

public record SessionFacets(
    String sessionId,
    String underlyingGoal,
    Map<String, Integer> goalCategories,
    String outcome,
    Map<String, Integer> userSatisfactionCounts,
    String claudeHelpfulness,
    String sessionType,
    Map<String, Integer> frictionCounts,
    String frictionDetail,
    String primarySuccess,
    String briefSummary,
    Optional<List<String>> userInstructionsToClaude,
    long extractedAt
) {
    static final Set<String> VALID_OUTCOMES = Set.of(
        "fully_achieved", "mostly_achieved", "partially_achieved",
        "not_achieved", "unclear_from_transcript"
    );
    static final Set<String> VALID_HELPFULNESS = Set.of(
        "unhelpful", "slightly_helpful", "moderately_helpful",
        "very_helpful", "essential"
    );
    static final Set<String> VALID_SESSION_TYPES = Set.of(
        "single_task", "multi_task", "iterative_refinement",
        "exploration", "quick_question", "warmup_minimal"
    );

    public static boolean isValid(Map<?, ?> map) {
        if (!map.containsKey("session_id")) return false;
        var outcome = map.get("outcome");
        if (outcome instanceof String s && !s.isEmpty() && !VALID_OUTCOMES.contains(s)) return false;
        var helpful = map.get("claude_helpfulness");
        if (helpful instanceof String s && !s.isEmpty() && !VALID_HELPFULNESS.contains(s)) return false;
        var stype = map.get("session_type");
        if (stype instanceof String s && !s.isEmpty() && !VALID_SESSION_TYPES.contains(s)) return false;
        return true;
    }
}
