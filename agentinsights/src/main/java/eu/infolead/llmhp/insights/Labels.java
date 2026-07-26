package eu.infolead.llmhp.insights;

import java.util.*;

public final class Labels {

    public static final Map<String, String> MAP = new LinkedHashMap<>();
    static {
        var m = MAP;
        m.put("debug_investigate", "Debug/Investigate"); m.put("implement_feature", "Implement Feature");
        m.put("fix_bug", "Fix Bug"); m.put("write_script_tool", "Write Script/Tool");
        m.put("refactor_code", "Refactor Code"); m.put("configure_system", "Configure System");
        m.put("create_pr_commit", "Create PR/Commit"); m.put("analyze_data", "Analyze Data");
        m.put("understand_codebase", "Understand Codebase"); m.put("write_tests", "Write Tests");
        m.put("write_docs", "Write Docs"); m.put("deploy_infra", "Deploy/Infra");
        m.put("fully_achieved", "Fully Achieved"); m.put("mostly_achieved", "Mostly Achieved");
        m.put("partially_achieved", "Partially Achieved"); m.put("not_achieved", "Not Achieved");
        m.put("unclear_from_transcript", "Unclear"); m.put("single_task", "Single Task");
        m.put("multi_task", "Multi Task"); m.put("iterative_refinement", "Iterative Refinement");
        m.put("exploration", "Exploration"); m.put("quick_question", "Quick Question");
        m.put("frustrated", "Frustrated"); m.put("dissatisfied", "Dissatisfied");
        m.put("likely_satisfied", "Likely Satisfied"); m.put("satisfied", "Satisfied");
        m.put("happy", "Happy"); m.put("unsure", "Unsure"); m.put("neutral", "Neutral");
        m.put("delighted", "Delighted"); m.put("misunderstood_request", "Misunderstood Request");
        m.put("wrong_approach", "Wrong Approach"); m.put("buggy_code", "Buggy Code");
        m.put("user_rejected_action", "User Rejected Action"); m.put("excessive_changes", "Excessive Changes");
        m.put("slow_or_verbose", "Slow/Verbose"); m.put("tool_failed", "Tool Failed");
        m.put("user_unclear", "User Unclear"); m.put("external_issue", "External Issue");
        m.put("fast_accurate_search", "Fast/Accurate Search"); m.put("correct_code_edits", "Correct Code Edits");
        m.put("good_explanations", "Good Explanations"); m.put("proactive_help", "Proactive Help");
        m.put("multi_file_changes", "Multi-file Changes"); m.put("good_debugging", "Good Debugging");
    }

    public static String label(String key) {
        if (key == null) return "";
        return MAP.getOrDefault(key, key.replace('_', ' '));
    }

    public static String display(String key) {
        var s = label(key);
        if (s.isEmpty()) return s;
        var words = s.split(" ");
        var sb = new StringBuilder();
        for (var w : words) {
            if (w.isEmpty()) continue;
            if (!sb.isEmpty()) sb.append(" ");
            sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return sb.toString();
    }
}
