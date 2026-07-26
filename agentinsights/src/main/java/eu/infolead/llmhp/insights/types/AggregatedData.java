package eu.infolead.llmhp.insights.types;

import java.util.*;

public record AggregatedData(
    int totalSessions,
    int sessionsWithFacets,
    DateRange dateRange,
    long totalMessages,
    double totalDurationHours,
    long totalInputTokens,
    long totalOutputTokens,
    Map<String, Integer> toolCounts,
    Map<String, Integer> languages,
    int gitCommits,
    int gitPushes,
    Map<String, Integer> projects,
    Map<String, Integer> goalCategories,
    Map<String, Integer> outcomes,
    Map<String, Integer> satisfaction,
    Map<String, Integer> helpfulness,
    Map<String, Integer> sessionTypes,
    Map<String, Integer> friction,
    Map<String, Integer> success,
    List<SessionSummary> sessionSummaries,
    int totalInterruptions,
    int totalToolErrors,
    Map<String, Integer> toolErrorCategories,
    List<Double> userResponseTimes,
    double medianResponseTime,
    double avgResponseTime,
    int sessionsUsingTaskAgent,
    int sessionsUsingMcp,
    int sessionsUsingWebSearch,
    int sessionsUsingWebFetch,
    int totalLinesAdded,
    int totalLinesRemoved,
    int totalFilesModified,
    int daysActive,
    double messagesPerDay,
    List<Integer> messageHours,
    MultiClaudingStats multiClauding
) {
    public record DateRange(String start, String end) {}
    public record SessionSummary(String id, String date, String summary, Optional<String> goal) {}
    public record MultiClaudingStats(int overlapEvents, int sessionsInvolved, int userMessagesDuring) {}

    public static AggregatedData empty() {
        return new AggregatedData(
            0, 0, new DateRange("", ""), 0L, 0.0, 0L, 0L,
            new HashMap<>(), new HashMap<>(), 0, 0,
            new HashMap<>(), new HashMap<>(), new HashMap<>(),
            new HashMap<>(), new HashMap<>(), new HashMap<>(),
            new HashMap<>(), new HashMap<>(),
            List.of(),
            0, 0, new HashMap<>(), List.of(), 0.0, 0.0,
            0, 0, 0, 0, 0, 0, 0, 0, 0.0, List.of(),
            new MultiClaudingStats(0, 0, 0)
        );
    }
}
