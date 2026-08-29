package eu.infolead.llmhp.sdlcguardrails;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Thin wrapper around git for diff-based plan-sync checking. */
public final class GitDiff {
    private GitDiff() {}

    /** List of changed file paths between two refs (or HEAD if base is the working tree). */
    public static List<String> changedFiles(Path root, String base, String head) throws IOException {
        List<String> cmd = new ArrayList<>(List.of("git", "diff", "--name-only", "--no-renames"));
        if (base != null && !base.isBlank()) cmd.add(base);
        if (head != null && !head.isBlank()) cmd.add(head);
        String out = run(root, cmd.toArray(new String[0]));
        List<String> files = new ArrayList<>();
        for (String line : out.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) files.add(t);
        }
        return files;
    }

    /** Current branch name. */
    public static String currentBranch(Path root) throws IOException {
        return run(root, "git", "rev-parse", "--abbrev-ref", "HEAD").trim();
    }

    /** Merge-base of two refs. */
    public static String mergeBase(Path root, String a, String b) throws IOException {
        return run(root, "git", "merge-base", a, b).trim();
    }

    private static String run(Path cwd, String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(cwd.toFile());
        pb.redirectErrorStream(true);
        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            throw new IOException("failed to start git: " + e.getMessage(), e);
        }
        try {
            if (!p.waitFor(10, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new IOException("git command timed out: " + String.join(" ", cmd));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("git interrupted", e);
        }
        String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        if (p.exitValue() != 0) {
            throw new IOException("git failed (" + p.exitValue() + ") for " + String.join(" ", cmd) + ": " + out.trim());
        }
        return out;
    }
}
