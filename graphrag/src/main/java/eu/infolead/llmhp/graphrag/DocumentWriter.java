package eu.infolead.llmhp.graphrag;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import eu.infolead.llmhp.graphrag.types.SemanticBlock;

public final class DocumentWriter {

    public record ExportedDocument(
        String id,
        String doc,
        String lang,
        String authority,
        SemanticBlock block
    ) {
        public String fileName(String sha8) {
            return id + "--" + sha8 + ".md";
        }
    }

    public static String docId(ExportedDocument d) {
        var block = d.block();
        var slug = block.label() != null
            ? slugify(block.label().replace(":", "-"))
            : slugify((block.name() != null ? block.name() : block.kind().envName())
                + "-" + block.line());
        return slugify(d.doc()) + "-" + block.kind().envName() + "-" + slug;
    }

    public static String render(ExportedDocument d, List<String> structureContext) {
        var block = d.block();
        var sb = new StringBuilder();
        sb.append("---\n");
        sb.append("id: ").append(d.id()).append('\n');
        sb.append("doc: ").append(d.doc()).append('\n');
        sb.append("lang: ").append(d.lang()).append('\n');
        sb.append("authority: ").append(d.authority()).append('\n');
        sb.append("env: ").append(block.kind().envName()).append('\n');
        if (block.label() != null) {
            sb.append("labels: [").append(block.label()).append("]\n");
        }
        if (!block.refs().isEmpty()) {
            sb.append("refs: [").append(String.join(", ", block.refs())).append("]\n");
        }
        sb.append("file: ").append(block.file()).append('\n');
        sb.append("line: ").append(block.line()).append('\n');
        sb.append("---\n\n");

        if (block.label() != null) {
            sb.append('[').append(envTag(block)).append(" label=").append(block.label()).append("]\n");
        }
        if (!block.refs().isEmpty() && block.isFormal()) {
            var verb = block.kind() == SemanticBlock.Kind.PROOF
                || block.kind() == SemanticBlock.Kind.SOLUTION ? "proves" : "cites";
            sb.append('[').append(envTag(block)).append(' ').append(verb).append(": ")
              .append(String.join(", ", block.refs())).append("]\n");
        }
        if (!structureContext.isEmpty()) {
            sb.append("[SECTION appears_in: ").append(String.join(", ", structureContext)).append("]\n");
        }
        if (block.name() != null && !block.name().isBlank()) {
            sb.append("\n**").append(block.name()).append("**\n");
        }
        sb.append('\n').append(block.body()).append('\n');
        return sb.toString();
    }

    private static String envTag(SemanticBlock block) {
        return block.kind().name();
    }

    public static String sha8(String content) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            var hash = digest.digest(content.getBytes(StandardCharsets.UTF_8));
            var sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(content.hashCode());
        }
    }

    public static Path write(Path inputDir, ExportedDocument d, List<String> structureContext)
            throws IOException {
        Files.createDirectories(inputDir);
        var rendered = render(d, structureContext);
        var sha = sha8(rendered);
        var file = inputDir.resolve(d.id() + "--" + sha + ".md");
        Files.writeString(file, rendered);
        return file;
    }

    public static List<Path> removeStale(Path inputDir, String docId) throws IOException {
        var removed = new ArrayList<Path>();
        if (!Files.isDirectory(inputDir)) return removed;
        try (var stream = Files.list(inputDir)) {
            for (var f : stream.toList()) {
                var name = f.getFileName().toString();
                if (name.startsWith(docId + "--") && name.endsWith(".md")) {
                    Files.deleteIfExists(f);
                    removed.add(f);
                }
            }
        }
        return removed;
    }

    static String slugify(String s) {
        var sb = new StringBuilder();
        for (var c : s.toLowerCase().toCharArray()) {
            if (Character.isLetterOrDigit(c)) sb.append(c);
            else if (c == '-' || c == '_' || c == ':') sb.append('-');
            else if (c == ' ' && sb.length() > 0 && sb.charAt(sb.length() - 1) != '-') sb.append('-');
        }
        while (sb.length() > 0 && sb.charAt(sb.length() - 1) == '-') sb.deleteCharAt(sb.length() - 1);
        var result = sb.toString();
        return result.length() > 80 ? result.substring(0, 80) : result;
    }
}
