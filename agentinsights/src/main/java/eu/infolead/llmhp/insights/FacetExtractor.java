package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.SessionFacets;
import eu.infolead.llmhp.insights.types.SessionMeta;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class FacetExtractor {

    public interface LlmClient {
        String complete(String systemPrompt, String userPrompt, int maxTokens) throws Exception;
    }

    static final String FACET_PROMPT = """
        Analyze this AI coding agent session and extract structured facets.

        CRITICAL GUIDELINES:

        1. **goal_categories**: Count ONLY what the USER explicitly asked for.
           - DO NOT count the agent's autonomous codebase exploration
           - DO NOT count work the agent decided to do on its own
           - ONLY count when user says "can you...", "please...", "I need...", "let's..."

        2. **user_satisfaction_counts**: Base ONLY on explicit user signals.
           - "Yay!", "great!", "perfect!" -> happy
           - "thanks", "looks good", "that works" -> satisfied
           - "ok, now let's..." (continuing without complaint) -> likely_satisfied
           - "that's not right", "try again" -> dissatisfied
           - "this is broken", "I give up" -> frustrated

        3. **friction_counts**: Be specific about what went wrong.
           - misunderstood_request: Agent interpreted incorrectly
           - wrong_approach: Right goal, wrong solution method
           - buggy_code: Code didn't work correctly
           - user_rejected_action: User said no/stop to a tool call
           - excessive_changes: Over-engineered or changed too much

        4. If very short or just warmup, use warmup_minimal for goal_category
        """;

    static final String SUMMARIZE_PROMPT = """
        Summarize this portion of an AI coding agent session transcript. Focus on:
        1. What the user asked for
        2. What the agent did (tools used, files modified)
        3. Any friction or issues
        4. The outcome

        Keep it concise - 3-5 sentences. Preserve specific details like file names, error messages, and user feedback.
        """;

    static List<String> extractUserInstructions(SessionMeta meta, Map<String, Object> log) {
        var instructions = new ArrayList<String>();
        var messages = (List<?>) log.getOrDefault("messages", List.of());
        for (var msg : messages) {
            if (!(msg instanceof Map<?, ?> m)) continue;
            if (!"user".equals(m.get("type"))) continue;
            var content = m.get("message");
            if (content instanceof String s && !s.isBlank())
                instructions.add(s.length() > 200 ? s.substring(0, 197) + "..." : s);
        }
        return instructions;
    }

    public static SessionFacets extractFacets(LlmClient llm, SessionMeta meta, Map<String, Object> log)
            throws Exception {
        var transcript = formatTranscript(log);
        if (transcript.length() > 30000) {
            transcript = summarizeTranscript(llm, transcript, meta.sessionId());
        }

        var jsonPrompt = FACET_PROMPT + "\n\nSESSION:\n" + transcript + """


            RESPOND WITH ONLY A VALID JSON OBJECT matching this schema:
            {
              "underlying_goal": "What the user fundamentally wanted to achieve",
              "goal_categories": {"category_name": count, ...},
              "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
              "user_satisfaction_counts": {"level": count, ...},
              "claude_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
              "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
              "friction_counts": {"friction_type": count, ...},
              "friction_detail": "One sentence describing friction or empty",
              "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|good_debugging",
              "brief_summary": "One sentence: what user wanted and whether they got it"
            }""";

        var response = llm.complete("", jsonPrompt, 4096);
        var jsonMatch = extractJson(response);
        if (jsonMatch == null) return null;

        var parsed = ManualJson.parse(jsonMatch);
        if (!(parsed instanceof Map<?, ?> map)) return null;
        if (!SessionFacets.isValid(map)) return null;

        return new SessionFacets(
            meta.sessionId(),
            strV(map, "underlying_goal", ""),
            safeIntMap(map.get("goal_categories")),
            strV(map, "outcome", "unclear_from_transcript"),
            safeIntMap(map.get("user_satisfaction_counts")),
            strV(map, "claude_helpfulness", "moderately_helpful"),
            strV(map, "session_type", "single_task"),
            safeIntMap(map.get("friction_counts")),
            strV(map, "friction_detail", ""),
            strV(map, "primary_success", "none"),
            strV(map, "brief_summary", ""),
            Optional.of(extractUserInstructions(meta, log)),
            System.currentTimeMillis()
        );
    }

    static Map<String, Integer> safeIntMap(Object v) {
        var result = new HashMap<String, Integer>();
        if (v instanceof Map<?, ?> map) {
            for (var e : map.entrySet()) {
                if (e.getValue() instanceof Number n) result.put(e.getKey().toString(), n.intValue());
            }
        }
        return result;
    }

    static String strV(Map<?, ?> map, String key, String fallback) {
        var v = map.get(key);
        return v instanceof String s ? s : fallback;
    }

    static String formatTranscript(Map<String, Object> log) {
        var sb = new StringBuilder();
        var sessionId = (String) log.getOrDefault("session_id", "unknown");
        sb.append("Session: ").append(sessionId.length() > 8 ? sessionId.substring(0, 8) : sessionId).append("\n");

        var messages = (List<?>) log.getOrDefault("messages", List.of());
        for (var msg : messages) {
            if (!(msg instanceof Map<?, ?> m)) continue;
            var type = (String) m.get("type");
            var content = m.get("message");

            if ("user".equals(type) && content instanceof String s) {
                sb.append("[User]: ").append(s.length() > 500 ? s.substring(0, 497) + "..." : s).append("\n");
            } else if ("user".equals(type) && content instanceof Map<?, ?> msgContent) {
                var blocks = msgContent.get("content");
                if (blocks instanceof List<?> bl) {
                    for (var block : bl) {
                        if (block instanceof Map<?, ?> bm && "text".equals(bm.get("type"))
                            && bm.get("text") instanceof String t) {
                            sb.append("[User]: ").append(t.length() > 500 ? t.substring(0, 497) + "..." : t).append("\n");
                        }
                    }
                }
            } else if ("assistant".equals(type) && content instanceof Map<?, ?> msgContent) {
                var blocks = msgContent.get("content");
                if (blocks instanceof List<?> bl) {
                    for (var block : bl) {
                        if (!(block instanceof Map<?, ?> bm)) continue;
                        if ("text".equals(bm.get("type")) && bm.get("text") instanceof String t)
                            sb.append("[Assistant]: ").append(t.length() > 300 ? t.substring(0, 297) + "..." : t).append("\n");
                        else if ("tool_use".equals(bm.get("type")) && bm.get("name") instanceof String tn)
                            sb.append("[Tool: ").append(tn).append("]\n");
                    }
                }
            }
        }
        return sb.toString();
    }

    static String summarizeTranscript(LlmClient llm, String fullTranscript, String sessionId)
            throws Exception {
        int chunkSize = 25000;
        var chunks = new ArrayList<String>();
        for (int i = 0; i < fullTranscript.length(); i += chunkSize)
            chunks.add(fullTranscript.substring(i, Math.min(i + chunkSize, fullTranscript.length())));

        if (chunks.size() <= 1) return fullTranscript;

        var summaries = new ArrayList<String>();
        for (var chunk : chunks) {
            var text = llm.complete("", SUMMARIZE_PROMPT + "\n\nTRANSCRIPT CHUNK:\n" + chunk, 500);
            summaries.add(text != null ? text : chunk.substring(0, Math.min(chunk.length(), 2000)));
        }

        var sessionIdPrefix = sessionId.length() > 8 ? sessionId.substring(0, 8) : sessionId;
        var header = "Session: " + sessionIdPrefix
            + "\n[Long session - " + chunks.size() + " parts summarized]\n\n";
        return header + String.join("\n\n---\n\n", summaries);
    }

    static String extractJson(String text) {
        if (text == null) return null;
        var start = text.indexOf('{');
        var end = text.lastIndexOf('}');
        if (start < 0 || end < start) return null;
        return text.substring(start, end + 1);
    }
}
