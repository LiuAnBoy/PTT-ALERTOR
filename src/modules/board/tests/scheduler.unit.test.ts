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

const mockAggregator = { getState: jest.fn() };
jest.mock("../../../core/alertAggregator", () => ({ alertAggregator: mockAggregator }));

const mockStartRound = jest.fn();
jest.mock("../../../core/roundTracker", () => ({ roundTracker: { startRound: mockStartRound } }));

const mockSendProgressAlert = jest.fn().mockResolvedValue(undefined);
const mockSendRecoveryAlert = jest.fn().mockResolvedValue(undefined);
jest.mock("../../user/services/errorLogger", () => ({
  sendProgressAlert: () => mockSendProgressAlert(),
  sendRecoveryAlert: () => mockSendRecoveryAlert(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { dispatchCrawlerJobs } from "../workers/scheduler";

beforeEach(() => {
  jest.clearAllMocks();
  mockSmembers.mockResolvedValue(["Soho", "CodeJob"]);
});

describe("dispatchCrawlerJobs — circuit gate paths", () => {
  it("OPEN (no probe): sends throttled progress alert and does NOT dispatch", async () => {
    mockCircuit.isOpen.mockReturnValue(true);
    mockCircuit.shouldAttempt.mockReturnValue(false);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual([]);
    expect(mockSendProgressAlert).toHaveBeenCalledTimes(1);
    expect(mockSendRecoveryAlert).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockStartRound).not.toHaveBeenCalled();
  });

  it("HALF_OPEN (probe): dispatches without sending a progress alert", async () => {
    mockCircuit.isOpen.mockReturnValue(true);
    mockCircuit.shouldAttempt.mockReturnValue(true);
    mockCircuit.getState.mockReturnValue("HALF_OPEN");
    mockAggregator.getState.mockReturnValue("ALERTING");

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual(["Soho", "CodeJob"]);
    expect(mockSendProgressAlert).not.toHaveBeenCalled();
    expect(mockSendRecoveryAlert).not.toHaveBeenCalled();
    expect(mockStartRound).toHaveBeenCalledWith(2);
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("CLOSED while ALERTING: sends recovery alert and dispatches", async () => {
    mockCircuit.isOpen.mockReturnValue(false);
    mockCircuit.getState.mockReturnValue("CLOSED");
    mockAggregator.getState.mockReturnValue("ALERTING");

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual(["Soho", "CodeJob"]);
    expect(mockSendRecoveryAlert).toHaveBeenCalledTimes(1);
    expect(mockSendProgressAlert).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("CLOSED while NORMAL: dispatches with no recovery/progress alert", async () => {
    mockCircuit.isOpen.mockReturnValue(false);
    mockCircuit.getState.mockReturnValue("CLOSED");
    mockAggregator.getState.mockReturnValue("NORMAL");

    await dispatchCrawlerJobs();

    expect(mockSendRecoveryAlert).not.toHaveBeenCalled();
    expect(mockSendProgressAlert).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it("returns early when there are no subscribed boards", async () => {
    mockSmembers.mockResolvedValue([]);

    const result = await dispatchCrawlerJobs();

    expect(result).toEqual([]);
    expect(mockCircuit.isOpen).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockStartRound).not.toHaveBeenCalled();
    expect(mockSendProgressAlert).not.toHaveBeenCalled();
    expect(mockSendRecoveryAlert).not.toHaveBeenCalled();
  });
});
