package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Tests for shell write-target detection and the Maintain->Plan loop. Runnable via `java <class>`. */
public final class ShellAndLoopTest {
    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) throws Exception {
        testRedirectionDetected();
        testCopyDestDetected();
        testRmDetected();
        testSedInPlaceDetected();
        testSafeCommandNoTargets();
        testGlobAndVarSkipped();
        testR6VerificationGate();
        testIncidentWritesLoop();
        System.out.println("ShellAndLoopTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    private static void testRedirectionDetected() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-redir");
        List<Path> targets = ShellCommandAnalyzer.writeTargets("echo hi > out.txt", root);
        check("redirect-target", targets.stream().anyMatch(t -> t.toString().endsWith("out.txt")));
        List<Path> append = ShellCommandAnalyzer.writeTargets("cat x >> log.txt", root);
        check("append-target", append.stream().anyMatch(t -> t.toString().endsWith("log.txt")));
    }

    private static void testCopyDestDetected() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-cp");
        List<Path> targets = ShellCommandAnalyzer.writeTargets("cp src.txt dest.txt", root);
        // destination is last operand
        check("copy-dest", targets.stream().anyMatch(t -> t.toString().endsWith("dest.txt")));
    }

    private static void testRmDetected() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-rm");
        List<Path> targets = ShellCommandAnalyzer.writeTargets("rm -f generated/x.gen.go", root);
        check("rm-target", targets.stream().anyMatch(t -> t.toString().endsWith("generated/x.gen.go")));
    }

    private static void testSedInPlaceDetected() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-sed");
        List<Path> targets = ShellCommandAnalyzer.writeTargets("sed -i 's/a/b/' file.txt", root);
        check("sed-i-target", targets.stream().anyMatch(t -> t.toString().endsWith("file.txt")));
    }

    private static void testSafeCommandNoTargets() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-safe");
        List<Path> targets = ShellCommandAnalyzer.writeTargets("git status && ls -la", root);
        check("safe-command-no-targets", targets.isEmpty());
    }

    private static void testGlobAndVarSkipped() throws Exception {
        Path root = Path.of("/tmp/sdlc-shell-glob");
        List<Path> glob = ShellCommandAnalyzer.writeTargets("rm -rf build/*", root);
        check("glob-skipped", glob.isEmpty());
        List<Path> var = ShellCommandAnalyzer.writeTargets("cp a.txt $DEST", root);
        check("var-skipped", var.isEmpty());
    }

    private static void testR6VerificationGate() throws Exception {
        Path root = Files.createTempDirectory("sdlc-r6");
        Files.createDirectories(root.resolve(".sdlc-guardrails"));
        // requireVerification on, evidence path default
        Files.writeString(root.resolve(".sdlc-guardrails/config.json"),
            "{\"enabled\":true,\"requireVerification\":true}");
        ContractConfig cfg = ContractConfig.load(root);
        DiffGuard guard = new DiffGuard(cfg, root, PlanTracker.of(null));

        // no evidence -> block
        check("r6-no-evidence-blocks", guard.checkVerificationEvidence().isBlock());

        // stale evidence -> block
        Path evidence = root.resolve("tmp/eval-loop-score.md");
        Files.createDirectories(evidence.getParent());
        Files.writeString(evidence, "1, round1, pass\n2, round1, pass\n");
        // backdate it
        Files.setLastModifiedTime(evidence, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() - 60 * 60 * 1000));
        check("r6-stale-blocks", guard.checkVerificationEvidence().isBlock());

        // fresh red evidence -> block
        Files.setLastModifiedTime(evidence, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis()));
        Files.writeString(evidence, "3, compile, pass\n4, test, fail\n");
        check("r6-red-blocks", guard.checkVerificationEvidence().isBlock());

        // fresh green evidence -> pass
        Files.writeString(evidence, "5, compile, pass\n6, test, pass\n");
        check("r6-green-passes", !guard.checkVerificationEvidence().isBlock());

        // requireVerification off -> pass regardless
        Files.writeString(root.resolve(".sdlc-guardrails/config.json"),
            "{\"enabled\":true,\"requireVerification\":false}");
        DiffGuard guard2 = new DiffGuard(ContractConfig.load(root), root, PlanTracker.of(null));
        check("r6-disabled-passes", !guard2.checkVerificationEvidence().isBlock());
    }

    private static void testIncidentWritesLoop() throws Exception {
        Path root = Files.createTempDirectory("sdlc-incident");
        // exercise the CLI incident path by directly constructing the files (CLI tested elsewhere);
        // here verify the plan-tracker can read a plan and DiffGuard command-gating uses the analyzer.
        Path planFile = root.resolve("plan.md");
        Files.writeString(planFile, "## Files that change\n- src/App.java\n");
        PlanTracker plan = PlanTracker.of(planFile);
        check("plan-parses", plan.isPlanRelevant());

        Files.createDirectories(root.resolve(".sdlc-guardrails"));
        Files.writeString(root.resolve(".sdlc-guardrails/config.json"),
            "{\"enabled\":true,\"protectedPaths\":[\"**/*.gen.go\"],\"testPaths\":[\"**/test/**\"]}");
        ContractConfig cfg = ContractConfig.load(root);
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        // a bash rm of a protected file must block via command gating
        DiffGuard.Verdict v = guard.checkCommand("rm -f schemas/out.gen.go", false);
        check("bash-rm-protected-blocks", v.isBlock() && "R2".equals(v.rule()));

        // bash touching a test file in fix scope blocks
        DiffGuard.Verdict t = guard.checkCommand("sed -i 's/x/y/' src/test/FooTest.java", true);
        check("bash-test-fix-blocks", t.isBlock() && "R3".equals(t.rule()));

        // bash on a safe file passes
        DiffGuard.Verdict s = guard.checkCommand("cat src/App.java", false);
        check("bash-safe-passes", !s.isBlock());
    }

    private static void check(String name, boolean ok) {
        if (ok) passed++;
        else { failed++; System.out.println("  FAIL: " + name); }
    }
}
