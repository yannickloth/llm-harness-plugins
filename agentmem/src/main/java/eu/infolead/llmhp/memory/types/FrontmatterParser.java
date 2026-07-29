package eu.infolead.llmhp.memory.types;

import java.util.LinkedHashMap;
import java.util.Map;

public final class FrontmatterParser {

    public static Map<String, String> parse(String raw) {
        var result = new LinkedHashMap<String, String>();
        var lines = raw.split("\n");
        if (lines.length == 0 || !lines[0].trim().equals("---")) return result;
        for (int i = 1; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.equals("---")) break;
            var colon = line.indexOf(':');
            if (colon > 0) result.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
        }
        return result;
    }
}
