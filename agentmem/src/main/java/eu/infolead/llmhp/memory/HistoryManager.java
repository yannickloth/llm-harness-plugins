package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.Comparator;

public final class HistoryManager {

    public static void snapshot(Path memDir, String name) throws IOException {
        var historyDir = memDir.resolve(".history");
        Files.createDirectories(historyDir);
        var sourceFile = memDir.resolve(name.endsWith(".md") ? name : name + ".md");
        if (!Files.exists(sourceFile)) throw new NoSuchFileException(sourceFile.toString());
        var stamp = Instant.now().toString().replace(":", "-");
        Files.copy(sourceFile, historyDir.resolve(sourceFile.getFileName() + "." + stamp));
        System.out.println("SNAPSHOT " + stamp);
    }

    public static void list(Path memDir, String namePattern) throws IOException {
        var historyDir = memDir.resolve(".history");
        if (!Files.exists(historyDir)) return;
        try (var files = Files.list(historyDir)) {
            files.filter(Files::isRegularFile)
                 .sorted(Comparator.comparing((Path f) -> {
                     try { return Files.getLastModifiedTime(f).toInstant(); }
                     catch (IOException e) { return Instant.EPOCH; }
                 }).reversed())
                 .filter(f -> namePattern == null || f.getFileName().toString().contains(namePattern))
                 .forEach(f -> System.out.println(f.getFileName()));
        }
    }

    public static void prune(Path memDir, int maxDays) throws IOException {
        var historyDir = memDir.resolve(".history");
        if (!Files.exists(historyDir)) return;
        var cutoff = Instant.now().minus(Duration.ofDays(maxDays));
        try (var files = Files.list(historyDir)) {
            files.filter(f -> {
                try { return Files.getLastModifiedTime(f).toInstant().isBefore(cutoff); }
                catch (IOException e) { return false; }
            }).forEach(f -> { try { Files.delete(f); System.out.println("PRUNED " + f.getFileName()); } catch (IOException ignored) {} });
        }
    }
}
