package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class Migration {

    sealed interface Migrate permits AddField, RenameType, ChangeFormat {}
    record AddField(String field, String defaultValue) implements Migrate {}
    record RenameType(String oldType, String newType) implements Migrate {}
    record ChangeFormat(String from, String to) implements Migrate {}

    static final int CURRENT_VERSION = 1;

    public static void migrate(Path memDir) throws IOException {
        var configFile = memDir.resolve("config.json");
        var version = CURRENT_VERSION;

        try {
            var raw = Files.readString(configFile);
            version = Integer.parseInt(raw.replaceAll(".*\"schema_version\"\\s*:\\s*(\\d+).*", "$1"));
        } catch (IOException | NumberFormatException e) {}

        if (version >= CURRENT_VERSION) { System.out.println("UP_TO_DATE"); return; }

        var migrations = loadMigrations(version);
        for (var m : migrations) {
            System.out.printf("Applying migration: %s\n", m);
            applyMigration(memDir, m);
        }
        Files.writeString(configFile, "{\"schema_version\": %d}\n".formatted(CURRENT_VERSION));
        System.out.println("Migration complete. Schema v%d".formatted(CURRENT_VERSION));
    }

    static List<Migrate> loadMigrations(int fromVersion) {
        var migrations = new ArrayList<Migrate>();
        if (fromVersion < 1) {
            migrations.add(new AddField("version", "1"));
            migrations.add(new AddField("reads", "0"));
        }
        return migrations;
    }

    static void applyMigration(Path memDir, Migrate migration) throws IOException {
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> applyToFile(f, migration));
        }
    }

    static void applyToFile(Path file, Migrate migration) {
        try {
            var content = Files.readString(file);
            String updated;
            switch (migration) {
                case AddField(String field, String defaultVal) -> {
                    if (!content.contains(field + ":")) {
                        var endIdx = content.indexOf("---", 3);
                        if (endIdx > 0)
                            updated = content.substring(0, endIdx) + field + ": " + defaultVal + "\n" + content.substring(endIdx);
                        else updated = content;
                    } else updated = content;
                    Files.writeString(file, updated);
                }
                case RenameType(String oldType, String newType) -> {
                    updated = content.replace("type: " + oldType, "type: " + newType);
                    Files.writeString(file, updated);
                }
                case ChangeFormat _ -> {}
            }
        } catch (IOException ignored) {}
    }
}
