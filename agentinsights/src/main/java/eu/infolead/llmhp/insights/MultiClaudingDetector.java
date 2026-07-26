package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.AggregatedData;
import eu.infolead.llmhp.insights.types.SessionMeta;

import java.util.*;

public final class MultiClaudingDetector {

    static final long OVERLAP_WINDOW_MS = 30 * 60 * 1000;

    public record MessageEvent(long ts, String sessionId) {}

    public static AggregatedData.MultiClaudingStats detect(List<SessionMeta> sessions) {

        var allMessages = new ArrayList<MessageEvent>();
        for (var session : sessions) {
            for (var ts : session.userMessageTimestamps()) {
                try {
                    var millis = parseTimestampToMillis(ts);
                    if (millis >= 0) allMessages.add(new MessageEvent(millis, session.sessionId()));
                } catch (Exception ignored) {}
            }
        }
        allMessages.sort(Comparator.comparingLong(MessageEvent::ts));

        var overlaps = new HashSet<String>();
        var involved = new HashSet<String>();
        var overlappingMessages = new HashSet<String>();

        var sessionLastIdx = new HashMap<String, Integer>();
        int windowStart = 0;

        for (int i = 0; i < allMessages.size(); i++) {
            var msg = allMessages.get(i);

            while (windowStart < i && msg.ts() - allMessages.get(windowStart).ts() > OVERLAP_WINDOW_MS) {
                var expiring = allMessages.get(windowStart);
                var lastIdx = sessionLastIdx.getOrDefault(expiring.sessionId(), -1);
                if (lastIdx == windowStart) sessionLastIdx.remove(expiring.sessionId());
                windowStart++;
            }

            var prevIdx = sessionLastIdx.get(msg.sessionId());
            if (prevIdx != null) {
                for (int j = prevIdx + 1; j < i; j++) {
                    var between = allMessages.get(j);
                    if (!between.sessionId().equals(msg.sessionId())) {
                        var pair = msg.sessionId().compareTo(between.sessionId()) < 0
                            ? msg.sessionId() + ":" + between.sessionId()
                            : between.sessionId() + ":" + msg.sessionId();
                        overlaps.add(pair);
                        involved.add(msg.sessionId());
                        involved.add(between.sessionId());
                        overlappingMessages.add(msg.sessionId() + ":" + msg.ts());
                        overlappingMessages.add(between.sessionId() + ":" + between.ts());
                        break;
                    }
                }
            }
            sessionLastIdx.put(msg.sessionId(), i);
        }

        return new AggregatedData.MultiClaudingStats(overlaps.size(), involved.size(), overlappingMessages.size());
    }

    static long parseTimestampToMillis(String ts) {
        try { return java.time.Instant.parse(ts).toEpochMilli(); }
        catch (Exception e) { return -1; }
    }
}
