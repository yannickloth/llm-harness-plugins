package eu.infolead.llmhp.promptregistry;

import eu.infolead.llmhp.promptregistry.types.PromptVersion;
import eu.infolead.llmhp.promptregistry.types.ABTestResult;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.stream.*;

final class RegistryStore {

    private final Path registryDir;
    private final Path parentDir;
    private final Path lockDir;
    static final String VERSIONS_FILE = ".prompt-versions";
    static final String VERSIONS_LOCK = ".prompt-versions.lock";
    static final String PROMPTS_DIR = "prompts";

    RegistryStore(Path registryDir) {
        this.registryDir = registryDir;
        this.parentDir = registryDir.getParent() != null ? registryDir.getParent() : Path.of(".");
        this.lockDir = parentDir.resolve(".locks");
    }

    RegistryStore() {
        this(Path.of(".prompt-registry", "registry"));
    }

    PromptVersion getLatest(String name) throws IOException {
        var dir = registryDir.resolve(name);
        if (!Files.isDirectory(dir)) return null;
        try (var files = Files.list(dir)) {
            return files.filter(f -> f.getFileName().toString().matches("^v\\d+\\.json$"))
                .map(this::readVersionFile)
                .filter(Objects::nonNull)
                .max(Comparator.comparingInt(PromptVersion::version))
                .orElse(null);
        }
    }

    PromptVersion getVersion(String name, int version) throws IOException {
        var file = registryDir.resolve(name).resolve("v%d.json".formatted(version));
        if (!Files.isRegularFile(file)) return null;
        return readVersionFile(file);
    }

    PromptVersion commit(String name, String content, String author) throws IOException {
        if (!PromptVersion.isValidName(name)) {
            throw new IllegalArgumentException("invalid prompt name: " + name);
        }
        try (var ignored = acquireLock()) {
            var latest = getLatest(name);
            var nextVersion = (latest == null) ? 1 : latest.version() + 1;
            var version = new PromptVersion(name, nextVersion, content, author, Instant.now());

            updateActiveVersionLocked(name, nextVersion);

            var dir = registryDir.resolve(name);
            Files.createDirectories(dir);
            var tmpDir = registryDir.resolve(".tmp");
            Files.createDirectories(tmpDir);
            var tmpFile = tmpDir.resolve("%s_v%d_%s.json".formatted(name, nextVersion, UUID.randomUUID()));
            Files.writeString(tmpFile, version.toJson());
            try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
                ch.force(true);
            }
            Files.move(tmpFile, dir.resolve("v%d.json".formatted(nextVersion)),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);

            return version;
        }
    }

    PromptVersion pull(String name, Integer version) throws IOException {
        var resolved = version != null ? version : resolveActiveVersion(name);
        var targetVersion = resolved > 0 ? resolved : null;
        if (targetVersion == null) {
            var latest = getLatest(name);
            if (latest == null) return null;
            targetVersion = latest.version();
        }
        if (targetVersion < 1) return null;
        return getVersion(name, targetVersion);
    }

    List<PromptVersion> versions(String name) throws IOException {
        var dir = registryDir.resolve(name);
        if (!Files.isDirectory(dir)) return List.of();
        try (var files = Files.list(dir)) {
            return files.filter(f -> f.getFileName().toString().matches("^v\\d+\\.json$"))
                .map(this::readVersionFile)
                .filter(Objects::nonNull)
                .sorted(Comparator.comparingInt(PromptVersion::version))
                .toList();
        }
    }

    List<String> listNames() throws IOException {
        if (!Files.isDirectory(registryDir)) return List.of();
        try (var dirs = Files.list(registryDir)) {
            return dirs.filter(Files::isDirectory)
                .map(p -> p.getFileName().toString())
                .filter(n -> !n.startsWith("."))
                .sorted()
                .toList();
        }
    }

    int resolveActiveVersion(String name) throws IOException {
        try (var ignored = acquireLock()) {
            var versionsMap = readVersionsFileLocked();
            return versionsMap.getOrDefault(name, -1);
        }
    }

    void updateActiveVersion(String name, int version) throws IOException {
        try (var ignored = acquireLock()) {
            updateActiveVersionLocked(name, version);
        }
    }

    private void updateActiveVersionLocked(String name, int version) throws IOException {
        var versionsMap = readVersionsFileLocked();
        versionsMap.put(name, version);
        writeVersionsFileLocked(versionsMap);
    }

    private FileLockInfo acquireLock() throws IOException {
        Files.createDirectories(lockDir);
        var lockPath = lockDir.resolve(VERSIONS_LOCK);
        var lockFile = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        try {
            return new FileLockInfo(lockFile.lock(), lockFile, lockPath);
        } catch (IOException e) {
            lockFile.close();
            throw e;
        }
    }

    record FileLockInfo(FileLock lock, FileChannel channel, Path lockPath) implements AutoCloseable {
        public void close() throws IOException {
            try {
                lock.release();
            } finally {
                try {
                    channel.close();
                } finally {
                    Files.deleteIfExists(lockPath);
                }
            }
        }
    }

    List<PromptVersion> getAllActive() throws IOException {
        try (var ignored = acquireLock()) {
            var versionsMap = readVersionsFileLocked();
            var result = new ArrayList<PromptVersion>();
            for (var entry : versionsMap.entrySet()) {
                var v = getVersion(entry.getKey(), entry.getValue());
                if (v != null) result.add(v);
            }
            return result;
        }
    }

    ABTestResult testVariants(String name, int variantA, int variantB) throws IOException {
        var a = getVersion(name, variantA);
        var b = getVersion(name, variantB);
        var description = new StringBuilder();
        if (a == null) description.append("variant_a v%d not found; ".formatted(variantA));
        if (b == null) description.append("variant_b v%d not found; ".formatted(variantB));
        if (a != null && b != null) {
            description.append("both variants available — compare outputs to score");
        }
        return new ABTestResult(name, variantA, variantB, description.toString().trim(), Instant.now());
    }

    int promptCount() throws IOException {
        var names = listNames();
        return names.size();
    }

    int totalVersions() throws IOException {
        var count = 0;
        for (var name : listNames()) {
            count += versions(name).size();
        }
        return count;
    }

    static boolean hasUncommittedChanges(Path pluginPromptsDir, PromptVersion latest) throws IOException {
        if (!Files.isDirectory(pluginPromptsDir)) return false;
        var promptFile = pluginPromptsDir.resolve(latest.name() + ".md");
        if (!Files.isRegularFile(promptFile)) return false;
        var current = Files.readString(promptFile).strip();
        return !current.equals(latest.content().strip());
    }

    private Map<String, Integer> readVersionsFileLocked() throws IOException {
        var file = parentDir.resolve(VERSIONS_FILE);
        if (!Files.isRegularFile(file)) return new LinkedHashMap<>();
        var content = Files.readString(file).strip();
        if (content.isEmpty()) return new LinkedHashMap<>();
        var map = new LinkedHashMap<String, Integer>();
        for (var line : content.split("\n")) {
            line = line.strip();
            if (line.isEmpty()) continue;
            var parts = line.split(":", 2);
            if (parts.length == 2) {
                try {
                    map.put(parts[0], Integer.parseInt(parts[1]));
                } catch (NumberFormatException e) {
                    System.err.println("[prompt-registry] WARN: corrupt version entry: " + line);
                }
            }
        }
        return map;
    }

    private void writeVersionsFileLocked(Map<String, Integer> map) throws IOException {
        var file = parentDir.resolve(VERSIONS_FILE);
        var sb = new StringBuilder();
        for (var entry : map.entrySet()) {
            sb.append("%s:%d\n".formatted(entry.getKey(), entry.getValue()));
        }
        var tmpDir = parentDir.resolve(".tmp");
        Files.createDirectories(tmpDir);
        var tmpFile = tmpDir.resolve("versions_" + UUID.randomUUID());
        Files.writeString(tmpFile, sb.toString());
        try (var ch = FileChannel.open(tmpFile, StandardOpenOption.WRITE)) {
            ch.force(true);
        }
        Files.move(tmpFile, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    String toJson(Map<String, Object> map) {
        var sb = new StringBuilder("{");
        var first = true;
        for (var entry : map.entrySet()) {
            if (!first) sb.append(",");
            sb.append("\"%s\":%s".formatted(PromptVersion.escapeJson(entry.getKey()), jsonValue(entry.getValue())));
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }

    private String jsonValue(Object v) {
        return switch (v) {
            case null -> "null";
            case String s -> "\"%s\"".formatted(PromptVersion.escapeJson(s));
            case Number n -> n.toString();
            case Boolean b -> b.toString();
            case Map<?, ?> m -> toJsonMap(m);
            case List<?> list -> {
                var items = list.stream().map(this::jsonValue).collect(Collectors.joining(","));
                yield "[%s]".formatted(items);
            }
            default -> "\"%s\"".formatted(PromptVersion.escapeJson(v.toString()));
        };
    }

    @SuppressWarnings("unchecked")
    private String toJsonMap(Map<?, ?> map) {
        var sb = new StringBuilder("{");
        var first = true;
        for (var entry : map.entrySet()) {
            if (!first) sb.append(",");
            sb.append("\"%s\":%s".formatted(PromptVersion.escapeJson(entry.getKey().toString()), jsonValue(entry.getValue())));
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }

    PromptVersion readVersionFile(Path file) {
        try {
            var raw = Files.readString(file).strip();
            var version = parseVersionJson(raw);
            if (version == null) {
                System.err.println("[prompt-registry] WARN: corrupt version file: " + file);
            }
            return version;
        } catch (IOException e) {
            System.err.println("[prompt-registry] WARN: cannot read version file: " + file + " (" + e.getMessage() + ")");
            return null;
        }
    }

    static PromptVersion parseVersionJson(String json) {
        try {
            var map = parseSimpleJson(json);
            var name = (String) map.get("name");
            var versionNum = (Number) map.get("version");
            var content = (String) map.get("content");
            if (name == null || versionNum == null || content == null) return null;
            var version = versionNum.intValue();
            var author = (String) map.getOrDefault("author", "unknown");
            var ts = (String) map.getOrDefault("timestamp", Instant.now().toString());
            var cacheScope = (String) map.getOrDefault("cacheScope", "global");
            return new PromptVersion(name, version, content, author, Instant.parse(ts), cacheScope);
        } catch (Exception e) {
            return null;
        }
    }

    static Map<String, Object> parseSimpleJson(String json) {
        var map = new LinkedHashMap<String, Object>();
        if (json == null || json.isBlank()) return map;
        var s = json.strip();
        if (!s.startsWith("{") || !s.endsWith("}")) return map;
        s = s.substring(1, s.length() - 1).strip();
        var i = 0;
        while (i < s.length()) {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i >= s.length()) break;
            if (s.charAt(i) != '"') break;
            var keyEnd = s.indexOf('"', i + 1);
            while (keyEnd > 0 && isEscapedQuote(s, keyEnd)) keyEnd = s.indexOf('"', keyEnd + 1);
            if (keyEnd < 0) break;
            var key = s.substring(i + 1, keyEnd);
            i = keyEnd + 1;
            while (i < s.length() && s.charAt(i) != ':') i++;
            i++;
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i >= s.length()) break;
            var c = s.charAt(i);
            if (c == '"') {
                var valEnd = s.indexOf('"', i + 1);
                while (valEnd > 0 && isEscapedQuote(s, valEnd)) valEnd = s.indexOf('"', valEnd + 1);
                if (valEnd < 0) break;
                var raw = s.substring(i + 1, valEnd);
                map.put(key, unescapeJson(raw));
                i = valEnd + 1;
            } else if (c == '-' || Character.isDigit(c)) {
                var start = i;
                while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '-' || s.charAt(i) == '.' || s.charAt(i) == 'e' || s.charAt(i) == 'E' || s.charAt(i) == '+')) i++;
                var numStr = s.substring(start, i);
                if (numStr.contains(".")) {
                    map.put(key, Double.parseDouble(numStr));
                } else {
                    map.put(key, Long.parseLong(numStr));
                }
            } else if (c == 't' || c == 'f' || c == 'n') {
                if (s.startsWith("true", i)) { map.put(key, true); i += 4; }
                else if (s.startsWith("false", i)) { map.put(key, false); i += 5; }
                else if (s.startsWith("null", i)) { map.put(key, null); i += 4; }
                else break;
            } else if (c == '{' || c == '[') {
                return null;
            } else {
                break;
            }
            while (i < s.length() && s.charAt(i) != ',') {
                if (s.charAt(i) == '}') break;
                i++;
            }
            if (i < s.length() && s.charAt(i) == ',') i++;
            if (i < s.length() && s.charAt(i) == '}') break;
        }
        return map;
    }

    private static boolean isEscapedQuote(String s, int quotePos) {
        int backslashes = 0;
        for (int j = quotePos - 1; j >= 0 && s.charAt(j) == '\\'; j--) backslashes++;
        return backslashes % 2 == 1;
    }

    static String unescapeJson(String s) {
        var sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            var c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                var next = s.charAt(i + 1);
                switch (next) {
                    case 'n' -> { sb.append('\n'); i++; }
                    case 'r' -> { sb.append('\r'); i++; }
                    case 't' -> { sb.append('\t'); i++; }
                    case 'b' -> { sb.append('\b'); i++; }
                    case 'f' -> { sb.append('\f'); i++; }
                    case '"' -> { sb.append('"'); i++; }
                    case '\\' -> { sb.append('\\'); i++; }
                    case '/' -> { sb.append('/'); i++; }
                    case 'u' -> {
                        if (i + 5 < s.length()) {
                            try {
                                var codePt = Integer.parseInt(s.substring(i + 2, i + 6), 16);
                                if (Character.isValidCodePoint(codePt)) {
                                    sb.appendCodePoint(codePt);
                                }
                                i += 5;
                            } catch (NumberFormatException ignored) { sb.append(c); }
                        } else { sb.append(c); }
                    }
                    default -> sb.append(c);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
