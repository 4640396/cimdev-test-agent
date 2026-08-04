package com.cimdev.testagent;

import jakarta.validation.Valid;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

import static com.cimdev.testagent.ApiModels.*;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = {"http://127.0.0.1", "http://localhost"})
class ApiController {
    private final ControlService service;

    ApiController(ControlService service) { this.service = service; }

    @GetMapping("/runtime") Map<String, Object> runtime() {
        return Map.of("service", "java-control-plane", "database", "mysql", "storage", "local", "workers", service.workers());
    }

    @GetMapping("/projects") List<ProjectView> projects() { return service.projects(); }
    @PostMapping("/projects") ProjectView saveProject(@Valid @RequestBody ProjectRequest request) { return service.saveProject(request); }

    @GetMapping("/tasks") List<TaskView> tasks(@RequestParam(defaultValue = "100") int limit) { return service.tasks(limit); }
    @PostMapping("/tasks") ResponseEntity<TaskView> createTask(@Valid @RequestBody CreateTaskRequest request) { return ResponseEntity.accepted().body(service.createTask(request)); }
    @GetMapping("/tasks/{id}") TaskView task(@PathVariable String id) { return service.task(id); }
    @GetMapping("/tasks/{id}/logs") List<TaskLog> logs(@PathVariable String id) { return service.logs(id); }
    @PostMapping("/tasks/{id}/cancel") TaskView cancel(@PathVariable String id) { return service.cancel(id); }
    @PostMapping("/tasks/{id}/retry") ResponseEntity<TaskView> retry(@PathVariable String id) { return ResponseEntity.accepted().body(service.retry(id)); }
    @GetMapping(value = "/tasks/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE) SseEmitter events(@PathVariable String id) { return service.subscribe(id); }
    @GetMapping("/tasks/{id}/artifacts") List<Map<String, Object>> artifacts(@PathVariable String id) { return service.artifacts(id); }
    @GetMapping("/tasks/{taskId}/artifacts/{artifactId}") ResponseEntity<FileSystemResource> artifact(@PathVariable String taskId, @PathVariable String artifactId) {
        var path = service.artifactPath(taskId, artifactId);
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + path.getFileName() + "\"").body(new FileSystemResource(path));
    }

    @GetMapping("/workers") List<WorkerView> workers() { return service.workers(); }
    @PostMapping("/workers/register") WorkerView register(@Valid @RequestBody WorkerRegisterRequest request) { return service.register(request); }
    @PostMapping("/workers/{id}/heartbeat") void heartbeat(@PathVariable String id) { service.heartbeatWorker(id); }
    @PostMapping("/worker/tasks/claim") ResponseEntity<ClaimedTask> claim(@Valid @RequestBody ClaimRequest request) { return service.claim(request).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build()); }
    @PostMapping("/worker/tasks/{taskId}/heartbeat") void taskHeartbeat(@PathVariable String taskId, @RequestParam String workerId) { service.heartbeatTask(taskId, workerId); }
    @PostMapping("/worker/tasks/{taskId}/events") void workerEvent(@PathVariable String taskId, @Valid @RequestBody AgentEvent event) { service.workerEvent(taskId, event); }
    @PostMapping("/worker/tasks/{taskId}/complete") TaskView complete(@PathVariable String taskId, @RequestBody CompleteTaskRequest request) { return service.complete(taskId, request); }
    @PostMapping("/worker/tasks/{taskId}/fail") TaskView fail(@PathVariable String taskId, @Valid @RequestBody FailTaskRequest request) { return service.fail(taskId, request); }
    @PostMapping(value = "/worker/tasks/{taskId}/artifacts", consumes = MediaType.MULTIPART_FORM_DATA_VALUE) Map<String, Object> upload(@PathVariable String taskId, @RequestPart MultipartFile file) throws Exception { return service.saveArtifact(taskId, file); }

    @GetMapping("/schedules") List<ScheduleView> schedules() { return service.schedules(); }
    @PostMapping("/schedules") ScheduleView schedule(@Valid @RequestBody ScheduleRequest request) { return service.saveSchedule(request); }
    @PutMapping("/schedules/{id}") ScheduleView updateSchedule(@PathVariable String id, @Valid @RequestBody ScheduleRequest request) {
        return service.saveSchedule(new ScheduleRequest(id, request.projectId(), request.intervalMinutes(), request.enabled()));
    }
    @DeleteMapping("/schedules/{id}") ResponseEntity<Void> deleteSchedule(@PathVariable String id) { return service.deleteSchedule(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build(); }

    @PostMapping("/webhooks/version-release") ResponseEntity<TaskView> release(@RequestBody Map<String, Object> request) {
        var projectId = String.valueOf(request.get("projectId"));
        var project = service.projects().stream().filter(item -> item.id().equals(projectId)).findFirst().orElseThrow(() -> new IllegalArgumentException("项目不存在"));
        @SuppressWarnings("unchecked") var types = request.get("testTypes") instanceof List<?> values ? (List<String>) values : project.defaultTestTypes();
        @SuppressWarnings("unchecked") var capabilities = request.get("requiredCapabilities") instanceof List<?> values ? (List<String>) values : List.<String>of();
        var input = new TaskInput(project.projectPath(), project.name(), String.valueOf(request.getOrDefault("version", project.defaultVersion())), types, capabilities);
        return ResponseEntity.accepted().body(service.createTask(new CreateTaskRequest(projectId, input, "version-release")));
    }
}
