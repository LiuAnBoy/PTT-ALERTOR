/**
 * Factory for creating a mock grammy Context.
 * Provides jest.fn() stubs for from, chat, reply, message.
 */
export function createMockContext(overrides?: {
  from?: { id: number; username?: string } | null;
  chat?: { id: number } | null;
  messageText?: string;
}) {
  return {
    from: overrides?.from !== undefined ? overrides.from : { id: 12345, username: "testuser" },
    chat: overrides?.chat !== undefined ? overrides.chat : { id: 12345 },
    message: overrides?.messageText !== undefined ? { text: overrides.messageText } : undefined,
    reply: jest.fn().mockResolvedValue({}),
  };
}

export type MockContext = ReturnType<typeof createMockContext>;
