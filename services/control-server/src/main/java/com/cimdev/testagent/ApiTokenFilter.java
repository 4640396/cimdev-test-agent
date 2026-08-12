package com.cimdev.testagent;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

@Component
class ApiTokenFilter extends OncePerRequestFilter {
    private final Set<String> tokens;

    ApiTokenFilter(@Value("${test-agent.api-token:}") String token) {
        this.tokens = Arrays.stream(token.split(",")).map(String::trim).filter(item -> !item.isEmpty()).collect(Collectors.toSet());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        var uri = request.getRequestURI();
        if (uri.equals("/actuator/health") || uri.startsWith("/v3/api-docs") || uri.startsWith("/swagger-ui") || uri.equals("/swagger-ui.html")) {
            chain.doFilter(request, response);
            return;
        }
        if (tokens.isEmpty()) {
            unauthorized(response);
            return;
        }
        var supplied = request.getHeader("Authorization");
        if (supplied != null && supplied.startsWith("Bearer ")) {
            var candidate = supplied.substring("Bearer ".length()).getBytes(StandardCharsets.UTF_8);
            for (var expected : tokens) {
                if (MessageDigest.isEqual(candidate, expected.getBytes(StandardCharsets.UTF_8))) {
                    chain.doFilter(request, response);
                    return;
                }
            }
        }
        unauthorized(response);
    }

    private void unauthorized(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"error\":\"Unauthorized\"}");
    }
}
