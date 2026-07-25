package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

public final class EntityIndex {

    static final Pattern FILE_PATH = Pattern.compile("[\\w/.-]+\\.[a-z]{1,6}");
    static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");
    static final Pattern ABBREV = Pattern.compile("\\b([A-Z]{2,}(?:\\d+)?)\\b");
    static final Pattern URL_PAT = Pattern.compile("https?://[\\w./-]+");

    public static void rebuild(Path memDir) throws IOException {
        var entities = new LinkedHashMap<String, Set<String>>();
        try (var files = Files.list(memDir)) {
            files.filter(Files::isRegularFile)
                 .filter(f -> f.toString().endsWith(".md"))
                 .filter(f -> !f.getFileName().toString().equals("MEMORY.md"))
                 .forEach(f -> extract(f.getFileName().toString(), f, entities));
        }
        writeIndex(memDir.resolve(".entities.json"), entities);
        System.out.printf("Rebuilt entity index: %d entities%n", entities.size());
    }

    public static String lookup(Path memDir, String entity) throws IOException {
        var index = readIndex(memDir.resolve(".entities.json"));
        var files = index.get(entity);
        return (files == null || files.isEmpty()) ? "NONE" : String.join(",", files);
    }

    public static String query(Path memDir, String keyword) throws IOException {
        var index = readIndex(memDir.resolve(".entities.json"));
        var matches = new LinkedHashSet<String>();
        var lower = keyword.toLowerCase();
        for (var e : index.entrySet()) {
            if (e.getKey().toLowerCase().contains(lower)) matches.addAll(e.getValue());
        }
        return matches.isEmpty() ? "NONE" : String.join(",", matches);
    }

    public static void update(Path memDir, String filename, String content) throws IOException {
        var indexFile = memDir.resolve(".entities.json");
        var entities = readIndex(indexFile);
        extractFromString(filename + ".md", content, entities);
        writeIndex(indexFile, entities);
    }

    static void extract(String filename, Path file, Map<String, Set<String>> entities) {
        try { extractFromString(filename, Files.readString(file), entities); } catch (IOException ignored) {}
    }

    static void extractFromString(String filename, String content, Map<String, Set<String>> entities) {
        for (var pat : List.of(FILE_PATH, BACKTICK, ABBREV, URL_PAT)) {
            var m = pat.matcher(content);
            while (m.find()) {
                var entity = m.group(1);
                entities.computeIfAbsent(entity, k -> new LinkedHashSet<>()).add(filename);
            }
        }
    }

    public static Map<String, Set<String>> readIndex(Path file) throws IOException {
        if (!Files.exists(file)) return new LinkedHashMap<>();
        return parseJson(Files.readString(file));
    }

    static void writeIndex(Path file, Map<String, Set<String>> entities) throws IOException {
        var sb = new StringBuilder("{\n");
        var first = true;
        for (var e : entities.entrySet()) {
            if (!first) sb.append(",\n");
            first = false;
            sb.append("  \"%s\": [".formatted(escape(e.getKey())));
            sb.append(e.getValue().stream().map(f -> "\"%s\"".formatted(escape(f)))
                     .collect(java.util.stream.Collectors.joining(", ")));
            sb.append("]");
        }
        sb.append("\n}\n");
        Files.writeString(file, sb.toString());
    }

    static Map<String, Set<String>> parseJson(String raw) {
        var result = new LinkedHashMap<String, Set<String>>();
        var currentKey = "";
        var inArray = false;
        var buf = new StringBuilder();
        var depth = 0;

        for (int i = 0; i < raw.length(); i++) {
            var ch = raw.charAt(i);
            if (ch == '{') { depth++; if (depth == 1) continue; buf.append(ch); }
            else if (ch == '}') { depth--; if (depth > 0) buf.append(ch); }
            else if (ch == '"' && depth == 1) {
                if (inArray) { var val = buf.toString(); if (!val.isBlank()) result.get(currentKey).add(val); buf.setLength(0); inArray = false; }
                else { currentKey = buf.toString(); buf.setLength(0); }
            } else if (ch == '[' && depth == 1) { result.put(currentKey, new LinkedHashSet<>()); inArray = true; }
            else if (ch == ']' && depth == 1) { inArray = false; }
            else if (ch == ',' || Character.isWhitespace(ch)) {
                if (depth > 1) buf.append(ch);
            } else { buf.append(ch); }
        }
        return result;
    }

    static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
