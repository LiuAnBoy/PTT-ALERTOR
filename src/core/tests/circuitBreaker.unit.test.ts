jest.mock("../logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { CircuitBreaker } from "../circuitBreaker";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ cooldownMs: 50 });
  });

  it("should start in CLOSED state", () => {
    expect(cb.getState()).toBe("CLOSED");
  });

  it("should report isOpen false when CLOSED", () => {
    expect(cb.isOpen()).toBe(false);
  });

  it("should stay CLOSED when round has at least one success", () => {
    cb.recordRoundResult({ total: 5, failed: 4 });
    expect(cb.getState()).toBe("CLOSED");
  });

  it("should transition CLOSED -> OPEN when all boards fail", () => {
    cb.recordRoundResult({ total: 3, failed: 3 });
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isOpen()).toBe(true);
  });

  it("should stay CLOSED when total is 0", () => {
    cb.recordRoundResult({ total: 0, failed: 0 });
    expect(cb.getState()).toBe("CLOSED");
  });

  it("should transition OPEN -> HALF_OPEN after cooldown", async () => {
    cb.recordRoundResult({ total: 2, failed: 2 });
    expect(cb.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 60));

    expect(cb.shouldAttempt()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");
  });

  it("should not transition to HALF_OPEN before cooldown elapses", () => {
    cb.recordRoundResult({ total: 2, failed: 2 });
    expect(cb.getState()).toBe("OPEN");
    expect(cb.shouldAttempt()).toBe(false);
    expect(cb.getState()).toBe("OPEN");
  });

  it("should transition HALF_OPEN -> CLOSED on success", async () => {
    cb.recordRoundResult({ total: 1, failed: 1 });
    await new Promise((r) => setTimeout(r, 60));
    cb.shouldAttempt(); // OPEN -> HALF_OPEN

    cb.recordRoundResult({ total: 3, failed: 1 });
    expect(cb.getState()).toBe("CLOSED");
  });

  it("should transition HALF_OPEN -> OPEN on failure", async () => {
    cb.recordRoundResult({ total: 1, failed: 1 });
    await new Promise((r) => setTimeout(r, 60));
    cb.shouldAttempt(); // OPEN -> HALF_OPEN

    cb.recordRoundResult({ total: 2, failed: 2 });
    expect(cb.getState()).toBe("OPEN");
  });

  it("should reset to CLOSED state", () => {
    cb.recordRoundResult({ total: 1, failed: 1 });
    expect(cb.getState()).toBe("OPEN");

    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);
  });
});
