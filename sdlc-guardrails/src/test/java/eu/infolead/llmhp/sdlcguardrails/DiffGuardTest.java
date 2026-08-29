package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Files;
import java.nio.file.Path;

/** Tests for DiffGuard enforcement rules. Runnable via `java <class>` (no JUnit). */
public final class DiffGuardTest {
    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) throws Exception {
        testProtectedPathBlock();
        testTestProtectionInFixScope();
        testTestEditAllowedOutsideFix();
        testPlanSyncWarn();
        testPlanSyncAllowsDeclared();
        testDisabledContractPasses();
        testFailSafeOnMissingRoot();
        System.out.println("DiffGuardTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    private static void testProtectedPathBlock() throws Exception {
        Path root = Files.createTempDirectory("sdlc-root");
        Path gen = root.resolve("schemas/out.gen.go");
        Files.createDirectories(gen.getParent());
        Files.writeString(gen, "x");

        // config enables contract with a protected path
        Files.createDirectories(root.resolve(".sdlc-guardrails"));
        Files.writeString(root.resolve(".sdlc-guardrails/config.json"),
            "{\"enabled\":true,\"protectedPaths\":[\"**/*.gen.go\"]}");

        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(null);
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        DiffGuard.Verdict v = guard.checkWrite(gen, false);
        check("protected-path-block", v.isBlock() && "R2".equals(v.rule()));

        // non-protected path passes
        Path normal = root.resolve("src/App.java");
        Files.createDirectories(normal.getParent());
        check("normal-path-passes", !guard.checkWrite(normal, false).isBlock());
    }

    private static void testTestProtectionInFixScope() throws Exception {
        Path root = Files.createTempDirectory("sdlc-root");
        Files.createDirectories(root.resolve(".sdlc-guardrails"));
        Files.writeString(root.resolve(".sdlc-guardrails/config.json"),
            "{\"enabled\":true,\"testPaths\":[\"**/test/**\"]}");
        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(null);
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        Path test = root.resolve("src/test/FooTest.java");
        Files.createDirectories(test.getParent());
        check("test-blocked-in-fix", guard.checkWrite(test, true).isBlock());
        check("test-allowed-outside-fix", !guard.checkWrite(test, false).isBlock());
    }

    private static void testTestEditAllowedOutsideFix() throws Exception {
        testTestProtectionInFixScope();
    }

    private static void testPlanSyncWarn() throws Exception {
        Path root = Files.createTempDirectory("sdlc-root");
        Files.createDirectories(root.resolve(".sdlc-guardrails"));
        // a plan.md opts plan-sync in even without explicit config
        Files.writeString(root.resolve("plan.md"),
            "## Files that change\n- src/App.java\n\n## Proof\n- tests pass");
        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(root.resolve("plan.md"));
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        // outside plan -> warn (not block)
        Path other = root.resolve("src/Other.java");
        Files.createDirectories(other.getParent());
        check("out-of-plan-warns", guard.checkPlanSync(other).isWarn());
        // declared -> pass
        Path app = root.resolve("src/App.java");
        check("declared-passes", !guard.checkPlanSync(app).isWarn());
    }

    private static void testPlanSyncAllowsDeclared() throws Exception {
        testPlanSyncWarn();
    }

    private static void testDisabledContractPasses() throws Exception {
        Path root = Files.createTempDirectory("sdlc-root");
        // no config, no plan.md -> disabled
        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(null);
        DiffGuard guard = new DiffGuard(cfg, root, plan);
        Path any = root.resolve("anything.go");
        check("disabled-passes", !guard.checkWrite(any, true).isBlock());
        check("disabled-plan-pass", !guard.checkPlanSync(any).isWarn());
    }

    private static void testFailSafeOnMissingRoot() throws Exception {
        Path root = Files.createTempDirectory("sdlc-root");
        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(null);
        DiffGuard guard = new DiffGuard(cfg, root, plan);
        // null target -> pass
        check("null-target-passes", !guard.checkWrite(null, true).isBlock());
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            passed++;
        } else {
            failed++;
            System.out.println("  FAIL: " + name);
        }
    }
}
