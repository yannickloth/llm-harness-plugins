package eu.infolead.llmhp.memory;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.OptionalLong;

public final class ConsolidationLock {

    record LockState(long mtimeMs, OptionalLong holderPid, String bootId, boolean locked) {}

    public static void check(Path memDir) throws IOException {
        var state = readLock(memDir);
        var now = System.currentTimeMillis();
        long STALE_MS = 60 * 60 * 1000L;
        if (state.locked() && now - state.mtimeMs() < STALE_MS) System.out.println("LOCKED");
        else System.out.println("FREE");
    }

    public static void acquire(Path memDir) throws IOException {
        var state = readLock(memDir);
        var now = System.currentTimeMillis();
        long STALE_MS = 60 * 60 * 1000L;
        var bootId = getBootId();

        if (state.locked() && now - state.mtimeMs() < STALE_MS) {
            System.out.println("BUSY");
            throw new IllegalStateException("Lock busy");
        }

        var lockFile = memDir.resolve(".consolidate-lock");
        Files.createDirectories(memDir);
        Files.writeString(lockFile, "%d:%s".formatted(ProcessHandle.current().pid(), bootId));

        try { Thread.sleep(50); } catch (InterruptedException e) {}

        var verifyParts = Files.readString(lockFile).trim().split(":");
        if (Long.parseLong(verifyParts[0]) != ProcessHandle.current().pid()) {
            System.out.println("BUSY");
            throw new IllegalStateException("Lost lock race");
        }

        System.out.println("ACQUIRED");
    }

    public static void release(Path memDir) throws IOException {
        var lockFile = memDir.resolve(".consolidate-lock");
        if (Files.exists(lockFile)) Files.delete(lockFile);
        System.out.println("RELEASED");
    }

    public static void status(Path memDir) throws IOException {
        var state = readLock(memDir);
        System.out.printf("mtime: %d, pid: %s, locked: %s\n",
            state.mtimeMs(),
            state.holderPid().isPresent() ? String.valueOf(state.holderPid().getAsLong()) : "none",
            state.locked());
    }

    static LockState readLock(Path memDir) throws IOException {
        var lockFile = memDir.resolve(".consolidate-lock");
        var bootId = getBootId();
        try {
            var attrs = Files.readAttributes(lockFile, BasicFileAttributes.class);
            var parts = Files.readString(lockFile).trim().split(":");
            var pid = Long.parseLong(parts[0]);
            var lockBootId = parts.length > 1 ? parts[1] : "";
            var live = lockBootId.equals(bootId)
                && ProcessHandle.of(pid).map(ph -> ph.isAlive()).orElse(false);
            return new LockState(attrs.lastModifiedTime().toMillis(), OptionalLong.of(pid), lockBootId, live);
        } catch (NoSuchFileException e) {
            return new LockState(0, OptionalLong.empty(), bootId, false);
        }
    }

    static String getBootId() {
        try { return Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).trim(); }
        catch (IOException e) { return "unknown"; }
    }
}
