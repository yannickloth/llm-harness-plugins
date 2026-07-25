package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

public final class SyncClient {

    public static Map<String, String> computeDelta(Path memDir) throws Exception {
        var delta = new LinkedHashMap<String, String>();
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> {
                     try {
                         var content = Files.readString(f);
                         var hash = "sha256:" + sha256(content);
                         delta.put(f.getFileName().toString(), "%s %s".formatted(hash, f.getFileName()));
                     } catch (Exception ignored) {}
                 });
        }
        return delta;
    }

    public static String sha256(String input) {
        try {
            var md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(input.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
