package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Path;
import java.util.List;

/**
 * Core enforcement. Produces a {@link Verdict} for a tool call against the repo
 * contract. Fail-safe: any ambiguity resolves to {@code pass}.
 */
public final class DiffGuard {

    /** Outcome of a guardrail check. */
    public record Verdict(String verdict, String rule, String reason) {
        public static Verdict pass() {
            return new Verdict("pass", null, null);
        }
        public static Verdict block(String rule, String reason) {
            return new Verdict("block", rule, reason);
        }
        public static Verdict warn(String rule, String reason) {
            return new Verdict("warn", rule, reason);
        }
        public boolean isBlock() {
            return "block".equals(verdict);
        }
        public boolean isWarn() {
            return "warn".equals(verdict);
        }
    }

    private final ContractConfig config;
    private final Path root;
    private final PlanTracker plan;

    public DiffGuard(ContractConfig config, Path root, PlanTracker plan) {
        this.config = config;
        this.root = root;
        this.plan = plan;
    }

    /**
     * Check an edit/write target. {@code fixScope} marks a session working on a fix
     * (enables test-protection R3). Never throws.
     */
    public Verdict checkWrite(Path target, boolean fixScope) {
        if (target == null) return Verdict.pass();
        if (!config.enabled) return Verdict.pass();

        // R2 — protected path (hard block)
        if (PathUtil.matchesAny(root, target, config.protectedPaths)) {
            return Verdict.block("R2", "protected path: " + rel(target));
        }

        // R3 — test protection during a fix (hard block unless adding coverage)
        if (fixScope && isTestPath(target)) {
            return Verdict.block("R3", "test file edited in fix scope without adding coverage: " + rel(target));
        }

        return Verdict.pass();
    }

    /**
     * R1 advisory: does the plan declare this path? WARN when a plan exists and the
     * edit is outside it. Not a block — legitimate changes touch more files.
     */
    public Verdict checkPlanSync(Path target) {
        if (!config.enabled || !config.requirePlan) return Verdict.pass();
        if (plan == null || !plan.parseOk() || !plan.isPlanRelevant()) return Verdict.pass();
        // plan.md itself, artifacts, and config are always allowed
        if (isArtifact(target)) return Verdict.pass();
        if (plan.declares(root, target)) return Verdict.pass();
        return Verdict.warn("R1", "edit outside declared plan scope: " + rel(target));
    }

    /**
     * Check a shell command for write targets against the contract (R2/R3). Returns
     * the worst verdict across all detected write targets. If none are detected, passes.
     */
    public Verdict checkCommand(String command, boolean fixScope) {
        if (!config.enabled) return Verdict.pass();
        List<Path> targets = ShellCommandAnalyzer.writeTargets(command, root);
        Verdict worst = Verdict.pass();
        for (Path t : targets) {
            Verdict v = checkWrite(t, fixScope);
            if (v.isBlock()) return v; // hard block dominates
            if (v.isWarn()) worst = v;
        }
        return worst;
    }

    /**
     * R6 — verification-before-done gate. When {@code requireVerification} is on,
     * a commit is blocked unless fresh, all-green verification evidence exists.
     * Evidence is the eval-loop score snapshot ({@code round, gate, pass/fail}).
     * Fail-safe: missing/stale/unparseable evidence => block (this is the one rule
     * that intentionally fails closed, because its whole point is to refuse
     * unverified "done" claims).
     */
    public Verdict checkVerificationEvidence() {
        if (!config.enabled || !config.requireVerification) return Verdict.pass();
        Path evidence = root.resolve(config.verifyEvidenceRel);
        if (!java.nio.file.Files.isRegularFile(evidence)) {
            return Verdict.block("R6", "no verification evidence at " + config.verifyEvidenceRel);
        }
        try {
            long mtime = java.nio.file.Files.getLastModifiedTime(evidence).toMillis();
            long now = System.currentTimeMillis();
            if (now - mtime > config.verifyFreshnessMs) {
                return Verdict.block("R6", "verification evidence is stale (>" + (config.verifyFreshnessMs / 60000) + " min)");
            }
            boolean green = isGreenEvidence(evidence);
            if (!green) {
                return Verdict.block("R6", "verification evidence exists but is not all-green");
            }
            return Verdict.pass();
        } catch (Exception e) {
            return Verdict.block("R6", "cannot read verification evidence: " + e.getMessage());
        }
    }

    private static boolean isGreenEvidence(Path evidence) throws java.io.IOException {
        // eval-loop score format: one line per gate result per round:
        //   "round, gate, pass|fail, elapsed"
        // A fresh all-green snapshot has its last line ending in "pass".
        java.util.List<String> lines = java.nio.file.Files.readAllLines(evidence);
        String last = null;
        for (String l : lines) {
            if (!l.isBlank()) last = l;
        }
        if (last == null) return false;
        String[] parts = last.split(",");
        for (int i = parts.length - 1; i >= 0; i--) {
            String tok = parts[i].trim().toLowerCase();
            if (tok.equals("pass")) return true;
            if (tok.equals("fail")) return false;
            // ignore round/gate labels; keep scanning backwards for the verdict
        }
        return false;
    }

    private boolean isTestPath(Path target) {
        return PathUtil.matchesAny(root, target, config.testPaths);
    }

    private boolean isArtifact(Path target) {
        String name = target.getFileName().toString();
        return name.equals(config.planArtifact)
            || name.equals(config.specArtifact)
            || name.equals(config.intentArtifact);
    }

    private String rel(Path target) {
        String r = PathUtil.toRelative(root, target);
        return r == null ? target.toString() : r;
    }
}
