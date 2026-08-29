package eu.infolead.llmhp.sdlcguardrails;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Locates SDLC artifacts (intent.md / spec.md / plan.md) within a repo. */
public final class ArtifactDetector {
    private ArtifactDetector() {}

    /** Search roots, ordered: project root, docs/, artifacts/, .sdlc-guardrails/. */
    public static Path find(Path root, String artifact) {
        for (Path dir : candidateDirs(root)) {
            Path p = dir.resolve(artifact);
            if (Files.isRegularFile(p)) return p;
        }
        // Recursive search in root for the filename (shallow, avoids node_modules/.git).
        try (var stream = Files.walk(root, 4)) {
            return stream
                .filter(Files::isRegularFile)
                .filter(p -> p.getFileName().toString().equals(artifact))
                .filter(ArtifactDetector::notInVendoredDir)
                .findFirst()
                .orElse(null);
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean exists(Path root, String artifact) {
        return find(root, artifact) != null;
    }

    private static List<Path> candidateDirs(Path root) {
        return List.of(
            root,
            root.resolve("docs"),
            root.resolve("artifacts"),
            root.resolve(".sdlc-guardrails"),
            root.resolve("intent"),
            root.resolve("spec"),
            root.resolve("plan")
        );
    }

    private static boolean notInVendoredDir(Path p) {
        String s = p.toString();
        return !s.contains("/node_modules/")
            && !s.contains("/.git/")
            && !s.contains("/target/")
            && !s.contains("/build/classes");
    }
}
