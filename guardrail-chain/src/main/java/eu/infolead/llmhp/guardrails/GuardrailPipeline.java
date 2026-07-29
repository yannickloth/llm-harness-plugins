package eu.infolead.llmhp.guardrails;

import eu.infolead.llmhp.guardrails.types.GuardConfig;
import eu.infolead.llmhp.guardrails.types.GuardResult;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.*;

public final class GuardrailPipeline {
    private final GuardConfig config;
    private final SecretScanner secretScanner;
    private final PathValidator pathValidator;
    private final PromptGuard promptGuard;

    public GuardrailPipeline(GuardConfig config) {
        this.config = config;
        this.secretScanner = new SecretScanner();
        this.pathValidator = new PathValidator();
        this.promptGuard = new PromptGuard();
    }

    public record PipelineResult(List<GuardResult> results) {
        public boolean blocked() {
            return results.stream().anyMatch(r -> r instanceof GuardResult.Block);
        }
        public boolean warnings() {
            return results.stream().anyMatch(r -> r instanceof GuardResult.Warn);
        }
        public List<GuardResult.Block> blocks() {
            return results.stream()
                .filter(r -> r instanceof GuardResult.Block)
                .map(r -> (GuardResult.Block) r)
                .toList();
        }
        public List<GuardResult.Warn> warns() {
            return results.stream()
                .filter(r -> r instanceof GuardResult.Warn)
                .map(r -> (GuardResult.Warn) r)
                .toList();
        }
    }

    public PipelineResult runPreWrite(String content, Path targetPath, Path containmentDir, Set<String> protectedFiles) throws IOException {
        var results = new ArrayList<GuardResult>();

        if (config.enableSecretScan()) {
            results.add(secretScanner.scan(content));
        }

        if (config.enablePromptGuard()) {
            results.add(promptGuard.scan(content));
        }
        if (config.enableSizeBounds()) {
            results.add(promptGuard.checkSizeBounds(content));
        }

        if (config.enablePathValidation() && targetPath != null) {
            results.add(pathValidator.validate(targetPath, containmentDir));
            if (protectedFiles != null && !protectedFiles.isEmpty()) {
                results.add(pathValidator.validateProtectedFiles(targetPath, protectedFiles));
            }
        }

        return new PipelineResult(Collections.unmodifiableList(results));
    }

    public PipelineResult runInputFilter(String prompt) {
        var results = new ArrayList<GuardResult>();

        if (config.enablePromptGuard()) {
            results.add(promptGuard.scan(prompt));
        }
        if (config.enableSizeBounds()) {
            results.add(promptGuard.checkSizeBounds(prompt));
        }

        if (config.enableSecretScan()) {
            results.add(secretScanner.scan(prompt));
        }

        return new PipelineResult(Collections.unmodifiableList(results));
    }

    public PipelineResult runOutputFilter(String output) {
        var results = new ArrayList<GuardResult>();

        if (config.enableSecretScan()) {
            results.add(secretScanner.scan(output));
        }

        if (config.enableSizeBounds()) {
            results.add(promptGuard.checkSizeBounds(output));
        }

        return new PipelineResult(Collections.unmodifiableList(results));
    }

    public PipelineResult runAll(String content, Path targetPath, Path containmentDir,
                                  Set<String> protectedFiles, String name) throws IOException {
        var results = new ArrayList<GuardResult>();

        if (config.enableSecretScan()) {
            results.add(secretScanner.scan(content));
        }

        if (config.enablePromptGuard()) {
            results.add(promptGuard.scan(content));
        }
        if (config.enableSizeBounds()) {
            results.add(promptGuard.checkSizeBounds(content));
        }

        if (config.enablePathValidation()) {
            if (name != null && !name.isEmpty()) {
                results.add(pathValidator.validateName(name));
            }
            if (targetPath != null && containmentDir != null) {
                results.add(pathValidator.validate(targetPath, containmentDir));
                if (protectedFiles != null && !protectedFiles.isEmpty()) {
                    results.add(pathValidator.validateProtectedFiles(targetPath, protectedFiles));
                }
            }
        }

        return new PipelineResult(Collections.unmodifiableList(results));
    }

    public GuardConfig config() { return config; }
    public SecretScanner secretScanner() { return secretScanner; }
    public PathValidator pathValidator() { return pathValidator; }
    public PromptGuard promptGuard() { return promptGuard; }
}
