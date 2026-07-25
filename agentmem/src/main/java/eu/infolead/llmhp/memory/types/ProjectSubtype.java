package eu.infolead.llmhp.memory.types;

sealed interface ProjectSubtype permits ProjectSubtype.Failure, ProjectSubtype.Serendipity, ProjectSubtype.Anomaly, ProjectSubtype.Digest, ProjectSubtype.Question, ProjectSubtype.Episode {

    record Failure() implements ProjectSubtype {}
    record Serendipity() implements ProjectSubtype {}
    record Anomaly() implements ProjectSubtype {}
    record Digest() implements ProjectSubtype {}
    record Question() implements ProjectSubtype {}
    record Episode() implements ProjectSubtype {}

    static ProjectSubtype fromString(String s) {
        return switch (s.toLowerCase()) {
            case "failure" -> new Failure();
            case "serendipity" -> new Serendipity();
            case "anomaly" -> new Anomaly();
            case "digest" -> new Digest();
            case "question" -> new Question();
            case "episode" -> new Episode();
            default -> throw new IllegalArgumentException("Unknown project subtype: " + s);
        };
    }

    static String toString(ProjectSubtype s) {
        return switch (s) {
            case Failure _ -> "failure";
            case Serendipity _ -> "serendipity";
            case Anomaly _ -> "anomaly";
            case Digest _ -> "digest";
            case Question _ -> "question";
            case Episode _ -> "episode";
        };
    }
}
