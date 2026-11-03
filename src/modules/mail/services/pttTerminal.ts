import iconv from "iconv-lite";

import { createLogger } from "../../../core/logger";

const logger = createLogger("MAIL");

export const PTT_WS_URL = "wss://ws.ptt.cc/bbs/";
export const PTT_WS_ORIGIN = "https://term.ptt.cc";

/** Maximum Big5 byte length PTT accepts for a mail subject. */
export const SUBJECT_MAX_BYTES = 58;
/** Maximum Big5 byte length of a PTT user id. */
export const PTT_ID_MAX_BYTES = 12;

const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** How long to wait for the closing prompt once the mail is known to be sent. */
const CONFIRMED_STEP_TIMEOUT_MS = 3_000;
const LOGOUT_STEP_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_STEPS = 40;
const MAX_BUFFER_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------

export type PttErrorCode =
  | "WrongPassword"
  | "TwoFactorRequired"
  | "NoSuchUser"
  | "PttBusy"
  | "SecureConnectionRequired"
  | "Timeout"
  | "ConnectFailed"
  | "UnfinishedDraft";

/** Typed failure of the terminal client; `code` is safe to log and to show. */
export class PttError extends Error {
  /**
   * @param code - The failure category.
   * @param message - Optional detail; must never contain credentials or screen text.
   */
  constructor(
    readonly code: PttErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PttError";
  }
}

/** `not_sent`: failed before the save key; `sent`: confirmation seen; `unknown`: in between. */
export type MailOutcome = "not_sent" | "sent" | "unknown";

export interface MailResult {
  outcome: MailOutcome;
  /** Set when a failure occurred (also possible on `sent` if the tail of the flow failed). */
  errorCode?: PttErrorCode;
  detail?: string;
}

/** How far the mail flow got; decides the outcome of a failure. */
export type MailProgress = "before_save" | "saving" | "confirmed";

/**
 * Maps the progress of the mail flow to the outcome of a failure at that point.
 * @param progress - The furthest point the flow reached.
 * @returns The outcome to report.
 */
export function classifyMailOutcome(progress: MailProgress): MailOutcome {
  if (progress === "before_save") return "not_sent";
  if (progress === "saving") return "unknown";
  return "sent";
}

// ---------------------------------------------------------------------------
// Encoding: every user- or article-derived string passes through encodeInput
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  /** Turn newlines into spaces instead of Enter (for ids and subjects). */
  singleLine?: boolean;
  /** Cut the result to at most this many Big5 bytes without splitting a character. */
  maxBytes?: number;
}

// Newlines, then every C0 control except CR (ESC and DEL included).
// eslint-disable-next-line no-control-regex
const NON_CR_CONTROLS = /[\x00-\x0c\x0e-\x1f\x7f]/g;

/**
 * Encodes text typed on behalf of a user into Big5 keystrokes. Control bytes are stripped so
 * the text can never act as a key; each newline becomes a single CR; characters outside cp950
 * become `?`.
 * @param text - Untrusted text (id, password, title, reply, article).
 * @param options - Single-line mode and a Big5 byte cap.
 * @returns The bytes to send.
 */
export function encodeInput(text: string, options: EncodeOptions = {}): Buffer {
  const normalized = text
    .replace(/\r\n|\r|\n/g, options.singleLine ? " " : "\r")
    .replace(NON_CR_CONTROLS, "");
  const parts: Buffer[] = [];
  let total = 0;
  for (const ch of normalized) {
    const bytes = iconv.encode(ch, "cp950");
    if (options.maxBytes !== undefined && total + bytes.length > options.maxBytes) break;
    parts.push(bytes);
    total += bytes.length;
  }
  return Buffer.concat(parts);
}

/**
 * Cuts text to a Big5 byte budget without splitting a two-byte character.
 * @param text - The text to cut.
 * @param maxBytes - The byte budget.
 * @returns The longest prefix whose Big5 encoding fits.
 */
export function truncateBig5(text: string, maxBytes: number): string {
  let total = 0;
  let out = "";
  for (const ch of text) {
    const length = iconv.encode(ch, "cp950").length;
    if (total + length > maxBytes) break;
    out += ch;
    total += length;
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const STRAY_CONTROLS = /[\x00\x1b]/g;

/**
 * Decodes Big5 terminal output and removes ANSI escape sequences.
 * @param raw - Raw bytes received since the last step started.
 * @returns Plain screen text for prompt matching.
 */
export function decodeScreen(raw: Buffer): string {
  return iconv.decode(raw, "cp950").replace(ANSI_PATTERN, "").replace(STRAY_CONTROLS, "");
}

// ---------------------------------------------------------------------------
// Pure screen -> action functions
// ---------------------------------------------------------------------------

const key = (text: string): Buffer => Buffer.from(text, "latin1");
const KEY_ENTER = "\r";
const KEY_CTRL_X = "\x18";
const KEY_LEFT = "\x1b[D";

/** The latest start index of `pattern` in `screen`, or -1. */
function lastIndexOfMatch(screen: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, "g");
  let last = -1;
  for (let m = global.exec(screen); m; m = global.exec(screen)) {
    last = m.index;
    if (m[0].length === 0) global.lastIndex++;
  }
  return last;
}

interface Rule<T> {
  pattern: RegExp;
  enabled?: boolean;
  make: () => T;
}

/** Picks the enabled rule whose text appears latest on the screen (the newest prompt wins). */
function pickLatest<T>(screen: string, rules: Rule<T>[]): T | undefined {
  let best: T | undefined;
  let bestIndex = -1;
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const index = lastIndexOfMatch(screen, rule.pattern);
    if (index > bestIndex) {
      bestIndex = index;
      best = rule.make();
    }
  }
  return best;
}

export interface LoginState {
  idSent: boolean;
  passwordSent: boolean;
}

export interface LoginInput {
  /** Encoded id, at most 12 bytes. */
  id: Buffer;
  /** Encoded password. */
  password: Buffer;
}

export type LoginDecision =
  | { kind: "wait" }
  | { kind: "done" }
  | { kind: "error"; error: PttError }
  | { kind: "send"; step: string; keys: Buffer; next: LoginState };

const MAIN_MENU = /【主功能表】|\(G\)oodbye/;
const RESERVED_IDS = new Set(["guest", "new"]);

/**
 * Rejects the PTT ids that are not accounts: `guest` and `new` log in without a password, so
 * a "successful" login with them proves nothing and could mail as a guest.
 * @param id - The PTT id to check.
 * @throws PttError `WrongPassword` for `guest` or `new` in any letter case.
 */
export function assertRealPttId(id: string): void {
  if (RESERVED_IDS.has(id.trim().toLowerCase())) {
    throw new PttError("WrongPassword", "reserved id");
  }
}

/**
 * Decides the next login action from the screen shown since the last keys were sent.
 * @param screen - Decoded screen text with ANSI removed.
 * @param state - Which credentials were already sent.
 * @param input - The encoded credentials.
 * @returns Wait, finish, fail with a typed error, or send keys.
 */
export function decideLogin(screen: string, state: LoginState, input: LoginInput): LoginDecision {
  // The user's own draft is never answered: any key could save it to a slot or discard it. The
  // check covers the whole unanswered screen, so no later prompt on it receives a key either.
  if (/有一篇文章尚未完成|請選擇暫存檔/.test(screen)) {
    return { kind: "error", error: new PttError("UnfinishedDraft") };
  }
  if (/系統過載/.test(screen)) return { kind: "error", error: new PttError("PttBusy") };
  if (/此帳號已設定為只能使用安全連線/.test(screen)) {
    return { kind: "error", error: new PttError("SecureConnectionRequired") };
  }
  if (state.passwordSent && /密碼不對|密碼錯誤/.test(screen)) {
    return { kind: "error", error: new PttError("WrongPassword") };
  }
  if (state.passwordSent && !MAIN_MENU.test(screen) && /兩階段/.test(screen)) {
    return { kind: "error", error: new PttError("TwoFactorRequired") };
  }

  const send = (step: string, keys: string | Buffer, next: LoginState = state): LoginDecision => ({
    kind: "send",
    step,
    keys: typeof keys === "string" ? key(keys) : keys,
    next,
  });
  const decision = pickLatest<LoginDecision>(screen, [
    { pattern: MAIN_MENU, enabled: state.passwordSent, make: () => ({ kind: "done" }) },
    { pattern: /您想刪除其他重複登入的連線嗎/, make: () => send("keep-other-session", "n\r") },
    { pattern: /您要刪除以上錯誤嘗試的記錄嗎/, make: () => send("clear-failed-attempts", "y\r") },
    { pattern: /登入太頻繁/, make: () => send("login-too-frequent", " ") },
    { pattern: /任意鍵/, make: () => send("any-key", " ") },
    {
      pattern: /請輸入代號/,
      enabled: !state.idSent,
      make: () =>
        send("send-id", Buffer.concat([input.id, key(KEY_ENTER)]), { ...state, idSent: true }),
    },
    {
      pattern: /請輸入您的密碼|密碼[:：]\s*$/m,
      enabled: state.idSent && !state.passwordSent,
      make: () =>
        send("send-password", Buffer.concat([input.password, key(KEY_ENTER)]), {
          ...state,
          passwordSent: true,
        }),
    },
  ]);
  return decision ?? { kind: "wait" };
}

export type MailStage =
  | "start"
  | "mail_menu"
  | "recipient_prompt"
  | "recipient_result"
  | "save_confirm"
  | "after_save"
  | "finished";

export interface MailInput {
  /** Encoded recipient id. */
  recipient: Buffer;
  /** Encoded subject, already within the byte cap. */
  subject: Buffer;
  /** Encoded body (lines separated by CR). */
  body: Buffer;
}

export type MailDecision =
  | { kind: "wait" }
  | { kind: "error"; error: PttError }
  | {
      kind: "send";
      step: string;
      keys: Buffer;
      next: MailStage;
      /** True when `keys` contains the key that makes PTT send the mail. */
      commit?: boolean;
    };

/**
 * Whether the screen proves PTT accepted and sent the mail.
 * @param screen - Decoded screen text.
 * @returns True when the sent-mail text or the keep-a-copy prompt is shown.
 */
export function isSendConfirmed(screen: string): boolean {
  return /已順利寄出|是否自存底稿/.test(screen);
}

/**
 * Decides the next mail action from the current stage and the screen shown since the last keys.
 * @param stage - The stage the flow is in.
 * @param screen - Decoded screen text with ANSI removed.
 * @param input - The encoded recipient, subject and body.
 * @param confirmed - Whether the sent confirmation was already seen.
 * @returns Wait, fail with a typed error, or send keys and move to the next stage.
 */
export function decideMail(
  stage: Exclude<MailStage, "finished">,
  screen: string,
  input: MailInput,
  confirmed: boolean,
): MailDecision {
  const send = (
    step: string,
    keys: Buffer | string,
    next: MailStage,
    commit = false,
  ): MailDecision => ({
    kind: "send",
    step,
    keys: typeof keys === "string" ? key(keys) : keys,
    next,
    ...(commit ? { commit: true } : {}),
  });

  switch (stage) {
    case "start":
      return send("open-mail", "M\r", "mail_menu");
    case "mail_menu":
      return /【電子郵件】/.test(screen) ? send("open-compose", "S\r", "recipient_prompt") : wait();
    case "recipient_prompt":
      return /使用者代號/.test(screen)
        ? send(
            "send-recipient",
            Buffer.concat([input.recipient, key(KEY_ENTER)]),
            "recipient_result",
          )
        : wait();
    case "recipient_result":
      if (/主題[:：]/.test(screen)) {
        return send(
          "send-subject-and-body",
          Buffer.concat([input.subject, key(KEY_ENTER), input.body, key(KEY_CTRL_X)]),
          "save_confirm",
        );
      }
      if (/【電子郵件】/.test(screen)) {
        return { kind: "error", error: new PttError("NoSuchUser") };
      }
      return wait();
    case "save_confirm":
      return /確定要儲存檔案嗎/.test(screen) ? send("save", "s\r", "after_save", true) : wait();
    case "after_save":
      return (
        pickLatest<MailDecision>(screen, [
          { pattern: /選擇簽名檔|x=隨機/, make: () => send("signature", "0\r", "after_save") },
          { pattern: /是否自存底稿/, make: () => send("skip-draft-copy", "n\r", "after_save") },
          {
            pattern: /任意鍵/,
            make: () => send("ack", "\r", confirmed ? "finished" : "after_save"),
          },
        ]) ?? wait()
      );
  }
}

function wait(): MailDecision {
  return { kind: "wait" };
}

export type LogoutDecision =
  | { kind: "wait" }
  | { kind: "send"; step: string; keys: Buffer; goodbyeSent: boolean; finished: boolean };

/**
 * Decides the next logout action: reach the main menu, press G, confirm with y.
 * @param screen - Decoded screen text with ANSI removed.
 * @param goodbyeSent - Whether G was already pressed.
 * @returns Wait or the keys to send.
 */
export function decideLogout(screen: string, goodbyeSent: boolean): LogoutDecision {
  const send = (step: string, keys: string, sent: boolean, finished = false): LogoutDecision => ({
    kind: "send",
    step,
    keys: key(keys),
    goodbyeSent: sent,
    finished,
  });
  return (
    pickLatest<LogoutDecision>(screen, [
      { pattern: /確定要離開/, make: () => send("confirm-goodbye", "y\r", true, true) },
      { pattern: MAIN_MENU, enabled: !goodbyeSent, make: () => send("goodbye", "G\r", true) },
      { pattern: /任意鍵/, make: () => send("any-key", " ", goodbyeSent) },
    ]) ?? { kind: "wait" }
  );
}

// ---------------------------------------------------------------------------
// Transport (thin socket layer) and session
// ---------------------------------------------------------------------------

/** Byte pipe to the terminal; a WebSocket in production, a fake in tests. */
export interface PttTransport {
  onData: ((chunk: Buffer) => void) | null;
  onClose: (() => void) | null;
  send(data: Buffer): void;
  close(): void;
}

/**
 * Opens the PTT WebSocket with the term.ptt.cc Origin header.
 * @param url - WebSocket endpoint.
 * @param origin - Origin header value.
 * @param timeoutMs - Handshake timeout.
 * @returns A connected transport.
 * @throws PttError `ConnectFailed` when the handshake fails or times out.
 */
export function openWebSocketTransport(
  url = PTT_WS_URL,
  origin = PTT_WS_ORIGIN,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<PttTransport> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new PttError("ConnectFailed", "global WebSocket is not available"));
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { Origin: origin } });
    } catch {
      reject(new PttError("ConnectFailed", "WebSocket constructor failed"));
      return;
    }
    ws.binaryType = "arraybuffer";
    const transport: PttTransport = {
      onData: null,
      onClose: null,
      send: (data) => ws.send(data),
      close: () => ws.close(),
    };
    let opened = false;
    const timer = setTimeout(() => {
      reject(new PttError("ConnectFailed", "handshake timed out"));
      ws.close();
    }, timeoutMs);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve(transport);
    });
    ws.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) transport.onData?.(Buffer.from(event.data));
    });
    ws.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(timer);
        reject(new PttError("ConnectFailed", "WebSocket error"));
      }
    });
    ws.addEventListener("close", () => {
      if (!opened) {
        clearTimeout(timer);
        reject(new PttError("ConnectFailed", "closed before open"));
      }
      transport.onClose?.();
    });
  });
}

export interface PttTerminalOptions {
  /** Longest wait for one expected prompt. */
  stepTimeoutMs?: number;
  /** Cap on the whole login-and-mail run. */
  overallTimeoutMs?: number;
  /** Wait for the closing prompt once the mail is known to be sent. */
  confirmedStepTimeoutMs?: number;
  /** Wait for each logout prompt. */
  logoutStepTimeoutMs?: number;
  /** How long to wait for the server to close the socket after logout. */
  closeGraceMs?: number;
}

export interface ConnectOptions extends PttTerminalOptions {
  /** Replaces the WebSocket connection (tests). */
  connect?: () => Promise<PttTransport>;
}

export interface MailParams {
  to: string;
  subject: string;
  body: string;
}

/** One PTT terminal session. Not reusable after `close()`. */
export class PttTerminal {
  private raw = Buffer.alloc(0);
  private cachedScreen: string | null = null;
  private closed = false;
  private listener: (() => void) | null = null;
  private closeListener: (() => void) | null = null;
  private readonly stepTimeoutMs: number;
  private readonly confirmedStepTimeoutMs: number;
  private readonly logoutStepTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly deadline: number;

  /**
   * @param transport - The byte pipe to PTT.
   * @param options - Timeouts.
   */
  constructor(
    private readonly transport: PttTransport,
    options: PttTerminalOptions = {},
  ) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.confirmedStepTimeoutMs = options.confirmedStepTimeoutMs ?? CONFIRMED_STEP_TIMEOUT_MS;
    this.logoutStepTimeoutMs = options.logoutStepTimeoutMs ?? LOGOUT_STEP_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
    this.deadline = Date.now() + (options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
    transport.onData = (chunk) => {
      this.raw = Buffer.concat([this.raw, chunk]);
      if (this.raw.length > MAX_BUFFER_BYTES) {
        this.raw = this.raw.subarray(this.raw.length - MAX_BUFFER_BYTES);
      }
      this.cachedScreen = null;
      this.listener?.();
    };
    transport.onClose = () => {
      this.closed = true;
      this.closeListener?.();
    };
  }

  /**
   * Connects to PTT.
   * @param options - Timeouts and an optional transport factory.
   * @returns A session on a connected transport.
   * @throws PttError `ConnectFailed`.
   */
  static async connect(options: ConnectOptions = {}): Promise<PttTerminal> {
    const transport = await (options.connect ?? (() => openWebSocketTransport()))();
    return new PttTerminal(transport, options);
  }

  /**
   * Logs in, answering the prompts of decision 3 (never kicks another session).
   * @param id - PTT id.
   * @param password - PTT password; never logged.
   * @throws PttError `WrongPassword` (also for the ids guest and new), `TwoFactorRequired`,
   *   `PttBusy`, `SecureConnectionRequired`, `UnfinishedDraft`, `Timeout` or `ConnectFailed`.
   */
  async login(id: string, password: string): Promise<void> {
    assertRealPttId(id);
    const input: LoginInput = {
      id: encodeInput(id, { singleLine: true, maxBytes: PTT_ID_MAX_BYTES }),
      password: encodeInput(password, { singleLine: true }),
    };
    if (input.id.length === 0 || input.password.length === 0) {
      throw new PttError("WrongPassword", "empty credentials");
    }
    let state: LoginState = { idSent: false, passwordSent: false };
    for (let i = 0; i < MAX_STEPS; i++) {
      const decision = await this.waitFor("login", (screen) => {
        const d = decideLogin(screen, state, input);
        return d.kind === "wait" ? undefined : d;
      });
      if (decision.kind === "error") throw decision.error;
      if (decision.kind === "done") {
        logger.debug({ step: "login-done" }, "ptt step");
        return;
      }
      logger.debug({ step: decision.step }, "ptt step");
      this.send(decision.keys);
      state = decision.next;
    }
    throw new PttError("Timeout", "too many login steps");
  }

  /**
   * Sends one in-site mail from the main menu. Never throws; the result says whether the mail
   * was sent, not sent, or unknown (decision 4).
   * @param params - Recipient, subject and body (untrusted text).
   * @returns The outcome and the error code of a failure, if any.
   */
  async sendMail(params: MailParams): Promise<MailResult> {
    const input: MailInput = {
      recipient: encodeInput(params.to, { singleLine: true, maxBytes: PTT_ID_MAX_BYTES }),
      subject: encodeInput(params.subject, { singleLine: true, maxBytes: SUBJECT_MAX_BYTES }),
      body: encodeInput(params.body),
    };
    const flow = { progress: "before_save" as MailProgress };
    let stage: MailStage = "start";
    this.clear();
    try {
      if (input.recipient.length === 0) throw new PttError("NoSuchUser", "empty recipient");
      for (let i = 0; i < MAX_STEPS && stage !== "finished"; i++) {
        const current: Exclude<MailStage, "finished"> = stage;
        const decision: Exclude<MailDecision, { kind: "wait" }> = await this.waitFor(
          `mail:${current}`,
          (screen) => {
            if (current === "after_save" && isSendConfirmed(screen)) flow.progress = "confirmed";
            const d = decideMail(current, screen, input, flow.progress === "confirmed");
            return d.kind === "wait" ? undefined : d;
          },
          flow.progress === "confirmed" ? this.confirmedStepTimeoutMs : undefined,
        );
        if (decision.kind === "error") throw decision.error;
        logger.debug({ step: decision.step }, "ptt step");
        // Mark the save key as sent before writing it, so a failed write counts as unknown.
        if (decision.commit) flow.progress = "saving";
        this.send(decision.keys);
        stage = decision.next;
      }
      if (stage !== "finished") throw new PttError("Timeout", "too many mail steps");
      return { outcome: classifyMailOutcome(flow.progress) };
    } catch (error) {
      const err = toPttError(error);
      const outcome = classifyMailOutcome(flow.progress);
      logger.warn({ errorCode: err.code, outcome }, "ptt mail flow failed");
      return { outcome, errorCode: err.code, detail: err.message };
    }
  }

  /**
   * Leaves PTT politely (left arrow, G, y). Never throws; failures are logged.
   */
  async logout(): Promise<void> {
    try {
      this.send(key(KEY_LEFT));
      let goodbyeSent = false;
      for (let i = 0; i < 6; i++) {
        const decision: Extract<LogoutDecision, { kind: "send" }> = await this.waitFor(
          "logout",
          (screen) => {
            const d = decideLogout(screen, goodbyeSent);
            return d.kind === "wait" ? undefined : d;
          },
          this.logoutStepTimeoutMs,
          true,
        );
        logger.debug({ step: decision.step }, "ptt step");
        this.send(decision.keys);
        goodbyeSent = decision.goodbyeSent;
        if (decision.finished) {
          await this.waitClosed(this.closeGraceMs);
          return;
        }
      }
    } catch (error) {
      logger.warn({ errorCode: toPttError(error).code }, "ptt logout failed");
    }
  }

  /** Closes the socket; safe to call more than once. */
  close(): void {
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      // Already closed.
    }
  }

  private clear(): void {
    this.raw = Buffer.alloc(0);
    this.cachedScreen = null;
  }

  private screen(): string {
    this.cachedScreen ??= decodeScreen(this.raw);
    return this.cachedScreen;
  }

  /** Clears the screen buffer (so an old prompt cannot satisfy the next wait) and writes keys. */
  private send(keys: Buffer): void {
    if (this.closed) throw new PttError("ConnectFailed", "connection closed");
    this.clear();
    this.transport.send(keys);
  }

  private waitClosed(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      this.closeListener = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Waits until `pick` returns a value for the screen accumulated since the last send.
   * `pick` may have side effects; it runs on every new chunk.
   */
  private waitFor<T>(
    step: string,
    pick: (screen: string) => T | undefined,
    timeoutMs: number = this.stepTimeoutMs,
    ignoreDeadline = false,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remaining = this.deadline - Date.now();
      const budget = ignoreDeadline ? timeoutMs : Math.min(timeoutMs, remaining);
      if (budget <= 0) {
        reject(new PttError("Timeout", `overall timeout before ${step}`));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new PttError("Timeout", `no expected prompt at ${step}`));
      }, budget);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listener = null;
        this.closeListener = null;
      };
      const check = (): boolean => {
        try {
          const result = pick(this.screen());
          if (result === undefined) return false;
          cleanup();
          resolve(result);
        } catch (error) {
          cleanup();
          reject(error);
        }
        return true;
      };
      if (check()) return;
      if (this.closed) {
        cleanup();
        reject(new PttError("ConnectFailed", "connection closed"));
        return;
      }
      this.listener = () => void check();
      this.closeListener = () => {
        if (check()) return;
        cleanup();
        reject(new PttError("ConnectFailed", "connection closed"));
      };
    });
  }
}

function toPttError(error: unknown): PttError {
  if (error instanceof PttError) return error;
  return new PttError("ConnectFailed", error instanceof Error ? error.name : "unknown error");
}

// ---------------------------------------------------------------------------
// One-call lifecycles for callers (workers)
// ---------------------------------------------------------------------------

export interface SendPttMailParams extends MailParams {
  pttId: string;
  password: string;
}

/**
 * Connects, logs in, sends one mail, logs out and closes the socket in every path.
 * @param params - Credentials and the mail.
 * @param options - Timeouts and an optional transport factory.
 * @returns The outcome; a failure before the save key is `not_sent` with an `errorCode`.
 */
export async function sendPttMail(
  params: SendPttMailParams,
  options: ConnectOptions = {},
): Promise<MailResult> {
  let terminal: PttTerminal;
  try {
    assertRealPttId(params.pttId);
    terminal = await PttTerminal.connect(options);
  } catch (error) {
    const err = toPttError(error);
    return { outcome: "not_sent", errorCode: err.code, detail: err.message };
  }
  try {
    try {
      await terminal.login(params.pttId, params.password);
    } catch (error) {
      const err = toPttError(error);
      logger.warn({ errorCode: err.code }, "ptt login failed");
      return { outcome: "not_sent", errorCode: err.code, detail: err.message };
    }
    const result = await terminal.sendMail(params);
    // Only leave politely from a known menu: after a mid-compose failure a stray key could
    // answer a pending prompt, so those paths just close the socket.
    if (result.outcome === "sent" || result.errorCode === "NoSuchUser") await terminal.logout();
    return result;
  } finally {
    terminal.close();
  }
}

/**
 * Connects, logs in, logs out and closes; used to validate a PTT account.
 * @param pttId - PTT id.
 * @param password - PTT password; never logged.
 * @param options - Timeouts and an optional transport factory.
 * @throws PttError with the login failure; `WrongPassword` for the ids guest and new, which
 *   are refused before connecting.
 */
export async function verifyPttLogin(
  pttId: string,
  password: string,
  options: ConnectOptions = {},
): Promise<void> {
  assertRealPttId(pttId);
  const terminal = await PttTerminal.connect(options);
  try {
    await terminal.login(pttId, password);
    await terminal.logout();
  } catch (error) {
    const err = toPttError(error);
    logger.warn({ errorCode: err.code }, "ptt verify failed");
    throw err;
  } finally {
    terminal.close();
  }
}
