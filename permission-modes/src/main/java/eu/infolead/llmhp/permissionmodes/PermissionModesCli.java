package eu.infolead.llmhp.permissionmodes;

import java.nio.file.Path;
import java.io.*;

public final class PermissionModesCli {

    public static void main(String... args) {
        if (args.length < 1) {
            System.err.println("usage: permission-modes <check|transition|status|state|load|save> [...]");
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
                System.out.printf("""
                    {"allowed":%s,"reason":"%s","promptUser":%s,"mode":"%s","autoStripped":%s}
                    """.strip().formatted(
                        result.allowed(),
                        safeJson(result.reason()),
                        result.promptUser(),
                        modes.currentMode().modeName(),
                        modes.isAutoStripped()));
            }
            case "transition" -> {
                if (args.length < 3) { System.err.println("transition <projectDir> <targetMode>"); System.exit(1); }
                var targetName = args[2];
                if (!PermissionModes.Mode.isValid(targetName)) {
                    System.out.printf("{\"error\":\"unknown mode: %s\"}%n", safeJson(targetName));
                    return;
                }
                modes.transitionPermissionMode(targetName);
                System.out.printf("""
                    {"mode":"%s","symbol":"%s"}
                    """.strip().formatted(
                        modes.currentMode().modeName(),
                        modes.currentMode().symbol()));
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
                System.out.printf("""
                    {"mode":"%s","symbol":"%s","blockedCategories":["%s"],"allows":["%s"],"denys":["%s"],"bypassImmuneCount":%d,"autoStripped":%s}
                    """.strip().formatted(
                        modes.currentMode().modeName(),
                        modes.currentMode().symbol(),
                        blocked.toString(),
                        allows.toString(),
                        denys.toString(),
                        modes.bypassImmunePatterns().size(),
                        modes.isAutoStripped()));
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
                System.out.printf("{\"immune\":%s}%n", modes.isBypassImmune(toolName, filePath));
            }
            default -> {
                System.err.println("unknown subcommand: " + subcommand);
                System.exit(1);
            }
        }
    }

    private static String safeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                 .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
