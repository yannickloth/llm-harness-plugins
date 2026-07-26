package eu.infolead.llmhp.insights;

import eu.infolead.llmhp.insights.types.*;

import java.util.*;

public final class Aggregator {

    public static AggregatedData aggregate(List<SessionMeta> sessions, Map<String, SessionFacets> facets) {
        var result = AggregatedData.empty();
        var dates = new ArrayList<String>();
        var allResponseTimes = new ArrayList<Double>();
        var allMessageHours = new ArrayList<Integer>();

        var tc = new HashMap<>(result.toolCounts());
        var lg = new HashMap<>(result.languages());
        var proj = new HashMap<>(result.projects());
        var goals = new HashMap<>(result.goalCategories());
        var outcomes = new HashMap<>(result.outcomes());
        var sat = new HashMap<>(result.satisfaction());
        var help = new HashMap<>(result.helpfulness());
        var stypes = new HashMap<>(result.sessionTypes());
        var fric = new HashMap<>(result.friction());
        var succ = new HashMap<>(result.success());
        var errCats = new HashMap<>(result.toolErrorCategories());

        long totalMsgs = 0, totalIn = 0, totalOut = 0;
        double totalHours = 0;
        int totalGitC = 0, totalGitP = 0;
        int totalInter = 0, totalErrs = 0;
        int taCount = 0, mcpCount = 0, wsCount = 0, wfCount = 0;
        int totalLa = 0, totalLr = 0, totalFm = 0;
        var summaries = new ArrayList<AggregatedData.SessionSummary>();

        for (var session : sessions) {
            dates.add(session.startTime());
            totalMsgs += session.userMessageCount();
            totalHours += session.durationMinutes() / 60.0;
            totalIn += session.inputTokens();
            totalOut += session.outputTokens();
            totalGitC += session.gitCommits();
            totalGitP += session.gitPushes();
            totalInter += session.userInterruptions();
            totalErrs += session.toolErrors();
            totalLa += session.linesAdded();
            totalLr += session.linesRemoved();
            totalFm += session.filesModified();

            if (session.usesTaskAgent()) taCount++;
            if (session.usesMcp()) mcpCount++;
            if (session.usesWebSearch()) wsCount++;
            if (session.usesWebFetch()) wfCount++;

            allResponseTimes.addAll(session.userResponseTimes());
            allMessageHours.addAll(session.messageHours());

            for (var e : session.toolCounts().entrySet()) tc.merge(e.getKey(), e.getValue(), Integer::sum);
            for (var e : session.languages().entrySet()) lg.merge(e.getKey(), e.getValue(), Integer::sum);
            for (var e : session.toolErrorCategories().entrySet()) errCats.merge(e.getKey(), e.getValue(), Integer::sum);

            if (!session.projectPath().isEmpty())
                proj.merge(session.projectPath(), 1, Integer::sum);

            var sf = facets.get(session.sessionId());
            if (sf != null) {
                for (var e : sf.goalCategories().entrySet())
                    if (e.getValue() > 0) goals.merge(e.getKey(), e.getValue(), Integer::sum);
                outcomes.merge(sf.outcome(), 1, Integer::sum);
                for (var e : sf.userSatisfactionCounts().entrySet())
                    if (e.getValue() > 0) sat.merge(e.getKey(), e.getValue(), Integer::sum);
                help.merge(sf.claudeHelpfulness(), 1, Integer::sum);
                stypes.merge(sf.sessionType(), 1, Integer::sum);
                for (var e : sf.frictionCounts().entrySet())
                    if (e.getValue() > 0) fric.merge(e.getKey(), e.getValue(), Integer::sum);
                if (!sf.primarySuccess().equals("none")) succ.merge(sf.primarySuccess(), 1, Integer::sum);

                if (summaries.size() < 50) {
                    var datePart = session.startTime().contains("T")
                        ? session.startTime().substring(0, session.startTime().indexOf('T'))
                        : session.startTime();
                    summaries.add(new AggregatedData.SessionSummary(
                        session.sessionId().length() > 8 ? session.sessionId().substring(0, 8) : session.sessionId(),
                        datePart,
                        session.summary().orElse(session.firstPrompt().length() > 100
                            ? session.firstPrompt().substring(0, 97) + "..."
                            : session.firstPrompt()),
                        Optional.ofNullable(sf.underlyingGoal())
                    ));
                }
            }
        }

        dates.sort(String::compareTo);
        var dateStart = dates.isEmpty() ? "" : dates.getFirst();
        var dateEnd = dates.isEmpty() ? "" : dates.getLast();
        if (dateStart.contains("T")) dateStart = dateStart.substring(0, dateStart.indexOf('T'));
        if (dateEnd.contains("T")) dateEnd = dateEnd.substring(0, dateEnd.indexOf('T'));

        double medianRt = 0, avgRt = 0;
        if (!allResponseTimes.isEmpty()) {
            var sorted = allResponseTimes.stream().sorted().toList();
            int mid = sorted.size() / 2;
            medianRt = sorted.size() % 2 == 0
                ? (sorted.get(mid - 1) + sorted.get(mid)) / 2.0
                : sorted.get(mid);
            avgRt = allResponseTimes.stream().mapToDouble(Double::doubleValue).average().orElse(0);
        }

        var daysActive = new HashSet<String>();
        for (var d : dates) {
            if (!d.isEmpty()) daysActive.add(d);
        }

        var mc = MultiClaudingDetector.detect(sessions);

        return new AggregatedData(
            sessions.size(), facets.size(), new AggregatedData.DateRange(dateStart, dateEnd),
            totalMsgs, totalHours, totalIn, totalOut,
            tc, lg, totalGitC, totalGitP, proj,
            goals, outcomes, sat, help, stypes, fric, succ,
            summaries,
            totalInter, totalErrs, errCats,
            allResponseTimes, medianRt, avgRt,
            taCount, mcpCount, wsCount, wfCount,
            totalLa, totalLr, totalFm,
            daysActive.size(),
            daysActive.isEmpty() ? 0 : (double) totalMsgs / daysActive.size(),
            allMessageHours, mc
        );
    }
}
