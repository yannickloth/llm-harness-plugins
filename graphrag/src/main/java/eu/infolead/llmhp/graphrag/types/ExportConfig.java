package eu.infolead.llmhp.graphrag.types;

import java.nio.file.*;
import java.util.*;

public record ExportConfig(
    String projectName,
    Path projectRoot,
    String latexRoot,
    List<String> excludeDirs,
    Models models,
    boolean autoUpdate,
    int debounceSeconds,
    String graphragBinary,
    String indexRoot
) {

    public record Models(
        String chatModel,
        String chatApiKeyEnv,
        String chatApiBase,
        String embeddingProvider,
        String embeddingModel,
        String embeddingApiBase,
        String embeddingApiKeyEnv
    ) {}

    public static ExportConfig parse(String yaml, Path harnessRoot, Path projectRootOverride) {
        String projectName = "";
        String projectRoot = "";
        String latexRoot = "src/legacy/latex";
        var excludeDirs = new ArrayList<String>();
        String chatModel = "";
        String chatApiKeyEnv = "OPENROUTER_API_KEY";
        String chatApiBase = "";
        String embeddingProvider = "ollama";
        String embeddingModel = "nomic-embed-text";
        String embeddingApiBase = "http://localhost:11434";
        String embeddingApiKeyEnv = "GRAPHRAG_API_KEY";
        boolean autoUpdate = true;
        int debounce = 300;
        String graphragBinary = "graphrag";
        String indexRoot = "graph-index";

        String section = "";
        boolean inProjects = false;
        boolean inExclude = false;

        for (var raw : yaml.split("\n")) {
            if (raw.isBlank()) continue;
            var line = raw.strip();
            if (line.startsWith("#")) continue;

            if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
                inExclude = false;
                if (line.equals("models:")) { section = "models"; inProjects = false; continue; }
                if (line.equals("projects:")) { section = "projects"; inProjects = true; continue; }
                section = "";
            }

            if (inExclude) {
                if (line.startsWith("- ")) {
                    excludeDirs.add(unquote(line.substring(2).strip()));
                    continue;
                }
                inExclude = false;
            }

            int colon = line.indexOf(':');
            if (colon < 0) continue;
            var key = line.substring(0, colon).strip();
            var value = unquote(line.substring(colon + 1).strip());

            switch (key) {
                case "exclude" -> { if (value.isEmpty()) inExclude = true; }
                case "auto_update" -> autoUpdate = value.equalsIgnoreCase("true");
                case "debounce_seconds" -> debounce = Integer.parseInt(value);
                case "graphrag_binary" -> graphragBinary = value;
                case "index_root" -> indexRoot = value;
                case "chat_model" -> chatModel = value;
                case "chat_api_key_env" -> chatApiKeyEnv = value;
                case "chat_api_base" -> chatApiBase = value;
                case "embedding_provider" -> embeddingProvider = value;
                case "embedding_model" -> embeddingModel = value;
                case "embedding_api_base" -> embeddingApiBase = value;
                case "embedding_api_key_env" -> embeddingApiKeyEnv = value;
                case "name" -> { if (inProjects) projectName = value; }
                case "root" -> { if (inProjects) projectRoot = value; }
                case "latex_root" -> { if (inProjects && !value.isEmpty()) latexRoot = value; }
                default -> {}
            }
        }

        if (excludeDirs.isEmpty()) {
            excludeDirs.addAll(List.of("result", "target", "downloads", ".git", "graph-index",
                "tmp", "build", ".direnv", ".direnv-cache", "node_modules", "literature"));
        }

        var root = projectRootOverride != null ? projectRootOverride : Path.of(projectRoot);

        return new ExportConfig(
            projectName.isEmpty() ? root.getFileName().toString() : projectName,
            root,
            latexRoot,
            List.copyOf(excludeDirs),
            new Models(chatModel, chatApiKeyEnv, chatApiBase, embeddingProvider, embeddingModel,
                embeddingApiBase, embeddingApiKeyEnv),
            autoUpdate, debounce, graphragBinary, indexRoot
        );
    }

    private static String unquote(String s) {
        if (s.length() >= 2) {
            var first = s.charAt(0);
            var last = s.charAt(s.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\''))
                return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
