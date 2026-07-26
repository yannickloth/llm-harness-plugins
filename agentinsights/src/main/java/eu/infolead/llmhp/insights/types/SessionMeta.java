package eu.infolead.llmhp.insights.types;

import java.util.*;

public record SessionMeta(
    String sessionId,
    String projectPath,
    String startTime,
    int durationMinutes,
    int userMessageCount,
    int assistantMessageCount,
    Map<String, Integer> toolCounts,
    Map<String, Integer> languages,
    int gitCommits,
    int gitPushes,
    long inputTokens,
    long outputTokens,
    String firstPrompt,
    Optional<String> summary,
    int userInterruptions,
    List<Double> userResponseTimes,
    int toolErrors,
    Map<String, Integer> toolErrorCategories,
    boolean usesTaskAgent,
    boolean usesMcp,
    boolean usesWebSearch,
    boolean usesWebFetch,
    int linesAdded,
    int linesRemoved,
    int filesModified,
    List<Integer> messageHours,
    List<String> userMessageTimestamps,
    long sessionMtime
) {
    public static SessionMeta empty(String sessionId) {
        return new SessionMeta(
            sessionId, "", "", 0, 0, 0,
            Map.of(), Map.of(), 0, 0, 0, 0, "",
            Optional.empty(), 0, List.of(), 0, Map.of(),
            false, false, false, false, 0, 0, 0,
            List.of(), List.of(), 0
        );
    }

    public Map<String, Object> toMap() {
        var map = new LinkedHashMap<String, Object>();
        map.put("session_id", sessionId);
        map.put("project_path", projectPath);
        map.put("start_time", startTime);
        map.put("duration_minutes", durationMinutes);
        map.put("user_message_count", userMessageCount);
        map.put("assistant_message_count", assistantMessageCount);
        map.put("tool_counts", toolCounts);
        map.put("languages", languages);
        map.put("git_commits", gitCommits);
        map.put("git_pushes", gitPushes);
        map.put("input_tokens", inputTokens);
        map.put("output_tokens", outputTokens);
        map.put("user_interruptions", userInterruptions);
        map.put("user_response_times", userResponseTimes);
        map.put("tool_errors", toolErrors);
        map.put("tool_error_categories", toolErrorCategories);
        map.put("uses_task_agent", usesTaskAgent);
        map.put("uses_mcp", usesMcp);
        map.put("uses_web_search", usesWebSearch);
        map.put("uses_web_fetch", usesWebFetch);
        map.put("lines_added", linesAdded);
        map.put("lines_removed", linesRemoved);
        map.put("files_modified", filesModified);
        map.put("message_hours", messageHours);
        map.put("user_message_timestamps", userMessageTimestamps);
        map.put("session_mtime", sessionMtime);
        map.put("first_prompt", firstPrompt);
        summary.ifPresent(s -> map.put("summary", s));
        return map;
    }
}
