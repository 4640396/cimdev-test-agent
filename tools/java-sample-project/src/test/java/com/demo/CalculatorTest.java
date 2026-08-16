package com.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class CalculatorTest {

    private final Calculator calculator = new Calculator();

    @Test
    @DisplayName("add returns the sum of two positive integers")
    void addTwoPositiveIntegers() {
        assertEquals(5, calculator.add(2, 3));
    }

    @Test
    @DisplayName("add handles negative and positive integers")
    void addNegativeAndPositiveIntegers() {
        assertEquals(-1, calculator.add(-4, 3));
    }

    @Test
    @DisplayName("subtract returns the difference of two integers")
    void subtractTwoIntegers() {
        assertEquals(3, calculator.subtract(7, 4));
    }

    @Test
    @DisplayName("subtract handles a negative result")
    void subtractToNegativeResult() {
        assertEquals(-5, calculator.subtract(2, 7));
    }

    @Test
    @DisplayName("divide returns an exact integer quotient")
    void divideExactIntegerResult() {
        assertEquals(3.0, calculator.divide(9, 3));
    }

    @Test
    @DisplayName("divide returns a fractional quotient")
    void divideFractionalResult() {
        assertEquals(2.5, calculator.divide(5, 2));
    }

    @Test
    @DisplayName("divide by zero throws IllegalArgumentException")
    void divideByZeroThrows() {
        IllegalArgumentException exception =
                assertThrows(IllegalArgumentException.class, () -> calculator.divide(8, 0));
        assertEquals("divisor must not be zero", exception.getMessage());
    }
}
