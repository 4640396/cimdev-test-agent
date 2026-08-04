package com.cimdev.testagent;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ApiIntegrationTest {
    @Autowired MockMvc mvc;

    @Test
    void projectTaskWorkerAndCompletionFlow() throws Exception {
        var project = mvc.perform(post("/api/projects").contentType(MediaType.APPLICATION_JSON).content("""
                {"name":"portal","projectPath":"C:/works/portal","defaultVersion":"main","defaultTestTypes":["unit"]}
                """)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        var projectId = new com.fasterxml.jackson.databind.ObjectMapper().readTree(project).path("id").asText();

        mvc.perform(post("/api/workers/register").contentType(MediaType.APPLICATION_JSON).content("""
                {"id":"worker-1","name":"windows-worker","capabilities":["windows","java"]}
                """)).andExpect(status().isOk());

        var task = mvc.perform(post("/api/tasks").contentType(MediaType.APPLICATION_JSON).content("""
                {"projectId":"%s","triggerType":"test"}
                """.formatted(projectId))).andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        var taskId = new com.fasterxml.jackson.databind.ObjectMapper().readTree(task).path("id").asText();

        mvc.perform(post("/api/worker/tasks/claim").contentType(MediaType.APPLICATION_JSON).content("""
                {"workerId":"worker-1","capabilities":["windows","java"]}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.taskId").value(taskId));

        mvc.perform(post("/api/worker/tasks/{id}/events", taskId).contentType(MediaType.APPLICATION_JSON).content("""
                {"level":"info","message":"mvn test passed"}
                """)).andExpect(status().isOk());

        mvc.perform(post("/api/worker/tasks/{id}/complete", taskId).contentType(MediaType.APPLICATION_JSON).content("""
                {"result":{"lanes":[{"type":"unit","status":"passed","summary":"1 passed"}],"report":{"passed":1,"failed":0,"coverage":80},"artifacts":[]}}
                """)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("COMPLETED"));

        mvc.perform(get("/api/tasks/{id}", taskId)).andExpect(status().isOk())
                .andExpect(jsonPath("$.report.passed").value(1))
                .andExpect(jsonPath("$.logs.length()").value(4));
    }
}
