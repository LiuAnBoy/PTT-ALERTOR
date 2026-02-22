/**
 * Factory for creating a mock grammy Bot instance.
 * Provides jest.fn() stubs for api.sendMessage.
 */
export function createMockBot() {
  return {
    api: {
      sendMessage: jest.fn().mockResolvedValue({}),
    },
  };
}

export type MockBot = ReturnType<typeof createMockBot>;
