import module java.base;

class SessionLifecycle {
    public static void main(String... args) {
        if (args.length < 2) {
            System.err.println("usage: session-lifecycle <record-access|record-edit|check-errors|snapshot-commits|diff-commits|archive|sweep> <project-dir> [args...]");
            System.exit(1);
        }
        var subcommand = args[0];
        var projectDir = args[1];
        var trailingArgs = java.util.Arrays.copyOfRange(args, 2, args.length);

        injectEnv("OPENCODE_PROJECT_DIR", projectDir);
        injectEnv("CLAUDE_PROJECT_DIR", projectDir);  // consumers read this name; keep both for compatibility

        switch (subcommand) {
            case "record-access" -> {
                if (trailingArgs.length < 2) { System.err.println("record-access expects: session_id access_type [file_path]"); System.exit(1); }
                var sessionId = trailingArgs[0];
                var accessType = trailingArgs[1];
                if (trailingArgs.length >= 3) {
                    var stdinJson = "{\"session_id\":\"" + escape(sessionId) + "\",\"access_type\":\"" + escape(accessType) + "\",\"tool_input\":{\"file_path\":\"" + escape(trailingArgs[2]) + "\"}}";
                    System.setIn(new java.io.ByteArrayInputStream(stdinJson.getBytes(StandardCharsets.UTF_8)));
                }
                new LogFileChange().main();
            }
            case "record-edit" -> {
                if (trailingArgs.length < 1) { System.err.println("record-edit expects: session_id [file_path]"); System.exit(1); }
                var sessionId = trailingArgs[0];
                if (trailingArgs.length >= 2) {
                    var stdinJson = "{\"session_id\":\"" + escape(sessionId) + "\",\"access_type\":\"edit\",\"tool_input\":{\"file_path\":\"" + escape(trailingArgs[1]) + "\"}}";
                    System.setIn(new java.io.ByteArrayInputStream(stdinJson.getBytes(StandardCharsets.UTF_8)));
                }
                new LogFileChange().main();
            }
            case "check-errors" -> {
                new SessionStartErrors().main();
            }
            case "snapshot-commits" -> {
                var sessionId = trailingArgs.length > 0 ? trailingArgs[0] : "unknown";
                var stdinJson = "{\"session_id\":\"" + escape(sessionId) + "\"}";
                System.setIn(new java.io.ByteArrayInputStream(stdinJson.getBytes(StandardCharsets.UTF_8)));
                new SessionStartCommits().main();
            }
            case "diff-commits" -> {
                var sessionId = trailingArgs.length > 0 ? trailingArgs[0] : "unknown";
                var stdinJson = "{\"session_id\":\"" + escape(sessionId) + "\"}";
                System.setIn(new java.io.ByteArrayInputStream(stdinJson.getBytes(StandardCharsets.UTF_8)));
                new SessionEndCommits().main();
            }
            case "archive" -> {
                var sessionId = trailingArgs.length > 0 ? trailingArgs[0] : "unknown";
                var stdinJson = "{\"session_id\":\"" + escape(sessionId) + "\"}";
                System.setIn(new java.io.ByteArrayInputStream(stdinJson.getBytes(StandardCharsets.UTF_8)));
                new SessionEndArchive().main();
            }
            case "sweep" -> new SessionSweep().main();
            case "breaker-fail" -> new SessionBreakers().main();
            case "breaker-success" -> new SessionBreakers().main();
            case "breaker-check" -> new SessionBreakers().main();
            case "breaker-reset" -> new SessionBreakers().main();
            case "auto-gate-check" -> new AutoModeGate().main();
            case "auto-gate-disable" -> new AutoModeGate().main();
            case "auto-gate-reset" -> new AutoModeGate().main();
            case "auto-gate-status" -> new AutoModeGate().main();
            default -> {
            System.err.println("usage: session-lifecycle <record-access|record-edit|check-errors|snapshot-commits|diff-commits|archive|sweep|breaker-fail|breaker-success|breaker-check|breaker-reset|auto-gate-check|auto-gate-disable|auto-gate-reset|auto-gate-status> <project-dir> [args...]");
                System.exit(1);
            }
        }
    }

    private static void injectEnv(String key, String value) {
        try {
            var env = System.getenv();
            var field = env.getClass().getDeclaredField("m");
            field.setAccessible(true);
            @SuppressWarnings("unchecked")
            var map = (java.util.Map<String, String>) field.get(env);
            map.put(key, value);
        } catch (Throwable t) {
            System.err.println("[session-lifecycle] cannot inject env " + key + "; hooks will fall back to user.dir");
        }
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                 .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
