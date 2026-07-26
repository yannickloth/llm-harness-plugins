package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.SessionMeta;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public final class SessionScanner {

    static final Map<String, String> EXTENSION_LANGUAGE = Map.ofEntries(
        Map.entry(".ts", "TypeScript"), Map.entry(".tsx", "TypeScript"),
        Map.entry(".js", "JavaScript"), Map.entry(".jsx", "JavaScript"),
        Map.entry(".py", "Python"), Map.entry(".rb", "Ruby"),
        Map.entry(".go", "Go"), Map.entry(".rs", "Rust"),
        Map.entry(".java", "Java"), Map.entry(".kt", "Kotlin"),
        Map.entry(".md", "Markdown"), Map.entry(".json", "JSON"),
        Map.entry(".yaml", "YAML"), Map.entry(".yml", "YAML"),
        Map.entry(".sh", "Shell"), Map.entry(".bash", "Shell"),
        Map.entry(".css", "CSS"), Map.entry(".html", "HTML"),
        Map.entry(".sql", "SQL"), Map.entry(".xml", "XML")
    );

    static final Set<String> WRITE_TOOLS = Set.of("Write", "Edit", "write", "edit");

    static final int MIN_USER_MESSAGES = 2;
    static final int MIN_DURATION_MINUTES = 1;

    public record ScanResult(String sessionId, long mtime) {}

    public static List<ScanResult> discoverSessions(Path sessionDir) throws IOException {
        if (!Files.exists(sessionDir)) return List.of();
        var results = new ArrayList<ScanResult>();
        try (var walk = Files.walk(sessionDir, 3)) {
            walk.filter(Files::isRegularFile)
                .filter(f -> f.getFileName().toString().endsWith(".jsonl"))
                .forEach(f -> {
                    try {
                        var mtime = Files.getLastModifiedTime(f).toMillis();
                        var id = sessionIdFromName(f.getFileName().toString());
                        results.add(new ScanResult(id, mtime));
                    } catch (IOException ignored) {}
                });
        }
        return results;
    }

    public static Optional<SessionMeta> scanSession(Path sessionFile) throws IOException {
        var sessionId = sessionIdFromName(sessionFile.getFileName().toString());
        var mtime = Files.getLastModifiedTime(sessionFile).toMillis();

        var messages = new ArrayList<Map<String, Object>>();
        int parseErrors = 0;
        try (var lines = Files.lines(sessionFile)) {
            for (var line : (Iterable<String>) lines::iterator) {
                if (line.isBlank()) continue;
                try {
                    var msg = ManualJson.parse(line);
                    if (msg instanceof Map<?, ?> m) {
                        @SuppressWarnings("unchecked")
                        var typed = (Map<String, Object>) new HashMap<>(m);
                        messages.add(typed);
                    } else {
                        parseErrors++;
                    }
                } catch (Exception e) { parseErrors++; }
            }
        }
        if (messages.isEmpty()) return Optional.empty();

        var meta = extractMeta(sessionId, mtime, messages, parseErrors);
        if (meta.userMessageCount() < MIN_USER_MESSAGES && meta.durationMinutes() < MIN_DURATION_MINUTES)
            return Optional.empty();

        return Optional.of(meta);
    }

    static SessionMeta extractMeta(String sessionId, long mtime, List<Map<String, Object>> messages, int parseErrors) {
        var toolCounts = new HashMap<String, Integer>();
        var languages = new HashMap<String, Integer>();
        int gitCommits = 0, gitPushes = 0, userInterruptions = 0, toolErrors = 0;
        int linesAdded = 0, linesRemoved = 0, userMsgCount = 0, assistantMsgCount = 0;
        long inputTokens = 0, outputTokens = 0;
        var toolErrorCategories = new HashMap<String, Integer>();
        var userResponseTimes = new ArrayList<Double>();
        var filesModifiedSet = new HashSet<String>();
        var messageHours = new ArrayList<Integer>();
        var userMessageTimestamps = new ArrayList<String>();
        boolean usesTaskAgent = false, usesMcp = false, usesWebSearch = false, usesWebFetch = false;
        String firstPrompt = "", projectPath = "";
        String startTime = "", lastStartTime = "";
        String lastAssistantTimestamp = null;

        for (var msg : messages) {
            var type = (String) msg.getOrDefault("type", "");
            var timestamp = (String) msg.get("timestamp");

            if ("assistant".equals(type)) {
                assistantMsgCount++;
                if (timestamp != null) lastAssistantTimestamp = timestamp;
                var msgContent = msg.get("message");
                if (msgContent instanceof Map<?, ?> content) {
                    var usage = content.get("usage");
                    if (usage instanceof Map<?, ?> u) {
                        inputTokens += toLong(u.get("input_tokens"));
                        outputTokens += toLong(u.get("output_tokens"));
                    }
                    var blocks = content.get("content");
                    if (blocks instanceof List<?> blockList) {
                        for (var block : blockList) {
                            if (!(block instanceof Map<?, ?> bm)) continue;
                            var blockType = (String) bm.get("type");
                            var blockName = (String) bm.get("name");
                            if ("tool_use".equals(blockType) && blockName != null) {
                                toolCounts.merge(blockName, 1, Integer::sum);
                                if (blockName.equals("Task") || blockName.equals("task")) usesTaskAgent = true;
                                if (blockName.startsWith("mcp__")) usesMcp = true;
                                if (blockName.equals("WebSearch")) usesWebSearch = true;
                                if (blockName.equals("WebFetch")) usesWebFetch = true;

                                var input = bm.get("input");
                                if (input instanceof Map<?, ?> inp) {
                                    var fp = (String) inp.get("file_path");
                                    if (fp == null) fp = (String) inp.get("filePath");
                                    if (fp != null) {
                                        recordLanguage(languages, fp);
                                        if (WRITE_TOOLS.contains(blockName)) filesModifiedSet.add(fp);
                                    }
                                    if (blockName.equals("Edit") || blockName.equals("edit")) {
                                        var oldStr = (String) inp.get("old_string");
                                        var newStr = (String) inp.get("new_string");
                                        if (oldStr != null && newStr != null) {
                                            int added = 0, removed = 0;
                                            if (newStr.length() > oldStr.length()) {
                                                added = newStr.split("\n", -1).length - oldStr.split("\n", -1).length;
                                                added = Math.max(0, added);
                                            } else {
                                                removed = oldStr.split("\n", -1).length - newStr.split("\n", -1).length;
                                                removed = Math.max(0, removed);
                                            }
                                            linesAdded += added;
                                            linesRemoved += removed;
                                        }
                                    }
                                    if (blockName.equals("Write") || blockName.equals("write")) {
                                        var writeContent = (String) inp.get("content");
                                        if (writeContent != null) linesAdded += writeContent.split("\n", -1).length;
                                    }
                                    var cmd = (String) inp.get("command");
                                    if (cmd != null) {
                                        if (cmd.contains("git commit")) gitCommits++;
                                        if (cmd.contains("git push")) gitPushes++;
                                    }
                                }
                            }
                        }
                    }
                }
            } else if ("user".equals(type)) {
                var msgContent = msg.get("message");
                boolean isHuman = false;
                if (msgContent instanceof String s && !s.isBlank()) isHuman = true;
                else if (msgContent instanceof Map<?, ?> content) {
                    var blocks = content.get("content");
                    if (blocks instanceof List<?> blockList) {
                        for (var block : blockList) {
                            if (!(block instanceof Map<?, ?> bm)) continue;
                            var blockType = (String) bm.get("type");
                            if ("text".equals(blockType) && bm.get("text") instanceof String t && !t.isBlank()) {
                                isHuman = true;
                                break;
                            }
                            if ("tool_result".equals(blockType)) {
                                var isErr = bm.get("is_error");
                                if (Boolean.TRUE.equals(isErr)) {
                                    toolErrors++;
                                    categorizeError(toolErrorCategories, (String) bm.get("content"));
                                }
                            }
                        }
                    }
                }
                if (isHuman) {
                    userMsgCount++;
                    if (firstPrompt.isEmpty() && msgContent instanceof String s) firstPrompt = s;
                    else if (firstPrompt.isEmpty() && msgContent instanceof Map<?, ?> content) {
                        var blocks = content.get("content");
                        if (blocks instanceof List<?> bl && !bl.isEmpty() && bl.getFirst() instanceof Map<?, ?> bm
                            && "text".equals(bm.get("type")) && bm.get("text") instanceof String t)
                            firstPrompt = t;
                    }
                    if (timestamp != null) {
                        try {
                            var date = Instant.parse(timestamp);
                            messageHours.add(date.atZone(java.time.ZoneId.systemDefault()).getHour());
                            userMessageTimestamps.add(timestamp);
                        } catch (Exception ignored) {}
                    }
                    if (lastAssistantTimestamp != null && timestamp != null) {
                        try {
                            double gap = (Instant.parse(timestamp).toEpochMilli()
                                - Instant.parse(lastAssistantTimestamp).toEpochMilli()) / 1000.0;
                            if (gap > 2 && gap < 3600) userResponseTimes.add(gap);
                        } catch (Exception ignored) {}
                    }

                    var text = extractText(msgContent);
                    if (text != null && text.contains("[Request interrupted by user")) userInterruptions++;
                }

                if (startTime.isEmpty()) {
                    if (timestamp != null) {
                        startTime = timestamp;
                        lastStartTime = timestamp;
                    }
                } else if (timestamp != null && isHuman) {
                    lastStartTime = timestamp;
                }
            }
        }

        int duration = calcDuration(startTime, lastStartTime);
        int filesModified = filesModifiedSet.size();
        String summaryMsg = parseErrors > 0 ? " (" + parseErrors + " parse errors)" : "";

        return new SessionMeta(
            sessionId, projectPath, startTime, duration,
            userMsgCount, assistantMsgCount,
            toolCounts, languages, gitCommits, gitPushes,
            inputTokens, outputTokens, firstPrompt,
            parseErrors > 0 ? Optional.of(summaryMsg) : Optional.empty(),
            userInterruptions, userResponseTimes,
            toolErrors, toolErrorCategories,
            usesTaskAgent, usesMcp, usesWebSearch, usesWebFetch,
            linesAdded, linesRemoved, filesModified,
            messageHours, userMessageTimestamps, mtime
        );
    }

    static int calcDuration(String startStr, String endStr) {
        if (startStr.isEmpty() || endStr.isEmpty()) return 0;
        try {
            var start = Instant.parse(startStr);
            var end = Instant.parse(endStr);
            return (int) ((end.toEpochMilli() - start.toEpochMilli()) / 60000);
        } catch (Exception e) { return 0; }
    }

    static void recordLanguage(Map<String, Integer> languages, String filePath) {
        var dot = filePath.lastIndexOf('.');
        if (dot < 0) return;
        var ext = filePath.substring(dot).toLowerCase();
        var lang = EXTENSION_LANGUAGE.getOrDefault(ext, null);
        if (lang != null) languages.merge(lang, 1, Integer::sum);
    }

    static void categorizeError(Map<String, Integer> categories, String content) {
        if (content == null) { categories.merge("Other", 1, Integer::sum); return; }
        var lower = content.toLowerCase();
        String cat;
        if (lower.contains("exit code")) cat = "Command Failed";
        else if (lower.contains("rejected") || lower.contains("doesn't want")) cat = "User Rejected";
        else if (lower.contains("string to replace not found") || lower.contains("no changes")) cat = "Edit Failed";
        else if (lower.contains("modified since read")) cat = "File Changed";
        else if (lower.contains("exceeds maximum") || lower.contains("too large")) cat = "File Too Large";
        else if (lower.contains("file not found") || lower.contains("does not exist")) cat = "File Not Found";
        else cat = "Other";
        categories.merge(cat, 1, Integer::sum);
    }

    static String extractText(Object msgContent) {
        if (msgContent instanceof String s) return s;
        if (msgContent instanceof Map<?, ?> content) {
            var blocks = content.get("content");
            if (blocks instanceof List<?> bl) {
                for (var block : bl) {
                    if (block instanceof Map<?, ?> bm && "text".equals(bm.get("type"))
                        && bm.get("text") instanceof String t)
                        return t;
                }
            }
        }
        return null;
    }

    static String sessionIdFromName(String filename) {
        var name = filename;
        if (name.endsWith(".jsonl")) name = name.substring(0, name.length() - 6);
        return name;
    }

    static long toLong(Object v) {
        if (v instanceof Number n) return n.longValue();
        if (v instanceof String s) {
            try { return Long.parseLong(s); } catch (NumberFormatException e) { return 0; }
        }
        return 0;
    }
}
