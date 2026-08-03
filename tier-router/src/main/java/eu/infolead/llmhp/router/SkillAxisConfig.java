package eu.infolead.llmhp.router;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

final class SkillAxisConfig {

    private SkillAxisConfig() {}

    static List<SkillAxisMapping> load(Path jsonPath) {
        if (!Files.exists(jsonPath)) return List.of();
        try {
            var raw = Files.readString(jsonPath);
            return parseMapping(raw);
        } catch (Exception e) {
            System.err.println("[tier-router] skill-axis config load failed: " + e.getMessage());
            return List.of();
        }
    }

    static List<SkillAxisMapping> parseMapping(String json) {
        var mappings = new ArrayList<SkillAxisMapping>();
        var segments = json.split("\"axis\"\\s*:\\s*\"");
        for (int i = 1; i < segments.length; i++) {
            var seg = segments[i];
            var axisEnd = seg.indexOf('"');
            if (axisEnd < 0) continue;
            var axisName = seg.substring(0, axisEnd).toUpperCase();

            var modelStart = seg.indexOf("\"model\"", axisEnd);
            if (modelStart < 0) continue;
            var modelValStart = seg.indexOf('"', modelStart + 7) + 1;
            var modelValEnd = seg.indexOf('"', modelValStart);
            var model = seg.substring(modelValStart, modelValEnd);

            var initial = "";
            var fbIdx = seg.indexOf("\"initial\"");
            if (fbIdx >= 0) {
                var colonIdx = seg.indexOf(':', fbIdx + 9);
                if (colonIdx >= 0) {
                    var afterColon = seg.substring(colonIdx + 1).strip();
                    if (afterColon.startsWith("\"")) {
                        var fbValStart = colonIdx + 1 + (seg.substring(colonIdx + 1).indexOf('"')) + 1;
                        var fbValEnd = seg.indexOf('"', fbValStart);
                        if (fbValEnd >= 0) {
                            initial = seg.substring(fbValStart, fbValEnd);
                        }
                    }
                }
            }

            var matchTypeStr = "direct";
            var mtIdx = seg.indexOf("\"matchType\"");
            if (mtIdx >= 0) {
                var mtValStart = seg.indexOf('"', mtIdx + 11) + 1;
                var mtValEnd = seg.indexOf('"', mtValStart);
                var rawMt = seg.substring(mtValStart, mtValEnd);
                matchTypeStr = rawMt.equals("generalist") ? "generalist" : "direct";
            }

            var note = "";
            var noteIdx = seg.indexOf("\"note\"");
            if (noteIdx >= 0) {
                var noteValStart = seg.indexOf('"', noteIdx + 6) + 1;
                var noteValEnd = seg.indexOf('"', noteValStart);
                note = seg.substring(noteValStart, noteValEnd);
            }

            try {
                var axis = SkillAxis.valueOf(axisName);
                var matchType = matchTypeStr.equals("generalist")
                    ? SkillAxisMapping.MatchType.generalist
                    : SkillAxisMapping.MatchType.direct;
                mappings.add(new SkillAxisMapping(axis, model, initial.isEmpty() ? null : initial, matchType, note));
            } catch (IllegalArgumentException e) {
                System.err.println("[tier-router] unknown skill axis: " + axisName);
            }
        }
        return mappings;
    }

    static Map<SkillAxis, SkillAxisMapping> toMap(List<SkillAxisMapping> mappings) {
        return mappings.stream()
            .collect(Collectors.toMap(SkillAxisMapping::axis, m -> m, (a, b) -> b));
    }

    static Optional<SkillAxisMapping> lookup(Map<SkillAxis, SkillAxisMapping> map, SkillAxis axis) {
        return Optional.ofNullable(map.get(axis));
    }
}
