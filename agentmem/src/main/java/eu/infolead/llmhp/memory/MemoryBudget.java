package eu.infolead.llmhp.memory;

import eu.infolead.llmhp.memory.types.Confidence;
import eu.infolead.llmhp.memory.types.FrontmatterParser;
import eu.infolead.llmhp.memory.types.ModelTier;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;

public final class MemoryBudget {

    static final long MAX_TOTAL_TOKENS = 12_000L;
    static final long MAX_SECTION_TOKENS = 2_000L;
    static final long CHARS_PER_TOKEN = 4L;

    static final long MAX_TOTAL_CHARS = MAX_TOTAL_TOKENS * CHARS_PER_TOKEN;
    static final long MAX_SECTION_CHARS = MAX_SECTION_TOKENS * CHARS_PER_TOKEN;

    static long estimateTokens(String text) {
        if (text == null || text.isEmpty()) return 0;
        return (text.length() + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN;
    }

    static long estimateCharsFromTokens(long tokens) {
        return tokens * CHARS_PER_TOKEN;
    }

    static String safeTruncate(String text, long maxChars) {
        if (maxChars <= 0) return "";
        if (text.length() <= maxChars) return text;
        int end = (int) maxChars;
        while (end > 0 && Character.isSurrogate(text.charAt(end - 1))) end--;
        if (end == 0) return "";
        return text.substring(0, end);
    }

    record BudgetAllocation(
        String key,
        String label,
        boolean included,
        long charsAllocated,
        boolean truncated
    ) {}

    record BudgetResult(
        String output,
        long totalTokens,
        long totalChars,
        List<BudgetAllocation> allocations,
        long tokensAvailable,
        long sectionsBudgeted,
        long sectionsExcluded
    ) {
        String summary() {
            return "Tokens: %d/%d | Sections: %d budgeted, %d excluded".formatted(
                totalTokens, MAX_TOTAL_TOKENS, sectionsBudgeted, sectionsExcluded);
        }
    }

    record SectionCandidate(
        String key,
        String label,
        String content,
        long tokens,
        long chars,
        int priority,
        double trustWeight
    ) {}

    static BudgetResult buildBudgetedInjection(Path memDir, String projectRoot) throws IOException {
        if (!Files.exists(memDir)) {
            return new BudgetResult("", 0, 0, List.of(), MAX_TOTAL_TOKENS, 0, 0);
        }

        var candidates = new ArrayList<SectionCandidate>();

        var indexPath = memDir.resolve("MEMORY.md");
        boolean hasIndex = Files.exists(indexPath);
        String indexContent = hasIndex ? Files.readString(indexPath).trim() : "";

        int idxPriority = hasIndex && !indexContent.isEmpty() ? 90 : -1;

        if (!indexContent.isEmpty()) {
            long idxChars = Math.min(indexContent.length(), MAX_SECTION_CHARS);
            candidates.add(new SectionCandidate(
                "index", "Memory Index",
                indexContent,
                estimateTokens(indexContent),
                idxChars,
                idxPriority,
                1.0
            ));
        }

        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .filter(f -> !f.getFileName().toString().equals("REVIEW.md"))
                 .sorted(Comparator.comparing(Path::getFileName))
                 .forEach(f -> {
                     try {
                         var raw = Files.readString(f);
                         if (raw.isEmpty()) return;
                         var fm = FrontmatterParser.parse(raw);
                         var conf = parseConfidence(fm.getOrDefault("confidence", "medium"));
                         var tier = parseTier(fm.get("model_tier"));
                         var type = fm.getOrDefault("type", "project");

                         int typePriority = typePriority(type);
                         double trustWeight = confidenceWeight(conf) * tierWeight(tier);
                         long tok = estimateTokens(raw);

                         candidates.add(new SectionCandidate(
                             f.getFileName().toString(),
                             f.getFileName().toString(),
                             raw,
                             tok,
                             Math.min(raw.length(), MAX_SECTION_CHARS),
                             typePriority,
                             trustWeight
                         ));
                     } catch (Exception ignored) {}
                 });
        }

        candidates.sort((a, b) -> {
            int cmp = Integer.compare(b.priority(), a.priority());
            if (cmp != 0) return cmp;
            return Double.compare(b.trustWeight(), a.trustWeight());
        });

        var allocations = new ArrayList<BudgetAllocation>();
        var output = new StringBuilder();
        long tokensUsed = 0;
        long charsUsed = 0;
        long sectionsBudgeted = 0;
        long sectionsExcluded = 0;

        int idxIdx = -1;
        for (int i = 0; i < candidates.size(); i++) {
            if (candidates.get(i).key().equals("index")) { idxIdx = i; break; }
        }
        if (idxIdx >= 0) {
            var idx = candidates.remove(idxIdx);
            candidates.addFirst(idx);
        }

        for (var cand : candidates) {
            long remainingTokens = MAX_TOTAL_TOKENS - tokensUsed;
            long remainingChars = MAX_TOTAL_CHARS - charsUsed;
            if (remainingTokens <= 0 || remainingChars <= 0) {
                sectionsExcluded++;
                allocations.add(new BudgetAllocation(cand.key(), cand.label(), false, 0, false));
                continue;
            }

            long sectionChars = Math.min(cand.chars(), remainingChars);
            long sectionTokens = Math.min(cand.tokens(), remainingTokens);
            boolean truncated = sectionChars < cand.chars();

            output.append("<!-- memory-budget: ").append(cand.key())
                   .append(" priority=").append(cand.priority())
                   .append(" trust=").append(String.format("%.2f", cand.trustWeight()))
                   .append(" tokens=").append(sectionTokens).append(" -->\n");
            var safeContent = safeTruncate(cand.content(), sectionChars);
            output.append(safeContent);
            if (truncated) output.append("\n... [budget-truncated: %d/%d tokens]".formatted(sectionTokens, cand.tokens()));
            output.append("\n\n");

            tokensUsed += sectionTokens;
            charsUsed += safeContent.length();
            sectionsBudgeted++;
            allocations.add(new BudgetAllocation(cand.key(), cand.label(), true, safeContent.length(), truncated));
        }

        return new BudgetResult(
            output.toString(),
            tokensUsed,
            charsUsed,
            allocations,
            MAX_TOTAL_TOKENS - tokensUsed,
            sectionsBudgeted,
            sectionsExcluded
        );
    }

    static int typePriority(String type) {
        return switch (type.toLowerCase()) {
            case "user" -> 100;
            case "feedback" -> 80;
            case "project" -> 70;
            case "reference" -> 50;
            default -> 40;
        };
    }

    static double confidenceWeight(Confidence conf) {
        return switch (conf) {
            case HIGH -> 1.0;
            case MEDIUM -> 0.75;
            case LOW -> 0.4;
            case SPECULATIVE -> 0.15;
        };
    }

    static double tierWeight(ModelTier tier) {
        return switch (tier) {
            case S -> 1.0;
            case A -> 0.9;
            case B -> 0.75;
            case C -> 0.3;
            case UNKNOWN -> 0.5;
        };
    }

    private static ModelTier parseTier(String s) {
        if (s == null) return ModelTier.UNKNOWN;
        try { return ModelTier.valueOf(s.toUpperCase()); }
        catch (IllegalArgumentException e) { return ModelTier.UNKNOWN; }
    }

    private static Confidence parseConfidence(String s) {
        if (s == null) return Confidence.MEDIUM;
        try { return Confidence.fromString(s); }
        catch (IllegalArgumentException e) { return Confidence.MEDIUM; }
    }

    record SessionBudget(
        String sessionId,
        long tokensInjected,
        long ceiling,
        Instant startTime,
        boolean exhausted,
        String allocationsJson
    ) {
        static SessionBudget fresh(String sessionId, long ceiling) {
            return new SessionBudget(sessionId, 0, ceiling, Instant.now(), false, "[]");
        }
    }

    static Path budgetFile(Path memDir, String sessionId) {
        return memDir.resolve(".sessions").resolve("budget-" + sanitizeSessionId(sessionId) + ".json");
    }

    static long currentMemoryTotalTokens(Path memDir) throws IOException {
        var parent = memDir.getParent();
        var projectRoot = parent != null ? parent.toString() : memDir.resolve("..").normalize().toString();
        var result = buildBudgetedInjection(memDir, projectRoot);
        return result.totalTokens();
    }

    static long deltaTokens(Path memDir, String sessionId) throws IOException {
        var budget = loadBudgetOrFresh(memDir, sessionId);
        var currentTotal = currentMemoryTotalTokens(memDir);
        return Math.max(0, currentTotal - budget.tokensInjected());
    }

    static BudgetResult buildBudgetedInjectionForReinject(Path memDir, String projectRoot, String sessionId) throws IOException {
        var budget = loadBudgetOrFresh(memDir, sessionId);
        if (budget.exhausted()) {
            return new BudgetResult("", 0, 0, List.of(), 0, 0, 0);
        }

        var result = buildBudgetedInjection(memDir, projectRoot);
        if (result.totalTokens() <= 0) return result;

        return result;
    }

    static String sanitizeSessionId(String id) {
        return id.replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    static SessionBudget loadBudget(Path memDir, String sessionId) throws IOException {
        var file = budgetFile(memDir, sessionId);
        if (!Files.exists(file)) return SessionBudget.fresh(sessionId, MAX_TOTAL_TOKENS);
        var raw = Files.readString(file).strip();
        return parseBudget(raw, sessionId);
    }

    static SessionBudget loadBudgetOrFresh(Path memDir, String sessionId) {
        try { return loadBudget(memDir, sessionId); }
        catch (IOException e) {
            return SessionBudget.fresh(sessionId, MAX_TOTAL_TOKENS);
        }
    }

    static void saveBudget(Path memDir, SessionBudget budget) throws IOException {
        var sessionsDir = memDir.resolve(".sessions");
        Files.createDirectories(sessionsDir);
        var target = budgetFile(memDir, budget.sessionId());

        var tmpDir = sessionsDir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("budget-%s.%s".formatted(sanitizeSessionId(budget.sessionId()), UUID.randomUUID()));

        Files.writeString(tmpFile, budgetToJson(budget));
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
            ch.force(true);
        }
        try {
            Files.move(tmpFile, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            try { Files.deleteIfExists(tmpFile); } catch (IOException ignored) {}
            throw e;
        }
    }

    static SessionBudget accumulate(SessionBudget budget, long tokens) {
        var newTotal = budget.tokensInjected() + tokens;
        var exhausted = newTotal >= budget.ceiling();
        return new SessionBudget(budget.sessionId(), newTotal, budget.ceiling(), budget.startTime(), exhausted, budget.allocationsJson());
    }

    static String budgetToJson(SessionBudget b) {
        var escapedSid = b.sessionId().replace("\\", "\\\\").replace("\"", "\\\"");
        var escapedStartTime = b.startTime().toString().replace("\\", "\\\\").replace("\"", "\\\"");
        var escapedAlloc = b.allocationsJson().replace("\\", "\\\\").replace("\"", "\\\"");
        return """
            {"sessionId":"%s","tokensInjected":%d,"ceiling":%d,"startTime":"%s","exhausted":%s,"allocations":%s}
            """.formatted(escapedSid, b.tokensInjected(), b.ceiling(), escapedStartTime, b.exhausted(), escapedAlloc);
    }

    static SessionBudget parseBudget(String json, String sessionId) {
        long tokensInjected = 0;
        long ceiling = MAX_TOTAL_TOKENS;
        var startTime = Instant.now();
        boolean exhausted = false;
        String allocations = "[]";

        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            return SessionBudget.fresh(sessionId, MAX_TOTAL_TOKENS);
        }
        var inner = trimmed.substring(1, trimmed.length() - 1);
        var inString = false;
        var braceDepth = 0;
        var bracketDepth = 0;
        var key = new StringBuilder();
        var val = new StringBuilder();
        var currentKey = "";

        for (int i = 0; i < inner.length(); i++) {
            var ch = inner.charAt(i);
            if (ch == '\\' && inString) { val.append(ch); if (i + 1 < inner.length()) val.append(inner.charAt(++i)); continue; }
            if (ch == '"' && !inString) { inString = true; continue; }
            if (ch == '"' && inString) { inString = false; continue; }
            if (inString) { val.append(ch); continue; }
            if (ch == '{') { braceDepth++; val.append(ch); continue; }
            if (ch == '}') { braceDepth--; val.append(ch); continue; }
            if (ch == '[') { bracketDepth++; val.append(ch); continue; }
            if (ch == ']') { bracketDepth--; val.append(ch); continue; }
            if (ch == ':' && braceDepth == 0 && bracketDepth == 0) { currentKey = val.toString().trim(); val.setLength(0); continue; }
            if (ch == ',' && braceDepth == 0 && bracketDepth == 0) {
                var tmp = parseFieldResult(currentKey, val.toString().trim(), tokensInjected, ceiling, startTime, exhausted, allocations);
                tokensInjected = tmp.tokensInjected;
                ceiling = tmp.ceiling;
                startTime = tmp.startTime;
                exhausted = tmp.exhausted;
                allocations = tmp.allocations;
                currentKey = "";
                val.setLength(0);
                continue;
            }
            val.append(ch);
        }
        if (!currentKey.isEmpty()) {
            var tmp = parseFieldResult(currentKey, val.toString().trim(), tokensInjected, ceiling, startTime, exhausted, allocations);
            tokensInjected = tmp.tokensInjected;
            ceiling = tmp.ceiling;
            startTime = tmp.startTime;
            exhausted = tmp.exhausted;
            allocations = tmp.allocations;
        }
        return new SessionBudget(sessionId, tokensInjected, ceiling, startTime, exhausted, allocations);
    }

    record ParseFieldResult(long tokensInjected, long ceiling, Instant startTime, boolean exhausted, String allocations) {}

    static ParseFieldResult parseFieldResult(String key, String val, long tokensInjected, long ceiling, Instant startTime, boolean exhausted, String allocations) {
        return switch (key) {
            case "tokensInjected" -> new ParseFieldResult(Long.parseLong(val), ceiling, startTime, exhausted, allocations);
            case "ceiling" -> new ParseFieldResult(tokensInjected, Long.parseLong(val), startTime, exhausted, allocations);
            case "startTime" -> new ParseFieldResult(tokensInjected, ceiling, Instant.parse(val.replace("\"", "")), exhausted, allocations);
            case "exhausted" -> new ParseFieldResult(tokensInjected, ceiling, startTime, Boolean.parseBoolean(val), allocations);
            case "allocations" -> new ParseFieldResult(tokensInjected, ceiling, startTime, exhausted, val);
            default -> new ParseFieldResult(tokensInjected, ceiling, startTime, exhausted, allocations);
        };
    }
}
