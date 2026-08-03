package eu.infolead.llmhp.guardrails;

import eu.infolead.llmhp.guardrails.types.GuardConfig;
import eu.infolead.llmhp.guardrails.types.GuardResult;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

public class GuardrailPipelineCli {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) { usage(); return; }
        var cmd = args[0];

        switch (cmd) {
            case "scan-secrets" -> {
                var content = readStdinOrArg(args, 1);
                var scanner = new SecretScanner();
                var result = scanner.scan(content);
                System.out.println(toJson(result));
            }
            case "check-path" -> {
                if (args.length < 3) { System.err.println("check-path <targetPath> <containmentDir>"); System.exit(1); return; }
                var validator = new PathValidator();
                var result = validator.validate(Path.of(args[1]), Path.of(args[2]));
                System.out.println(toJson(result));
            }
            case "check-name" -> {
                if (args.length < 2) { System.err.println("check-name <name>"); System.exit(1); return; }
                var validator = new PathValidator();
                var result = validator.validateName(args[1]);
                System.out.println(toJson(result));
            }
            case "check-injection" -> {
                var prompt = readStdinOrArg(args, 1);
                var guard = new PromptGuard();
                var result = guard.scan(prompt);
                System.out.println(toJson(result));
            }
            case "check-size" -> {
                var content = readStdinOrArg(args, 1);
                var guard = new PromptGuard();
                var maxBytes = args.length > 2 ? Integer.parseInt(args[2]) : 500_000;
                var result = guard.checkSizeBounds(content, maxBytes);
                System.out.println(toJson(result));
            }
            case "pre-write" -> {
                if (args.length < 4) { System.err.println("pre-write <targetPath> <containmentDir> <content> [protected...]"); System.exit(1); return; }
                var content = readStdinOrArg(args, 3);
                var targetPath = Path.of(args[1]);
                var containmentDir = Path.of(args[2]);
                var protectedFiles = new HashSet<String>();
                for (int i = 4; i < args.length; i++) protectedFiles.add(args[i]);
                var pipeline = new GuardrailPipeline(GuardConfig.all());
                var result = pipeline.runPreWrite(content, targetPath, containmentDir, protectedFiles);
                System.out.println(pipelineResultToJson(result));
                if (result.blocked()) System.exit(1);
            }
            case "input-filter" -> {
                var prompt = readStdinOrArg(args, 1);
                var pipeline = new GuardrailPipeline(GuardConfig.all());
                var result = pipeline.runInputFilter(prompt);
                System.out.println(pipelineResultToJson(result));
                if (result.blocked()) System.exit(1);
            }
            case "output-filter" -> {
                var output = readStdinOrArg(args, 1);
                var pipeline = new GuardrailPipeline(GuardConfig.all());
                var result = pipeline.runOutputFilter(output);
                System.out.println(pipelineResultToJson(result));
                if (result.blocked()) System.exit(1);
            }
            case "transcript-filter" -> {
                var transcript = readStdinOrArg(args, 1);
                var filter = new TranscriptFilter();
                var result = filter.filter(transcript);
                System.out.println(transcriptFilterToJson(result));
                if (result.error()) System.exit(1);
            }
            default -> { System.err.println("Unknown: " + cmd); System.exit(1); }
        }
    }

    static String readStdinOrArg(String[] args, int idx) throws IOException {
        if (idx < args.length && !args[idx].equals("--")) return args[idx];
        return readStdin();
    }

    static String readStdin() throws IOException {
        try (var reader = new BufferedReader(new InputStreamReader(System.in))) {
            var sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString().strip();
        }
    }

    static String toJson(GuardResult r) {
        if (r instanceof GuardResult.Block b) {
            return "{\"result\":\"block\",\"source\":\"%s\",\"message\":\"%s\"}".formatted(escapeJson(b.source()), escapeJson(b.message()));
        } else if (r instanceof GuardResult.Warn w) {
            return "{\"result\":\"warn\",\"source\":\"%s\",\"message\":\"%s\"}".formatted(escapeJson(w.source()), escapeJson(w.message()));
        }
        return "{\"result\":\"pass\",\"source\":\"%s\"}".formatted(r.source());
    }

    static String pipelineResultToJson(GuardrailPipeline.PipelineResult pr) {
        var blocks = pr.blocks().stream().map(GuardrailPipelineCli::toJson).collect(Collectors.joining(","));
        var warns = pr.warns().stream().map(GuardrailPipelineCli::toJson).collect(Collectors.joining(","));
        return "{\"blocked\":%b,\"warnings\":%b,\"blocks\":[%s],\"warns\":[%s]}".formatted(
            pr.blocked(), pr.warnings(), blocks, warns);
    }

    static String transcriptFilterToJson(TranscriptFilter.FilterResult r) {
        if (r.error()) {
            return "{\"error\":true,\"errorMessage\":\"%s\",\"originalCount\":0,\"filteredCount\":0,\"strippedCount\":0,\"json\":\"[]\"}".formatted(
                escapeJson(r.errorMessage()));
        }
        return "{\"error\":false,\"originalCount\":%d,\"filteredCount\":%d,\"strippedCount\":%d,\"json\":\"%s\"}".formatted(
            r.originalCount(), r.filteredCount(), r.strippedCount(), escapeJson(r.json()));
    }

    static String escapeJson(String s) {
        if (s == null) return "null";
        var sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }

    static void usage() {
        System.err.println("""
            GuardrailPipeline <cmd> [args...]
            Commands:
              scan-secrets [content|-stdin]
              check-path <targetPath> <containmentDir>
              check-name <name>
              check-injection [prompt|-stdin]
              check-size [content|-stdin] [maxBytes]
              pre-write <targetPath> <containmentDir> <content> [protected...]
              input-filter [prompt|-stdin]
              output-filter [output|-stdin]
              transcript-filter [json|-stdin]
              Use -- to read content from stdin.
            """);
    }
}
