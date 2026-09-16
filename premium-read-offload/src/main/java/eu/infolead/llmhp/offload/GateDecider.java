package eu.infolead.llmhp.offload;

import java.util.Locale;
import java.util.Set;

/**
 * Pure decision logic for the premium-read-offload gate. No I/O — fully
 * unit-testable.
 *
 * <p>The gate fires only when a session is spending a premium subscription pool
 * (Kimi / ZAI) and the agent attempts an unbounded bulk read. Everything else
 * falls through.
 */
public final class GateDecider {

    /** Providers whose models are premium (subscription-quota) pools. Note
     * {@code kimi-for-coding} is a distinct provider id from {@code kimi} in
     * opencode's catalog, and is the Kimi coding subscription. */
    public static final Set<String> PREMIUM_PROVIDERS = Set.of("kimi", "kimi-for-coding", "zai", "zai-coding-plan");

    /** Model IDs treated as premium within those providers. Substring-matched,
     * lowercased, so provider-specific prefixes/suffixes still resolve. */
    public static final Set<String> PREMIUM_MODEL_MARKERS = Set.of("k3", "glm-5.3");

    /** Verdict of a gate evaluation. */
    public enum Verdict {
        /** Not a premium session, or not a bulk read: let it through. */
        ALLOW,
        /** Bulk read on a premium session: block and redirect to offload-read. */
        BLOCK
    }

    /** Reason for the verdict, carried into the block message. */
    public enum Reason {
        NOT_PREMIUM,
        TARGETED_READ,
        SMALL_FILE,
        MISSING_PATH,
        FILE_NOT_FOUND,
        UNPARSEABLE_PATH,
        DIRECT_READ_PERMITTED,
        BULK_READ
    }

    /** Result of evaluating one potential gate. */
    public record Decision(Verdict verdict, Reason reason, String detail) {
        public boolean blocked() { return verdict == Verdict.BLOCK; }
    }

    private final int premiumThreshold;
    private final int zaiThreshold;
    private final int targetedMax;
    private final int minWorthLines;

    /**
     * @param premiumThreshold default line count above which a Kimi read gates
     * @param zaiThreshold     lower threshold for ZAI sessions (credit preservation)
     * @param targetedMax      max {@code limit} still considered a targeted read
     * @param minWorthLines    corpus lines below which a cold offload is not worth it
     */
    public GateDecider(int premiumThreshold, int zaiThreshold, int targetedMax, int minWorthLines) {
        this.premiumThreshold = premiumThreshold;
        this.zaiThreshold = zaiThreshold;
        this.targetedMax = targetedMax;
        this.minWorthLines = minWorthLines;
    }

    /** Back-compat constructor: default worth-it threshold. */
    public GateDecider(int premiumThreshold, int zaiThreshold, int targetedMax) {
        this(premiumThreshold, zaiThreshold, targetedMax, 200);
    }

    /** Defaults matching the design doc. */
    public static GateDecider fromEnv() {
        int premium = envInt("LLMHP_OFFLOAD_MIN_LINES", 1000);
        int zai = envInt("LLMHP_OFFLOAD_ZAI_MIN_LINES", 400);
        int targeted = envInt("LLMHP_OFFLOAD_TARGETED_MAX", 2000);
        int worth = envInt("LLMHP_OFFLOAD_MIN_WORTH_LINES", 200);
        return new GateDecider(premium, zai, targeted, worth);
    }

    private static int envInt(String name, int fallback) {
        var v = System.getenv(name);
        if (v == null || v.isBlank()) return fallback;
        try { return Integer.parseInt(v.trim()); } catch (NumberFormatException e) { return fallback; }
    }

    /** True when this provider/model pair is a premium subscription pool. */
    public boolean isPremium(String providerID, String modelID) {
        if (providerID == null || modelID == null) return false;
        var provider = providerID.toLowerCase(Locale.ROOT);
        if (!PREMIUM_PROVIDERS.contains(provider)) return false;
        var model = modelID.toLowerCase(Locale.ROOT);
        return PREMIUM_MODEL_MARKERS.stream().anyMatch(model::contains);
    }

    /** Threshold for this provider: ZAI lower than Kimi. */
    public int thresholdFor(String providerID) {
        var p = providerID == null ? "" : providerID.toLowerCase(Locale.ROOT);
        return p.startsWith("zai") ? zaiThreshold : premiumThreshold;
    }

    /**
     * Evaluate a {@code read} tool call.
     *
     * @param providerID active session provider (null if unknown)
     * @param modelID    active session model (null if unknown)
     * @param filePath   resolved path the agent wants to read
     * @param offset     1-based line offset, or null
     * @param limit      requested line count, or null
     * @param exists     whether the file exists (nonexistent files pass through)
     * @param lineCount  file line count, or -1 if unknown
     * @param directPermitted whether a one-shot direct-read permission is held
     */
    public Decision decideRead(String providerID, String modelID, String filePath,
                               Integer offset, Integer limit, boolean exists,
                               int lineCount, boolean directPermitted) {
        if (!isPremium(providerID, modelID)) {
            return new Decision(Verdict.ALLOW, Reason.NOT_PREMIUM, "session not on a premium pool");
        }
        if (directPermitted) {
            return new Decision(Verdict.ALLOW, Reason.DIRECT_READ_PERMITTED, "one-shot direct read permitted");
        }
        if (filePath == null || filePath.isBlank()) {
            return new Decision(Verdict.ALLOW, Reason.MISSING_PATH, "no file path");
        }
        // Let the Read tool produce its own not-found error.
        if (!exists) {
            return new Decision(Verdict.ALLOW, Reason.FILE_NOT_FOUND, "file does not exist");
        }
        if (isTargeted(offset, limit, lineCount)) {
            return new Decision(Verdict.ALLOW, Reason.TARGETED_READ, "targeted read");
        }
        int threshold = thresholdFor(providerID);
        if (lineCount >= 0 && lineCount <= threshold) {
            return new Decision(Verdict.ALLOW, Reason.SMALL_FILE, lineCount + " lines <= " + threshold);
        }
        return new Decision(Verdict.BLOCK, Reason.BULK_READ,
            lineCount + " lines on " + providerID + "/" + modelID + " (threshold " + threshold + ")");
    }

    /**
     * Questions answerable from metadata (line/word/character counts, "what
     * file/language is this", "which files") need no model at all: the answer
     * is a cheap local computation. Delegating them pays a multi-second child
     * startup for a few hundred bytes of output — the single most embarrassing
     * failure mode of the offload pattern.
     */
    private static final java.util.regex.Pattern TRIVIAL_QUESTION = java.util.regex.Pattern.compile(
        "(?i)\\b(how many (lines|words|chars|characters|files)|line count|"
        + "what (file|files|file type|language|extension)|which files?|"
        + "list (the )?files?|is (this|the) file empty|file size)\\b");

    /**
     * Should this offload be delegated at all, or answered locally?
     *
     * <p>A warm worker (cache hit) is always worth it — the corpus is already in
     * the worker's context, so the turn is near-free and keeps the premium
     * context clean. A cold worker is only worth it when the corpus is big
     * enough that loading it would have cost the premium session real context,
     * and the question is not trivially answerable from metadata.
     *
     * @param question    the caller's question
     * @param corpusLines total lines across the corpus, or -1 if unknown
     * @param cacheHit    whether an existing worker session will be resumed
     */
    public boolean worthOffload(String question, int corpusLines, boolean cacheHit) {
        if (cacheHit) return true;
        if (isTrivialQuestion(question)) return false;
        if (corpusLines >= 0 && corpusLines < minWorthLines) return false;
        return true;
    }

    /** True when the question asks only for metadata a local computation answers. */
    public static boolean isTrivialQuestion(String question) {
        return question != null && TRIVIAL_QUESTION.matcher(question).find();
    }

    /**
     * A read is targeted when it names an offset or limit and does not span more
     * than {@code targetedMax} lines. A huge limit is treated as unbounded — an
     * escape hatch must not be able to request the whole file.
     */
    public boolean isTargeted(Integer offset, Integer limit, int lineCount) {
        if (offset == null && limit == null) return false;
        if (limit == null) return true;            // offset-only: start partway, read to end
        if (limit <= 0) return false;
        if (limit > targetedMax) return false;     // unbounded in disguise
        if (lineCount >= 0 && offset != null && offset > 0) {
            // offset+limit that covers the whole file is not targeted.
            long covered = (long) lineCount - (offset - 1);
            if (covered <= limit) return false;
        }
        return true;
    }

    /**
     * Extract the target file path from a plain read command
     * ({@code cat|head|tail|less|more}), stripping flags and quotes. Returns the
     * first non-flag token, or empty when the command is not a plain read or the
     * path is ambiguous (pipes/redirects/multiple files).
     */
    public static String extractBashReadPath(String command) {
        return bashRead(command).path();
    }

    /** Result of parsing a bash read command. */
    public record BashRead(String path, boolean bounded) {}

    /**
     * Parse a bash read command. {@code bounded} is true when the command limits
     * how much is read — a numeric {@code head}/{@code tail} count, or
     * {@code sed -n}, or {@code less}/{@code more} (interactive paging, not
     * bulk-load), all of which are treated as targeted reads.
     */
    public static BashRead bashRead(String command) {
        if (command == null) return new BashRead("", false);
        var cmd = command.trim();
        // Pipes and redirects are targeted or non-context ops: do not gate.
        if (cmd.contains("|") || cmd.contains(">")) return new BashRead("", false);
        var tokens = tokenize(cmd);
        if (tokens.isEmpty()) return new BashRead("", false);
        var name = tokens.get(0);
        boolean isRead = name.equals("cat") || name.equals("head") || name.equals("tail")
            || name.equals("less") || name.equals("more");
        if (!isRead) return new BashRead("", false);

        boolean bounded = false;
        var path = "";
        for (int i = 1; i < tokens.size(); i++) {
            var t = tokens.get(i);
            if (t.startsWith("-")) {
                // -100 / -n100 / --lines=100 are numeric bounds; -n alone takes
                // the next token as the count.
                var digits = t.replaceFirst("^-+", "");
                if (name.equals("head") || name.equals("tail")) {
                    if (digits.matches("\\d+") || digits.matches("[ncl]\\d+")
                        || digits.matches("lines=\\d+") || digits.matches("[ncl]=\"?\\d+\"?")) {
                        bounded = true;
                    }
                    if (digits.matches("[ncl]\"?")) {
                        // count is the next token
                        if (i + 1 < tokens.size() && tokens.get(i + 1).matches("\\d+")) { bounded = true; i++; }
                    }
                }
                continue;
            }
            if (path.isEmpty()) { path = t; continue; }   // first non-flag is the file
        }
        // less/more/page: interactive, not a bulk load into context.
        if (name.equals("less") || name.equals("more")) bounded = true;
        return new BashRead(path, bounded);
    }

    /**
     * Split a shell-ish command into tokens, keeping single/double-quoted runs
     * (including embedded spaces) as one token and stripping the quotes.
     */
    static java.util.List<String> tokenize(String cmd) {
        var out = new java.util.ArrayList<String>();
        var sb = new StringBuilder();
        char quote = 0;
        for (int i = 0; i < cmd.length(); i++) {
            char c = cmd.charAt(i);
            if (quote != 0) {
                if (c == quote) { quote = 0; } else { sb.append(c); }
            } else if (c == '\'' || c == '"') {
                quote = c;
            } else if (Character.isWhitespace(c)) {
                if (!sb.isEmpty()) { out.add(sb.toString()); sb.setLength(0); }
            } else {
                sb.append(c);
            }
        }
        if (!sb.isEmpty()) out.add(sb.toString());
        return out;
    }
}
