package eu.infolead.llmhp.router;

/**
 * CLI for tier-router engine. Invoked by OpenCode/Claude Code/Pi plugins via shell.
 *
 * Usage:
 *   echo "Fix typo in src/main.py" | java ... RouterCli classify
 *   echo "Design a caching system" | java ... RouterCli route
 *   java ... RouterCli rewrite <tier> <<< "Fix the bug"
 */
final class RouterCli {

    private static final RouterEngine engine = new RouterEngine();

    void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: RouterCli <classify|route|rewrite> [args...]");
            System.exit(1);
            return;
        }

        var cmd = args[0];
        switch (cmd) {
            case "classify" -> classify();
            case "route" -> route();
            case "rewrite" -> {
                if (args.length < 2) {
                    System.err.println("rewrite requires tier argument");
                    System.exit(1);
                }
                rewrite(args[1]);
            }
            case "ambiguity" -> ambiguity();
            default -> {
                System.err.println("Unknown command: " + cmd);
                System.exit(1);
            }
        }
    }

    private void classify() throws Exception {
        var prompt = readStdin();
        var result = engine.route(prompt);
        System.out.println(result.toJson());
    }

    private void route() throws Exception {
        var prompt = readStdin();
        var result = engine.routeWithRewrite(prompt);
        System.out.println(result.toJson());
    }

    private void rewrite(String tierStr) throws Exception {
        var reformatter = new Reformatter();
        var prompt = readStdin();
        var tier = Tier.from(tierStr);
        var rewritten = reformatter.rewrite(prompt, tier);
        System.out.println(rewritten);
    }

    private void ambiguity() throws Exception {
        var reformatter = new Reformatter();
        var prompt = readStdin();
        if (reformatter.needsUserClarification(prompt)) {
            System.out.println("ambiguous:" + String.join("\n", reformatter.generateClarificationQuestions(prompt)));
        } else {
            System.out.println("clear");
        }
    }

    private String readStdin() throws Exception {
        try (var reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in))) {
            var sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString().strip();
        }
    }
}
