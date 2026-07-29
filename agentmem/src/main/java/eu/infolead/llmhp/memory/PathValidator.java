package eu.infolead.llmhp.memory;

import java.io.IOException;
import java.nio.file.*;
import java.util.Set;

public final class PathValidator {

    private static final eu.infolead.llmhp.guardrails.PathValidator DELEGATE =
        new eu.infolead.llmhp.guardrails.PathValidator();

    public static void validateName(String name) {
        var r = DELEGATE.validateName(name);
        if (r instanceof eu.infolead.llmhp.guardrails.types.GuardResult.Block b) {
            throw new IllegalArgumentException("REJECTED: " + b.message());
        }
    }

    public static void validate(Path targetPath, Path memDir) throws IOException {
        var r = DELEGATE.validate(targetPath, memDir);
        if (r instanceof eu.infolead.llmhp.guardrails.types.GuardResult.Block b) {
            throw new SecurityException("REJECTED: " + b.message());
        }
        var protFiles = Set.of(
            ".entities.json", ".consolidate-lock", ".sync-state.json",
            ".entities-graph.json", ".model-trust.json"
        );
        var r2 = DELEGATE.validateProtectedFiles(targetPath, protFiles);
        if (r2 instanceof eu.infolead.llmhp.guardrails.types.GuardResult.Block b2) {
            throw new SecurityException("REJECTED: " + b2.message());
        }
    }
}
