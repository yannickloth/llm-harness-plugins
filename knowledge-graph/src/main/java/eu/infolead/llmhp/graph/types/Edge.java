package eu.infolead.llmhp.graph.types;

import java.util.*;

public record Edge(
    String source,
    String target,
    String type,
    Map<String, String> properties
) {
    public Map<String, Object> toMap() {
        var map = new LinkedHashMap<String, Object>();
        map.put("source", source);
        map.put("target", target);
        map.put("type", type);
        map.put("properties", properties);
        return map;
    }
}
