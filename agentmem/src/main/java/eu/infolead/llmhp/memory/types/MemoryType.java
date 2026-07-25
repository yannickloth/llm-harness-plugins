package eu.infolead.llmhp.memory.types;

sealed interface MemoryType permits MemoryType.User, MemoryType.Feedback, MemoryType.Project, MemoryType.Reference {

    record User() implements MemoryType {}
    record Feedback() implements MemoryType {}
    record Project() implements MemoryType {}
    record Reference() implements MemoryType {}

    static MemoryType fromString(String s) {
        return switch (s.toLowerCase()) {
            case "user" -> new User();
            case "feedback" -> new Feedback();
            case "project" -> new Project();
            case "reference" -> new Reference();
            default -> throw new IllegalArgumentException("Unknown memory type: " + s);
        };
    }

    static String toString(MemoryType t) {
        return switch (t) {
            case User _ -> "user";
            case Feedback _ -> "feedback";
            case Project _ -> "project";
            case Reference _ -> "reference";
        };
    }
}
