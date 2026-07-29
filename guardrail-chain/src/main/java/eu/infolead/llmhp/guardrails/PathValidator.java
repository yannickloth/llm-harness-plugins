package eu.infolead.llmhp.guardrails;

import eu.infolead.llmhp.guardrails.types.GuardResult;
import java.io.IOException;
import java.nio.file.*;
import java.util.Set;

public final class PathValidator {

    public GuardResult validate(String targetPath, String containmentDir) throws IOException {
        return validate(Path.of(targetPath), Path.of(containmentDir));
    }

    public GuardResult validate(Path targetPath, Path containmentDir) throws IOException {
        var root = containmentDir.toRealPath();

        if (Files.exists(targetPath)) {
            var real = targetPath.toRealPath();
            if (!real.startsWith(root)) {
                return new GuardResult.Block("PathValidator",
                    "Path outside containment: %s".formatted(targetPath));
            }
        } else {
            var absolute = targetPath.toAbsolutePath();
            var parent = absolute.getParent();
            if (parent == null) {
                return new GuardResult.Block("PathValidator", "Cannot resolve parent directory");
            }
            if (!Files.exists(parent)) Files.createDirectories(parent);
            if (!parent.toRealPath().startsWith(root)) {
                return new GuardResult.Block("PathValidator",
                    "Target outside containment directory: %s".formatted(targetPath));
            }
            var cursor = parent;
            while (!cursor.equals(root)) {
                if (Files.isSymbolicLink(cursor)) {
                    var linkTarget = cursor.toRealPath();
                    if (!linkTarget.startsWith(root)) {
                        return new GuardResult.Block("PathValidator",
                            "Parent symlink escapes containment: %s -> %s".formatted(cursor, linkTarget));
                    }
                }
                var next = cursor.getParent();
                if (next == null || next.equals(cursor)) break;
                cursor = next;
            }
        }

        return new GuardResult.Pass("PathValidator");
    }

    public GuardResult validateProtectedFiles(Path targetPath, Set<String> protectedFiles) {
        if (protectedFiles.contains(targetPath.getFileName().toString())) {
            return new GuardResult.Block("PathValidator",
                "Cannot overwrite protected file: %s".formatted(targetPath.getFileName()));
        }
        return new GuardResult.Pass("PathValidator");
    }

    public GuardResult validateName(String name) {
        if (!name.matches("[a-zA-Z0-9_-]+")) {
            return new GuardResult.Block("PathValidator",
                "Name must match [a-zA-Z0-9_-]+");
        }
        return new GuardResult.Pass("PathValidator");
    }
}
