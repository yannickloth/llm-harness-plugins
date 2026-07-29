package eu.infolead.llmhp.promptregistry;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

final class PromptRegistryCli {
    void main(String[] args) throws Exception {
        if (args.length < 1) { usage(); return; }

        var regResult = parseRegistryDir(args);
        var registryDir = regResult.path;
        var store = new RegistryStore(registryDir);
        var cmd = args[0];
        var offset = 1 + regResult.consumed;

        switch (cmd) {
            case "commit" -> {
                if (args.length < offset + 1) { System.err.println("commit requires <name> [--from <plugin-dir>] [--author <author>]"); System.exit(1); return; }
                commit(store, args[offset], parseFlag(args, offset + 1, "--from"),
                    parseFlag(args, offset + 1, "--author"));
            }
            case "pull" -> {
                if (args.length < offset + 1) { System.err.println("pull requires <name>[@version] [--to <plugin-dir>]"); System.exit(1); return; }
                pull(store, args[offset], parseFlag(args, offset + 1, "--to"));
            }
            case "pull-all" -> {
                pullAll(store, parseFlag(args, offset, "--to"));
            }
            case "list" -> {
                var name = args.length >= offset + 1 ? args[offset] : null;
                list(store, name);
            }
            case "diff" -> {
                if (args.length < offset + 3) { System.err.println("diff requires <name> <v1> <v2>"); System.exit(1); return; }
                try {
                    diff(store, args[offset], Integer.parseInt(args[offset + 1]), Integer.parseInt(args[offset + 2]));
                } catch (NumberFormatException e) {
                    System.err.println("{\"error\":\"v1 and v2 must be integers\"}");
                    System.exit(1);
                }
            }
            case "test" -> {
                if (args.length < offset + 3) { System.err.println("test requires <name> <vA> <vB>"); System.exit(1); return; }
                try {
                    test(store, args[offset], Integer.parseInt(args[offset + 1]), Integer.parseInt(args[offset + 2]));
                } catch (NumberFormatException e) {
                    System.err.println("{\"error\":\"vA and vB must be integers\"}");
                    System.exit(1);
                }
            }
            case "active" -> {
                if (args.length < offset + 1) { System.err.println("active requires <name>"); System.exit(1); return; }
                active(store, args[offset]);
            }
            case "status" -> {
                status(store);
            }
            default -> { System.err.println("Unknown command: " + cmd); System.exit(1); }
        }
    }

    private String parseFlag(String[] args, int offset, String flag) {
        for (int i = offset; i < args.length - 1; i++) {
            if (args[i].equals(flag)) return args[i + 1];
        }
        return null;
    }

    record RegDirResult(Path path, int consumed) {}

    private RegDirResult parseRegistryDir(String[] args) {
        for (int i = 1; i < args.length - 1; i++) {
            if (args[i].equals("--registry-dir")) return new RegDirResult(Path.of(args[i + 1]), 2);
        }
        return new RegDirResult(Path.of(".prompt-registry", "registry"), 0);
    }

    private void commit(RegistryStore store, String name, String fromDir, String author) throws Exception {
        Path sourceDir;
        if (fromDir != null) {
            sourceDir = Path.of(fromDir, RegistryStore.PROMPTS_DIR);
        } else {
            sourceDir = Path.of(RegistryStore.PROMPTS_DIR);
        }
        var promptFile = sourceDir.resolve(name + ".md");
        if (!Files.isRegularFile(promptFile)) {
            System.err.println("{\"error\":\"prompt file not found: %s\"}".formatted(promptFile));
            System.exit(1);
            return;
        }
        var content = Files.readString(promptFile);
        var authorName = author != null ? author : System.getProperty("user.name", "unknown");
        var version = store.commit(name, content, authorName);
        System.out.println(version.toJson());
    }

    private void pull(RegistryStore store, String nameVer, String toDir) throws Exception {
        String name;
        Integer ver = null;
        if (nameVer.contains("@")) {
            var parts = nameVer.split("@", 2);
            name = parts[0];
            ver = Integer.parseInt(parts[1]);
        } else {
            name = nameVer;
        }
        var version = store.pull(name, ver);
        if (version == null) {
            System.err.println("{\"error\":\"no version found for %s\"}".formatted(name));
            System.exit(1);
            return;
        }
        Path targetDir;
        if (toDir != null) {
            targetDir = Path.of(toDir, RegistryStore.PROMPTS_DIR);
        } else {
            targetDir = Path.of(RegistryStore.PROMPTS_DIR);
        }
        Files.createDirectories(targetDir);
        Files.writeString(targetDir.resolve(name + ".md"), version.content());

        var result = new LinkedHashMap<String, Object>();
        result.put("name", version.name());
        result.put("version", version.version());
        result.put("pulled", version.slug());
        System.out.println(store.toJson(result));
    }

    private void pullAll(RegistryStore store, String toDir) throws Exception {
        var active = store.getAllActive();
        var results = new ArrayList<Map<String, Object>>();
        Path targetBase;
        if (toDir != null) {
            targetBase = Path.of(toDir, RegistryStore.PROMPTS_DIR);
        } else {
            targetBase = Path.of(RegistryStore.PROMPTS_DIR);
        }
        for (var version : active) {
            Files.createDirectories(targetBase);
            Files.writeString(targetBase.resolve(version.name() + ".md"), version.content());
            var r = new LinkedHashMap<String, Object>();
            r.put("name", version.name());
            r.put("version", version.version());
            results.add(r);
        }
        var map = new LinkedHashMap<String, Object>();
        map.put("pulled", results.size());
        map.put("prompts", results);
        System.out.println(store.toJson(map));
    }

    private void list(RegistryStore store, String name) throws Exception {
        if (name != null) {
            var versions = store.versions(name);
            var items = new ArrayList<Map<String, Object>>();
            var activeVersion = store.resolveActiveVersion(name);
            for (var v : versions) {
                var m = new LinkedHashMap<String, Object>();
                m.put("version", v.version());
                m.put("author", v.author());
                m.put("timestamp", v.timestamp().toString());
                m.put("active", v.version() == activeVersion);
                items.add(m);
            }
            var output = new LinkedHashMap<String, Object>();
            output.put("name", name);
            output.put("active_version", activeVersion > 0 ? activeVersion : null);
            output.put("versions", items);
            System.out.println(store.toJson(output));
        } else {
            var names = store.listNames();
            var items = new ArrayList<Map<String, Object>>();
            for (var n : names) {
                var versions = store.versions(n);
                var activeVersion = store.resolveActiveVersion(n);
                var m = new LinkedHashMap<String, Object>();
                m.put("name", n);
                m.put("version_count", versions.size());
                m.put("active_version", activeVersion > 0 ? activeVersion : null);
                items.add(m);
            }
            var output = new LinkedHashMap<String, Object>();
            output.put("prompts", items);
            output.put("total", items.size());
            System.out.println(store.toJson(output));
        }
    }

    private void diff(RegistryStore store, String name, int v1, int v2) throws Exception {
        var a = store.getVersion(name, v1);
        var b = store.getVersion(name, v2);
        if (a == null) { System.err.println("{\"error\":\"version v%d not found\"}".formatted(v1)); System.exit(1); return; }
        if (b == null) { System.err.println("{\"error\":\"version v%d not found\"}".formatted(v2)); System.exit(1); return; }

        var aLines = a.content().replace("\r\n", "\n").replace("\r", "\n").split("\n");
        var bLines = b.content().replace("\r\n", "\n").replace("\r", "\n").split("\n");
        var added = 0;
        var removed = 0;
        var maxLen = Math.max(aLines.length, bLines.length);
        for (int i = 0; i < maxLen; i++) {
            if (i >= aLines.length) { added++; continue; }
            if (i >= bLines.length) { removed++; continue; }
            if (!aLines[i].equals(bLines[i])) { removed++; added++; }
        }

        var output = new LinkedHashMap<String, Object>();
        output.put("name", name);
        output.put("v1", v1);
        output.put("v2", v2);
        output.put("lines_added", added);
        output.put("lines_removed", removed);
        output.put("changed", added + removed > 0);
        System.out.println(store.toJson(output));
    }

    private void test(RegistryStore store, String name, int vA, int vB) throws Exception {
        var result = store.testVariants(name, vA, vB);
        System.out.println(result.toJson());
    }

    private void active(RegistryStore store, String name) throws Exception {
        var version = store.resolveActiveVersion(name);
        var output = new LinkedHashMap<String, Object>();
        output.put("name", name);
        output.put("active_version", version > 0 ? version : null);
        System.out.println(store.toJson(output));
    }

    private void status(RegistryStore store) throws Exception {
        var names = store.listNames();
        var items = new ArrayList<Map<String, Object>>();
        for (var name : names) {
            var latest = store.getLatest(name);
            if (latest == null) continue;
            var pluginPromptsDir = Path.of(RegistryStore.PROMPTS_DIR);
            var changed = RegistryStore.hasUncommittedChanges(pluginPromptsDir, latest);
            var activeVersion = store.resolveActiveVersion(name);
            var entry = new LinkedHashMap<String, Object>();
            entry.put("name", name);
            entry.put("latest", latest.version());
            entry.put("active", activeVersion > 0 ? activeVersion : null);
            entry.put("uncommitted_changes", changed);
            items.add(entry);
        }
        var output = new LinkedHashMap<String, Object>();
        output.put("prompts", items);
        output.put("total", items.size());
        System.out.println(store.toJson(output));
    }

    void usage() {
        System.err.println("""
            PromptRegistry <cmd> [args...] [--registry-dir <dir>]
            Commands:
              commit <name> [--from <plugin-dir>] [--author <author>]
              pull <name>[@version] [--to <plugin-dir>]
              pull-all [--to <plugin-dir>]
              list [name]
              diff <name> <v1> <v2>
              test <name> <vA> <vB>
              active <name>
              status
            """);
    }
}
