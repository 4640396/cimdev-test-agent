package com.cimdev.testagent;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;

import java.time.Instant;
import java.util.List;

final class ApiModels {
    private ApiModels() {}

    record TaskInput(@NotBlank String projectPath, @NotBlank String systemName, String version, @NotEmpty List<String> testTypes, List<String> requiredCapabilities) {}
    record CreateTaskRequest(String projectId, TaskInput input, String triggerType, String idempotencyKey) {
        CreateTaskRequest(String projectId, TaskInput input, String triggerType) { this(projectId, input, triggerType, null); }
    }
    record TaskLog(long id, String level, String message, Instant createdAt) {}
    record TaskView(String id, String projectId, TaskInput input, String status, String triggerType, String workerId,
                    JsonNode report, JsonNode artifacts, String errorMessage, Instant createdAt, Instant updatedAt, List<TaskLog> logs) {}
    record ProjectRequest(String id, @NotBlank String name, @NotBlank String projectPath, String defaultVersion, @NotEmpty List<String> defaultTestTypes) {}
    record ProjectView(String id, String name, String projectPath, String defaultVersion, List<String> defaultTestTypes, Instant createdAt, Instant updatedAt) {}
    record WorkerRegisterRequest(String id, @NotBlank String name, @NotEmpty List<String> capabilities) {}
    record WorkerView(String id, String name, List<String> capabilities, String status, Instant lastHeartbeatAt) {}
    record WorkerRegisterResponse(String id, String name, List<String> capabilities, String status, Instant lastHeartbeatAt, String secret) {}
    record ClaimRequest(@NotBlank String workerId, @NotEmpty List<String> capabilities) {}
    record ClaimedTask(String taskId, TaskInput input) {}
    record AgentEvent(@NotBlank String level, @NotBlank String message) {}
    record CompleteTaskRequest(JsonNode result) {}
    record FailTaskRequest(@NotBlank String error) {}
    record ScheduleRequest(String id, @NotBlank String projectId, @Min(1) int intervalMinutes, boolean enabled) {}
    record ScheduleView(String id, String projectId, int intervalMinutes, boolean enabled, Instant nextRunAt, Instant createdAt, Instant updatedAt) {}
}
