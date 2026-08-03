package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

public final class MemoryVerifier {

    static final Pattern FILE_PATH_IN_TEXT = Pattern.compile(
        "(?:path|file|location|dir)[: ]`?((?![./])[\\w.-][\\w./-]*\\.[a-zA-Z]{1,8})`?|`((?![./])[\\w.-][\\w./-]*\\.[a-zA-Z]{1,8})`|\\b((?:src|lib|test|docs|config|vendor)/[\\w./-]+\\.[a-zA-Z]{1,8})\\b",
        Pattern.CASE_INSENSITIVE
    );

    static final Set<String> EXCLUDE_PREFIXES = Set.of(".agentmem/", ".git/", "node_modules/");
    static final Set<String> EXCLUDE_EXTENSIONS = Set.of(".json", ".lock", ".log", ".tmp", ".pid", ".cache", ".snap");

    static boolean isExcluded(String path) {
        for (var prefix : EXCLUDE_PREFIXES) {
            if (path.startsWith(prefix)) return true;
        }
        var lower = path.toLowerCase();
        for (var ext : EXCLUDE_EXTENSIONS) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }

    record FileRef(String memoryFile, String filePath, boolean exists, boolean insideProject) {}
    record VerificationResult(List<FileRef> refs, long totalFiles, long staleFiles, long outsideProject, String staleAnnotation) {}

    static Path resolveRealProjectRoot(Path projectRoot) {
        try {
            return projectRoot.toRealPath();
        } catch (IOException e) {
            return projectRoot.toAbsolutePath().normalize();
        }
    }

    static VerificationResult verify(Path memDir, Path projectRoot) throws IOException {
        var realProjectRoot = resolveRealProjectRoot(projectRoot);

        var refs = new ArrayList<FileRef>();
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .filter(f -> !f.getFileName().toString().equals("REVIEW.md"))
                 .forEach(f -> {
                     try {
                         var raw = Files.readString(f);
                         extractFileRefs(raw, f.getFileName().toString(), refs, projectRoot, realProjectRoot);
                     } catch (IOException ignored) {}
                 });
        }

        var staleFiles = refs.stream().filter(r -> !r.exists()).count();
        var outsideProject = refs.stream().filter(r -> !r.insideProject() && r.exists()).count();

        var staleAnnot = new StringBuilder();
        if (staleFiles > 0) {
            staleAnnot.append("STALE WARNING: ").append(staleFiles).append(" of ").append(refs.size()).append(" file references no longer exist.\n");
            for (var r : refs) {
                if (!r.exists()) {
                    staleAnnot.append("STALE - ").append(r.filePath())
                              .append(" (referenced in ").append(r.memoryFile()).append(")\n");
                }
            }
        }
        if (outsideProject == refs.size() - staleFiles && outsideProject > 0) {
            staleAnnot.append("NOTE: ").append(outsideProject).append(" referenced paths exist but are outside the project. No project-local existence verification possible.\n");
        }

        return new VerificationResult(refs, refs.size(), staleFiles, outsideProject, staleAnnot.toString());
    }

    static void extractFileRefs(String content, String memoryFile, List<FileRef> refs, Path projectRoot, Path realProjectRoot) {
        var seen = new HashSet<String>();
        var m = FILE_PATH_IN_TEXT.matcher(content);
        while (m.find()) {
            for (int g = 1; g <= m.groupCount(); g++) {
                var path = m.group(g);
                if (path == null || path.length() < 2 || path.length() > 255) continue;
                if (path.matches("^https?://.*")) continue;
                if (isExcluded(path)) continue;
                if (seen.contains(path)) continue;
                seen.add(path);

                boolean exists = false;
                boolean insideProject = false;
                try {
                    var resolved = projectRoot.resolve(path);
                    try {
                        var realResolved = resolved.toRealPath();
                        insideProject = realResolved.startsWith(realProjectRoot);
                    } catch (IOException e) {
                        insideProject = resolved.toAbsolutePath().normalize()
                            .startsWith(realProjectRoot);
                    }
                    exists = Files.exists(resolved);
                } catch (InvalidPathException e) {
                    exists = false;
                    insideProject = false;
                }
                refs.add(new FileRef(memoryFile, path, exists, insideProject));
            }
        }
    }

    static String buildVerifiedInjection(Path memDir, Path projectRoot) throws IOException {
        var result = verify(memDir, projectRoot);
        var sb = new StringBuilder();
        sb.append("## Memory Verification\n\n");
        sb.append("The following memory file references were checked against the project. ")
          .append("File paths marked as STALE no longer exist. Verify before acting on them.\n\n");

        if (!result.refs().isEmpty()) {
            sb.append("| Status | Memory File | Referenced Path |\n");
            sb.append("|--------|------------|------------------|\n");
            for (var ref : result.refs()) {
                var status = ref.exists() ? "OK" : "STALE";
                sb.append("| ").append(status).append(" | `").append(ref.memoryFile()).append("` | `").append(ref.filePath()).append("` |\n");
            }
            sb.append("\n");
        } else {
            sb.append("No file path references found in memories.\n\n");
        }

        return sb.toString();
    }

    static String injectWithVerification(Path memDir, String projectRoot) throws IOException {
        var projRoot = Path.of(projectRoot);
        var sb = new StringBuilder();
        if (!Files.exists(memDir)) return "";

        var indexPath = memDir.resolve("MEMORY.md");
        if (Files.exists(indexPath)) {
            var content = Files.readString(indexPath).trim();
            if (!content.isEmpty()) sb.append(content).append("\n\n");
        }

        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .filter(f -> !f.getFileName().toString().equals("REVIEW.md"))
                 .sorted(Comparator.comparing(Path::getFileName))
                 .forEach(f -> {
                     try {
                         var raw = Files.readString(f);
                         var stalePaths = findStalePaths(raw, projRoot);
                         var truncated = safeTruncate(raw, 8000);

                         sb.append("<!-- memory: ").append(f.getFileName()).append(" -->\n");
                         if (!stalePaths.isEmpty()) {
                             sb.append(" VERIFY: The following paths referenced in this memory no longer exist:\n");
                             for (var p : stalePaths) sb.append("  - `").append(p).append("`\n");
                             sb.append("\n");
                         }
                         sb.append(truncated).append("\n\n");
                     } catch (IOException ignored) {}
                 });
        }

        return sb.isEmpty() ? "" : sb.toString();
    }

    static String safeTruncate(String text, int maxChars) {
        if (maxChars <= 0) return "";
        if (text.length() <= maxChars) return text;
        int end = maxChars;
        while (end > 0 && Character.isSurrogate(text.charAt(end - 1))) end--;
        return end > 0 ? text.substring(0, end) : "";
    }

    static List<String> findStalePaths(String content, Path projectRoot) {
        var stale = new ArrayList<String>();
        var seen = new HashSet<String>();
        var m = FILE_PATH_IN_TEXT.matcher(content);
        while (m.find()) {
            for (int g = 1; g <= m.groupCount(); g++) {
                var path = m.group(g);
                if (path == null || path.length() < 2 || path.length() > 255) continue;
                if (path.matches("^https?://.*")) continue;
                if (isExcluded(path)) continue;
                if (seen.contains(path)) continue;
                seen.add(path);
                try {
                    if (!Files.exists(projectRoot.resolve(path))) stale.add(path);
                } catch (InvalidPathException e) {
                    stale.add(path);
                }
            }
        }
        return stale;
    }
}
