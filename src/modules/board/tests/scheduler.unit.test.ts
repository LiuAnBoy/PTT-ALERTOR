// ── Mocks (before imports) ───────────────────────────────────────────────────

jest.mock("../../../core/logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    add: mockQueueAdd,
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../../core/queue", () => ({ bullmqConnection: {} }));

const mockSmembers = jest.fn();
jest.mock("../../../core/redis", () => ({
  redis: { smembers: (...a: unknown[]) => mockSmembers(...a) },
}));

const mockCircuit = {
  isOpen: jest.fn(),
  shouldAttempt: jest.fn(),
  getState: jest.fn(),
};
jest.mock("../../../core/circuitBreaker", () => ({ crawlerCircuit: mockCircuit }));

const mockStartRound = jest.fn();
jest.mock("../../../core/roundTracker", () => ({ roundTracker: { startRound: mockStartRound } }));

const mockCloseAlertRound = jest.fn().mockResolvedValue(undefined);
jest.mock("../../user/services/errorLogger", () => ({
  closeAlertRound: (...a: unknown[]) => mockCloseAlertRound(...a),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { dispatchCrawlerJobs } from "../workers/scheduler";

beforeEach(() => {
  jest.clearAllMocks();
  mockSmembers.mockResolvedValue(["Soho", "CodeJob"]);
});

describe("dispatchCrawlerJobs", () => {
  it("OPEN (no probe): closes the round as not clean and does NOT dispatch", async () => {
    mockCircuit.getState.mockReturnValue("OPEN");
    mockCircuit.isOpen.mockReturnValue(true);
    mockCircuit.shouldAttempt.mockReturnValue(false);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual([]);
    expect(mockCloseAlertRound).toHaveBeenCalledWith(false);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockStartRound).not.toHaveBeenCalled();
  });

  it("OPEN with cooldown elapsed: closes the round as not clean and dispatches a probe", async () => {
    mockCircuit.getState.mockReturnValue("OPEN");
    mockCircuit.isOpen.mockReturnValue(true);
    mockCircuit.shouldAttempt.mockReturnValue(true);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual(["Soho", "CodeJob"]);
    expect(mockCloseAlertRound).toHaveBeenCalledWith(false);
    expect(mockStartRound).toHaveBeenCalledWith(2);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("CLOSED: closes the round as circuit closed and dispatches", async () => {
    mockCircuit.getState.mockReturnValue("CLOSED");
    mockCircuit.isOpen.mockReturnValue(false);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual(["Soho", "CodeJob"]);
    expect(mockCloseAlertRound).toHaveBeenCalledWith(true);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("closes the round before reading the boards, so a Redis failure still ticks", async () => {
    mockCircuit.getState.mockReturnValue("CLOSED");
    mockSmembers.mockRejectedValue(new Error("redis down"));

    await expect(dispatchCrawlerJobs()).rejects.toThrow("redis down");

    expect(mockCloseAlertRound).toHaveBeenCalledTimes(1);
  });

  it("still closes the round when there are no subscribed boards", async () => {
    mockCircuit.getState.mockReturnValue("CLOSED");
    mockSmembers.mockResolvedValue([]);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual([]);
    expect(mockCloseAlertRound).toHaveBeenCalledTimes(1);
    expect(mockCircuit.isOpen).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockStartRound).not.toHaveBeenCalled();
  });
});
