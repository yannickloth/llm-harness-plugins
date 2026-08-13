package eu.infolead.llmhp.permissionmodes;

import java.nio.file.Path;
import java.io.*;

public final class PermissionModesCli {

    public static void main(String... args) {
        if (args.length < 1) {
            System.err.println("usage: permission-modes <check|transition|status|state|load|save|immune> [...]");
            System.exit(1);
        }
        var subcommand = args[0];
        var projectDir = args.length > 1 ? args[1] : System.getProperty("user.dir", ".");
        var modes = new PermissionModes(Path.of(projectDir));

        try { modes.loadState(); } catch (IOException e) { /* fresh start */ }

        switch (subcommand) {
            case "check" -> {
                if (args.length < 3) { System.err.println("check <projectDir> <toolName> [filePath]"); System.exit(1); }
                var toolName = args[2];
                var filePath = args.length > 3 ? args[3] : "";
                var result = modes.checkPermission(toolName, filePath);
                System.out.println(
                    "{\"allowed\":" + result.allowed()
                    + ",\"reason\":\"" + safeJson(result.reason())
                    + "\",\"promptUser\":" + result.promptUser()
                    + ",\"mode\":\"" + modes.currentMode().modeName()
                    + "\",\"autoStripped\":" + modes.isAutoStripped() + "}");
            }
            case "transition" -> {
                if (args.length < 3) { System.err.println("transition <projectDir> <targetMode>"); System.exit(1); }
                var targetName = args[2];
                if (!PermissionModes.Mode.isValid(targetName)) {
                    System.out.println("{\"error\":\"unknown mode: " + safeJson(targetName) + "\"}");
                    return;
                }
                modes.transitionPermissionMode(targetName);
                System.out.println(
                    "{\"mode\":\"" + modes.currentMode().modeName()
                    + "\",\"symbol\":\"" + modes.currentMode().symbol() + "\"}");
                try { modes.saveState(); } catch (IOException e) { System.err.println("save failed: " + e); }
            }
            case "status" -> {
                var cfg = modes.configFor(modes.currentMode());
                var blocked = new StringBuilder();
                for (var b : cfg.categoryBlocked().entrySet()) {
                    if (b.getValue()) {
                        if (!blocked.isEmpty()) blocked.append(",");
                        blocked.append(b.getKey().label());
                    }
                }
                var allows = new StringBuilder();
                for (var a : cfg.toolAllows().keySet()) {
                    if (!allows.isEmpty()) allows.append(",");
                    allows.append(a);
                }
                var denys = new StringBuilder();
                for (var d : cfg.toolDenys().entrySet()) {
                    if (!denys.isEmpty()) denys.append(",");
                    denys.append(d.getKey());
                }
                System.out.println(
                    "{\"mode\":\"" + modes.currentMode().modeName()
                    + "\",\"symbol\":\"" + modes.currentMode().symbol()
                    + "\",\"blockedCategories\":[" + toJsonArray(blocked.toString())
                    + "],\"allows\":[" + toJsonArray(allows.toString())
                    + "],\"denys\":[" + toJsonArray(denys.toString())
                    + "],\"bypassImmuneCount\":" + modes.bypassImmunePatterns().size()
                    + ",\"autoStripped\":" + modes.isAutoStripped() + "}");
            }
            case "state" -> {
                System.out.println(modes.stateToJson());
            }
            case "save" -> {
                try { modes.saveState(); System.out.println("{\"saved\":true}"); }
                catch (IOException e) { System.out.println("{\"saved\":false,\"error\":\"" + safeJson(e.getMessage()) + "\"}"); }
            }
            case "load" -> {
                try { modes.loadState(); System.out.println("{\"loaded\":true,\"mode\":\"" + modes.currentMode().modeName() + "\",\"autoStripped\":" + modes.isAutoStripped() + "}"); }
                catch (IOException e) { System.out.println("{\"loaded\":false,\"error\":\"" + safeJson(e.getMessage()) + "\"}"); }
            }
            case "immune" -> {
                if (args.length < 4) { System.err.println("immune <projectDir> <toolName> <filePath>"); System.exit(1); }
                var toolName = args[2];
                var filePath = args[3];
                System.out.println("{\"immune\":" + modes.isBypassImmune(toolName, filePath) + "}");
            }
            default -> {
                System.err.println("unknown subcommand: " + subcommand);
                System.exit(1);
            }
        }
    }

    private static String toJsonArray(String csv) {
        if (csv.isEmpty()) return "";
        var sb = new StringBuilder();
        var first = true;
        for (var part : csv.split(",")) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(safeJson(part)).append("\"");
        }
        return sb.toString();
    }

    private static String safeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                 .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
