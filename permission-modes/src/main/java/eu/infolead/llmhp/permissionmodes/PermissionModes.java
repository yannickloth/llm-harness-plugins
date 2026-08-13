package eu.infolead.llmhp.permissionmodes;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public final class PermissionModes {

    public enum Mode {
        DEFAULT("default", "·", "Ask for each tool use"),
        PLAN("plan", "P", "Read-only + plan-generation tools"),
        ACCEPT_EDITS("acceptEdits", "A", "Auto-accept edits in CWD"),
        BYPASS_PERMISSIONS("bypassPermissions", "!", "Skip all tool prompts (dangerous)"),
        DONT_ASK("dontAsk", "⊘", "Silent blocking"),
        AUTO("auto", "∞", "Full auto (ant-only, feature-gated)");

        private final String name, symbol, description;
        Mode(String name, String symbol, String description) {
            this.name = name;
            this.symbol = symbol;
            this.description = description;
        }
        public String modeName() { return name; }
        public String symbol() { return symbol; }
        public String description() { return description; }
        public static Mode fromName(String n) {
            return Arrays.stream(values())
                .filter(m -> m.name.equalsIgnoreCase(n))
                .findFirst().orElseThrow(() -> new IllegalArgumentException("unknown mode: " + n));
        }
        public static boolean isValid(String n) {
            return Arrays.stream(values()).anyMatch(m -> m.name.equalsIgnoreCase(n));
        }
    }

    public enum ToolCategory {
        READ("read"),
        EDIT("edit"),
        BASH("bash"),
        WRITE("write"),
        WEB_FETCH("webfetch"),
        TASK("task"),
        SKILL("skill"),
        GLOB("glob"),
        GREP("grep"),
        QUESTION("question"),
        TODO("todo"),
        OTHER("other");

        private final String label;
        ToolCategory(String label) { this.label = label; }
        public String label() { return label; }
        public static ToolCategory fromToolName(String toolName) {
            var lower = toolName.toLowerCase();
            return switch (lower) {
                case "read" -> READ;
                case "edit" -> EDIT;
                case "bash" -> BASH;
                case "write" -> WRITE;
                case "webfetch" -> WEB_FETCH;
                case "task" -> TASK;
                case "skill" -> SKILL;
                case "glob" -> GLOB;
                case "grep" -> GREP;
                case "question" -> QUESTION;
                case "todo" -> TODO;
                default -> OTHER;
            };
        }
    }

    public record ToolDeny(String toolName, String reason, boolean bypassImmune) {}
    public record ToolAllow(String toolName, String note) {}
    public record PermissionResult(boolean allowed, String reason, boolean promptUser) {}
    public record ModeConfig(
        Map<ToolCategory, Boolean> categoryBlocked,
        Map<String, ToolAllow> toolAllows,
        Map<String, ToolDeny> toolDenys
    ) {}

    private static final Set<String> DANGEROUS_CATEGORY_LABELS = Set.of("bash", "write", "edit", "webfetch", "task", "skill");

    private Mode currentMode;
    private final Map<Mode, ModeConfig> modeConfigs;
    private final Set<String> bypassImmunePatterns;
    private final Deque<ModeConfigRestore> stashStack;
    private final Path stateDir;
    private final Path cwdBase;
    private boolean autoStripped;

    private record ModeConfigRestore(Mode prevMode, Map<String, ToolAllow> stashedAllows, Map<String, ToolDeny> stashedDenys) {}

    public PermissionModes() {
        this(Path.of("."), Path.of("").toAbsolutePath().normalize());
    }

    public PermissionModes(Path stateDir) {
        this(stateDir, stateDir.toAbsolutePath().normalize());
    }

    public PermissionModes(Path stateDir, Path cwdBase) {
        this.currentMode = Mode.DEFAULT;
        this.modeConfigs = new EnumMap<>(Mode.class);
        this.bypassImmunePatterns = new LinkedHashSet<>();
        this.stashStack = new ArrayDeque<>();
        this.stateDir = stateDir;
        this.cwdBase = cwdBase.toAbsolutePath().normalize();
        this.autoStripped = false;

        configureDefaults();
        configureBypassImmune();
    }

    private void configureDefaults() {
        var readCat = ToolCategory.READ;
        var otherRead = Set.of(ToolCategory.GLOB, ToolCategory.GREP, ToolCategory.QUESTION, ToolCategory.TODO);

        modeConfigs.put(Mode.DEFAULT, new ModeConfig(new HashMap<>(), new HashMap<>(), new HashMap<>()));

        var planBlock = new HashMap<ToolCategory, Boolean>();
        for (var c : ToolCategory.values()) {
            planBlock.put(c, c != readCat && !otherRead.contains(c));
        }
        modeConfigs.put(Mode.PLAN, new ModeConfig(planBlock, new HashMap<>(), new HashMap<>()));

        modeConfigs.put(Mode.ACCEPT_EDITS, new ModeConfig(new HashMap<>(), new HashMap<>(), new HashMap<>()));

        var bpAllows = new HashMap<String, ToolAllow>();
        for (var c : ToolCategory.values()) bpAllows.put(c.label(), new ToolAllow(c.label(), "bypass"));
        modeConfigs.put(Mode.BYPASS_PERMISSIONS, new ModeConfig(new HashMap<>(), bpAllows, new HashMap<>()));

        var daBlock = new HashMap<ToolCategory, Boolean>();
        for (var c : ToolCategory.values()) daBlock.put(c, true);
        modeConfigs.put(Mode.DONT_ASK, new ModeConfig(daBlock, new HashMap<>(), new HashMap<>()));

        var autoAllows = new HashMap<String, ToolAllow>();
        for (var c : ToolCategory.values()) autoAllows.put(c.label(), new ToolAllow(c.label(), "auto"));
        modeConfigs.put(Mode.AUTO, new ModeConfig(new HashMap<>(), autoAllows, new HashMap<>()));
    }

    private void configureBypassImmune() {
        bypassImmunePatterns.addAll(List.of(
            ".git/", ".opencode/", ".claude/", "claude.md", "agents.md",
            ".bashrc", ".bash_profile", ".zshrc", ".profile",
            ".ssh/", ".env/", ".env.", ".env",
            "opencode.json", "config.json", "settings.json", "plugin.json", "hooks.json"
        ));
    }

    public void addBypassImmunePattern(String pattern) {
        bypassImmunePatterns.add(pattern);
    }

    public void removeBypassImmunePattern(String pattern) {
        bypassImmunePatterns.remove(pattern);
    }

    public Set<String> bypassImmunePatterns() {
        return Collections.unmodifiableSet(bypassImmunePatterns);
    }

    public void addToolAllow(Mode mode, String normalizedName, String note) {
        modeConfigs.computeIfAbsent(mode, m -> emptyConfig())
            .toolAllows().put(normalizedName, new ToolAllow(normalizedName, note));
    }

    public void addToolDeny(Mode mode, String normalizedName, String reason, boolean bypassImmune) {
        modeConfigs.computeIfAbsent(mode, m -> emptyConfig())
            .toolDenys().put(normalizedName, new ToolDeny(normalizedName, reason, bypassImmune));
    }

    public void addCategoryBlock(Mode mode, ToolCategory category) {
        modeConfigs.computeIfAbsent(mode, m -> emptyConfig())
            .categoryBlocked().put(category, true);
    }

    public void removeCategoryBlock(Mode mode, ToolCategory category) {
        var cfg = modeConfigs.get(mode);
        if (cfg != null) cfg.categoryBlocked().remove(category);
    }

    private static ModeConfig emptyConfig() {
        return new ModeConfig(new HashMap<>(), new HashMap<>(), new HashMap<>());
    }

    public static String normalizeToolName(String toolName) {
        if (toolName == null) return "";
        return toolName.toLowerCase();
    }

    public static boolean isDangerousTool(String toolName) {
        if (toolName == null) return false;
        var norm = normalizeToolName(toolName);
        for (var label : DANGEROUS_CATEGORY_LABELS) {
            if (norm.equals(label)) return true;
        }
        return false;
    }

    // --- permission check ---

    public PermissionResult checkPermission(String rawToolName, String filePath) {
        var toolName = normalizeToolName(rawToolName);
        var config = modeConfigs.getOrDefault(currentMode, emptyConfig());
        var category = ToolCategory.fromToolName(toolName);

        if (isBypassImmune(toolName, filePath)) {
            return new PermissionResult(false,
                "BYPASS_IMMUNE: " + toolName + " targeting immune path — always prompt",
                true);
        }

        var deny = config.toolDenys().get(toolName);
        if (deny != null) {
            if (deny.bypassImmune()) {
                return new PermissionResult(false,
                    "Denied (immune): " + toolName + " — " + deny.reason(),
                    true);
            }
            return new PermissionResult(false,
                "Denied: " + toolName + " — " + deny.reason(),
                false);
        }

        if (Boolean.TRUE.equals(config.categoryBlocked().getOrDefault(category, false))) {
            return new PermissionResult(false,
                "Category blocked in " + currentMode.modeName() + " mode: " + category.label(),
                false);
        }

        var allow = config.toolAllows().get(toolName);
        if (allow != null) {
            return new PermissionResult(true,
                "Auto-allowed: " + toolName + " — " + allow.note(),
                false);
        }

        return switch (currentMode) {
            case DEFAULT -> new PermissionResult(false, "Prompt for: " + toolName, true);
            case PLAN -> new PermissionResult(true, "Plan mode: " + toolName + " (read-allowed, writes blocked at category level)", false);
            case ACCEPT_EDITS -> {
                if ((toolName.equals("edit") || toolName.equals("write")) && isInCwd(filePath)) {
                    yield new PermissionResult(true, "Auto-accept " + toolName + " in CWD", false);
                }
                yield new PermissionResult(false, "acceptEdits: " + toolName + " outside CWD — prompt", true);
            }
            case BYPASS_PERMISSIONS -> new PermissionResult(true, "Bypass: " + toolName, false);
            case DONT_ASK -> new PermissionResult(false, "Silent block: " + toolName, false);
            case AUTO -> {
                if (autoStripped && isDangerousTool(toolName)) {
                    yield new PermissionResult(false,
                        "Auto mode: " + toolName + " stripped (dangerous)", true);
                }
                yield new PermissionResult(true, "Auto-approve: " + toolName, false);
            }
        };
    }

    // --- mode transitions ---

    public Mode currentMode() { return currentMode; }

    public Mode transitionPermissionMode(Mode target) {
        if (target == currentMode && (target != Mode.AUTO || stashStack.isEmpty())) {
            return currentMode;
        }

        var prev = currentMode;
        currentMode = target;

        if (target == Mode.AUTO && prev != Mode.AUTO) {
            stripDangerousPermissionsForAutoMode();
            autoStripped = true;
        } else if (prev == Mode.AUTO && target != Mode.AUTO) {
            restoreDangerousPermissionsFromAutoMode();
            autoStripped = false;
        }

        return currentMode;
    }

    public Mode transitionPermissionMode(String targetName) {
        if (!Mode.isValid(targetName)) {
            throw new IllegalArgumentException("unknown mode: " + targetName);
        }
        return transitionPermissionMode(Mode.fromName(targetName));
    }

    public boolean isAutoStripped() { return autoStripped; }

    public ModeConfig configFor(Mode mode) {
        return modeConfigs.getOrDefault(mode, emptyConfig());
    }

    private void stripDangerousPermissionsForAutoMode() {
        var cfg = modeConfigs.get(Mode.AUTO);
        if (cfg == null) return;

        var stashedAllows = new HashMap<String, ToolAllow>();
        var stashedDenys = new HashMap<String, ToolDeny>();

        for (var label : DANGEROUS_CATEGORY_LABELS) {
            if (cfg.toolAllows().containsKey(label)) {
                stashedAllows.put(label, cfg.toolAllows().get(label));
                cfg.toolAllows().remove(label);
            }
            if (cfg.toolDenys().containsKey(label)) {
                stashedDenys.put(label, cfg.toolDenys().get(label));
                cfg.toolDenys().remove(label);
            }
        }

        for (var label : DANGEROUS_CATEGORY_LABELS) {
            cfg.toolDenys().putIfAbsent(label,
                new ToolDeny(label, "stripped for auto-mode safety", true));
        }

        stashStack.push(new ModeConfigRestore(Mode.AUTO, stashedAllows, stashedDenys));
    }

    private void restoreDangerousPermissionsFromAutoMode() {
        if (stashStack.isEmpty()) return;
        var restore = stashStack.pop();
        if (restore.prevMode() != Mode.AUTO) return;

        var cfg = modeConfigs.get(Mode.AUTO);
        if (cfg == null) return;

        for (var label : DANGEROUS_CATEGORY_LABELS) {
            var deny = cfg.toolDenys().get(label);
            if (deny != null && deny.reason().contains("stripped for auto-mode safety")) {
                cfg.toolDenys().remove(label);
            }
        }

        for (var e : restore.stashedAllows().entrySet()) {
            cfg.toolAllows().put(e.getKey(), e.getValue());
        }
        for (var e : restore.stashedDenys().entrySet()) {
            cfg.toolDenys().put(e.getKey(), e.getValue());
        }
    }

    // --- BYPASS_IMMUNE ---

    private static final Set<String> IMMUNE_WRITE_TOOLS = Set.of("edit", "write", "bash", "task", "skill", "webfetch");

    public boolean isBypassImmune(String toolName, String filePath) {
        if (filePath == null || filePath.isBlank()) return false;
        var normTool = normalizeToolName(toolName);
        if (!IMMUNE_WRITE_TOOLS.contains(normTool)) return false;

        var normPath = Path.of(filePath.replace('\\', '/')).normalize()
            .toString().replace('\\', '/').toLowerCase();
        var isBashTool = normTool.equals("bash");

        for (var pattern : bypassImmunePatterns) {
            var p = pattern.toLowerCase().replace('\\', '/');
            if (p.endsWith("/")) {
                var dirName = p.substring(0, p.length() - 1);
                if (matchesSegment(normPath, dirName, true, isBashTool)) return true;
            } else if (p.startsWith(".")) {
                if (matchesSegment(normPath, p, false, isBashTool)) return true;
            } else {
                if (matchesSegment(normPath, p, false, isBashTool)) return true;
            }
        }
        return false;
    }

    private static boolean matchesSegment(String path, String needle, boolean isDir, boolean isBashTool) {
        if (isBashTool) {
            if (isDir) return path.contains("/" + needle + "/") || path.startsWith(needle + "/")
                || path.contains(" " + needle + "/")
                || path.contains("~/" + needle + "/")
                || path.contains("=" + needle + "/")
                || path.contains("=" + needle + " ")
                || path.endsWith(" " + needle)
                || path.endsWith("/" + needle)
                || path.endsWith("~/" + needle)
                || path.endsWith("=" + needle);
            if (isBareEnv(needle))
                return path.equals(needle)
                    || (path.contains("/" + needle) && !path.contains("/" + needle + "."))
                    || (path.contains(" " + needle) && !path.contains(" " + needle + "."))
                    || (path.contains("~" + needle) && !path.contains("~" + needle + "."))
                    || (path.startsWith(needle) && !path.startsWith(needle + "."));
            if (isPrefixPattern(needle)) {
                var idx = path.indexOf(needle);
                if (idx < 0) return false;
                var before = idx == 0 ? '/' : path.charAt(idx - 1);
                var afterIdx = idx + needle.length();
                if (afterIdx >= path.length()) return false;
                return (before == '/' || before == ' ' || before == ':' || before == '~' || before == '=');
            }
            var idx = path.indexOf(needle);
            if (idx < 0) return false;
            var before = idx == 0 ? '/' : path.charAt(idx - 1);
            var afterIdx = idx + needle.length();
            var after = afterIdx < path.length() ? path.charAt(afterIdx) : '/';
            return (before == '/' || before == ' ' || before == ':' || before == '~' || before == '=')
                && (after == '/' || after == '.' || after == ' ' || after == '\0');
        }
        if (isDir) return path.contains("/" + needle + "/") || path.startsWith(needle + "/");
        if (isBareEnv(needle))
            return path.equals(needle) || path.endsWith("/" + needle)
                || path.startsWith(needle + "/");
        if (isPrefixPattern(needle)) {
            var idx = path.indexOf(needle);
            if (idx < 0) return false;
            var before = idx == 0 ? '/' : path.charAt(idx - 1);
            var afterIdx = idx + needle.length();
            if (afterIdx >= path.length()) return false;
            return (before == '/' || before == ':');
        }
        var idx = path.indexOf(needle);
        if (idx < 0) return false;
        var before = idx == 0 ? '/' : path.charAt(idx - 1);
        var afterIdx = idx + needle.length();
        var after = afterIdx < path.length() ? path.charAt(afterIdx) : '/';
        return (before == '/' || before == ':')
            && (after == '/' || after == '.' || after == '\0');
    }

    private static boolean isBareEnv(String needle) {
        return needle.equals(".env");
    }

    private static boolean isPrefixPattern(String needle) {
        return needle.startsWith(".") && needle.endsWith(".");
    }

    public void setBypassImmunePatterns(Set<String> patterns) {
        bypassImmunePatterns.clear();
        bypassImmunePatterns.addAll(patterns);
    }

    // --- helpers ---

    public boolean isInCwd(String filePath) {
        if (filePath == null || filePath.isBlank()) return false;
        var normalized = filePath.replace('\\', '/');
        var path = Path.of(normalized).normalize();
        var str = path.toString().replace('\\', '/');

        if (path.isAbsolute()) {
            var cwdStr = cwdBase.toString().replace('\\', '/') + "/";
            return (str + "/").startsWith(cwdStr);
        }
        return !str.startsWith("..") && !str.startsWith("/");
    }

    // --- persistence ---

    private Path stateFile() {
        return stateDir.resolve("tmp").resolve("sessions")
            .resolve(".permission-modes").resolve("state.json");
    }

    private Path lockFile() {
        return stateDir.resolve("tmp").resolve("sessions")
            .resolve(".permission-modes").resolve(".lock");
    }

    @FunctionalInterface
    private interface LockedAction {
        void run() throws java.io.IOException;
    }

    private void withLock(LockedAction action) throws java.io.IOException {
        var dir = lockFile().getParent();
        Files.createDirectories(dir);
        try (var channel = java.nio.channels.FileChannel.open(lockFile(),
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE)) {
            java.nio.channels.FileLock lock = null;
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (lock == null) {
                try {
                    lock = channel.tryLock();
                    if (lock == null) {
                        if (System.nanoTime() > deadline) throw new java.io.IOException("timeout acquiring state lock");
                        Thread.sleep(10);
                    }
                } catch (java.nio.channels.OverlappingFileLockException e) {
                    if (System.nanoTime() > deadline) throw new java.io.IOException("timeout acquiring state lock");
                    Thread.sleep(10);
                }
            }
            try {
                action.run();
            } finally {
                lock.release();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new java.io.IOException("interrupted acquiring state lock", e);
        }
    }

    public void saveState() throws java.io.IOException {
        withLock(() -> {
            var json = stateToJson();
            var stateFile = stateFile();
            var tmpFile = lockFile().resolveSibling(
                "state.json.tmp." + Thread.currentThread().threadId() + "." + System.nanoTime());
            Files.writeString(tmpFile, json);
            Files.move(tmpFile, stateFile, java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        });
    }

    public void loadState() throws java.io.IOException {
        withLock(() -> {
            var file = stateFile();
            if (!Files.exists(file)) return;
            var json = Files.readString(file);
            restoreFromJson(json);
        });
    }

    // --- JSON serde ---

    public String stateToJson() {
        var sb = new StringBuilder();
        sb.append("{");

        sb.append("\"currentMode\":\"").append(currentMode.modeName()).append("\",");
        sb.append("\"autoStripped\":").append(autoStripped).append(",");

        sb.append("\"stash\":");
        stashToJson(sb);

        sb.append(",\"configs\":{");
        var firstCfg = true;
        for (var entry : modeConfigs.entrySet()) {
            if (!firstCfg) sb.append(",");
            firstCfg = false;
            sb.append("\"").append(entry.getKey().modeName()).append("\":");
            configToJson(sb, entry.getValue());
        }
        sb.append("},");

        sb.append("\"bypassImmune\":[");
        var firstBi = true;
        for (var p : bypassImmunePatterns) {
            if (!firstBi) sb.append(",");
            firstBi = false;
            sb.append("\"").append(escapeJson(p)).append("\"");
        }
        sb.append("]");

        sb.append("}");
        return sb.toString();
    }

    private void stashToJson(StringBuilder sb) {
        sb.append("[");
        var first = true;
        for (var restore : stashStack) {
            if (!first) sb.append(",");
            first = false;
            sb.append("{\"allows\":{");
            var firstA = true;
            for (var e : restore.stashedAllows().entrySet()) {
                if (!firstA) sb.append(",");
                firstA = false;
                sb.append("\"").append(escapeJson(e.getKey())).append("\":\"")
                  .append(escapeJson(e.getValue().note())).append("\"");
            }
            sb.append("},\"denys\":{");
            var firstD = true;
            for (var e : restore.stashedDenys().entrySet()) {
                if (!firstD) sb.append(",");
                firstD = false;
                sb.append("\"").append(escapeJson(e.getKey())).append("\":{\"reason\":\"")
                  .append(escapeJson(e.getValue().reason()))
                  .append("\",\"immune\":").append(e.getValue().bypassImmune()).append("}");
            }
            sb.append("}}");
        }
        sb.append("]");
    }

    private void configToJson(StringBuilder sb, ModeConfig cfg) {        sb.append("{");

        sb.append("\"blockedCategories\":[");
        var blocked = new StringJoiner(",");
        for (var e : cfg.categoryBlocked().entrySet()) {
            if (e.getValue()) blocked.add("\"" + e.getKey().label() + "\"");
        }
        sb.append(blocked.toString());
        sb.append("],");

        sb.append("\"allows\":{");
        var firstA = true;
        for (var a : cfg.toolAllows().entrySet()) {
            if (!firstA) sb.append(",");
            firstA = false;
            sb.append("\"").append(escapeJson(a.getKey())).append("\":\"")
              .append(escapeJson(a.getValue().note())).append("\"");
        }
        sb.append("},");

        sb.append("\"denys\":{");
        var firstD = true;
        for (var d : cfg.toolDenys().entrySet()) {
            if (!firstD) sb.append(",");
            firstD = false;
            sb.append("\"").append(escapeJson(d.getKey())).append("\":{\"reason\":\"")
              .append(escapeJson(d.getValue().reason()))
              .append("\",\"immune\":").append(d.getValue().bypassImmune()).append("}");
        }
        sb.append("}");

        sb.append("}");
    }

    private void restoreFromJson(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
        var outer = trimmed.substring(1, trimmed.length() - 1);

        var parts = splitTopLevel(outer, ',');
        for (var part : parts) {
            var kv = splitFirst(part, ':');
            if (kv.length < 2) continue;
            var key = unquote(kv[0].strip());
            var val = kv[1].strip();

            switch (key) {
                case "currentMode" -> {
                    try {
                        currentMode = Mode.fromName(unquote(val));
                    } catch (IllegalArgumentException ignored) {
                        currentMode = Mode.DEFAULT;
                    }
                }
                case "autoStripped" -> {
                    autoStripped = Boolean.parseBoolean(val.strip());
                }
                case "stash" -> {
                    stashStack.clear();
                    restoreStashFromJson(val);
                }
                case "bypassImmune" -> {
                    bypassImmunePatterns.clear();
                    for (var p : parseArray(val)) bypassImmunePatterns.add(unescapeJson(p));
                }
                case "configs" -> {
                    restoreConfigsFromJson(val);
                }
            }
        }

        if (currentMode == Mode.AUTO && !autoStripped && stashStack.isEmpty()) {
            var cfg = modeConfigs.get(Mode.AUTO);
            if (cfg != null) {
                var stashedAllows = new HashMap<String, ToolAllow>();
                var stashedDenys = new HashMap<String, ToolDeny>();
                for (var label : DANGEROUS_CATEGORY_LABELS) {
                    if (cfg.toolAllows().containsKey(label)) {
                        stashedAllows.put(label, cfg.toolAllows().get(label));
                        cfg.toolAllows().remove(label);
                    }
                    if (cfg.toolDenys().containsKey(label)) {
                        stashedDenys.put(label, cfg.toolDenys().get(label));
                    }
                }
                for (var label : DANGEROUS_CATEGORY_LABELS) {
                    cfg.toolDenys().putIfAbsent(label,
                        new ToolDeny(label, "stripped for auto-mode safety", true));
                }
                stashStack.push(new ModeConfigRestore(Mode.AUTO, stashedAllows, stashedDenys));
                autoStripped = true;
            }
        }
        if (currentMode != Mode.AUTO) {
            autoStripped = false;
            stashStack.clear();
        }
    }

    private void restoreStashFromJson(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return;
        var inner = trimmed.substring(1, trimmed.length() - 1).strip();
        if (inner.isEmpty()) return;

        var parts = splitTopLevel(inner, ',');
        for (var part : parts) {
            var restoreJson = part.strip();
            if (!restoreJson.startsWith("{") || !restoreJson.endsWith("}")) continue;
            var reopen = restoreJson.substring(1, restoreJson.length() - 1);
            Map<String, ToolAllow> allows = new HashMap<>();
            Map<String, ToolDeny> denys = new HashMap<>();
            for (var field : splitTopLevel(reopen, ',')) {
                var kv = splitFirst(field, ':');
                if (kv.length < 2) continue;
                var k = unquote(kv[0].strip());
                var v = kv[1].strip();
                if ("allows".equals(k)) {
                    var a = v.strip();
                    if (a.startsWith("{") && a.endsWith("}")) {
                        var ai = a.substring(1, a.length() - 1).strip();
                        if (!ai.isEmpty()) {
                            for (var ap : splitTopLevel(ai, ',')) {
                                var akv = splitFirst(ap, ':');
                                if (akv.length < 2) continue;
                                var name = unquote(akv[0].strip());
                                var note = unescapeJson(unquote(akv[1].strip()));
                                allows.put(name, new ToolAllow(name, note));
                            }
                        }
                    }
                } else if ("denys".equals(k)) {
                    var d = v.strip();
                    if (d.startsWith("{") && d.endsWith("}")) {
                        var di = d.substring(1, d.length() - 1).strip();
                        if (!di.isEmpty()) {
                            for (var dp : splitTopLevel(di, ',')) {
                                var dkv = splitFirst(dp, ':');
                                if (dkv.length < 2) continue;
                                var name = unquote(dkv[0].strip());
                                var denyJson = dkv[1].strip();
                                if (!denyJson.startsWith("{") || !denyJson.endsWith("}")) continue;
                                var denyInner = denyJson.substring(1, denyJson.length() - 1);
                                String reason = "";
                                boolean immune = false;
                                for (var ff : splitTopLevel(denyInner, ',')) {
                                    var fkv = splitFirst(ff, ':');
                                    if (fkv.length < 2) continue;
                                    var fk = unquote(fkv[0].strip());
                                    var fv = fkv[1].strip();
                                    if ("reason".equals(fk)) reason = unescapeJson(unquote(fv));
                                    else if ("immune".equals(fk)) immune = Boolean.parseBoolean(fv.strip());
                                }
                                denys.put(name, new ToolDeny(name, reason, immune));
                            }
                        }
                    }
                }
            }
            stashStack.push(new ModeConfigRestore(Mode.AUTO, allows, denys));
        }
    }

    private void restoreConfigsFromJson(String json) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
        var inner = trimmed.substring(1, trimmed.length() - 1);

        var parts = splitTopLevel(inner, ',');
        for (var part : parts) {
            var kv = splitFirst(part, ':');
            if (kv.length < 2) continue;
            var modeName = unquote(kv[0].strip());
            var cfgJson = kv[1].strip();

            Mode mode;
            try {
                mode = Mode.fromName(modeName);
            } catch (IllegalArgumentException e) {
                continue;
            }

            var cfg = restoreConfigFromJson(cfgJson);
            modeConfigs.put(mode, cfg);
        }
    }

    private ModeConfig restoreConfigFromJson(String json) {
        var blocked = new HashMap<ToolCategory, Boolean>();
        var allows = new HashMap<String, ToolAllow>();
        var denys = new HashMap<String, ToolDeny>();

        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return new ModeConfig(blocked, allows, denys);
        var inner = trimmed.substring(1, trimmed.length() - 1);

        var parts = splitTopLevel(inner, ',');
        for (var part : parts) {
            var kv = splitFirst(part, ':');
            if (kv.length < 2) continue;
            var key = unquote(kv[0].strip());
            var val = kv[1].strip();

            switch (key) {
                case "blockedCategories" -> {
                    for (var cat : parseArray(val)) {
                        try {
                            blocked.put(ToolCategory.fromToolName(cat), true);
                        } catch (IllegalArgumentException ignored) {}
                    }
                }
                case "allows" -> {
                    restoreAllows(val, allows);
                }
                case "denys" -> {
                    restoreDenys(val, denys);
                }
            }
        }

        return new ModeConfig(blocked, allows, denys);
    }

    private void restoreAllows(String json, Map<String, ToolAllow> allows) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
        var inner = trimmed.substring(1, trimmed.length() - 1).strip();
        if (inner.isEmpty()) return;

        var parts = splitTopLevel(inner, ',');
        for (var part : parts) {
            var kv = splitFirst(part, ':');
            if (kv.length < 2) continue;
            var toolName = unquote(kv[0].strip());
            var note = unescapeJson(unquote(kv[1].strip()));
            allows.put(toolName, new ToolAllow(toolName, note));
        }
    }

    private void restoreDenys(String json, Map<String, ToolDeny> denys) {
        var trimmed = json.strip();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
        var inner = trimmed.substring(1, trimmed.length() - 1).strip();
        if (inner.isEmpty()) return;

        var parts = splitTopLevel(inner, ',');
        for (var part : parts) {
            var kv = splitFirst(part, ':');
            if (kv.length < 2) continue;
            var toolName = unquote(kv[0].strip());
            var denyJson = kv[1].strip();

            if (!denyJson.startsWith("{") || !denyJson.endsWith("}")) continue;
            var denyInner = denyJson.substring(1, denyJson.length() - 1);
            String reason = "";
            boolean immune = false;
            for (var dp : splitTopLevel(denyInner, ',')) {
                var dkv = splitFirst(dp, ':');
                if (dkv.length < 2) continue;
                var dk = unquote(dkv[0].strip());
                var dv = dkv[1].strip();
                if ("reason".equals(dk)) reason = unescapeJson(unquote(dv));
                else if ("immune".equals(dk)) immune = Boolean.parseBoolean(dv.strip());
            }
            denys.put(toolName, new ToolDeny(toolName, reason, immune));
        }
    }

    private static String[] splitTopLevel(String s, char delim) {
        var result = new ArrayList<String>();
        var depth = 0;
        var start = 0;
        var inString = false;
        for (var i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            if (c == '"' && (i == 0 || s.charAt(i - 1) != '\\')) inString = !inString;
            if (inString) continue;
            if (c == '{' || c == '[') depth++;
            if (c == '}' || c == ']') depth--;
            if (c == delim && depth == 0) {
                result.add(s.substring(start, i));
                start = i + 1;
            }
        }
        result.add(s.substring(start));
        return result.toArray(new String[0]);
    }

    private static String[] splitFirst(String s, char delim) {
        int depth = 0;
        boolean inString = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' && (i == 0 || s.charAt(i - 1) != '\\')) inString = !inString;
            if (inString) continue;
            if (c == '{' || c == '[') depth++;
            if (c == '}' || c == ']') depth--;
            if (c == delim && depth == 0) {
                return new String[]{s.substring(0, i), s.substring(i + 1)};
            }
        }
        return new String[]{s};
    }

    private static String unquote(String s) {
        if (s.startsWith("\"") && s.endsWith("\"")) return s.substring(1, s.length() - 1);
        return s;
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                 .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    private static String unescapeJson(String s) {
        var sb = new StringBuilder(s.length());
        var i = 0;
        while (i < s.length()) {
            var c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                var next = s.charAt(i + 1);
                switch (next) {
                    case '"' -> { sb.append('"'); i += 2; continue; }
                    case '\\' -> { sb.append('\\'); i += 2; continue; }
                    case '/' -> { sb.append('/'); i += 2; continue; }
                    case 'n' -> { sb.append('\n'); i += 2; continue; }
                    case 'r' -> { sb.append('\r'); i += 2; continue; }
                    case 't' -> { sb.append('\t'); i += 2; continue; }
                }
            }
            sb.append(c);
            i++;
        }
        return sb.toString();
    }

    private static List<String> parseArray(String s) {
        var result = new ArrayList<String>();
        var trimmed = s.strip();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            var inner = trimmed.substring(1, trimmed.length() - 1).strip();
            if (inner.isEmpty()) return result;
            var depth = 0;
            var inString = false;
            var start = 0;
            for (var i = 0; i < inner.length(); i++) {
                var c = inner.charAt(i);
                if (c == '"' && (i == 0 || inner.charAt(i - 1) != '\\')) inString = !inString;
                if (inString) continue;
                if (c == '{' || c == '[') depth++;
                if (c == '}' || c == ']') depth--;
                if (c == ',' && depth == 0) {
                    result.add(unquote(inner.substring(start, i).strip()));
                    start = i + 1;
                }
            }
            result.add(unquote(inner.substring(start).strip()));
        }
        return result;
    }
}
