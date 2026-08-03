package eu.infolead.llmhp.permissionmodes;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;

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

    private static final Set<String> DEFAULT_DANGEROUS = Set.of("bash", "write", "edit", "webfetch", "task", "skill");

    private Mode currentMode;
    private final Map<Mode, ModeConfig> modeConfigs;
    private final Set<String> bypassImmunePatterns;
    private final Deque<ModeConfigRestore> stashStack;
    private final Path stateDir;
    private boolean autoStripped;

    private record ModeConfigRestore(Mode prevMode, Set<String> stashedAllows, Set<String> stashedDenys) {}

    public PermissionModes() {
        this(Path.of("."));
    }

    public PermissionModes(Path stateDir) {
        this.currentMode = Mode.DEFAULT;
        this.modeConfigs = new EnumMap<>(Mode.class);
        this.bypassImmunePatterns = new LinkedHashSet<>();
        this.stashStack = new ArrayDeque<>();
        this.stateDir = stateDir;
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
            ".git/", ".claude/", "claude.md",
            ".bashrc", ".bash_profile", ".zshrc", ".profile",
            ".ssh/", ".env", ".env.local",
            "config.json", "opencode.json",
            "settings.json", "plugin.json", "hooks.json"
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

    public void addToolAllow(Mode mode, String toolName, String note) {
        modeConfigs.computeIfAbsent(mode, m -> emptyConfig())
            .toolAllows().put(toolName, new ToolAllow(toolName, note));
    }

    public void addToolDeny(Mode mode, String toolName, String reason, boolean bypassImmune) {
        modeConfigs.computeIfAbsent(mode, m -> emptyConfig())
            .toolDenys().put(toolName, new ToolDeny(toolName, reason, bypassImmune));
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

    // --- permission check ---

    public PermissionResult checkPermission(String toolName, String filePath) {
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
                if (autoStripped && DEFAULT_DANGEROUS.contains(toolName)) {
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

        var stashedAllows = new HashSet<String>();
        var stashedDenys = new HashSet<String>();

        for (var tool : DEFAULT_DANGEROUS) {
            if (cfg.toolAllows().containsKey(tool)) {
                stashedAllows.add(tool);
                cfg.toolAllows().remove(tool);
            }
            if (cfg.toolDenys().containsKey(tool)) {
                stashedDenys.add(tool);
                cfg.toolDenys().remove(tool);
            }
        }

        for (var tool : DEFAULT_DANGEROUS) {
            cfg.toolDenys().putIfAbsent(tool,
                new ToolDeny(tool, "stripped for auto-mode safety", true));
        }

        stashStack.push(new ModeConfigRestore(Mode.AUTO, stashedAllows, stashedDenys));
    }

    private void restoreDangerousPermissionsFromAutoMode() {
        if (stashStack.isEmpty()) return;
        var restore = stashStack.pop();
        if (restore.prevMode() != Mode.AUTO) return;

        var cfg = modeConfigs.get(Mode.AUTO);
        if (cfg == null) return;

        for (var tool : DEFAULT_DANGEROUS) {
            var deny = cfg.toolDenys().get(tool);
            if (deny != null && deny.reason().contains("stripped for auto-mode safety")) {
                cfg.toolDenys().remove(tool);
            }
        }

        for (var tool : restore.stashedAllows()) {
            cfg.toolAllows().put(tool, new ToolAllow(tool, "restored from auto-mode stash"));
        }
        for (var tool : restore.stashedDenys()) {
            cfg.toolDenys().put(tool,
                new ToolDeny(tool, "restored from auto-mode stash", false));
        }
    }

    // --- BYPASS_IMMUNE ---

    private static final Set<String> IMMUNE_WRITE_TOOLS = Set.of("edit", "write", "bash", "task");

    public boolean isBypassImmune(String toolName, String filePath) {
        if (filePath == null || filePath.isBlank()) return false;
        if (!IMMUNE_WRITE_TOOLS.contains(toolName)) return false;

        var norm = filePath.toLowerCase().replace('\\', '/');
        for (var pattern : bypassImmunePatterns) {
            var p = pattern.toLowerCase().replace('\\', '/');
            if (norm.contains(p)) return true;
        }
        return false;
    }

    public void setBypassImmunePatterns(Set<String> patterns) {
        bypassImmunePatterns.clear();
        bypassImmunePatterns.addAll(patterns);
    }

    // --- helpers ---

    private static boolean isInCwd(String filePath) {
        if (filePath == null || filePath.isBlank()) return false;
        var path = Path.of(filePath).normalize();
        var cwd = Path.of("").toAbsolutePath().normalize();

        if (path.isAbsolute()) return path.startsWith(cwd);
        return !path.startsWith("..") && !path.startsWith("/");
    }

    // --- persistence ---

    public void saveState() throws java.io.IOException {
        var dir = stateDir.resolve("tmp").resolve("sessions").resolve(".permission-modes");
        Files.createDirectories(dir);

        var json = stateToJson();
        Files.writeString(dir.resolve("state.json"), json);
    }

    public void loadState() throws java.io.IOException {
        var file = stateDir.resolve("tmp").resolve("sessions")
            .resolve(".permission-modes").resolve("state.json");
        if (!Files.exists(file)) return;
        var json = Files.readString(file);
        restoreFromJson(json);
    }

    // --- JSON serde ---

    public String stateToJson() {
        var sb = new StringBuilder();
        sb.append("{");

        sb.append("\"currentMode\":\"").append(currentMode.modeName()).append("\",");
        sb.append("\"autoStripped\":").append(autoStripped).append(",");

        sb.append("\"configs\":{");
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

    private void configToJson(StringBuilder sb, ModeConfig cfg) {
        sb.append("{");

        sb.append("\"blockedCategories\":[");
        var blocked = cfg.categoryBlocked().entrySet().stream()
            .filter(Map.Entry::getValue)
            .map(e -> "\"" + e.getKey().label() + "\"")
            .collect(Collectors.joining(","));
        sb.append(blocked);
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
                    currentMode = Mode.fromName(unquote(val));
                }
                case "autoStripped" -> {
                    autoStripped = Boolean.parseBoolean(val.strip());
                }
                case "bypassImmune" -> {
                    bypassImmunePatterns.clear();
                    parseArray(val).forEach(bypassImmunePatterns::add);
                }
                case "configs" -> {
                    restoreConfigsFromJson(val);
                }
            }
        }

        if (currentMode == Mode.AUTO && !autoStripped) {
            stripDangerousPermissionsForAutoMode();
            autoStripped = true;
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
            var note = unquote(kv[1].strip());
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
                if ("reason".equals(dk)) reason = unquote(dv);
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
