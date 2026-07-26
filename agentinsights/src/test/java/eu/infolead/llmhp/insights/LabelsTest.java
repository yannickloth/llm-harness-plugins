package eu.infolead.llmhp.insights;

import java.nio.file.*;
import java.util.*;

public class LabelsTest {
    static int passed = 0, failed = 0;

    public static void main(String[] args) {
        testKnownLabel();
        testUnknownKey();
        testNullKey();
        testDisplay();
        testAllKnownKeys();
        testConsistentMap();

        System.out.printf("\n%d passed, %d failed\n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void testKnownLabel() {
        assertEq("Debug/Investigate", Labels.label("debug_investigate"), "debug_investigate");
        assertEq("Implement Feature", Labels.label("implement_feature"), "implement_feature");
        assertEq("Fix Bug", Labels.label("fix_bug"), "fix_bug");
        assertEq("Fully Achieved", Labels.label("fully_achieved"), "fully_achieved");
        assertEq("Happy", Labels.label("happy"), "happy");
        assertEq("Misunderstood Request", Labels.label("misunderstood_request"), "misunderstood_request");
    }

    static void testUnknownKey() {
        assertEq("some key", Labels.label("some_key"), "unknown key gets underscores replaced");
    }

    static void testNullKey() {
        assertEq("", Labels.label(null), "null key returns empty string");
    }

    static void testDisplay() {
        assertEq("Debug/Investigate", Labels.display("debug_investigate"), "display capitalizes");
    }

    static void testAllKnownKeys() {
        for (var key : Labels.MAP.keySet()) {
            var result = Labels.label(key);
            if (result.isBlank()) {
                failed++;
                System.err.printf("FAIL [known key '%s' returned blank]\n", key);
            } else {
                passed++;
            }
        }
    }

    static void testConsistentMap() {
        String[] keys = {"debug_investigate", "fix_bug", "happy", "correct_code_edits"};
        for (var key : keys) {
            var label = Labels.label(key);
            var display = Labels.display(key);
            if (!Character.isUpperCase(display.charAt(0))) {
                failed++;
                System.err.printf("FAIL [display of '%s' not capitalized: '%s']\n", key, display);
            } else {
                passed++;
            }
        }
    }

    static void assertEq(String expected, String actual, String msg) {
        if (expected.equals(actual)) { passed++; } else {
            failed++;
            System.err.printf("FAIL [%s] expected='%s' actual='%s'\n", msg, expected, actual);
        }
    }
}
