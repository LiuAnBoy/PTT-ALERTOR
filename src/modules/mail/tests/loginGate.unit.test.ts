/**
 * Unit tests for the per-account PTT login gate: one login per account per gap, an atomic
 * reservation, a longer hold after a suspension, and no login through a Redis error.
 */

import { createMockRedis } from "../../../__mocks__/mockRedis";

const mockRedis = createMockRedis();

jest.mock("../../../core/redis", () => ({ redis: mockRedis }));
jest.mock("../../../core/logger", () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { holdLogins, LOGIN_GAP_MS, reserveLogin, THROTTLE_HOLD_MS } from "../services/loginGate";

beforeEach(() => jest.clearAllMocks());

describe("reserveLogin", () => {
  it("reserves the gap atomically and lets the login go ahead", async () => {
    mockRedis.set.mockResolvedValueOnce("OK");
    await expect(reserveLogin(" MyId ")).resolves.toBe(0);
    expect(mockRedis.set).toHaveBeenCalledWith("mail:login:myid", "1", "PX", LOGIN_GAP_MS, "NX");
  });

  it("returns the remaining wait when the account logged in recently", async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    mockRedis.pttl.mockResolvedValueOnce(95_000);
    await expect(reserveLogin("myid")).resolves.toBe(95_000);
  });

  it("waits a little when the key expired between the two calls", async () => {
    mockRedis.set.mockResolvedValueOnce(null);
    mockRedis.pttl.mockResolvedValueOnce(-2);
    await expect(reserveLogin("myid")).resolves.toBeGreaterThan(0);
  });

  it("never lets a login through when Redis fails", async () => {
    mockRedis.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(reserveLogin("myid")).resolves.toBeGreaterThan(0);
  });
});

describe("holdLogins", () => {
  it("overwrites the reservation with the longer suspension hold", async () => {
    await holdLogins("MyId");
    expect(mockRedis.set).toHaveBeenCalledWith("mail:login:myid", "1", "PX", THROTTLE_HOLD_MS);
  });
});
