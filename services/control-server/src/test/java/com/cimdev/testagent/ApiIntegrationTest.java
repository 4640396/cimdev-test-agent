package com.cimdev.testagent;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApiIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    private static final String TOKEN = "test-token";
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeEach
    void cleanDatabase() {
        jdbc.update("DELETE FROM audit_log");
        jdbc.update("DELETE FROM task_artifacts");
        jdbc.update("DELETE FROM task_logs");
        jdbc.update("DELETE FROM test_tasks");
        jdbc.update("DELETE FROM schedules");
        jdbc.update("DELETE FROM workers");
        jdbc.update("DELETE FROM projects");
    }

    @Test
    void projectTaskWorkerAndCompletionFlow() throws Exception {
        var projectId = createProject("portal");
        var workerSecret = registerWorker("worker-1", new String[]{"windows", "java"});

        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/{id}/events", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"level":"info","message":"mvn test passed"}
                """)).andExpect(status().isOk());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", workerSecret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"1 passed"}],"report":{"passed":1,"failed":0,"coverage":80},"artifacts":[]}}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("COMPLETED"));

        mvc.perform(get("/api/tasks/{id}", taskId).headers(auth())).andExpect(status().isOk())
                .andExpect(jsonPath("$.report.passed").value(1))
                .andExpect(jsonPath("$.logs.length()").value(4));

        assertThat(auditCount("task.create")).isGreaterThanOrEqualTo(1);
        assertThat(auditCount("task.complete")).isGreaterThanOrEqualTo(1);
    }

    @Test
    void apiRequiresTokenByDefault() throws Exception {
        mvc.perform(get("/api/projects")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/projects").headers(auth())).andExpect(status().isOk());
        mvc.perform(get("/actuator/health")).andExpect(status().isOk());
    }

    @Test
    void workerIdentityAndTaskOwnershipAreEnforced() throws Exception {
        var projectId = createProject("inventory");
        var worker1Secret = registerWorker("worker-1", new String[]{"windows", "java"});
        var worker2Secret = registerWorker("worker-2", new String[]{"windows", "java"});

        var task = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = JSON.readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/claim").headers(auth())
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isForbidden());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-2", worker2Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[],"report":{"passed":0,"failed":0,"coverage":null},"artifacts":[]}}
                """)).andExpect(status().isForbidden());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).headers(auth()).headers(worker("worker-1", worker1Secret))
                .contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"ok"}],"report":{"passed":1,"failed":0,"coverage":50},"artifacts":[]}}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("COMPLETED"));
    }

    @Test
    void createTaskAndWebhookAreIdempotent() throws Exception {
        var projectId = createProject("billing");

        var first = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test","idempotencyKey":"manual-key-1"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var second = mvc.perform(post("/api/tasks").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test","idempotencyKey":"manual-key-1"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        assertThat(JSON.readTree(first).path("id").asText()).isEqualTo(JSON.readTree(second).path("id").asText());

        var release = mvc.perform(post("/api/webhooks/version-release").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","version":"v1.2.0","testTypes":["unit","regression"]}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var releaseAgain = mvc.perform(post("/api/webhooks/version-release").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","version":"v1.2.0","testTypes":["unit","regression"]}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        assertThat(JSON.readTree(release).path("id").asText()).isEqualTo(JSON.readTree(releaseAgain).path("id").asText());
        assertThat(auditCount("task.create.duplicate")).isGreaterThanOrEqualTo(2);
    }

    private String createProject(String name) throws Exception {
        var response = mvc.perform(post("/api/projects").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"name":"%s","projectPath":"C:/works/%s","defaultVersion":"main","defaultTestTypes":["unit"]}
                """.formatted(name, name))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return JSON.readTree(response).path("id").asText();
    }

    private String registerWorker(String id, String[] capabilities) throws Exception {
        var response = mvc.perform(post("/api/workers/register").headers(auth()).contentType(MediaType.APPLICATION_JSON).content("""
                {"id":"%s","name":"%s","capabilities":%s}
                """.formatted(id, id, JSON.writeValueAsString(capabilities)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        var secret = JSON.readTree(response).path("secret").asText();
        assertThat(secret).isNotBlank();
        return secret;
    }

    private long auditCount(String action) {
        var count = jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE action=?", Long.class, action);
        return count == null ? 0 : count;
    }

    private org.springframework.http.HttpHeaders auth() {
        var headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(TOKEN);
        return headers;
    }

    private org.springframework.http.HttpHeaders worker(String id, String secret) {
        var headers = new org.springframework.http.HttpHeaders();
        headers.set("X-Worker-Id", id);
        headers.set("X-Worker-Secret", secret);
        return headers;
    }
}
