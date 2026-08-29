package eu.infolead.llmhp.sdlcguardrails;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;

/** Append-only verdict log (JSONL). Atomic appends; never blocks on a failure. */
public final class AuditLog {
    private final Path file;

    public AuditLog(Path file) {
        this.file = file;
    }

    public void record(String session, String tool, String path, String rule, String verdict, String reason) {
        try {
            Path parent = file.getParent();
            if (parent != null) Files.createDirectories(parent);
            String line = jsonLine(session, tool, path, rule, verdict, reason);
            Files.writeString(file, line + System.lineSeparator(), StandardCharsets.UTF_8,
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (IOException e) {
            // audit must never break plugin behavior
        }
    }

    private static String jsonLine(String session, String tool, String path, String rule, String verdict, String reason) {
        return "{"
            + "\"ts\":\"" + escape(Instant.now().toString()) + "\""
            + ",\"session\":\"" + escape(nn(session)) + "\""
            + ",\"tool\":\"" + escape(nn(tool)) + "\""
            + ",\"path\":\"" + escape(nn(path)) + "\""
            + ",\"rule\":\"" + escape(nn(rule)) + "\""
            + ",\"verdict\":\"" + escape(nn(verdict)) + "\""
            + ",\"reason\":\"" + escape(nn(reason)) + "\""
            + "}";
    }

    /** Tail the last {@code limit} lines. */
    public Deque<String> tail(int limit) {
        Deque<String> out = new ArrayDeque<>();
        if (!Files.exists(file)) return out;
        try {
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (line.isBlank()) continue;
                out.addLast(line);
                if (out.size() > limit) out.removeFirst();
            }
        } catch (IOException e) {
            // empty on failure
        }
        return out;
    }

    public long size() {
        if (!Files.exists(file)) return 0;
        try {
            return Files.lines(file).count();
        } catch (IOException e) {
            return 0;
        }
    }

    private static String nn(String s) {
        return s == null ? "" : s;
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
