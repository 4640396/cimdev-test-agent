package com.demo;

public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int subtract(int a, int b) {
        return a - b;
    }

    public double divide(int a, int b) {
        if (b == 0) throw new IllegalArgumentException("divisor must not be zero");
        return (double) a / b;
    }
}
