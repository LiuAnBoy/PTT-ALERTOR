import iconv from "iconv-lite";

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../../../core/logger", () => ({ createLogger: () => mockLogger }));

import {
  classifyMailOutcome,
  decideLogin,
  decideLogout,
  decideMail,
  decodeScreen,
  encodeInput,
  type LoginInput,
  type LoginState,
  type MailInput,
  PttError,
  type PttErrorCode,
  PttTerminal,
  type PttTransport,
  sendPttMail,
  SUBJECT_MAX_BYTES,
  truncateBig5,
  verifyPttLogin,
} from "../services/pttTerminal";

const big5 = (text: string): Buffer => iconv.encode(text, "cp950");
const latin = (b: Buffer): string => b.toString("latin1");

const loginInput: LoginInput = { id: Buffer.from("alice"), password: Buffer.from("s3cret") };
const fresh: LoginState = { idSent: false, passwordSent: false };
const afterId: LoginState = { idSent: true, passwordSent: false };
const afterPw: LoginState = { idSent: true, passwordSent: true };

/** Fake terminal: replies to the n-th write with the n-th canned screen (null = silence). */
class FakeTransport implements PttTransport {
  onData: ((chunk: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  sent: Buffer[] = [];
  closeCalls = 0;

  constructor(private readonly replies: Array<string | string[] | null>) {}

  send(data: Buffer): void {
    const reply = this.replies[this.sent.length];
    this.sent.push(data);
    if (!reply) return;
    const chunks = Array.isArray(reply) ? reply : [reply];
    setImmediate(() => chunks.forEach((c) => this.onData?.(big5(c))));
  }

  close(): void {
    this.closeCalls++;
    setImmediate(() => this.onClose?.());
  }

  emit(screen: string): void {
    this.onData?.(big5(screen));
  }
}

const OPTS = {
  stepTimeoutMs: 60,
  overallTimeoutMs: 5000,
  confirmedStepTimeoutMs: 30,
  logoutStepTimeoutMs: 30,
  closeGraceMs: 30,
};

// Replies for a whole run: login, mail, logout.
const LOGIN_REPLIES = [
  "\x1b[1;37m請輸入您的密碼:\x1b[m",
  "您想刪除其他重複登入的連線嗎？[Y/n]",
  "請按任意鍵繼續",
  "\x1b[2J【主功能表】 (G)oodbye",
];
const MAIL_REPLIES = [
  "【私人信件區】",
  "請輸入使用者代號：",
  "主題：",
  "確定要儲存檔案嗎? (S)儲存 (A)放棄",
  "請選擇簽名檔 (x=隨機)",
  "已順利寄出，是否自存底稿 (Y/N)? [N]",
  "請按任意鍵繼續",
];
const LOGOUT_REPLIES = [
  "【主功能表】",
  "您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N]",
  "此次停留時間: 0 小時 0 分 [按任意鍵繼續]",
  null,
];

async function loggedIn(replies: Array<string | string[] | null>) {
  const transport = new FakeTransport(replies);
  const term = new PttTerminal(transport, OPTS);
  transport.emit("請輸入代號，或以 guest 參觀，或以 new 註冊:");
  await term.login("alice", "s3cret");
  return { transport, term };
}

describe("decideLogin", () => {
  const keys = (screen: string, state = fresh) => {
    const d = decideLogin(screen, state, loginInput);
    return d.kind === "send" ? latin(d.keys) : d.kind;
  };

  it.each([
    ["id prompt", "請輸入代號，或以 guest 參觀，或以 new 註冊:", fresh, "alice\r"],
    ["password prompt", "請輸入您的密碼:", afterId, "s3cret\r"],
    ["duplicate login", "您想刪除其他重複登入的連線嗎？[Y/n]", afterPw, "n\r"],
    ["failed attempts log", "您要刪除以上錯誤嘗試的記錄嗎？", afterPw, "y\r"],
    ["too frequent", "登入太頻繁，請稍後再試", afterPw, " "],
    ["any key", "請按任意鍵繼續", afterPw, " "],
  ])("answers the %s prompt", (_name, screen, state, expected) => {
    expect(keys(screen, state)).toBe(expected);
  });

  it("answers through ANSI decoration and advances the state", () => {
    const screen = decodeScreen(big5("\x1b[1;37m請輸入代號\x1b[0m\x1b[5;1H:"));
    const d = decideLogin(screen, fresh, loginInput);
    expect(d).toMatchObject({ kind: "send", next: { idSent: true, passwordSent: false } });
  });

  it("finishes on the main menu only after the password was sent", () => {
    expect(keys("【主功能表】 批踢踢實業坊", afterPw)).toBe("done");
    expect(keys("【主功能表】 批踢踢實業坊", fresh)).toBe("wait");
    expect(keys("(G)oodbye", afterId)).toBe("wait");
  });

  it("recognises the main menu when PTT redraws its title without the opening 【", () => {
    // Live PTT redraws only changed cells; the 【 left by the previous screen is not resent.
    expect(keys("主功能表】                     批踢踢實業坊", afterPw)).toBe("done");
  });

  it.each([
    ["任意鍵", "有一篇文章尚未完成\r\n請按任意鍵繼續"],
    ["duplicate login", "請選擇暫存檔\r\n您想刪除其他重複登入的連線嗎？[Y/n]"],
    ["main menu", "有一篇文章尚未完成，是否繼續？\r\n【主功能表】 (G)oodbye"],
  ])("a draft prompt followed by %s on one screen still gets no key", (_name, screen) => {
    const d = decideLogin(screen, afterPw, loginInput);
    expect(d.kind).toBe("error");
    expect((d as { error: PttError }).error.code).toBe("UnfinishedDraft");
  });

  it.each([
    ["draft picker", "請選擇暫存檔 (0-9)"],
    ["unfinished article", "有一篇文章尚未完成，是否繼續？"],
  ])("stops with UnfinishedDraft on the %s prompt and sends no key", (_name, screen) => {
    const d = decideLogin(screen, afterPw, loginInput);
    expect(d.kind).toBe("error");
    expect((d as { error: PttError }).error.code).toBe("UnfinishedDraft");
  });

  it.each([
    ["密碼不對", "密碼不對或無此帳號", afterPw, "WrongPassword"],
    ["密碼錯誤", "密碼錯誤", afterPw, "WrongPassword"],
    ["two factor", "請輸入兩階段驗證碼:", afterPw, "TwoFactorRequired"],
    ["busy", "系統過載, 請稍後再來", fresh, "PttBusy"],
    ["secure only", "此帳號已設定為只能使用安全連線", afterId, "SecureConnectionRequired"],
  ])("fails on %s", (_name, screen, state, code) => {
    const d = decideLogin(screen, state, loginInput);
    expect(d.kind).toBe("error");
    expect((d as { error: PttError }).error.code).toBe(code);
  });

  it("does not answer the id prompt twice and waits on an unknown screen", () => {
    expect(keys("請輸入代號", afterId)).toBe("wait");
    expect(keys("歡迎光臨", fresh)).toBe("wait");
  });

  it("reports PTT's DDoS/BOT suspension instead of answering anything", () => {
    const screen =
      "[PTT DDoS/BOT 偵測系統] 帳號 alice 有疑似不當連續登入行為所以暫停連線，約 5 分鐘後恢復。";
    const d = decideLogin(screen, afterPw, loginInput);
    expect((d as { error: PttError }).error.code).toBe("LoginThrottled");
  });

  it("records a yes/no answer and ignores the prompt redrawn with that answer", () => {
    const d = decideLogin("您想刪除其他重複登入的連線嗎？[Y/n]", afterPw, loginInput);
    const next = (d as { next: LoginState }).next;
    expect(next.answered).toEqual(["keep-other-session"]);
    expect(keys("您想刪除其他重複登入的連線嗎？[Y/n] n", next)).toBe("wait");
    expect(keys("您想刪除其他重複登入的連線嗎？[Y/n] n\r\n請按任意鍵繼續", next)).toBe(" ");
  });

  it("lets the newest prompt win over a stale one in the same buffer", () => {
    expect(keys("請按任意鍵繼續\r\n【主功能表】", afterPw)).toBe("done");
    expect(keys("【主功能表】\r\n請按任意鍵繼續", afterPw)).toBe(" ");
  });
});

describe("decideMail", () => {
  const input: MailInput = {
    recipient: Buffer.from("bob"),
    subject: Buffer.from("subj"),
    body: Buffer.from("body\r"),
  };

  it("walks the mail steps in order", () => {
    const steps: Array<[Parameters<typeof decideMail>[0], string, string, string]> = [
      ["start", "", "M\r", "mail_menu"],
      ["mail_menu", "【私人信件區】", "S\r", "recipient_prompt"],
      ["recipient_prompt", "請輸入使用者代號：", "bob\r", "recipient_result"],
      ["recipient_result", "主題：", "subj\rbody\r\x18", "save_confirm"],
      ["save_confirm", "確定要儲存檔案嗎?", "s\r", "after_save"],
      ["after_save", "選擇簽名檔 (x=隨機)", "0\r", "after_save"],
      ["after_save", "已順利寄出，是否自存底稿 (Y/N)?", "n\r", "after_save"],
    ];
    for (const [stage, screen, keys, next] of steps) {
      const d = decideMail(stage, screen, input, false);
      expect(d).toMatchObject({ kind: "send", next });
      expect(latin((d as { keys: Buffer }).keys)).toBe(keys);
    }
  });

  it("marks only the save key as the commit point", () => {
    const save = decideMail("save_confirm", "確定要儲存檔案嗎?", input, false);
    const sig = decideMail("after_save", "選擇簽名檔", input, false);
    expect(save).toMatchObject({ commit: true });
    expect(sig).not.toHaveProperty("commit");
  });

  it("finishes after the final acknowledgement only once confirmed", () => {
    expect(decideMail("after_save", "請按任意鍵繼續", input, true)).toMatchObject({
      next: "finished",
    });
    expect(decideMail("after_save", "請按任意鍵繼續", input, false)).toMatchObject({
      next: "after_save",
    });
  });

  it("recognises the live mail menu, also when its title arrives without the opening 【", () => {
    for (const screen of ["私人信件區】", "●(R)ead 我的信箱 (S)end 站內寄信", "【私人信件區】"]) {
      expect(decideMail("mail_menu", screen, input, false)).toMatchObject({
        next: "recipient_prompt",
      });
    }
  });

  it("does not take the main menu's 【 私人信件區 】 item for the mail menu", () => {
    const mainMenu = "(M)ail         【 私人信件區 】 (T)alk 【 休閒聊天區 】";
    expect(decideMail("mail_menu", mainMenu, input, false).kind).toBe("wait");
    expect(decideMail("recipient_result", mainMenu, input, false).kind).toBe("wait");
  });

  it("does not answer the signature or draft-copy prompt again when it is redrawn", () => {
    expect(
      decideMail("after_save", "選擇簽名檔 (x=隨機) 0", input, false, ["signature"]).kind,
    ).toBe("wait");
    const echo = "已順利寄出，是否自存底稿 (Y/N)? [N] n";
    expect(decideMail("after_save", echo, input, true, ["signature", "skip-draft-copy"]).kind).toBe(
      "wait",
    );
  });

  it("reports a missing recipient and waits on an unrelated screen", () => {
    const d = decideMail("recipient_result", "【私人信件區】", input, false);
    expect((d as { error: PttError }).error.code).toBe("NoSuchUser");
    expect(decideMail("mail_menu", "loading", input, false).kind).toBe("wait");
  });
});

describe("decideLogout", () => {
  it("presses G on the main menu, confirms, then finishes on the farewell key", () => {
    expect(latin((decideLogout("【主功能表】", "start") as { keys: Buffer }).keys)).toBe("G\r");
    const confirm = decideLogout("您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N]", "goodbye");
    expect(confirm).toMatchObject({ next: "confirmed", finished: false });
    expect(latin((confirm as { keys: Buffer }).keys)).toBe("y\r");
    // PTT keeps the session on its farewell screen until a key is pressed.
    const farewell = decideLogout("此次停留時間: 0 小時 0 分 [按任意鍵繼續]", "confirmed");
    expect(farewell).toMatchObject({ finished: true });
    expect(latin((farewell as { keys: Buffer }).keys)).toBe(" ");
    expect(decideLogout("您確定要離開嗎(Y/N)？[N] y", "confirmed").kind).toBe("wait");
  });
});

describe("classifyMailOutcome", () => {
  it("maps progress to the outcome of a failure at that point", () => {
    expect(classifyMailOutcome("before_save")).toBe("not_sent");
    expect(classifyMailOutcome("saving")).toBe("unknown");
    expect(classifyMailOutcome("confirmed")).toBe("sent");
  });
});

describe("encodeInput", () => {
  it("drops ESC, Ctrl+X, DEL and other C0 bytes", () => {
    const hostile = "a\x1b[2Jb\x18c\x00d\x07e\x7ff\tg\x0bh";
    expect(latin(encodeInput(hostile))).toBe("a[2Jbcdefgh");
  });

  it("maps \\n, \\r\\n and lone \\r to one CR each", () => {
    expect(latin(encodeInput("a\nb\r\nc\rd"))).toBe("a\rb\rc\rd");
    expect(latin(encodeInput("a\r\n\r\nb"))).toBe("a\r\rb");
  });

  it("turns newlines into spaces in single-line mode", () => {
    expect(latin(encodeInput("a\r\nb\nc", { singleLine: true }))).toBe("a b c");
  });

  it("encodes Chinese as Big5 and unmappable characters as ?", () => {
    expect(encodeInput("中文")).toEqual(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]));
    expect(latin(encodeInput("a😀é"))).toBe("a??");
  });

  it("never emits a control byte other than CR for any BMP character", () => {
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const bytes = encodeInput(String.fromCodePoint(cp));
      const bad = [...bytes].some((b) => (b < 0x20 && b !== 0x0d) || b === 0x7f);
      if (bad) throw new Error(`control byte for U+${cp.toString(16)}`);
    }
  });
});

describe("subject truncation", () => {
  it("keeps a two-byte character that ends exactly at the limit", () => {
    const subject = "a".repeat(SUBJECT_MAX_BYTES - 2) + "中";
    expect(encodeInput(subject, { maxBytes: SUBJECT_MAX_BYTES }).length).toBe(58);
    expect(truncateBig5(subject, SUBJECT_MAX_BYTES)).toBe(subject);
  });

  it("drops a two-byte character that straddles the limit instead of splitting it", () => {
    const subject = "a".repeat(SUBJECT_MAX_BYTES - 1) + "中文";
    const bytes = encodeInput(subject, { singleLine: true, maxBytes: SUBJECT_MAX_BYTES });
    expect(bytes.length).toBe(57);
    expect(latin(bytes)).toBe("a".repeat(57));
    expect(truncateBig5(subject, SUBJECT_MAX_BYTES)).toBe("a".repeat(57));
  });

  it("never exceeds the limit for all-Chinese text", () => {
    const bytes = encodeInput("測".repeat(40), { maxBytes: SUBJECT_MAX_BYTES });
    expect(bytes.length).toBe(58);
    expect(iconv.decode(bytes, "cp950")).toBe("測".repeat(29));
  });
});

describe("decodeScreen", () => {
  it("strips ANSI and decodes Big5 split across chunks", () => {
    const raw = big5("\x1b[1;33m請輸入代號\x1b[m");
    expect(decodeScreen(raw)).toBe("請輸入代號");
  });
});

describe("PttTerminal.login", () => {
  beforeEach(() => jest.clearAllMocks());

  it("answers each prompt in order and never kicks the other session", async () => {
    const { transport } = await loggedIn(LOGIN_REPLIES);
    expect(transport.sent.map(latin)).toEqual(["alice\r", "s3cret\r", "n\r", " "]);
  });

  it("sends no stray key when PTT echoes the duplicate-login answer on its own", async () => {
    // Live PTT redraws the prompt with the typed "n" before the next screen; answering the echo
    // again put an Enter on the main menu and opened the board list.
    const duplicate = "您想刪除其他重複登入的連線嗎？[Y/n]";
    const transport = new FakeTransport([
      "請輸入您的密碼:",
      duplicate,
      `${duplicate} n`,
      "\x1b[2J【主功能表】 (G)oodbye",
    ]);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("請輸入代號:");
    setTimeout(() => transport.emit("請按任意鍵繼續"), 20);
    await term.login("alice", "s3cret");
    expect(transport.sent.map(latin)).toEqual(["alice\r", "s3cret\r", "n\r", " "]);
  });

  it("accumulates a prompt split across chunks, including a split Big5 character", async () => {
    const transport = new FakeTransport(["請輸入您的密碼:", "【主功能表】"]);
    const term = new PttTerminal(transport, OPTS);
    const bytes = big5("請輸入代號:");
    transport.onData?.(bytes.subarray(0, 3));
    setImmediate(() => transport.onData?.(bytes.subarray(3)));
    await term.login("alice", "pw");
    expect(transport.sent.map(latin)).toEqual(["alice\r", "pw\r"]);
  });

  it.each([
    ["密碼不對或無此帳號", "WrongPassword"],
    ["請輸入兩階段驗證碼", "TwoFactorRequired"],
    ["系統過載, 請稍後再來", "PttBusy"],
  ])("rejects with a typed error for %s", async (screen, code) => {
    const transport = new FakeTransport(["請輸入您的密碼:", screen]);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("請輸入代號:");
    await expect(term.login("alice", "pw")).rejects.toMatchObject({ code });
  });

  it("reports TooManySessions when PTT disconnects after the duplicate-login n", async () => {
    // pttbbs drops a login that keeps three or more other sessions, with no message.
    const transport = new FakeTransport(["請輸入您的密碼:", "您想刪除其他重複登入的連線嗎？[Y/n]"]);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("請輸入代號:");
    const send = transport.send.bind(transport);
    transport.send = (d) => {
      send(d);
      if (latin(d) === "n\r") setImmediate(() => transport.onClose?.());
    };
    await expect(term.login("alice", "pw")).rejects.toMatchObject({ code: "TooManySessions" });
    expect(transport.sent.map(latin)).toEqual(["alice\r", "pw\r", "n\r"]);
  });

  it("times out when no expected prompt arrives", async () => {
    const transport = new FakeTransport([]);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("歡迎");
    await expect(term.login("alice", "pw")).rejects.toMatchObject({ code: "Timeout" });
  });

  it("does not let a cleared old prompt satisfy a new wait", async () => {
    // After the id is sent the id prompt is gone from the buffer; silence must time out.
    const transport = new FakeTransport([null]);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("請輸入代號:");
    await expect(term.login("alice", "pw")).rejects.toMatchObject({ code: "Timeout" });
    expect(transport.sent.map(latin)).toEqual(["alice\r"]);
  });

  it("rejects empty credentials without sending anything", async () => {
    const transport = new FakeTransport([]);
    const term = new PttTerminal(transport, OPTS);
    await expect(term.login("", "pw")).rejects.toMatchObject({ code: "WrongPassword" });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("PttTerminal.sendMail", () => {
  const params = { to: "bob", subject: "Re: 出售全新手機", body: "你好\n請問還在嗎\r\n謝謝" };
  const compose = Buffer.concat([
    big5("Re: 出售全新手機"),
    Buffer.from("\r"),
    big5("你好\r請問還在嗎\r謝謝"),
    Buffer.from("\x18"),
  ]);

  beforeEach(() => jest.clearAllMocks());

  it("sends the full key sequence and reports sent", async () => {
    const { transport, term } = await loggedIn([...LOGIN_REPLIES, ...MAIL_REPLIES]);
    const result = await term.sendMail(params);
    expect(result).toEqual({ outcome: "sent" });
    expect(transport.sent).toHaveLength(12);
    expect(transport.sent[4]).toEqual(Buffer.from("M\r"));
    expect(transport.sent[5]).toEqual(Buffer.from("S\r"));
    expect(transport.sent[6]).toEqual(Buffer.from("bob\r"));
    expect(transport.sent[7]).toEqual(compose);
    expect(transport.sent.slice(8).map(latin)).toEqual(["s\r", "0\r", "n\r", "\r"]);
  });

  it("reports NoSuchUser as not_sent", async () => {
    const { transport, term } = await loggedIn([
      ...LOGIN_REPLIES,
      "【私人信件區】",
      "請輸入使用者代號：",
      "【私人信件區】",
    ]);
    const result = await term.sendMail(params);
    expect(result).toMatchObject({ outcome: "not_sent", errorCode: "NoSuchUser" });
    expect(transport.sent).toHaveLength(7);
  });

  it("is not_sent when a timeout hits before the save key", async () => {
    // Silence after the subject/body/Ctrl+X write: the save prompt never arrives.
    const { transport, term } = await loggedIn([
      ...LOGIN_REPLIES,
      ...MAIL_REPLIES.slice(0, 3),
      null,
    ]);
    const result = await term.sendMail(params);
    expect(result).toMatchObject({ outcome: "not_sent", errorCode: "Timeout" });
    expect(transport.sent.map(latin)).not.toContain("s\r");
  });

  it("is unknown when a timeout hits between the save key and the confirmation", async () => {
    const { transport, term } = await loggedIn([
      ...LOGIN_REPLIES,
      ...MAIL_REPLIES.slice(0, 4),
      null,
    ]);
    const result = await term.sendMail(params);
    expect(result).toMatchObject({ outcome: "unknown", errorCode: "Timeout" });
    expect(transport.sent.map(latin)).toContain("s\r");
  });

  it("is unknown when the connection drops after the save key", async () => {
    const { transport, term } = await loggedIn([...LOGIN_REPLIES, ...MAIL_REPLIES.slice(0, 4)]);
    setTimeout(() => transport.onClose?.(), 10);
    const result = await term.sendMail(params);
    expect(result).toMatchObject({ outcome: "unknown", errorCode: "ConnectFailed" });
  });

  it("is sent when a timeout hits after the confirmation", async () => {
    const { term } = await loggedIn([
      ...LOGIN_REPLIES,
      ...MAIL_REPLIES.slice(0, 4),
      "已順利寄出，是否自存底稿 (Y/N)? [N]",
      null,
    ]);
    const result = await term.sendMail(params);
    expect(result).toMatchObject({ outcome: "sent", errorCode: "Timeout" });
  });

  it("is sent when the confirmation is the last thing PTT shows", async () => {
    const { term } = await loggedIn([...LOGIN_REPLIES, ...MAIL_REPLIES.slice(0, 4), "已順利寄出"]);
    const result = await term.sendMail(params);
    expect(result.outcome).toBe("sent");
  });

  it("never lets reply text act as keystrokes", async () => {
    const { transport, term } = await loggedIn([...LOGIN_REPLIES, ...MAIL_REPLIES.slice(0, 4)]);
    await term
      .sendMail({ to: "bob", subject: "x\x18y", body: "hi\x1b[Aq\x18\x18s\r" })
      .catch(() => undefined);
    const body = transport.sent[7];
    // Exactly one Ctrl+X (ours, last) and no ESC in the compose write.
    expect([...body].filter((b) => b === 0x18)).toHaveLength(1);
    expect(body[body.length - 1]).toBe(0x18);
    expect(body.includes(0x1b)).toBe(false);
  });
});

describe("PttTerminal.logout", () => {
  /** Closes the socket when the given key is sent, as PTT does at the end of its logout. */
  const closeOn = (transport: FakeTransport, closingKey: string) =>
    new Promise<void>((resolve) => {
      const send = transport.send.bind(transport);
      transport.send = (d) => {
        send(d);
        if (latin(d) !== closingKey) return;
        setImmediate(() => transport.onClose?.());
        resolve();
      };
    });

  it("presses G from the main menu, confirms, and presses a key on the farewell screen", async () => {
    // On the main menu a left arrow only moves the cursor, so the menu text never comes back;
    // and PTT keeps the session on its farewell screen until a key is pressed.
    const { transport, term } = await loggedIn([...LOGIN_REPLIES, ...LOGOUT_REPLIES.slice(1)]);
    const closing = closeOn(transport, " ");
    await term.logout();
    await closing;
    expect(transport.sent.slice(4).map(latin)).toEqual(["G\r", "y\r", " "]);
  });

  it("goes back to the main menu with a left arrow from another screen", async () => {
    const transport = new FakeTransport(LOGOUT_REPLIES);
    const term = new PttTerminal(transport, OPTS);
    transport.emit("【私人信件區】");
    const closing = closeOn(transport, " ");
    await term.logout();
    await closing;
    expect(transport.sent.map(latin)).toEqual(["\x1b[D", "G\r", "y\r", " "]);
  });

  it("treats a close right after y as a finished logout", async () => {
    const { transport, term } = await loggedIn([...LOGIN_REPLIES, ...LOGOUT_REPLIES.slice(1, 2)]);
    const closing = closeOn(transport, "y\r");
    await term.logout();
    await closing;
    expect(transport.sent.slice(4).map(latin)).toEqual(["G\r", "y\r"]);
  });

  it("does not throw when the screen never responds", async () => {
    const { term } = await loggedIn([...LOGIN_REPLIES]);
    await expect(term.logout()).resolves.toBeUndefined();
  });
});

describe("sendPttMail lifecycle", () => {
  beforeEach(() => jest.clearAllMocks());

  it("closes the transport and logs no secret on a full success", async () => {
    const transport = new FakeTransport([...LOGIN_REPLIES, ...MAIL_REPLIES, ...LOGOUT_REPLIES]);
    const result = await sendPttMail(
      { pttId: "alice", password: "s3cret", to: "bob", subject: "hi", body: "hello" },
      {
        ...OPTS,
        connect: async () => {
          setImmediate(() => transport.emit("請輸入代號:"));
          return transport;
        },
      },
    );
    expect(result.outcome).toBe("sent");
    expect(transport.closeCalls).toBe(1);
    expect(JSON.stringify(mockLogger.debug.mock.calls)).not.toContain("s3cret");
  });

  it("returns not_sent with the code on a wrong password and still closes", async () => {
    const transport = new FakeTransport(["請輸入您的密碼:", "密碼不對"]);
    const result = await sendPttMail(
      { pttId: "alice", password: "s3cret", to: "bob", subject: "hi", body: "hello" },
      {
        ...OPTS,
        connect: async () => {
          setImmediate(() => transport.emit("請輸入代號:"));
          return transport;
        },
      },
    );
    expect(result).toMatchObject({ outcome: "not_sent", errorCode: "WrongPassword" });
    expect(transport.closeCalls).toBe(1);
    const logged = JSON.stringify([
      ...mockLogger.debug.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ]);
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("密碼不對");
  });

  it("returns not_sent / ConnectFailed when the connection cannot be made", async () => {
    const result = await sendPttMail(
      { pttId: "a", password: "b", to: "c", subject: "d", body: "e" },
      {
        connect: async () => {
          throw new PttError("ConnectFailed");
        },
      },
    );
    expect(result).toMatchObject({ outcome: "not_sent", errorCode: "ConnectFailed" });
  });

  it("closes without pressing any key when the mail flow ends unknown", async () => {
    const transport = new FakeTransport([...LOGIN_REPLIES, ...MAIL_REPLIES.slice(0, 4), null]);
    const result = await sendPttMail(
      { pttId: "alice", password: "s3cret", to: "bob", subject: "hi", body: "hello" },
      {
        ...OPTS,
        connect: async () => {
          setImmediate(() => transport.emit("請輸入代號:"));
          return transport;
        },
      },
    );
    expect(result.outcome).toBe("unknown");
    expect(transport.closeCalls).toBe(1);
    expect(transport.sent.map(latin)).not.toContain("\x1b[D");
  });
});

describe("reserved ids", () => {
  const connect = jest.fn();
  beforeEach(() => connect.mockClear());

  it.each(["guest", "GUEST", "New", " new "])(
    "sendPttMail refuses %j before connecting",
    async (pttId) => {
      const result = await sendPttMail(
        { pttId, password: "pw", to: "bob", subject: "hi", body: "hello" },
        { connect },
      );
      expect(result).toMatchObject({ outcome: "not_sent", errorCode: "WrongPassword" });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("verifyPttLogin refuses guest before connecting", async () => {
    await expect(verifyPttLogin("Guest", "pw", { connect })).rejects.toMatchObject({
      code: "WrongPassword",
    });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("unfinished draft", () => {
  it.each(["有一篇文章尚未完成，是否繼續？", "請選擇暫存檔 (0-9)"])(
    "sendPttMail closes without any key after the password for %s",
    async (screen) => {
      const transport = new FakeTransport(["請輸入您的密碼:", screen]);
      const result = await sendPttMail(
        { pttId: "alice", password: "pw", to: "bob", subject: "hi", body: "hello" },
        {
          ...OPTS,
          connect: async () => {
            setImmediate(() => transport.emit("請輸入代號:"));
            return transport;
          },
        },
      );
      expect(result).toMatchObject({ outcome: "not_sent", errorCode: "UnfinishedDraft" });
      expect(transport.sent.map(latin)).toEqual(["alice\r", "pw\r"]);
      expect(transport.closeCalls).toBe(1);
    },
  );
});

describe("verifyPttLogin", () => {
  it("throws the typed error and closes", async () => {
    const transport = new FakeTransport(["請輸入您的密碼:", "密碼錯誤"]);
    const code: PttErrorCode = "WrongPassword";
    await expect(
      verifyPttLogin("alice", "pw", {
        ...OPTS,
        connect: async () => {
          setImmediate(() => transport.emit("請輸入代號:"));
          return transport;
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(transport.closeCalls).toBe(1);
  });
});
