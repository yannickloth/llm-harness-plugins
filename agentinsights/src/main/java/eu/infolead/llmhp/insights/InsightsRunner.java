package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class InsightsRunner {

    public interface LlmClient {
        String complete(String systemPrompt, String userPrompt, int maxTokens) throws Exception;
    }

    public record Config(
        Path sessionDir,
        Path insightsDir,
        String platform,
        LlmClient llm
    ) {}

    public record Progress(String stage, int done, int total, String message) {
        public String toLine() {
            return String.format("[%s] %d/%d %s", stage, done, total, message);
        }
    }

    public interface ProgressCallback {
        void onProgress(Progress p);
    }

    public static String run(Config config, ProgressCallback cb) throws Exception {
        var cache = CacheManager.init(config.insightsDir());
        var facetsDir = config.insightsDir().resolve("facets");
        var sessionMetaDir = config.insightsDir().resolve("session-meta");

        cb.onProgress(new Progress("scan", 0, 0, "Discovering session files..."));

        var sessions = new ArrayList<SessionMeta>();
        var sessionFiles = SessionScanner.discoverSessions(config.sessionDir());

        cb.onProgress(new Progress("scan", 0, sessionFiles.size(), "Scanning " + sessionFiles.size() + " sessions..."));

        int scanned = 0;
        int failures = 0;
        for (var sf : sessionFiles) {
            try {
                var cached = CacheManager.loadCachedSessionMeta(sessionMetaDir, sf.sessionId());
                SessionMeta meta;
                if (cached.isPresent()) {
                    var parsed = ManualJson.parse(cached.get());
                    if (parsed instanceof Map<?, ?> map) {
                        var rawMtime = map.get("session_mtime");
                        long cachedMtime = rawMtime instanceof Number n ? n.longValue() : 0L;
                        if (cachedMtime >= sf.mtime()) {
                            meta = parseSessionMetaFromMap(map);
                        } else {
                            var opt = SessionScanner.scanSession(resolveSessionFile(config.sessionDir(), sf.sessionId()));
                            if (opt.isEmpty()) { failures++; continue; }
                            meta = opt.get();
                            CacheManager.saveSessionMeta(sessionMetaDir, sf.sessionId(),
                                ManualJson.toJson(meta.toMap()));
                        }
                    } else { failures++; continue; }
                } else {
                    var opt = SessionScanner.scanSession(resolveSessionFile(config.sessionDir(), sf.sessionId()));
                    if (opt.isEmpty()) { failures++; continue; }
                    meta = opt.get();
                    CacheManager.saveSessionMeta(sessionMetaDir, sf.sessionId(),
                        ManualJson.toJson(meta.toMap()));
                }
                sessions.add(meta);
                scanned++;
                if (scanned % 10 == 0 || scanned == sessionFiles.size())
                    cb.onProgress(new Progress("scan", scanned, sessionFiles.size(),
                        meta.sessionId().substring(0, Math.min(8, meta.sessionId().length()))));
            } catch (Exception e) {
                failures++;
                System.err.println("WARN: scan failed for " + sf.sessionId() + ": " + e.getMessage());
            }
        }

        if (failures > 0) System.err.println("WARN: " + failures + " session(s) failed to scan");

        cb.onProgress(new Progress("facets", 0, sessions.size(), "Extracting session facets..."));

        var facets = new HashMap<String, SessionFacets>();
        int facetDone = 0;
        int facetFailures = 0;
        for (var session : sessions) {
            if (session.userMessageCount() < 2) { facetDone++; continue; }

            try {
                var cached = CacheManager.loadCachedFacets(facetsDir, session.sessionId());
                if (cached.isPresent()) {
                    var parsed = ManualJson.parse(cached.get());
                    if (parsed instanceof Map<?, ?> map
                        && SessionFacets.isValid(map)) {
                        facets.put(session.sessionId(), parseFacetsFromMap(session.sessionId(), map));
                        facetDone++;
                        continue;
                    } else {
                        CacheManager.deleteFacets(facetsDir, session.sessionId());
                    }
                }

                var logMap = loadSessionLog(config.sessionDir(), session.sessionId());
                if (logMap == null) { facetDone++; facetFailures++; continue; }

                var sf = FacetExtractor.extractFacets(
                    config.llm()::complete, session, logMap);

                if (sf != null) {
                    facets.put(session.sessionId(), sf);
                    var facetsJson = ManualJson.toJson(facetsToMap(sf));
                    CacheManager.saveFacets(facetsDir, session.sessionId(), facetsJson);
                }

                facetDone++;
                cb.onProgress(new Progress("facets", facetDone, sessions.size(),
                    session.sessionId().substring(0, Math.min(8, session.sessionId().length()))));
            } catch (Exception e) {
                facetDone++;
                facetFailures++;
                System.err.println("WARN: facet extraction failed for " + session.sessionId() + ": " + e.getMessage());
            }
        }

        var sectionsFailed = new ArrayList<String>();

        cb.onProgress(new Progress("aggregate", 0, 0, "Aggregating data..."));
        var data = Aggregator.aggregate(sessions, facets);

        cb.onProgress(new Progress("insights", 0, 1, "Generating narrative insights..."));
        var insights = InsightGenerator.generateFacade(config.llm()::complete, data, facets,
            config.platform(), sectionsFailed);

        if (!sectionsFailed.isEmpty())
            System.err.println("WARN: " + sectionsFailed.size() + " insight sections failed: " + String.join(", ", sectionsFailed));

        cb.onProgress(new Progress("report", 0, 1, "Building HTML report..."));
        var html = HtmlReporter.generate(data, insights);
        var reportPath = config.insightsDir().resolve("report.html");
        Files.writeString(reportPath, html);

        cb.onProgress(new Progress("done", 1, 1, "Report saved"));
        var absPath = reportPath.toAbsolutePath().toString();
        var markdown = MarkdownSummarizer.generate(data, insights, absPath);
        return "REPORT " + absPath + "\n\n" + markdown;
    }

    static SessionMeta parseSessionMetaFromMap(Map<?, ?> map) {
        return new SessionMeta(
            strVal(map, "session_id"),
            strVal(map, "project_path"),
            strVal(map, "start_time"),
            toInt(map.get("duration_minutes")),
            toInt(map.get("user_message_count")),
            toInt(map.get("assistant_message_count")),
            safeIntMap(map.get("tool_counts")),
            safeIntMap(map.get("languages")),
            toInt(map.get("git_commits")),
            toInt(map.get("git_pushes")),
            toLongVal(map.get("input_tokens")),
            toLongVal(map.get("output_tokens")),
            strVal(map, "first_prompt"),
            Optional.ofNullable(map.get("summary") instanceof String s ? s : null),
            toInt(map.get("user_interruptions")),
            toDoubleList(map.get("user_response_times")),
            toInt(map.get("tool_errors")),
            safeIntMap(map.get("tool_error_categories")),
            Boolean.TRUE.equals(map.get("uses_task_agent")),
            Boolean.TRUE.equals(map.get("uses_mcp")),
            Boolean.TRUE.equals(map.get("uses_web_search")),
            Boolean.TRUE.equals(map.get("uses_web_fetch")),
            toInt(map.get("lines_added")),
            toInt(map.get("lines_removed")),
            toInt(map.get("files_modified")),
            toIntList(map.get("message_hours")),
            toStringList(map.get("user_message_timestamps")),
            toLongVal(map.get("session_mtime"))
        );
    }

    static SessionFacets parseFacetsFromMap(String sessionId, Map<?, ?> map) {
        return new SessionFacets(
            sessionId,
            strVal(map, "underlying_goal"),
            safeIntMap(map.get("goal_categories")),
            strValFallback(map, "outcome", "unclear_from_transcript"),
            safeIntMap(map.get("user_satisfaction_counts")),
            strValFallback(map, "claude_helpfulness", "moderately_helpful"),
            strValFallback(map, "session_type", "single_task"),
            safeIntMap(map.get("friction_counts")),
            strVal(map, "friction_detail"),
            strValFallback(map, "primary_success", "none"),
            strVal(map, "brief_summary"),
            Optional.ofNullable(toStrListNull(map.get("user_instructions_to_claude"))),
            toLongVal(map.get("extracted_at"))
        );
    }

    static String strVal(Map<?, ?> map, String key) {
        var v = map.get(key);
        return v instanceof String s ? s : "";
    }
    static String strValFallback(Map<?, ?> map, String key, String fallback) {
        var v = map.get(key);
        return v instanceof String s ? s : fallback;
    }

    static Map<String, Object> facetsToMap(SessionFacets f) {
        var map = new LinkedHashMap<String, Object>();
        map.put("session_id", f.sessionId());
        map.put("underlying_goal", f.underlyingGoal());
        map.put("goal_categories", f.goalCategories());
        map.put("outcome", f.outcome());
        map.put("user_satisfaction_counts", f.userSatisfactionCounts());
        map.put("claude_helpfulness", f.claudeHelpfulness());
        map.put("session_type", f.sessionType());
        map.put("friction_counts", f.frictionCounts());
        map.put("friction_detail", f.frictionDetail());
        map.put("primary_success", f.primarySuccess());
        map.put("brief_summary", f.briefSummary());
        f.userInstructionsToClaude().ifPresent(v -> map.put("user_instructions_to_claude", v));
        map.put("extracted_at", f.extractedAt());
        return map;
    }

    static Path resolveSessionFile(Path sessionDir, String sessionId) {
        var safe = sessionId.replaceAll("[^\\w.\\-]", "");
        var name = (safe.isEmpty() || !safe.equals(sessionId)) ? safe : sessionId;
        if (name.isEmpty() || name.equals("..") || name.contains("/") || name.contains("\\")) {
            throw new IllegalArgumentException("invalid session ID: " + sessionId);
        }
        return sessionDir.resolve(name + ".jsonl");
    }

    static Map<String, Object> loadSessionLog(Path sessionDir, String sessionId) throws IOException {
        var file = resolveSessionFile(sessionDir, sessionId);
        if (Files.exists(file)) return loadLogFile(file, sessionId);
        return null;
    }

    static Map<String, Object> loadLogFile(Path file, String sessionId) throws IOException {
        if (!Files.isRegularFile(file)) return null;
        var messages = new ArrayList<Object>();
        try (var lines = Files.lines(file)) {
            for (var line : (Iterable<String>) lines::iterator) {
                if (line.isBlank()) continue;
                try {
                    var parsed = ManualJson.parse(line);
                    if (parsed instanceof Map<?, ?> m) messages.add(m);
                } catch (Exception ignored) {}
            }
        }
        var result = new HashMap<String, Object>();
        result.put("session_id", sessionId);
        result.put("messages", messages);
        return result;
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

    static int toInt(Object v) { return v instanceof Number n ? n.intValue() : 0; }
    static long toLongVal(Object v) { return v instanceof Number n ? n.longValue() : 0L; }

    static List<Double> toDoubleList(Object v) {
        if (!(v instanceof List<?> l)) return List.of();
        return l.stream().filter(Number.class::isInstance).map(Number.class::cast)
            .mapToDouble(Number::doubleValue).boxed().toList();
    }

    static List<Integer> toIntList(Object v) {
        if (!(v instanceof List<?> l)) return List.of();
        return l.stream().filter(Number.class::isInstance).map(Number.class::cast)
            .mapToInt(Number::intValue).boxed().toList();
    }

    static List<String> toStringList(Object v) {
        if (!(v instanceof List<?> l)) return List.of();
        return l.stream().filter(String.class::isInstance).map(String.class::cast).toList();
    }

    static List<String> toStrListNull(Object v) {
        if (!(v instanceof List<?> l)) return null;
        var result = l.stream().filter(String.class::isInstance).map(String.class::cast).toList();
        return result.isEmpty() ? null : result;
    }
}
