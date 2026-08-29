package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * CLI entry point. Invoked by the opencode TS shim (fresh JVM per call, matching
 * repo convention). Emits JSON to stdout.
 *
 * <pre>
 *   sdlc-guardrails check <root> <tool> <path> <fixScope|-> [session]
 *   sdlc-guardrails diff  <root> <base> <head>
 *   sdlc-guardrails artifact <root> <kind> <path>
 *   sdlc-guardrails status <root>
 *   sdlc-guardrails audit <root> [limit]
 * </pre>
 */
public final class SdlcGuardrailsCli {
    public static void main(String[] args) {
        try {
            if (args.length == 0) {
                System.out.println("{\"error\":\"missing command\"}");
                System.exit(2);
            }
            switch (args[0]) {
                case "check" -> check(args);
                case "check-cmd" -> checkCmd(args);
                case "diff" -> diff(args);
                case "sync" -> sync(args);
                case "verify" -> verify(args);
                case "incident" -> incident(args);
                case "artifact" -> artifact(args);
                case "status" -> status(args);
                case "audit" -> audit(args);
                default -> {
                    System.out.println("{\"error\":\"unknown command: " + args[0] + "\"}");
                    System.exit(2);
                }
            }
        } catch (Exception e) {
            // fail-safe: never throw out of a guardrail CLI
            System.out.println("{\"verdict\":\"pass\",\"rule\":null,\"reason\":\"guardrail error: "
                + e.getMessage() + "\"}");
            System.exit(0);
        }
    }

    private static void check(String[] args) {
        if (args.length < 4) {
            System.out.println("{\"verdict\":\"pass\",\"rule\":null,\"reason\":\"usage: check <root> <tool> <path> <fixScope>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        String tool = args[2];
        String path = args[3];
        boolean fixScope = args.length > 4 && "true".equalsIgnoreCase(args[4]);
        String session = args.length > 5 ? args[5] : "";

        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(ArtifactDetector.find(root, cfg.planArtifact));
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        DiffGuard.Verdict verdict;
        Path target = toPath(root, path);
        if (target == null) {
            verdict = DiffGuard.Verdict.pass();
        } else if (tool.equals("bash")) {
            // bash: the `path` argument is the command string; gate its write targets.
            verdict = guard.checkCommand(path, fixScope);
        } else {
            DiffGuard.Verdict write = guard.checkWrite(target, fixScope);
            DiffGuard.Verdict sync = guard.checkPlanSync(target);
            verdict = merge(write, sync);
        }

        // audit every verdict except routine passes to keep the log meaningful
        if (verdict.isBlock() || verdict.isWarn()) {
            new AuditLog(cfg.auditLog(root))
                .record(session, tool, path, verdict.rule(), verdict.verdict(), verdict.reason());
        }

        System.out.println("{\"verdict\":\"" + verdict.verdict() + "\","
            + "\"rule\":" + jsonOrNull(verdict.rule()) + ","
            + "\"reason\":" + jsonOrNull(verdict.reason()) + "}");
    }

    private static void checkCmd(String[] args) {
        if (args.length < 4) {
            System.out.println("{\"verdict\":\"pass\",\"rule\":null,\"reason\":\"usage: check-cmd <root> <command> <fixScope>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        String command = args[2];
        boolean fixScope = "true".equalsIgnoreCase(args[3]);
        String session = args.length > 4 ? args[4] : "";

        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(ArtifactDetector.find(root, cfg.planArtifact));
        DiffGuard guard = new DiffGuard(cfg, root, plan);

        DiffGuard.Verdict verdict = guard.checkCommand(command, fixScope);
        if (verdict.isBlock() || verdict.isWarn()) {
            new AuditLog(cfg.auditLog(root))
                .record(session, "bash", command, verdict.rule(), verdict.verdict(), verdict.reason());
        }
        System.out.println("{\"verdict\":\"" + verdict.verdict() + "\","
            + "\"rule\":" + jsonOrNull(verdict.rule()) + ","
            + "\"reason\":" + jsonOrNull(verdict.reason()) + "}");
    }

    private static void verify(String[] args) {
        if (args.length < 2) {
            System.out.println("{\"verdict\":\"pass\",\"rule\":null,\"reason\":\"usage: verify <root>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        ContractConfig cfg = ContractConfig.load(root);
        PlanTracker plan = PlanTracker.of(ArtifactDetector.find(root, cfg.planArtifact));
        DiffGuard guard = new DiffGuard(cfg, root, plan);
        DiffGuard.Verdict verdict = guard.checkVerificationEvidence();
        if (verdict.isBlock()) {
            new AuditLog(cfg.auditLog(root))
                .record("", "verify", config(cfg), "R6", "block", verdict.reason());
        }
        System.out.println("{\"verdict\":\"" + verdict.verdict() + "\","
            + "\"rule\":" + jsonOrNull(verdict.rule()) + ","
            + "\"reason\":" + jsonOrNull(verdict.reason()) + "}");
    }

    private static String config(ContractConfig cfg) {
        return cfg.verifyEvidenceRel;
    }

    private static void diff(String[] args) {
        if (args.length < 4) {
            System.out.println("{\"error\":\"usage: diff <root> <base> <head>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        String base = "-".equals(args[2]) ? null : args[2];
        String head = "-".equals(args[3]) ? null : args[3];
        try {
            List<String> files = GitDiff.changedFiles(root, base, head);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < files.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(jsonOrNull(files.get(i)));
            }
            sb.append("]");
            System.out.println("{\"changed\":" + sb + "}");
        } catch (Exception e) {
            System.out.println("{\"changed\":[],\"error\":" + jsonOrNull(e.getMessage()) + "}");
        }
    }

    /**
     * R1 at commit/PR time: list changed files and flag those not declared in plan.md.
     * Default base is the merge-base with the current branch's upstream, else HEAD~1.
     */
    private static void sync(String[] args) {
        if (args.length < 2) {
            System.out.println("{\"error\":\"usage: sync <root> [base]\"}");
            return;
        }
        Path root = Path.of(args[1]);
        String base = args.length > 2 ? args[2] : null;
        ContractConfig cfg = ContractConfig.load(root);
        Path planFile = ArtifactDetector.find(root, cfg.planArtifact);
        PlanTracker plan = PlanTracker.of(planFile);
        if (!cfg.enabled || !cfg.requirePlan || planFile == null || !plan.isPlanRelevant()) {
            System.out.println("{\"hasPlan\":false,\"inScope\":[],\"outOfScope\":[],\"unverified\":[]}");
            return;
        }
        try {
            if (base == null || base.isBlank() || "-".equals(base)) {
                base = defaultBase(root);
            }
            List<String> changed = GitDiff.changedFiles(root, base, null);
            List<String> inScope = new java.util.ArrayList<>();
            List<String> outOfScope = new java.util.ArrayList<>();
            for (String f : changed) {
                if (f.endsWith(cfg.planArtifact) || f.endsWith(cfg.specArtifact) || f.endsWith(cfg.intentArtifact)) {
                    continue; // artifacts are always allowed
                }
                Path p = Path.of(f);
                if (plan.declares(root, p)) inScope.add(f);
                else outOfScope.add(f);
            }
            StringBuilder out = new StringBuilder();
            out.append("{\"hasPlan\":true,\"base\":").append(jsonOrNull(base))
               .append(",\"inScope\":").append(toJsonArray(inScope))
               .append(",\"outOfScope\":").append(toJsonArray(outOfScope)).append("}");
            System.out.println(out);
        } catch (Exception e) {
            System.out.println("{\"hasPlan\":true,\"error\":" + jsonOrNull(e.getMessage())
                + ",\"inScope\":[],\"outOfScope\":[]}");
        }
    }

    private static String defaultBase(Path root) {
        try {
            String branch = GitDiff.currentBranch(root);
            if (!"main".equals(branch) && !"master".equals(branch)) {
                try {
                    return GitDiff.mergeBase(root, "main", branch);
                } catch (Exception e) {
                    try {
                        return GitDiff.mergeBase(root, "master", branch);
                    } catch (Exception e2) {
                        return null;
                    }
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String toJsonArray(java.util.List<String> list) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(jsonOrNull(list.get(i)));
        }
        return sb.append("]").toString();
    }

    /**
     * Maintain -> Plan loop close. Writes an incident record and scaffolds a new
     * intent.md capturing the breached control band, so the SDLC loop starts again.
     */
    private static void incident(String[] args) {
        if (args.length < 3) {
            System.out.println("{\"error\":\"usage: incident <root> <description>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        String description = args[2];
        String id = "inc-" + java.time.Instant.now().toEpochMilli();
        Path dir = root.resolve(".sdlc-guardrails/incidents");
        try {
            java.nio.file.Files.createDirectories(dir);
            // 1. incident record
            Path incFile = dir.resolve(id + ".md");
            java.nio.file.Files.writeString(incFile, """
                # Incident: %s
                Reported: %s

                ## Breached control band
                %s

                ## Diagnosis
                <what happened; which guardrail did not hold>

                ## Write-back
                <the corrective change to fold back into intent.md>
                """.formatted(id, java.time.Instant.now(), description));
            // 2. scaffold a new intent.md (the loop's next cycle)
            Path intentDir = root.resolve("intent");
            java.nio.file.Files.createDirectories(intentDir);
            Path intentFile = intentDir.resolve("intent.md");
            String intentContent = java.nio.file.Files.exists(intentFile)
                ? "\n\n## Incident follow-up: " + id + "\n" + description + "\n"
                : """
                  # Intent: incident follow-up %s
                  Author: system (incident). Status: draft.

                  ## Problem
                  %s

                  ## Proposed outcome
                  <restore the breached control band>

                  ## Affected users and systems
                  <systems involved in the incident>

                  ## Constraints
                  <no recurrence of the breach>

                  ## Open questions
                  <root-cause items to confirm>
                  """.formatted(id, description);
            java.nio.file.Files.writeString(intentFile, intentContent,
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
            System.out.println("{\"incident\":\"" + id + "\",\"incidentFile\":" + jsonOrNull(incFile.toString())
                + ",\"intentFile\":" + jsonOrNull(intentFile.toString()) + "}");
        } catch (Exception e) {
            System.out.println("{\"error\":" + jsonOrNull(e.getMessage()) + "}");
        }
    }

    private static void artifact(String[] args) {
        if (args.length < 4) {
            System.out.println("{\"valid\":false,\"reason\":\"usage: artifact <root> <kind> <path>\"}");
            return;
        }
        String kind = args[2];
        String path = args[3];
        try {
            String text = Files.readString(Path.of(path));
            boolean valid = true;
            StringBuilder missing = new StringBuilder();
            for (String section : requiredSections(kind)) {
                if (!text.contains(section)) {
                    if (missing.length() > 0) missing.append(", ");
                    missing.append(section);
                }
            }
            if (missing.length() > 0) {
                valid = false;
                System.out.println("{\"valid\":false,\"kind\":\"" + kind + "\",\"missing\":\""
                    + missing + "\"}");
            } else {
                System.out.println("{\"valid\":true,\"kind\":\"" + kind + "\"}");
            }
        } catch (Exception e) {
            System.out.println("{\"valid\":false,\"reason\":\"unreadable: " + e.getMessage() + "\"}");
        }
    }

    private static String[] requiredSections(String kind) {
        return switch (kind.toLowerCase()) {
            case "intent" -> new String[]{"## Problem", "## Proposed outcome", "## Constraints"};
            case "spec" -> new String[]{"## Requirements", "## Design", "## Open questions"};
            case "plan" -> new String[]{"## Files that change", "## Proof"};
            default -> new String[0];
        };
    }

    private static void status(String[] args) {
        if (args.length < 2) {
            System.out.println("{\"error\":\"usage: status <root>\"}");
            return;
        }
        Path root = Path.of(args[1]);
        ContractConfig cfg = ContractConfig.load(root);
        Path intent = ArtifactDetector.find(root, cfg.intentArtifact);
        Path spec = ArtifactDetector.find(root, cfg.specArtifact);
        Path plan = ArtifactDetector.find(root, cfg.planArtifact);
        AuditLog log = new AuditLog(cfg.auditLog(root));
        System.out.println("{\"enabled\":" + cfg.enabled + ","
            + "\"requirePlan\":" + cfg.requirePlan + ","
            + "\"intent\":" + (intent != null) + ","
            + "\"spec\":" + (spec != null) + ","
            + "\"plan\":" + (plan != null) + ","
            + "\"protectedPaths\":" + cfg.protectedPaths.size() + ","
            + "\"auditEntries\":" + log.size() + "}");
    }

    private static void audit(String[] args) {
        if (args.length < 2) {
            System.out.println("{\"error\":\"usage: audit <root> [limit]\"}");
            return;
        }
        Path root = Path.of(args[1]);
        int limit = args.length > 2 ? Integer.parseInt(args[2]) : 20;
        ContractConfig cfg = ContractConfig.load(root);
        AuditLog log = new AuditLog(cfg.auditLog(root));
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (String line : log.tail(limit)) {
            if (!first) sb.append(",");
            sb.append(line);
            first = false;
        }
        sb.append("]");
        System.out.println(sb);
    }

    /** Merge two verdicts: block dominates, then warn, then pass. */
    private static DiffGuard.Verdict merge(DiffGuard.Verdict a, DiffGuard.Verdict b) {
        if (a.isBlock()) return a;
        if (b.isBlock()) return b;
        if (a.isWarn()) return a;
        if (b.isWarn()) return b;
        return DiffGuard.Verdict.pass();
    }

    private static Path toPath(Path root, String path) {
        if (path == null || path.isBlank()) return null;
        Path p = Path.of(path);
        return p.isAbsolute() ? p : root.resolve(p);
    }

    private static String jsonOrNull(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
}
