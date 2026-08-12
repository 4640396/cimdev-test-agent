package com.cimdev.testagent;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static com.cimdev.testagent.ApiModels.*;

@Service
class ControlService {
    private final TaskStore store;
    private final SseHub events;
    private final Path storageRoot;
    private final int leaseSeconds;

    ControlService(TaskStore store, SseHub events,
                   @Value("${test-agent.storage-root}") String storageRoot,
                   @Value("${test-agent.task-lease-seconds}") int leaseSeconds) throws IOException {
        this.store = store;
        this.events = events;
        this.storageRoot = Path.of(storageRoot).toAbsolutePath().normalize();
        this.leaseSeconds = leaseSeconds;
        Files.createDirectories(this.storageRoot);
    }

    ProjectView saveProject(ProjectRequest request) {
        var now = Instant.now();
        var existing = request.id() == null ? Optional.<ProjectView>empty() : store.project(request.id());
        var project = new ProjectView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.name(), request.projectPath(),
                request.defaultVersion() == null ? "" : request.defaultVersion(), request.defaultTestTypes(), existing.map(ProjectView::createdAt).orElse(now), now);
        store.saveProject(project);
        return project;
    }

    List<ProjectView> projects() { return store.projects(); }

    TaskView createTask(CreateTaskRequest request) {
        TaskInput input = request.input();
        String projectId = request.projectId();
        if (input == null && projectId != null) {
            var project = store.project(projectId).orElseThrow(() -> new IllegalArgumentException("项目不存在"));
            input = new TaskInput(project.projectPath(), project.name(), project.defaultVersion(), project.defaultTestTypes(), List.of());
        }
        if (input == null) throw new IllegalArgumentException("任务输入不能为空");
        var id = UUID.randomUUID().toString();
        var triggerType = request.triggerType() == null ? "manual" : request.triggerType();
        var existing = store.insertTask(id, projectId, input, triggerType, request.idempotencyKey());
        if (existing.isPresent()) {
            audit(actorFor(triggerType), "task.create.duplicate", existing.get().id(), "idempotency=" + request.idempotencyKey());
            return existing.get();
        }
        log(id, "info", "任务进入中央队列");
        audit(actorFor(triggerType), "task.create", id, "project=" + projectId);
        return task(id);
    }

    TaskView task(String id) { return store.task(id).orElseThrow(() -> new IllegalArgumentException("任务不存在")); }
    List<TaskView> tasks(int limit) { return store.tasks(Math.min(Math.max(limit, 1), 1000)); }
    List<TaskLog> logs(String id) { return store.logs(id); }
    List<AuditEntry> audit(int limit, String actor, String action) { return store.listAudit(Math.min(Math.max(limit, 1), 500), actor, action); }

    TaskView cancel(String id) {
        if (store.cancel(id)) {
            log(id, "warning", "任务已取消");
            audit("api", "task.cancel", id, null);
        }
        return task(id);
    }

    TaskView retry(String id) {
        var old = task(id);
        return createTask(new CreateTaskRequest(old.projectId(), old.input(), "retry:" + id, "retry:" + id));
    }

    WorkerRegisterResponse register(WorkerRegisterRequest request) {
        var worker = new WorkerView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.name(), request.capabilities(), "ONLINE", Instant.now());
        var secret = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "");
        store.saveWorker(worker);
        store.updateWorkerSecret(worker.id(), secretHash(worker.id(), secret));
        audit("api", "worker.register", null, "worker=" + worker.id());
        return new WorkerRegisterResponse(worker.id(), worker.name(), worker.capabilities(), worker.status(), worker.lastHeartbeatAt(), secret);
    }

    boolean verifyWorkerSecret(String workerId, String secret) {
        return workerId != null && secret != null && store.verifyWorkerSecret(workerId, secretHash(workerId, secret));
    }

    void requireTaskOwner(String taskId, String workerId) {
        var task = task(taskId);
        if (workerId == null || !workerId.equals(task.workerId())) throw new ForbiddenException("Worker 无权操作该任务");
    }

    void heartbeatWorker(String id) { store.heartbeatWorker(id); }
    List<WorkerView> workers() { return store.workers(); }

    Optional<ClaimedTask> claim(ClaimRequest request) {
        store.heartbeatWorker(request.workerId());
        var claimed = store.claim(request.workerId(), request.capabilities(), leaseSeconds);
        claimed.ifPresent(task -> log(task.taskId(), "info", "Worker已领取任务：" + request.workerId()));
        return claimed;
    }

    void heartbeatTask(String taskId, String workerId) { store.heartbeatTask(taskId, workerId, leaseSeconds); }

    void workerEvent(String taskId, AgentEvent event) {
        if (event.stage() != null && !event.stage().isBlank()) {
            store.updateStage(taskId, event.stage());
            events.publish(taskId, "snapshot", task(taskId));
        }
        log(taskId, event.level(), event.message());
    }

    TaskView complete(String taskId, CompleteTaskRequest request) {
        if (store.complete(taskId, request.result())) {
            log(taskId, "success", "Worker真实测试执行完成");
            audit("worker", "task.complete", taskId, null);
        }
        return task(taskId);
    }

    TaskView fail(String taskId, FailTaskRequest request) {
        store.fail(taskId, request.error());
        log(taskId, "error", request.error());
        audit("worker", "task.fail", taskId, request.error());
        return task(taskId);
    }

    Map<String, Object> saveArtifact(String taskId, MultipartFile file) throws IOException {
        task(taskId);
        var id = UUID.randomUUID().toString();
        var taskDirectory = storageRoot.resolve("tasks").resolve(taskId).normalize();
        Files.createDirectories(taskDirectory);
        var safeName = Path.of(Optional.ofNullable(file.getOriginalFilename()).orElse("artifact.bin")).getFileName().toString();
        var target = taskDirectory.resolve(id + "-" + safeName).normalize();
        if (!target.startsWith(taskDirectory)) throw new IllegalArgumentException("非法产物路径");
        Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);
        store.saveArtifact(id, taskId, safeName, target.toString(), Optional.ofNullable(file.getContentType()).orElse("application/octet-stream"), file.getSize());
        return Map.of("id", id, "name", safeName, "size", file.getSize());
    }

    List<Map<String, Object>> artifacts(String taskId) { return store.artifacts(taskId); }

    Path artifactPath(String taskId, String artifactId) {
        var row = store.artifact(taskId, artifactId).orElseThrow(() -> new IllegalArgumentException("产物不存在"));
        var path = Path.of(row.get("storage_path").toString()).toAbsolutePath().normalize();
        if (!path.startsWith(storageRoot) || !Files.exists(path)) throw new IllegalArgumentException("产物文件不存在");
        return path;
    }

    ScheduleView saveSchedule(ScheduleRequest request) {
        var now = Instant.now();
        var existing = request.id() == null ? Optional.<ScheduleView>empty() : store.schedules().stream().filter(item -> item.id().equals(request.id())).findFirst();
        store.project(request.projectId()).orElseThrow(() -> new IllegalArgumentException("项目不存在"));
        var schedule = new ScheduleView(request.id() == null ? UUID.randomUUID().toString() : request.id(), request.projectId(), request.intervalMinutes(), request.enabled(),
                now.plusSeconds(request.intervalMinutes() * 60L), existing.map(ScheduleView::createdAt).orElse(now), now);
        store.saveSchedule(schedule);
        return schedule;
    }

    List<ScheduleView> schedules() { return store.schedules(); }
    boolean deleteSchedule(String id) { return store.deleteSchedule(id); }

    org.springframework.web.servlet.mvc.method.annotation.SseEmitter subscribe(String taskId) { return events.subscribe(taskId, task(taskId)); }

    @Scheduled(fixedDelayString = "${test-agent.scheduler-delay-ms}")
    void schedule() {
        store.markStaleWorkersOffline(Instant.now().minusSeconds(90));
        store.requeueExpired();
        var now = Instant.now();
        for (var schedule : store.schedules()) {
            if (!schedule.enabled() || schedule.nextRunAt().isAfter(now)) continue;
            createTask(new CreateTaskRequest(schedule.projectId(), null, "schedule:" + schedule.id()));
            store.saveSchedule(new ScheduleView(schedule.id(), schedule.projectId(), schedule.intervalMinutes(), true,
                    now.plusSeconds(schedule.intervalMinutes() * 60L), schedule.createdAt(), now));
        }
    }

    private void log(String taskId, String level, String message) {
        var log = store.appendLog(taskId, level, message);
        events.publish(taskId, "log", log);
        events.publish(taskId, "snapshot", task(taskId));
    }

    private String actorFor(String triggerType) {
        return switch (triggerType == null ? "manual" : triggerType) {
            case "schedule" -> "schedule";
            case "version-release" -> "webhook";
            default -> "api";
        };
    }

    private String secretHash(String workerId, String secret) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest((workerId + ":" + secret).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private void audit(String actor, String action, String taskId, String payload) {
        String sourceIp = null;
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes requestAttributes) {
            try { sourceIp = requestAttributes.getRequest().getRemoteAddr(); } catch (Exception ignored) { }
        }
        store.insertAudit(actor, action, taskId, payload, sourceIp);
    }
}
