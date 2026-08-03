import module java.base;

import eu.infolead.llmhp.permissionmodes.PermissionModes;
import eu.infolead.llmhp.permissionmodes.PermissionModesCli;

void main() throws Exception {
    testDefaultModePrompts();
    testPlanModeBlocks();
    testAcceptEditsInCwd();
    testAcceptEditsOutside();
    testBypassPermissions();
    testDontAskSilentBlock();
    testAutoMode();
    testAutoStrippedPersists();
    testAutoStrippedOnLoad();
    testModeTransitions();
    testBypassImmune();
    testBypassImmuneCaseInsensitive();
    testTransitionToAutoStripsDangerous();
    testTransitionFromAutoRestores();
    testCustomAllowDeny();
    testCustomCategoryBlock();
    testJsonRoundtrip();
    testConfigsRoundtrip();
    testPersistenceSaveLoad();
    testCliCommands();
    testBypassImmuneDetection();
    testBypassImmuneNonTrigger();
    testUnknownToolAuto();
    testDontAskImmuneOrdering();

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

// --- mode behaviour tests ---

void testDefaultModePrompts() {
    var modes = new PermissionModes();
    assertEquals(PermissionModes.Mode.DEFAULT, modes.currentMode(), "start in default");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "default mode — should not auto-allow");
    assertTrue(r.promptUser(), "default mode — should prompt user");

    var r2 = modes.checkPermission("read", "src/main.java");
    assertFalse(r2.allowed(), "default mode — read should prompt");
    assertTrue(r2.promptUser(), "default mode — read prompt");
}

void testPlanModeBlocks() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");
    assertEquals(PermissionModes.Mode.PLAN, modes.currentMode(), "transition to plan");

    var r = modes.checkPermission("read", "src/main.java");
    assertTrue(r.allowed(), "plan mode — read allowed");

    var r2 = modes.checkPermission("glob", null);
    assertTrue(r2.allowed(), "plan mode — glob allowed");

    var r3 = modes.checkPermission("edit", "src/main.java");
    assertFalse(r3.allowed(), "plan mode — edit blocked");
    assertFalse(r3.promptUser(), "plan mode — edit silent block");

    var r4 = modes.checkPermission("bash", null);
    assertFalse(r4.allowed(), "plan mode — bash blocked");

    var r5 = modes.checkPermission("write", "src/main.java");
    assertFalse(r5.allowed(), "plan mode — write blocked");
}

void testAcceptEditsInCwd() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("edit", "src/main.java");
    assertTrue(r.allowed(), "acceptEdits — edit in CWD auto-approve");
    assertFalse(r.promptUser(), "acceptEdits — no prompt for cwd edit");
}

void testAcceptEditsOutside() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("acceptEdits");

    var r = modes.checkPermission("edit", "../other/src/main.java");
    assertFalse(r.allowed(), "acceptEdits — edit outside CWD should prompt");
    assertTrue(r.promptUser(), "acceptEdits — prompt for out-of-cwd edit");

    var r2 = modes.checkPermission("bash", null);
    assertFalse(r2.allowed(), "acceptEdits — bash should prompt");
    assertTrue(r2.promptUser(), "acceptEdits — bash prompt");
}

void testBypassPermissions() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var r = modes.checkPermission("edit", "src/main.java");
    assertTrue(r.allowed(), "bypassPermissions — edit auto-allowed");
    assertFalse(r.promptUser(), "bypassPermissions — no prompt");

    var r2 = modes.checkPermission("bash", null);
    assertTrue(r2.allowed(), "bypassPermissions — bash auto-allowed");

    var r3 = modes.checkPermission("webfetch", null);
    assertTrue(r3.allowed(), "bypassPermissions — webfetch auto-allowed");
}

void testDontAskSilentBlock() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("dontAsk");

    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "dontAsk — edit silent block");
    assertFalse(r.promptUser(), "dontAsk — no prompt on block");

    var r2 = modes.checkPermission("read", "src/main.java");
    assertFalse(r2.allowed(), "dontAsk — read also blocked");
    assertFalse(r2.promptUser(), "dontAsk — read silent block");
}

void testAutoMode() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto — should be stripped");

    // Dangerous tools stripped after transition
    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "auto — edit stripped (dangerous)");
    assertTrue(r.promptUser(), "auto — stripped tools prompt");

    var r2 = modes.checkPermission("bash", null);
    assertFalse(r2.allowed(), "auto — bash stripped (dangerous)");
    assertTrue(r2.promptUser(), "auto — stripped tools prompt");

    // Non-dangerous tools still auto-allowed
    var r3 = modes.checkPermission("read", "src/main.java");
    assertTrue(r3.allowed(), "auto — read auto-allowed");

    var r4 = modes.checkPermission("glob", null);
    assertTrue(r4.allowed(), "auto — glob auto-allowed");
}

void testAutoStrippedPersists() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto — stripped flag set");

    // exit and re-enter auto
    modes.transitionPermissionMode("default");
    assertFalse(modes.isAutoStripped(), "default — stripped flag cleared");

    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "re-entered auto — stripped again");
}

void testAutoStrippedOnLoad() throws Exception {
    // Simulate persisted AUTO state being loaded
    var tmpDir = Files.createTempDirectory("permission-auto-load");
    try {
        var modes1 = new PermissionModes(tmpDir);
        modes1.transitionPermissionMode("auto");
        modes1.saveState();

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.AUTO, modes2.currentMode(), "loaded auto mode");
        assertTrue(modes2.isAutoStripped(), "loaded auto — strip should be re-applied");

        var r = modes2.checkPermission("bash", null);
        assertFalse(r.allowed(), "loaded auto — bash still stripped");
    } finally {
        deleteRecursive(tmpDir);
    }
}

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
    assertTrue(r4.allowed(), "BYPASS_IMMUNE — read is not write-tool, passes through");
}

void testBypassImmuneCaseInsensitive() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    // CLAUDE.md should match claude.md
    var r = modes.checkPermission("edit", "claude.md");
    assertFalse(r.allowed(), "BYPASS_IMMUNE — claude.md (lowercase) matches CLAUDE.md pattern");
    assertTrue(r.reason().contains("BYPASS_IMMUNE"), "reason contains BYPASS_IMMUNE");
}

void testBypassImmuneDetection() {
    var modes = new PermissionModes();
    assertTrue(modes.isBypassImmune("edit", ".git/config"), "edit .git/ = immune");
    assertTrue(modes.isBypassImmune("write", ".claude/test.txt"), "write .claude/ = immune");
    assertTrue(modes.isBypassImmune("bash", "rm .env.local"), "bash .env = immune");
    assertTrue(modes.isBypassImmune("task", ".git/hooks/pre-commit"), "task .git/ = immune");
}

void testBypassImmuneNonTrigger() {
    var modes = new PermissionModes();
    assertFalse(modes.isBypassImmune("read", ".git/config"), "read is non-write");
    assertFalse(modes.isBypassImmune("glob", ".git/"), "glob is non-write");
    assertFalse(modes.isBypassImmune("webfetch", null), "null path");
    assertFalse(modes.isBypassImmune("edit", ""), "blank path");
    assertFalse(modes.isBypassImmune("edit", "src/main.java"), "normal file");
}

// --- auto-mode strip/restore ---

void testTransitionToAutoStripsDangerous() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");
    modes.transitionPermissionMode("auto");

    assertTrue(modes.isAutoStripped(), "auto — stripped flag set");

    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "auto — bash stripped");

    var r2 = modes.checkPermission("edit", null);
    assertFalse(r2.allowed(), "auto — edit stripped");

    var r3 = modes.checkPermission("webfetch", null);
    assertFalse(r3.allowed(), "auto — webfetch stripped");

    var r4 = modes.checkPermission("task", null);
    assertFalse(r4.allowed(), "auto — task stripped");

    var r5 = modes.checkPermission("skill", null);
    assertFalse(r5.allowed(), "auto — skill stripped");
}

void testTransitionFromAutoRestores() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("bypassPermissions");

    var bpCfg = modes.configFor(PermissionModes.Mode.BYPASS_PERMISSIONS);
    assertTrue(bpCfg.toolAllows().containsKey("bash"),
        "bypass mode — bash allow present before auto");

    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "auto stripped");

    modes.transitionPermissionMode("default");
    assertFalse(modes.isAutoStripped(), "default not stripped");

    // Bypass mode allows should survive roundtrip
    assertTrue(bpCfg.toolAllows().containsKey("bash"),
        "bypass mode — bash allow still present after roundtrip");

    // Re-entering auto should strip again
    modes.transitionPermissionMode("auto");
    assertTrue(modes.isAutoStripped(), "re-entered auto stripped");
    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "re-entered auto — bash still stripped");
}

// --- custom config ---

void testCustomAllowDeny() {
    var modes = new PermissionModes();
    modes.addToolAllow(PermissionModes.Mode.DEFAULT, "bash", "trusted pattern");
    modes.addToolDeny(PermissionModes.Mode.DEFAULT, "webfetch", "no-network policy", false);

    var r = modes.checkPermission("bash", null);
    assertTrue(r.allowed(), "custom allow — bash auto-allowed in default");
    assertFalse(r.promptUser(), "custom allow — no prompt");

    var r2 = modes.checkPermission("webfetch", null);
    assertFalse(r2.allowed(), "custom deny — webfetch blocked");
    assertFalse(r2.promptUser(), "custom deny — no prompt");

    var r3 = modes.checkPermission("edit", "src/main.java");
    assertFalse(r3.allowed(), "still default for edit");
    assertTrue(r3.promptUser(), "edit still prompts");
}

void testCustomCategoryBlock() {
    var modes = new PermissionModes();
    modes.addCategoryBlock(PermissionModes.Mode.ACCEPT_EDITS, PermissionModes.ToolCategory.BASH);

    modes.transitionPermissionMode("acceptEdits");
    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "custom category block — bash blocked in acceptEdits");
    assertFalse(r.promptUser(), "custom category block — silent");
}

// --- serialization ---

void testJsonRoundtrip() throws Exception {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("plan");
    var json = modes.stateToJson();

    assertTrue(json.contains("plan"), "json contains current mode");
    assertTrue(json.contains("bypassImmune"), "json contains bypassImmune key");
    assertTrue(json.contains(".git/"), "json contains default bypass-immune pattern");

    var tmpDir = Files.createTempDirectory("permission-json-test");
    try {
        var tmpFile = tmpDir.resolve("tmp").resolve("sessions").resolve(".permission-modes").resolve("state.json");
        Files.createDirectories(tmpFile.getParent());
        Files.writeString(tmpFile, json);

        var modes2 = new PermissionModes(tmpDir);
        modes2.loadState();
        assertEquals(PermissionModes.Mode.PLAN, modes2.currentMode(), "roundtrip: plan mode survived");
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

        // Verify custom deny persisted
        modes2.transitionPermissionMode("default");
        var r = modes2.checkPermission("webfetch", null);
        assertFalse(r.allowed(), "loaded custom deny — webfetch blocked");

        // Verify custom allow persisted
        var r2 = modes2.checkPermission("bash", null);
        assertTrue(r2.allowed(), "loaded custom allow — bash allowed");

        // Verify category block persisted
        modes2.transitionPermissionMode("acceptEdits");
        var r3 = modes2.checkPermission("bash", null);
        assertFalse(r3.allowed(), "loaded category block — bash blocked in acceptEdits");
    } finally {
        deleteRecursive(tmpDir);
    }
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
        assertEquals(PermissionModes.Mode.BYPASS_PERMISSIONS, modes2.currentMode(),
            "persisted mode restored");
    } finally {
        deleteRecursive(tmpDir);
    }
}

// --- edge cases ---

void testUnknownToolAuto() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("auto");

    // Known dangerous tools stripped
    var r = modes.checkPermission("bash", null);
    assertFalse(r.allowed(), "auto — bash stripped");

    // Unknown/non-standard tools fall through to auto-allow
    var r2 = modes.checkPermission("mcp_tool", null);
    assertTrue(r2.allowed(), "auto — unknown tool auto-allowed");

    var r3 = modes.checkPermission("custom_plugin", null);
    assertTrue(r3.allowed(), "auto — custom tool auto-allowed");
}

void testDontAskImmuneOrdering() {
    var modes = new PermissionModes();
    modes.transitionPermissionMode("dontAsk");

    // Normal file: silent block
    var r = modes.checkPermission("edit", "src/main.java");
    assertFalse(r.allowed(), "dontAsk — normal edit silent block");
    assertFalse(r.promptUser(), "dontAsk — no prompt");

    // Immune path: DONT_ASK still prompts for immune-protected paths
    var r2 = modes.checkPermission("edit", ".git/config");
    assertTrue(r2.promptUser() || r2.reason().contains("BYPASS_IMMUNE"),
        "dontAsk — immune paths still surface via BYPASS_IMMUNE");
}

// --- CLI roundtrip ---

void testCliCommands() throws Exception {
    // Verify no crash on basic commands (smoke test)
    // Output validity verified by JSON roundtrip tests above
    var cli = new PermissionModesCli();
    assertDoesNotThrow(() -> {
        cli.main(new String[]{"check", "/tmp", "read", "src/main.java"});
    }, "cli check");
}

// --- utility ---

void assertDoesNotThrow(Runnable r, String message) {
    try {
        r.run();
    } catch (Exception e) {
        throw new AssertionError("FAIL: " + message + " — threw " + e.getMessage());
    }
}

static void deleteRecursive(Path p) throws Exception {
    if (Files.isDirectory(p)) {
        try (var s = Files.list(p)) {
            s.forEach(x -> { try { deleteRecursive(x); } catch (Exception e) {} });
        }
    }
    Files.deleteIfExists(p);
}
