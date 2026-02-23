/**
 * Factory for creating a mock ioredis instance.
 * Provides jest.fn() stubs for all Redis commands used in the codebase.
 */
export function createMockRedis() {
  const mockPipeline = {
    exec: jest.fn().mockResolvedValue([]),
    zadd: jest.fn().mockReturnThis(),
    zscore: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    srem: jest.fn().mockReturnThis(),
    smembers: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    zrangebyscore: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
  };

  return {
    smembers: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    scard: jest.fn().mockResolvedValue(0),
    sismember: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue("OK"),
    zcard: jest.fn().mockResolvedValue(0),
    zadd: jest.fn().mockResolvedValue(1),
    zscore: jest.fn().mockResolvedValue(null),
    zrem: jest.fn().mockResolvedValue(1),
    zrangebyscore: jest.fn().mockResolvedValue([]),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    hset: jest.fn().mockResolvedValue(1),
    hdel: jest.fn().mockResolvedValue(1),
    hexists: jest.fn().mockResolvedValue(0),
    pipeline: jest.fn().mockReturnValue(mockPipeline),
    /** Access the mock pipeline for assertions. */
    _mockPipeline: mockPipeline,
  };
}

export type MockRedis = ReturnType<typeof createMockRedis>;
