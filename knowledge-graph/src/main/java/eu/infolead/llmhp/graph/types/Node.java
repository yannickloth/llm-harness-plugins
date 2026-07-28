package eu.infolead.llmhp.graph.types;

import java.util.*;

public record Node(
    String id,
    String type,
    String name,
    String file,
    String line,
    Map<String, String> properties
) {
    public String prefix() {
        var colon = id.indexOf(':');
        return colon > 0 ? id.substring(0, colon) : id;
    }

    public boolean hasProperty(String key) {
        return properties.containsKey(key);
    }

    public String property(String key) {
        return properties.getOrDefault(key, "");
    }

    public Map<String, Object> toMap() {
        var map = new LinkedHashMap<String, Object>();
        map.put("id", id);
        map.put("type", type);
        map.put("name", name);
        map.put("file", file);
        map.put("line", line);
        map.put("properties", properties);
        return map;
    }
}
