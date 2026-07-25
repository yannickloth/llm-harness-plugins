package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;

public final class Bootstrap {

    public static void run(Path repoPath, Path memDir) throws Exception {
        var logOutput = gitLog(repoPath);
        var patterns = analyzeGitLog(logOutput);

        System.out.println("Bootstrapping memory from git history...");

        if (patterns.isEmpty()) {
            System.out.println("No patterns found in git history.");
            return;
        }

        Files.createDirectories(memDir);
        for (var p : patterns.entrySet()) {
            var name = "bootstrap_" + p.getKey().replaceAll("[^a-zA-Z0-9_]", "_").toLowerCase();
            var desc = "Git history pattern: %s (%d occurrences)".formatted(p.getKey(), p.getValue().size());
            var content = buildContent(p.getKey(), p.getValue());

            var target = memDir.resolve(name + ".md");
            if (Files.exists(target)) continue;

            var frontmatter = """
                ---
                name: %s
                description: %s
                type: project
                who: Agent (autonomous)
                context: Bootstrap from git history analysis
                confidence: speculative
                modified: %s
                ---
                %s
                """.formatted(name, desc, Instant.now().toString(), content);

            Files.writeString(target, frontmatter);
            System.out.printf("  Created %s.md\n", name);
        }

        System.out.println("Bootstrap complete.");
    }

    static Map<String, List<String>> analyzeGitLog(String log) {
        var patterns = new LinkedHashMap<String, List<String>>();
        var fixPat = Pattern.compile("fix", Pattern.CASE_INSENSITIVE);
        var revertPat = Pattern.compile("revert", Pattern.CASE_INSENSITIVE);
        var configPat = Pattern.compile("config|env|setting", Pattern.CASE_INSENSITIVE);
        for (var line : log.split("\n")) {
            if (line.trim().isEmpty()) continue;
            if (fixPat.matcher(line).find()) patterns.computeIfAbsent("frequent_fixes", k -> new ArrayList<>()).add(line.trim());
            if (revertPat.matcher(line).find()) patterns.computeIfAbsent("reverted_changes", k -> new ArrayList<>()).add(line.trim());
            if (configPat.matcher(line).find()) patterns.computeIfAbsent("config_changes", k -> new ArrayList<>()).add(line.trim());
        }
        return patterns;
    }

    static String gitLog(Path repoPath) throws Exception {
        var pb = new ProcessBuilder("git", "-C", repoPath.toString(), "log", "--oneline", "-n", "200");
        pb.redirectErrorStream(true);
        var proc = pb.start();
        try (var reader = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
            return reader.lines().collect(java.util.stream.Collectors.joining("\n"));
        }
    }

    static String buildContent(String pattern, List<String> commits) {
        var sb = new StringBuilder();
        sb.append("**What:** Git history shows a recurring pattern of ").append(pattern).append("\n\n");
        sb.append("**Commit count:** ").append(commits.size()).append("\n\n");
        sb.append("**Recent commits:**\n");
        commits.stream().limit(5).forEach(c -> sb.append("- ").append(c).append("\n"));
        return sb.toString();
    }
}
