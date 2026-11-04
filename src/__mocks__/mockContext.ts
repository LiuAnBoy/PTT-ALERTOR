/**
 * Factory for creating a mock grammy Context.
 * Provides jest.fn() stubs for from, chat, reply, message.
 */
export function createMockContext(overrides?: {
  from?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    is_bot?: boolean;
  } | null;
  chat?: { id: number; type?: string } | null;
  messageText?: string;
  callbackData?: string;
  /** The message the pressed inline button sits under */
  callbackMessage?: { chat: { id: number }; message_id: number };
}) {
  return {
    from:
      overrides?.from !== undefined
        ? overrides.from
        : { id: 12345, first_name: "Test", last_name: "User", username: "testuser", is_bot: false },
    chat: overrides?.chat !== undefined ? overrides.chat : { id: 12345, type: "private" },
    message: overrides?.messageText !== undefined ? { text: overrides.messageText } : undefined,
    reply: jest.fn().mockResolvedValue({}),
    deleteMessage: jest.fn().mockResolvedValue(true),
    editMessageText: jest.fn().mockResolvedValue(true),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(true),
    answerCallbackQuery: jest.fn().mockResolvedValue(true),
    callbackQuery:
      overrides?.callbackData !== undefined
        ? { data: overrides.callbackData, message: overrides.callbackMessage }
        : undefined,
  };
}

export type MockContext = ReturnType<typeof createMockContext>;
