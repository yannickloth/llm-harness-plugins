import module java.base;

import eu.infolead.llmhp.permissionmodes.PermissionModes;
import eu.infolead.llmhp.permissionmodes.PermissionModesCli;

void main() throws Exception {
    testModeEnumValues();
    testModeFromNameValid();
    testModeFromNameInvalid();
    testModeIsValid();
    testToolCategoryMapping();
    testDefaultModePrompts();
    testDefaultModeAllTools();
    testPlanModeBlocksAllWrite();
    testPlanModeAllowsAllRead();
    testAcceptEditsInCwd();
    testAcceptEditsWriteInCwd();
    testAcceptEditsOutside();
    testAcceptEditsReadPrompts();
    testBypassPermissions();
    testBypassPermissionsAllCategories();
    testDontAskSilentBlock();
    testDontAskBlocksAllTools();
    testAutoMode();
    testAutoModeNonDangerousAllAllowed();
    testAutoStrippedPersists();
    testAutoStrippedOnLoad();
    testAutoExitToDefaultClearsStrip();
    testModeTransitions();
    testTransitionToSameModeNoop();
    testTransitionInvalidMode();
    testTransitionRoundtrip();
    testBypassImmune();
    testBypassImmuneCaseInsensitive();
    testBypassImmuneNewPatterns();
    testBypassImmuneSegmentAnchoring();
    testBypassImmuneDetection();
    testBypassImmuneBashCommands();
    testBypassImmuneTildePaths();
    testBypassImmuneAllWriteTools();
    testBypassImmuneNonTrigger();
    testTransitionToAutoStripsDangerous();
    testTransitionFromAutoRestores();
    testCustomAllowDeny();
    testCustomCategoryBlock();
    testRemoveCategoryBlock();
    testAddRemoveImmunePattern();
    testJsonRoundtrip();
    testConfigsRoundtrip();
    testJsonRoundtripSpecialChars();
    testRoundtripAllModes();
    testStateToJsonAllFields();
    testPersistenceSaveLoad();
    testPersistenceLoadNoFile();
    testAtomicSave();
    testAutoCrossProcessRestore();
    testAutoCrossProcessReenter();
    testConcurrentSaveLoad();
    testStaleAutoFlagClearedOnLoad();
    testUnknownToolAuto();
    testCaseVariantToolsAuto();
    testCaseVariantImmuneTools();
    testDontAskImmuneOrdering();
    testNormalizeToolName();
    testIsDangerousTool();
    testIsInCwd();
    testIsInCwdAbsoluteOutside();
    testIsInCwdCustomBase();
    testRestorePreservesBypassImmune();
    testBypassImmunePathNormalization();
    testCorruptedStateHandling();
    testCorruptedConfigsUnknownMode();
    testBypassImmunePatternsGetter();
    testCliCheck();
    testCliTransition();
    testCliStatus();
    testCliState();
    testCliSaveLoad();
    testCliImmune();
    testCliInvalidMode();

    System.out.println("PermissionModes tests: PASSED");
}

// --- helpers ---

void assertTrue(boolean condition, String message) {
    if (!condition) throw new AssertionError("FAIL: " + message);
}

void assertEquals(Object expected, Object actual, String message) {
    if (!expected.equals(actual))
        throw new AssertionError("FAIL: " + message + " — expected " + expected + ", got " + actual);
}

void assertFalse(boolean condition, String message) {
    if (condition) throw new AssertionError("FAIL: " + message);
}

void assertContains(String haystack, String needle, String message) {
    if (!haystack.contains(needle))
        throw new AssertionError("FAIL: " + message + " — " + needle + " not in output");
}

void assertNotContains(String haystack, String needle, String message) {
    if (haystack.contains(needle))
        throw new AssertionError("FAIL: " + message + " — " + needle + " found in output");
}

void assertNotNull(Object o, String message) {
    if (o == null) throw new AssertionError("FAIL: " + message);
}

// --- enum tests ---

void testModeEnumValues() {
    var modes = PermissionModes.Mode.values();
    assertEquals(6, modes.length, "6 modes defined");

    var def = PermissionModes.Mode.DEFAULT;
    assertEquals("default", def.modeName(), "DEFAULT name");
    assertEquals("·", def.symbol(), "DEFAULT symbol");

    var plan = PermissionModes.Mode.PLAN;
    assertEquals("plan", plan.modeName(), "PLAN name");
    assertEquals("P", plan.symbol(), "PLAN symbol");

    var ae = PermissionModes.Mode.ACCEPT_EDITS;
    assertEquals("acceptEdits", ae.modeName(), "ACCEPT_EDITS name");
    assertEquals("A", ae.symbol(), "ACCEPT_EDITS symbol");

    var bp = PermissionModes.Mode.BYPASS_PERMISSIONS;
    assertEquals("bypassPermissions", bp.modeName(), "BYPASS name");
    assertEquals("!", bp.symbol(), "BYPASS symbol");

    var da = PermissionModes.Mode.DONT_ASK;
    assertEquals("dontAsk", da.modeName(), "DONT_ASK name");
    assertEquals("⊘", da.symbol(), "DONT_ASK symbol");

    var auto = PermissionModes.Mode.AUTO;
    assertEquals("auto", auto.modeName(), "AUTO name");
    assertEquals("∞", auto.symbol(), "AUTO symbol");
}

void testModeFromNameValid() {
    assertEquals(PermissionModes.Mode.DEFAULT, PermissionModes.Mode.fromName("default"), "fromName default");
    assertEquals(PermissionModes.Mode.PLAN, PermissionModes.Mode.fromName("plan"), "fromName plan");
    assertEquals(PermissionModes.Mode.BYPASS_PERMISSIONS, PermissionModes.Mode.fromName("bypassPermissions"), "fromName bypass");
    assertEquals(PermissionModes.Mode.DONT_ASK, PermissionModes.Mode.fromName("DONTASK"), "fromName case-insensitive");
    assertEquals(PermissionModes.Mode.AUTO, PermissionModes.Mode.fromName("AUTO"), "fromName uppercase AUTO");
}

void testModeFromNameInvalid() {
    assertDoesNotThrow(() -> PermissionModes.Mode.fromName("bogus"), "fromName throws on invalid mode", true);
}

void testModeIsValid() {
    assertTrue(PermissionModes.Mode.isValid("default"), "default valid");
    assertTrue(PermissionModes.Mode.isValid("PLAN"), "PLAN case-insensitive valid");
    assertTrue(PermissionModes.Mode.isValid("auto"), "auto valid");
    assertFalse(PermissionModes.Mode.isValid("bogus"), "bogus invalid");
    assertFalse(PermissionModes.Mode.isValid(""), "empty invalid");
}

void testToolCategoryMapping() {
    assertEquals(PermissionModes.ToolCategory.READ, PermissionModes.ToolCategory.fromToolName("read"), "read");
    assertEquals(PermissionModes.ToolCategory.EDIT, PermissionModes.ToolCategory.fromToolName("EDIT"), "EDIT cs");
    assertEquals(PermissionModes.ToolCategory.BASH, PermissionModes.ToolCategory.fromToolName("Bash"), "Bash cs");
    assertEquals(PermissionModes.ToolCategory.WEB_FETCH, PermissionModes.ToolCategory.fromToolName("webfetch"), "webfetch");
    assertEquals(PermissionModes.ToolCategory.TASK, PermissionModes.ToolCategory.fromToolName("task"), "task");
    assertEquals(PermissionModes.ToolCategory.SKILL, PermissionModes.ToolCategory.fromToolName("skill"), "skill");
    assertEquals(PermissionModes.ToolCategory.GLOB, PermissionModes.ToolCategory.fromToolName("glob"), "glob");
    assertEquals(PermissionModes.ToolCategory.GREP, PermissionModes.ToolCategory.fromToolName("grep"), "grep");
    assertEquals(PermissionModes.ToolCategory.QUESTION, PermissionModes.ToolCategory.fromToolName("question"), "question");
    assertEquals(PermissionModes.ToolCategory.TODO, PermissionModes.ToolCategory.fromToolName("todo"), "todo");
    assertEquals(PermissionModes.ToolCategory.OTHER, PermissionModes.ToolCategory.fromToolName("unknown_tool"), "unknown → OTHER");
    assertEquals(PermissionModes.ToolCategory.OTHER, PermissionModes.ToolCategory.fromToolName("mcp_serve"), "mcp → OTHER");
}

// --- default mode ---

void testDefaultModePrompts() {
    var modes = new PermissionModes();
    assertEquals(PermissionModes.Mode.DEFAULT, modes.currentMode(), "start in default");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "default — edit not auto-allow");
    assertTrue(r.promptUser(), "default — edit prompt");

    var r2 = modes.checkPermission("read", "src/main.java");
    assertFalse(r2.allowed(), "default — read prompt");
    assertTrue(r2.promptUser(), "default — read prompt user");
}

void testDefaultModeAllTools() {
    var modes = new PermissionModes();
    for (var label : List.of("bash", "write", "edit", "webfetch", "task", "skill", "glob", "grep", "question", "todo", "mcp_tool")) {
        var r = modes.checkPermission(label, null);
        assertFalse(r.allowed(), "default — " + label + " prompts");
        assertTrue(r.promptUser(), "default — " + label + " promptUser=true");
    }
}

// --- plan mode ---

void testPlanModeBlocksAllWrite() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");

    for (var label : List.of("edit", "write", "bash", "webfetch", "task", "skill")) {
        var r = modes.checkPermission(label, "src/test." + label);
        assertFalse(r.allowed(), "plan — " + label + " blocked");
        assertFalse(r.promptUser(), "plan — " + label + " silent");
    }
    var rOther = modes.checkPermission("mcp_tool", null);
    assertFalse(rOther.allowed(), "plan — unknown tool (OTHER) blocked");
    assertFalse(rOther.promptUser(), "plan — OTHER silent block");
}

void testPlanModeAllowsAllRead() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");

    for (var label : List.of("read", "glob", "grep", "question", "todo")) {
        var r = modes.checkPermission(label, null);
        assertTrue(r.allowed(), "plan — " + label + " allowed");
        assertFalse(r.promptUser(), "plan — " + label + " no prompt");
    }
}

// --- acceptEdits ---

void testAcceptEditsInCwd() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("edit", "src/main.java");
    assertTrue(r.allowed(), "acceptEdits — edit in CWD auto-approve");
    assertFalse(r.promptUser(), "acceptEdits — no prompt for cwd edit");
}

void testAcceptEditsWriteInCwd() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("write", "src/main.java");
    assertTrue(r.allowed(), "acceptEdits — write in CWD auto-approve");
    assertFalse(r.promptUser(), "acceptEdits — write no prompt");
}

void testAcceptEditsOutside() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("edit", "../other/src/main.java");
    assertFalse(r.allowed(), "acceptEdits — edit outside should prompt");
    assertTrue(r.promptUser(), "acceptEdits — prompt for out-of-cwd edit");

    var r2 = modes.checkPermission("bash", null);
    assertFalse(r2.allowed(), "acceptEdits — bash prompt");
    assertTrue(r2.promptUser(), "acceptEdits — bash prompt user");
}

void testAcceptEditsReadPrompts() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("read", "src/main.java");
    assertFalse(r.allowed(), "acceptEdits — read prompts");
    assertTrue(r.promptUser(), "acceptEdits — read prompt user");

    var r2 = modes.checkPermission("glob", null);
    assertFalse(r2.allowed(), "acceptEdits — glob prompts");
    assertTrue(r2.promptUser(), "acceptEdits — glob prompt user");
}

// --- bypass ---

void testBypassPermissions() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var r = modes.checkPermission("edit", "src/main.java");
    assertTrue(r.allowed(), "bypass — edit auto-allowed");
    assertFalse(r.promptUser(), "bypass — no prompt");

    var r2 = modes.checkPermission("bash", null);
    assertTrue(r2.allowed(), "bypass — bash auto-allowed");

    var r3 = modes.checkPermission("webfetch", null);
    assertTrue(r3.allowed(), "bypass — webfetch auto-allowed");
}

void testBypassPermissionsAllCategories() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    for (var label : List.of("read", "edit", "write", "bash", "webfetch", "task", "skill", "glob", "grep", "question", "todo")) {
        var r = modes.checkPermission(label, "src/file");
        assertTrue(r.allowed(), "bypass — " + label + " allowed");
        assertFalse(r.promptUser(), "bypass — " + label + " no prompt");
    }
    var rOther = modes.checkPermission("mcp_tool", null);
    assertTrue(rOther.allowed(), "bypass — unknown allowed");
    assertFalse(rOther.promptUser(), "bypass — unknown no prompt");
}

// --- dontAsk ---

void testDontAskSilentBlock() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("dontAsk");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "dontAsk — edit silent block");
    assertFalse(r.promptUser(), "dontAsk — no prompt");

    var r2 = modes.checkPermission("read", "src/main.java");
    assertFalse(r2.allowed(), "dontAsk — read also blocked");
    assertFalse(r2.promptUser(), "dontAsk — read silent block");
}

void testDontAskBlocksAllTools() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("dontAsk");

    for (var label : List.of("read", "edit", "bash", "write", "webfetch", "task", "skill", "glob", "grep", "question", "todo", "mcp_tool")) {
        var r = modes.checkPermission(label, null);
        assertFalse(r.allowed(), "dontAsk — " + label + " blocked");
        assertFalse(r.promptUser(), "dontAsk — " + label + " silent");
    }
}

// --- auto ---

void testAutoMode() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto — stripped");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "auto — edit stripped");
    assertTrue(r.promptUser(), "auto — stripped prompt");

    var r2 = modes.checkPermission("bash", null);
    assertFalse(r2.allowed(), "auto — bash stripped");
    assertTrue(r2.promptUser(), "auto — stripped prompt");
}

void testAutoModeNonDangerousAllAllowed() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");

    for (var label : List.of("read", "glob", "grep", "question", "todo")) {
        var r = modes.checkPermission(label, null);
        assertTrue(r.allowed(), "auto — " + label + " allowed");
        assertFalse(r.promptUser(), "auto — " + label + " no prompt");
    }
}

void testAutoStrippedPersists() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto stripped");

    modes.transitionPermissionMode("default");
    assertFalse(modes.isAutoStripped(), "default not stripped");

    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "re-enter auto stripped");
}

void testAutoStrippedOnLoad() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-auto-load");
    try {
        var modes1 = new PermissionModes(tmpDir);
        modes1.transitionPermissionMode("auto");
        modes1.saveState();

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.AUTO, modes2.currentMode(), "loaded auto");
        assertTrue(modes2.isAutoStripped(), "loaded auto stripped");

        var r = modes2.checkPermission("bash", null);
        assertFalse(r.allowed(), "loaded auto bash stripped");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testAutoExitToDefaultClearsStrip() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto stripped");
    modes.transitionPermissionMode("default");
    assertFalse(modes.isAutoStripped(), "exit auto clears stripped");
    assertFalse(modes.isAutoStripped(), "clear confirmed");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "default after auto — still prompts");
    assertTrue(r.promptUser(), "default after auto — normal behavior");
}

// --- mode transitions ---

void testModeTransitions() {
    var modes = new PermissionModes();
    assertEquals(PermissionModes.Mode.DEFAULT, modes.currentMode(), "start default");

    modes.transitionPermissionMode("plan");
    assertEquals(PermissionModes.Mode.PLAN, modes.currentMode(), "to plan");

    modes.transitionPermissionMode("acceptEdits");
    assertEquals(PermissionModes.Mode.ACCEPT_EDITS, modes.currentMode(), "to acceptEdits");

    modes.transitionPermissionMode("bypassPermissions");
    assertEquals(PermissionModes.Mode.BYPASS_PERMISSIONS, modes.currentMode(), "to bypass");

    modes.transitionPermissionMode("dontAsk");
    assertEquals(PermissionModes.Mode.DONT_ASK, modes.currentMode(), "to dontAsk");

    modes.transitionPermissionMode("auto");
    assertEquals(PermissionModes.Mode.AUTO, modes.currentMode(), "to auto");
    assertTrue(modes.isAutoStripped(), "auto stripped");

    modes.transitionPermissionMode("default");
    assertEquals(PermissionModes.Mode.DEFAULT, modes.currentMode(), "back to default");
    assertFalse(modes.isAutoStripped(), "default not stripped");
}

void testTransitionToSameModeNoop() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");
    assertEquals(PermissionModes.Mode.PLAN, modes.currentMode(), "in plan");

    modes.transitionPermissionMode("plan");
    assertEquals(PermissionModes.Mode.PLAN, modes.currentMode(), "still plan");
}

void testTransitionInvalidMode() {
    var modes = new PermissionModes();
    assertDoesNotThrow(() -> modes.transitionPermissionMode("bogus"), "invalid mode throws", true);
}

void testTransitionRoundtrip() {
    var modes = new PermissionModes();
    for (var name : List.of("plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto", "default")) {
        modes.transitionPermissionMode(name);
        assertEquals(PermissionModes.Mode.fromName(name), modes.currentMode(), "roundtrip to " + name);
    }
}

// --- BYPASS_IMMUNE ---

void testBypassImmune() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var r = modes.checkPermission("edit", ".git/config");
    assertFalse(r.allowed(), "BYPASS_IMMUNE — .git/ always prompts");
    assertTrue(r.promptUser(), "BYPASS_IMMUNE — ask even in bypass");
    assertTrue(r.reason().contains("BYPASS_IMMUNE"), "reason contains BYPASS_IMMUNE");

    var r2 = modes.checkPermission("write", ".claude/test.txt");
    assertFalse(r2.allowed(), "BYPASS_IMMUNE — .claude/ always prompts");

    var r3 = modes.checkPermission("bash", "cat .ssh/id_rsa");
    assertFalse(r3.allowed(), "BYPASS_IMMUNE — .ssh/ always prompts");

    var r4 = modes.checkPermission("read", ".git/config");
    assertTrue(r4.allowed(), "read is not write-tool, passes through");
}

void testBypassImmuneCaseInsensitive() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var r = modes.checkPermission("edit", "claude.md");
    assertFalse(r.allowed(), "claude.md lowercase matches");
    assertTrue(r.reason().contains("BYPASS_IMMUNE"), "reason contains BYPASS_IMMUNE");

    var r2 = modes.checkPermission("edit", "CLAUDE.md");
    assertFalse(r2.allowed(), "CLAUDE.md uppercase matches");

    var r3 = modes.checkPermission("edit", "AGENTS.md");
    assertFalse(r3.allowed(), "AGENTS.md matches");

    var r4 = modes.checkPermission("edit", "agents.md");
    assertFalse(r4.allowed(), "agents.md lowercase matches");
}

void testBypassImmuneNewPatterns() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    assertTrue(modes.checkPermission("edit", ".opencode/config.json").reason().contains("BYPASS_IMMUNE"), ".opencode/ immune");
    assertTrue(modes.checkPermission("edit", "AGENTS.md").reason().contains("BYPASS_IMMUNE"), "AGENTS.md immune");
    assertFalse(modes.checkPermission("write", ".github/workflows/ci.yaml").reason().contains("BYPASS_IMMUNE"), ".github/ not .git/");
    assertTrue(modes.checkPermission("edit", ".claude/settings.json").reason().contains("BYPASS_IMMUNE"), ".claude/ immune");
    assertTrue(modes.checkPermission("edit", "opencode.json").reason().contains("BYPASS_IMMUNE"), "opencode.json immune");
    assertTrue(modes.checkPermission("edit", "config.json").reason().contains("BYPASS_IMMUNE"), "config.json immune");
    assertTrue(modes.checkPermission("edit", "settings.json").reason().contains("BYPASS_IMMUNE"), "settings.json immune");
    assertTrue(modes.checkPermission("edit", "plugin.json").reason().contains("BYPASS_IMMUNE"), "plugin.json immune");
    assertTrue(modes.checkPermission("edit", "hooks.json").reason().contains("BYPASS_IMMUNE"), "hooks.json immune");
    assertTrue(modes.checkPermission("edit", ".bashrc").reason().contains("BYPASS_IMMUNE"), ".bashrc immune");
    assertTrue(modes.checkPermission("edit", ".bash_profile").reason().contains("BYPASS_IMMUNE"), ".bash_profile immune");
    assertTrue(modes.checkPermission("edit", ".zshrc").reason().contains("BYPASS_IMMUNE"), ".zshrc immune");
    assertTrue(modes.checkPermission("edit", ".profile").reason().contains("BYPASS_IMMUNE"), ".profile immune");
}

void testBypassImmuneSegmentAnchoring() {
    var modes = new PermissionModes();

    assertTrue(modes.isBypassImmune("edit", ".git/config"), ".git/config");
    assertFalse(modes.isBypassImmune("edit", ".gitignore"), ".gitignore not .git/");
    assertFalse(modes.isBypassImmune("edit", ".github/workflows/ci.yaml"), ".github/ not immune");
    assertFalse(modes.isBypassImmune("edit", "agitate"), "agitate not .git/");

    assertTrue(modes.isBypassImmune("edit", ".env"), ".env");
    assertTrue(modes.isBypassImmune("edit", ".env.copy"), ".env.copy matches .env. prefix");
    assertTrue(modes.isBypassImmune("edit", ".env.local"), ".env.local");
    assertTrue(modes.isBypassImmune("edit", ".env.production"), ".env.production");

    assertFalse(modes.isBypassImmune("edit", "my.env.file"), "my.env.file no segment");
    assertFalse(modes.isBypassImmune("edit", "environment/config"), "environment not .env");

    assertTrue(modes.isBypassImmune("edit", "claude.md"), "claude.md matches");
    assertTrue(modes.isBypassImmune("edit", "root/claude.md"), "root/claude.md matches");
    assertFalse(modes.isBypassImmune("edit", "myclaude.md"), "myclaude.md should not match");
}

void testBypassImmuneDetection() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("edit", ".git/config"), "edit .git/");
    assertTrue(modes.isBypassImmune("write", ".claude/test.txt"), "write .claude/");
    assertTrue(modes.isBypassImmune("bash", "rm .env.local"), "bash .env");
    assertTrue(modes.isBypassImmune("task", ".git/hooks/pre-commit"), "task .git/");
    assertTrue(modes.isBypassImmune("edit", "AGENTS.md"), "edit AGENTS.md");
    assertTrue(modes.isBypassImmune("edit", "config.json"), "edit config.json");
    assertTrue(modes.isBypassImmune("edit", "opencode.json"), "edit opencode.json");
    assertTrue(modes.isBypassImmune("skill", ".env"), "skill + .env");
    assertTrue(modes.isBypassImmune("webfetch", ".ssh/config"), "webfetch + .ssh/");
}

void testBypassImmuneBashCommands() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("bash", "rm -rf .git"), "rm .git (no slash)");
    assertTrue(modes.isBypassImmune("bash", "rm .git"), "rm .git bare");
    assertTrue(modes.isBypassImmune("bash", "chmod 700 .ssh"), "chmod .ssh (no slash)");
    assertTrue(modes.isBypassImmune("bash", "rm -rf .claude"), "rm .claude");
    assertTrue(modes.isBypassImmune("bash", "rm -rf .opencode"), "rm .opencode");
    assertTrue(modes.isBypassImmune("bash", "cat .git/config"), "cat .git/config");
    assertTrue(modes.isBypassImmune("bash", "git --git-dir=.git status"), "git --git-dir=.git");
    assertTrue(modes.isBypassImmune("bash", "rm .env"), "rm .env bare");
    assertTrue(modes.isBypassImmune("bash", "source .env"), "source .env");
}

void testBypassImmuneTildePaths() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("bash", "rm -rf ~/.git"), "bash ~/.git");
    assertTrue(modes.isBypassImmune("bash", "cat ~/.ssh/id_rsa"), "bash ~/.ssh/");
    assertTrue(modes.isBypassImmune("bash", "source ~/.env"), "bash ~/.env");
    assertTrue(modes.isBypassImmune("bash", "source ~/.env.local"), "bash ~/.env.local");
    assertTrue(modes.isBypassImmune("edit", "~/.git/config"), "edit ~/.git/config");
}

void testBypassImmuneAllWriteTools() {
    var modes = new PermissionModes();
    for (var tool : List.of("edit", "write", "bash", "task", "skill", "webfetch")) {
        assertTrue(modes.isBypassImmune(tool, ".git/config"), tool + " + .git/ immune");
        assertTrue(modes.isBypassImmune(tool, ".env"), tool + " + .env immune");
    }
}

void testBypassImmuneNonTrigger() {
    var modes = new PermissionModes();
    assertFalse(modes.isBypassImmune("read", ".git/config"), "read non-write");
    assertFalse(modes.isBypassImmune("glob", ".git/"), "glob non-write");
    assertFalse(modes.isBypassImmune("grep", ".git/"), "grep non-write");
    assertFalse(modes.isBypassImmune("question", ".git/"), "question non-write");
    assertFalse(modes.isBypassImmune("todo", ".git/"), "todo non-write");
    assertFalse(modes.isBypassImmune("webfetch", null), "null path");
    assertFalse(modes.isBypassImmune("edit", ""), "blank path");
    assertFalse(modes.isBypassImmune("edit", "src/main.java"), "normal file");
    assertFalse(modes.isBypassImmune("edit", ".gitignore"), ".gitignore");
    assertFalse(modes.isBypassImmune("edit", ".github/workflows/ci.yaml"), ".github/");
    assertFalse(modes.isBypassImmune("edit", "my.env.file"), "my.env.file");
    assertFalse(modes.isBypassImmune("edit", "environment/config"), "environment");
    assertFalse(modes.isBypassImmune("Skill", "src/main.java"), "Skill normal file");
    assertFalse(modes.isBypassImmune("WebFetch", "src/main.java"), "WebFetch normal file");
    assertFalse(modes.isBypassImmune("Read", ".git/config"), "Read non-write case-variant");
}

// --- auto-mode strip/restore ---

void testTransitionToAutoStripsDangerous() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");
    modes.transitionPermissionMode("auto");

    assertTrue(modes.isAutoStripped(), "auto stripped");

    for (var label : List.of("bash", "write", "edit", "webfetch", "task", "skill")) {
        var r = modes.checkPermission(label, null);
        assertFalse(r.allowed(), "auto — " + label + " stripped");
        assertTrue(r.promptUser(), "auto — " + label + " prompts");
    }
}

void testTransitionFromAutoRestores() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var bpCfg = modes.configFor(PermissionModes.Mode.BYPASS_PERMISSIONS);
    assertTrue(bpCfg.toolAllows().containsKey("bash"), "bypass bash allow present");

    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto stripped");

    modes.transitionPermissionMode("default");
    assertFalse(modes.isAutoStripped(), "default not stripped");

    assertTrue(bpCfg.toolAllows().containsKey("bash"), "bypass bash allow survived");

    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "re-entered auto stripped");
    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "re-entered auto bash still stripped");
}

// --- custom config ---

void testCustomAllowDeny() {
    var modes = new PermissionModes();
    modes.addToolAllow(PermissionModes.Mode.DEFAULT, "bash", "trusted pattern");
    modes.addToolDeny(PermissionModes.Mode.DEFAULT, "webfetch", "no-network policy", false);

    var r = modes.checkPermission("bash", null);
    assertTrue(r.allowed(), "custom allow bash");
    assertFalse(r.promptUser(), "custom allow no prompt");

    var r2 = modes.checkPermission("webfetch", null);
    assertFalse(r2.allowed(), "custom deny webfetch");
    assertFalse(r2.promptUser(), "custom deny no prompt");

    var r3 = modes.checkPermission("edit", "src/main.java");
    assertFalse(r3.allowed(), "default edit still prompts");
    assertTrue(r3.promptUser(), "default edit prompt user");
}

void testCustomDenyImmune() {
    var modes = new PermissionModes();
    modes.addToolDeny(PermissionModes.Mode.DEFAULT, "bash", "block with prompt", true);

    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "custom deny immune bash blocked");
    assertTrue(r.promptUser(), "custom deny immune prompts");
}

void testCustomCategoryBlock() {
    var modes = new PermissionModes();
    modes.addCategoryBlock(PermissionModes.Mode.ACCEPT_EDITS, PermissionModes.ToolCategory.BASH);

    modes.transitionPermissionMode("acceptEdits");
    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "custom category block bash");
    assertFalse(r.promptUser(), "custom category block silent");
}

void testRemoveCategoryBlock() {
    var modes = new PermissionModes();
    modes.addCategoryBlock(PermissionModes.Mode.PLAN, PermissionModes.ToolCategory.BASH);
    modes.removeCategoryBlock(PermissionModes.Mode.PLAN, PermissionModes.ToolCategory.BASH);

    var cfg = modes.configFor(PermissionModes.Mode.PLAN);
    assertFalse(Boolean.TRUE.equals(cfg.categoryBlocked().getOrDefault(
        PermissionModes.ToolCategory.BASH, false)), "category block removed");
}

void testAddRemoveImmunePattern() {
    var modes = new PermissionModes();
    var before = modes.bypassImmunePatterns().size();

    modes.addBypassImmunePattern("custom.secret");
    assertEquals(before + 1, modes.bypassImmunePatterns().size(), "pattern added");
    assertTrue(modes.isBypassImmune("edit", "custom.secret"), "added pattern works");

    modes.removeBypassImmunePattern("custom.secret");
    assertEquals(before, modes.bypassImmunePatterns().size(), "pattern removed");
    assertFalse(modes.isBypassImmune("edit", "custom.secret"), "removed pattern not immune");
}

// --- serialization ---

void testJsonRoundtrip() throws Exception {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");
    var json = modes.stateToJson();

    assertTrue(json.contains("\"currentMode\":\"plan\""), "json contains currentMode");
    assertTrue(json.contains("\"bypassImmune\""), "json contains bypassImmune");
    assertTrue(json.contains(".git/"), "json contains .git/");
    assertTrue(json.contains(".opencode/"), "json contains .opencode/");

    var tmpDir = Files.createTempDirectory("permission-json-test");
    try {
        var tmpFile = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json");
        Files.createDirectories(tmpFile.getParent());
        Files.writeString(tmpFile, json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.PLAN, modes2.currentMode(), "roundtrip plan survived");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testConfigsRoundtrip() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-config-rt");
    try {
        var modes1 = new PermissionModes(tmpDir);
        modes1.addToolDeny(PermissionModes.Mode.DEFAULT, "webfetch", "no-network", false);
        modes1.addToolAllow(PermissionModes.Mode.DEFAULT, "bash", "trusted");
        modes1.addCategoryBlock(PermissionModes.Mode.ACCEPT_EDITS, PermissionModes.ToolCategory.BASH);

        var json = modes1.stateToJson();
        assertTrue(json.contains("webfetch"), "json contains custom deny");
        assertTrue(json.contains("trusted"), "json contains custom allow");

        var tmpFile = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json");
        Files.createDirectories(tmpFile.getParent());
        Files.writeString(tmpFile, json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();

        modes2.transitionPermissionMode("default");
        var r = modes2.checkPermission("webfetch", null);
        assertFalse(r.allowed(), "loaded custom deny webfetch");
        var r2 = modes2.checkPermission("bash", null);
        assertTrue(r2.allowed(), "loaded custom allow bash");

        modes2.transitionPermissionMode("acceptEdits");
        var r3 = modes2.checkPermission("bash", null);
        assertFalse(r3.allowed(), "loaded category block bash");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testJsonRoundtripSpecialChars() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-special-rt");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.addToolDeny(PermissionModes.Mode.DEFAULT, "bash", "has \"quotes\" and \\backslash", false);
        modes.addToolAllow(PermissionModes.Mode.DEFAULT, "webfetch", "note\nwith\nnewlines");
        modes.addBypassImmunePattern("path/with\"quote");
        modes.saveState();

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();

        modes2.transitionPermissionMode("default");
        var r = modes2.checkPermission("bash", null);
        assertFalse(r.allowed(), "special-chars deny bash blocked");
        assertContains(r.reason(), "\"quotes\" and \\backslash", "reason survived special chars");

        var r2 = modes2.checkPermission("webfetch", null);
        assertTrue(r2.allowed(), "special-chars allow webfetch allowed");
        assertContains(r2.reason(), "with", "note survived newlines");

        var immune = modes2.bypassImmunePatterns();
        assertTrue(immune.contains("path/with\"quote"), "immune pattern with quote survived");
        assertTrue(immune.contains(".git/"), "default patterns survived special-char roundtrip");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testRoundtripAllModes() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-all-rt");
    try {
        var modes = new PermissionModes(tmpDir);
        for (var mode : PermissionModes.Mode.values()) {
            modes.transitionPermissionMode(mode.modeName());
            modes.saveState();

            var modes2 = new PermissionModes(tmpDir);
            modes2.loadState();
            assertEquals(mode, modes2.currentMode(), "roundtrip mode " + mode.modeName());
        }
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testStateToJsonAllFields() {
    var modes = new PermissionModes();
    var json = modes.stateToJson();

    assertTrue(json.contains("\"autoStripped\":"), "autoStripped field present");
    assertTrue(json.contains("\"configs\":{"), "configs present");
    assertTrue(json.contains("\"blockedCategories\""), "blockedCategories present");
    assertTrue(json.contains("\"allows\""), "allows present");
    assertTrue(json.contains("\"denys\""), "denys present");

    assertNotContains(json, "\"bypassImmuneCount\"", "bypassImmuneCount not in state json");
    assertTrue(json.startsWith("{"), "json starts with {");
    assertTrue(json.endsWith("}"), "json ends with }");
}

// --- persistence ---

void testPersistenceSaveLoad() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-modes-test");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.transitionPermissionMode("bypassPermissions");
        modes.saveState();

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.BYPASS_PERMISSIONS, modes2.currentMode(), "mode persisted");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testPersistenceLoadNoFile() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-nofile");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.loadState();
        assertEquals(PermissionModes.Mode.DEFAULT, modes.currentMode(), "no file defaults to DEFAULT");
        assertFalse(modes.isAutoStripped(), "no file not auto stripped");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testAtomicSave() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-atomic");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.transitionPermissionMode("plan");
        modes.saveState();

        var stateDir = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes");
        var stateFile = stateDir.resolve("state.json");
        assertTrue(Files.exists(stateFile), "state file exists after save");

        var tmpFiles = Files.list(stateDir)
            .filter(p -> p.getFileName().toString().startsWith("state.json.tmp"))
            .toList();
        assertTrue(tmpFiles.isEmpty(), "no stale tmp files after atomic save");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testAutoCrossProcessRestore() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-auto-cp-restore");
    try {
        var p1 = new PermissionModes(tmpDir);
        p1.transitionPermissionMode("auto");
        assertTrue(p1.isAutoStripped(), "p1 auto stripped");
        assertFalse(p1.configFor(PermissionModes.Mode.AUTO).toolAllows().containsKey("bash"),
            "p1 AUTO bash allow stripped");
        p1.saveState();

        var p2 = new PermissionModes(tmpDir);
        p2.loadState();
        assertEquals(PermissionModes.Mode.AUTO, p2.currentMode(), "p2 loaded auto");

        p2.transitionPermissionMode("default");
        assertFalse(p2.isAutoStripped(), "p2 exit auto clears stripped");

        var autoCfg = p2.configFor(PermissionModes.Mode.AUTO);
        assertTrue(autoCfg.toolAllows().containsKey("bash"), "p2 AUTO bash allow restored after exit");
        assertFalse(autoCfg.toolDenys().containsKey("bash"), "p2 AUTO stripped deny removed after exit");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testAutoCrossProcessReenter() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-auto-cp-reenter");
    try {
        var p1 = new PermissionModes(tmpDir);
        p1.transitionPermissionMode("auto");
        p1.saveState();

        var p2 = new PermissionModes(tmpDir);
        p2.loadState();
        p2.transitionPermissionMode("default");
        p2.saveState();

        var p3 = new PermissionModes(tmpDir);
        p3.loadState();
        assertEquals(PermissionModes.Mode.DEFAULT, p3.currentMode(), "p3 loaded default after clean exit");

        p3.transitionPermissionMode("auto");
        assertTrue(p3.isAutoStripped(), "p3 re-enter auto strips");

        var r = p3.checkPermission("bash", null);
        assertFalse(r.allowed(), "p3 re-entered auto bash still blocked");
        assertFalse(p3.configFor(PermissionModes.Mode.AUTO).toolAllows().containsKey("bash"),
            "p3 re-entered auto bash allow stripped again");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testConcurrentSaveLoad() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-concurrent");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.transitionPermissionMode("plan");
        modes.saveState();

        var threads = new java.util.ArrayList<Thread>();
        var errors = new java.util.concurrent.atomic.AtomicInteger();
        for (int i = 0; i < 8; i++) {
            var t = new Thread(() -> {
                try {
                    for (int j = 0; j < 10; j++) {
                        var m = new PermissionModes(tmpDir);
                        m.loadState();
                        m.stateToJson();
                        m.saveState();
                    }
                } catch (Exception e) {
                    errors.incrementAndGet();
                }
            });
            t.start();
            threads.add(t);
        }
        for (var t : threads) t.join();
        assertEquals(0, errors.get(), "no concurrency errors");

        var reloaded = new PermissionModes(tmpDir);
        reloaded.loadState();
        assertEquals(PermissionModes.Mode.PLAN, reloaded.currentMode(), "mode survives concurrent saves");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testStaleAutoFlagClearedOnLoad() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-stale-flag");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.saveState();

        var stateFile = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json");
        var json = Files.readString(stateFile);
        json = json.replace("\"autoStripped\":false", "\"autoStripped\":true");
        Files.writeString(stateFile, json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertFalse(modes2.isAutoStripped(), "stale autoStripped cleared when not AUTO");
    } finally {
        deleteRecursive(tmpDir);
    }
}

// --- edge tools ---

void testUnknownToolAuto() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");

    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "auto — bash stripped");

    for (var label : List.of("mcp_tool", "custom_plugin", "unknown_widget")) {
        var r2 = modes.checkPermission(label, null);
        assertTrue(r2.allowed(), "auto — " + label + " auto-allowed");
    }
}

void testCaseVariantToolsAuto() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");

    for (var tool : List.of("Bash", "EDIT", "Write", "Task", "WebFetch", "Skill")) {
        var r = modes.checkPermission(tool, null);
        assertFalse(r.allowed(), "auto — " + tool + " stripped");
        assertTrue(r.promptUser(), "auto — " + tool + " prompts");
    }

    for (var tool : List.of("Read", "Glob", "Grep", "Question", "Todo")) {
        var r = modes.checkPermission(tool, null);
        assertTrue(r.allowed(), "auto — " + tool + " allowed");
    }
}

void testCaseVariantImmuneTools() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("Edit", ".git/config"), "Edit + .git/");
    assertTrue(modes.isBypassImmune("WRITE", ".claude/test.txt"), "WRITE + .claude/");
    assertTrue(modes.isBypassImmune("Bash", "rm .env"), "Bash + .env");
    assertTrue(modes.isBypassImmune("Task", ".git/hooks/pre-commit"), "Task + .git/");
    assertTrue(modes.isBypassImmune("Skill", ".env"), "Skill + .env");
    assertTrue(modes.isBypassImmune("WebFetch", ".ssh/config"), "WebFetch + .ssh/");
    assertFalse(modes.isBypassImmune("Read", ".git/config"), "Read non-write");
}

void testDontAskImmuneOrdering() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("dontAsk");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "dontAsk normal edit silent");
    assertFalse(r.promptUser(), "dontAsk no prompt");

    var r2 = modes.checkPermission("edit", ".git/config");
    assertTrue(r2.promptUser() || r2.reason().contains("BYPASS_IMMUNE"), "dontAsk immune prompts");
}

void testNormalizeToolName() {
    assertEquals("edit", PermissionModes.normalizeToolName("Edit"), "Edit → edit");
    assertEquals("bash", PermissionModes.normalizeToolName("BASH"), "BASH → bash");
    assertEquals("webfetch", PermissionModes.normalizeToolName("WebFetch"), "WebFetch → webfetch");
    assertEquals("", PermissionModes.normalizeToolName(null), "null → empty");
    assertEquals("", PermissionModes.normalizeToolName(""), "empty → empty");
    assertEquals("mcp_thing", PermissionModes.normalizeToolName("McP_ThInG"), "mixed case");
}

void testIsDangerousTool() {
    assertTrue(PermissionModes.isDangerousTool("bash"), "bash dangerous");
    assertTrue(PermissionModes.isDangerousTool("EDIT"), "EDIT dangerous");
    assertTrue(PermissionModes.isDangerousTool("write"), "write dangerous");
    assertTrue(PermissionModes.isDangerousTool("Task"), "Task dangerous");
    assertTrue(PermissionModes.isDangerousTool("webfetch"), "webfetch dangerous");
    assertTrue(PermissionModes.isDangerousTool("skill"), "skill dangerous");
    assertFalse(PermissionModes.isDangerousTool("read"), "read not");
    assertFalse(PermissionModes.isDangerousTool("glob"), "glob not");
    assertFalse(PermissionModes.isDangerousTool("grep"), "grep not");
    assertFalse(PermissionModes.isDangerousTool("question"), "question not");
    assertFalse(PermissionModes.isDangerousTool("todo"), "todo not");
    assertFalse(PermissionModes.isDangerousTool("mcp_tool"), "mcp_tool not");
    assertFalse(PermissionModes.isDangerousTool(null), "null not");
    assertFalse(PermissionModes.isDangerousTool(""), "empty not");
    assertFalse(PermissionModes.isDangerousTool("bash_stuff"), "bash_stuff not exact match");
}

void testIsInCwd() {
    var modes = new PermissionModes();
    assertTrue(modes.isInCwd("src/main.java"), "relative in cwd");
    assertTrue(modes.isInCwd("./src/main.java"), "./ in cwd");
    assertFalse(modes.isInCwd("../other/src/main.java"), ".. outside");
    assertFalse(modes.isInCwd(null), "null not");
    assertFalse(modes.isInCwd(""), "blank not");

    var absoluteIn = Path.of("").toAbsolutePath().resolve("src/main.java").toString();
    assertTrue(modes.isInCwd(absoluteIn), "absolute in cwd");
}

void testIsInCwdAbsoluteOutside() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cwd");
    try {
        var modes = new PermissionModes(tmpDir, tmpDir.resolve("sub"));
        assertFalse(modes.isInCwd("/etc/passwd"), "absolute /etc not in cwd");
        assertTrue(modes.isInCwd("file.txt"), "relative still in cwd");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testIsInCwdCustomBase() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cwd-base");
    try {
        var subDir = tmpDir.resolve("sub");
        Files.createDirectories(subDir);
        var innerFile = subDir.resolve("inner.txt");
        Files.writeString(innerFile, "x");

        var modes = new PermissionModes(tmpDir, subDir);
        assertTrue(modes.isInCwd(innerFile.toString()), "absolute file in sub is in cwd");
        assertTrue(modes.isInCwd("inner.txt"), "relative is in cwd");

        var outsideFile = tmpDir.resolve("outside.txt");
        Files.writeString(outsideFile, "x");
        assertFalse(modes.isInCwd(outsideFile.toString()), "absolute file in parent not in cwd");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testRestorePreservesBypassImmune() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-restore-immune");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.addToolDeny(PermissionModes.Mode.AUTO, "bash", "custom block", true);
        modes.transitionPermissionMode("auto");

        var deny = modes.configFor(PermissionModes.Mode.AUTO).toolDenys().get("bash");
        assertTrue(deny.bypassImmune(), "custom deny immune before auto");

        modes.transitionPermissionMode("default");
        modes.transitionPermissionMode("auto");

        deny = modes.configFor(PermissionModes.Mode.AUTO).toolDenys().get("bash");
        assertTrue(deny.bypassImmune(), "custom deny immune after roundtrip");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testBypassImmunePathNormalization() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("edit", ".git/config"), "normal .git/config");
    assertTrue(modes.isBypassImmune("edit", "./.git/config"), "./.git/config normalizes");
    assertTrue(modes.isBypassImmune("edit", "src/../.git/config"), "traversal normalizes into .git/");
    assertTrue(modes.isBypassImmune("edit", ".git/./config"), "dot segment in .git/");
    assertFalse(modes.isBypassImmune("edit", ".git/../notgit/config"), ".. exits .git/");
}

void testCorruptedStateHandling() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-corrupted");
    try {
        var modes = new PermissionModes(tmpDir);
        modes.saveState();

        var stateFile = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json");
        var json = Files.readString(stateFile);
        json = json.replace("\"currentMode\":\"default\"", "\"currentMode\":\"bogus\"");
        Files.writeString(stateFile, json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.DEFAULT, modes2.currentMode(), "corrupted mode falls back to DEFAULT");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCorruptedConfigsUnknownMode() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-unknown-cfg");
    try {
        var modes = new PermissionModes(tmpDir);
        var json = modes.stateToJson();
        json = json.replace("\"plan\":", "\"zombie\":");
        Files.createDirectories(tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes"));
        Files.writeString(tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json"), json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.DEFAULT, modes2.currentMode(), "unknown config mode skipped, default preserved");
        assertNotNull(modes2.configFor(PermissionModes.Mode.PLAN), "original plan config still present");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testBypassImmunePatternsGetter() {
    var modes = new PermissionModes();
    var patterns = modes.bypassImmunePatterns();
    assertTrue(patterns.contains(".git/"), "contains .git/");
    assertTrue(patterns.contains(".opencode/"), "contains .opencode/");
    assertTrue(patterns.contains("claude.md"), "contains claude.md");
    assertTrue(patterns.contains("agents.md"), "contains agents.md");
    assertTrue(patterns.contains(".env"), "contains .env");
    assertTrue(patterns.contains(".env."), "contains .env.");
    assertTrue(patterns.contains(".env/"), "contains .env/");
    assertTrue(patterns.size() == 18, "18 patterns total");

    assertDoesNotThrow(() -> patterns.add("hack"), "should not be able to modify returned set", true);
}

// --- CLI ---

void testCliCheck() throws Exception {
    var cli = new PermissionModesCli();
    assertDoesNotThrow(() -> cli.main(new String[]{"check", "/tmp", "read", "src/main.java"}), "cli check read");
    assertDoesNotThrow(() -> cli.main(new String[]{"check", "/tmp", "bash", "echo 100%"}), "cli check with percent");
}

void testCliTransition() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-trans");
    try {
        var cli = new PermissionModesCli();
        cli.main(new String[]{"transition", tmpDir.toString(), "plan"});
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCliStatus() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-status");
    try {
        var cli = new PermissionModesCli();
        assertDoesNotThrow(() -> cli.main(new String[]{"status", tmpDir.toString()}), "cli status");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCliState() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-state");
    try {
        var cli = new PermissionModesCli();
        assertDoesNotThrow(() -> cli.main(new String[]{"state", tmpDir.toString()}), "cli state");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCliSaveLoad() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-save");
    try {
        var cli1 = new PermissionModesCli();
        cli1.main(new String[]{"transition", tmpDir.toString(), "dontAsk"});

        var cli2 = new PermissionModesCli();
        assertDoesNotThrow(() -> cli2.main(new String[]{"status", tmpDir.toString()}), "cli save/load roundtrip");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCliImmune() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-immune");
    try {
        var cli = new PermissionModesCli();
        assertDoesNotThrow(() -> cli.main(new String[]{"immune", tmpDir.toString(), "edit", ".git/config"}), "cli immune");
        assertDoesNotThrow(() -> cli.main(new String[]{"immune", tmpDir.toString(), "read", ".git/config"}), "cli immune read");
    } finally {
        deleteRecursive(tmpDir);
    }
}

void testCliInvalidMode() throws Exception {
    var tmpDir = Files.createTempDirectory("permission-cli-inv");
    try {
        var cli = new PermissionModesCli();
        assertDoesNotThrow(() -> cli.main(new String[]{"transition", tmpDir.toString(), "bogus"}), "cli invalid mode no crash");
    } finally {
        deleteRecursive(tmpDir);
    }
}

// --- utility ---

void assertDoesNotThrow(Runnable r, String message) {
    assertDoesNotThrow(r, message, false);
}

void assertDoesNotThrow(Runnable r, String message, boolean expectThrow) {
    try {
        r.run();
        if (expectThrow) throw new AssertionError("FAIL: " + message + " — expected exception but none thrown");
    } catch (AssertionError e) {
        throw e;
    } catch (Exception e) {
        if (!expectThrow) throw new AssertionError("FAIL: " + message + " — threw " + e.getMessage());
    }
}

static void deleteRecursive(Path p) throws Exception {
    if (Files.isDirectory(p)) {
        try (var s = Files.list(p)) {
            s.forEach(x -> { try { deleteRecursive(x); } catch (Exception ex) {} });
        }
    }
    Files.deleteIfExists(p);
}
