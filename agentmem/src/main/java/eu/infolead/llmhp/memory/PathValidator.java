package eu.infolead.llmhp.memory;

import java.io.IOException;
import java.nio.file.*;
import java.util.Set;

public final class PathValidator {

    public static void validateName(String name) {
        if (!name.matches("[a-zA-Z0-9_-]+")) {
            throw new IllegalArgumentException("REJECTED: name must match [a-zA-Z0-9_-]+");
        }
    }

    public static void validate(Path targetPath, Path memDir) throws IOException {
        var mem = memDir.toRealPath();

        if (Files.exists(targetPath)) {
            var real = targetPath.toRealPath();
            if (Files.isSymbolicLink(targetPath) && !real.startsWith(mem)) {
                throw new SecurityException("REJECTED: symlink points outside memory directory");
            }
        } else {
            var parent = targetPath.toAbsolutePath().getParent();
            if (parent == null) throw new IOException("Cannot resolve parent");
            if (!Files.exists(parent)) Files.createDirectories(parent);
            if (!parent.toRealPath().startsWith(mem)) {
                throw new SecurityException("REJECTED: target outside memory directory");
            }
        }

        var protectedFiles = Set.of(
            ".entities.json", ".consolidate-lock", ".sync-state.json",
            ".entities-graph.json", ".model-trust.json"
        );
        if (protectedFiles.contains(targetPath.getFileName().toString())) {
            throw new SecurityException("REJECTED: cannot overwrite protected file: " + targetPath.getFileName());
        }
    }
}
