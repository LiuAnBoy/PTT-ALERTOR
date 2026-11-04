/**
 * Live PTT test. It logs in to the real PTT once and mails the test account itself, so it runs
 * only when PTT_LIVE=1 and both credentials are set; module test runs never send mail.
 *
 *   PTT_LIVE=1 PTT_TEST_ID=... PTT_TEST_PASSWORD=... npx jest src/modules/mail/tests/pttTerminal.test.ts
 *
 * One run is one login (login, mail and logout share a connection): PTT's DDoS/BOT detection
 * suspends an account that logs in repeatedly, so leave at least 3 minutes between runs.
 * After it passes, open the test account's PTT mailbox and confirm the subject and the three
 * body lines arrive as readable Chinese (this is the Big5 input check).
 */
import { sendPttMail } from "../services/pttTerminal";

const id = process.env.PTT_TEST_ID;
const password = process.env.PTT_TEST_PASSWORD;
const live = process.env.PTT_LIVE === "1" && !!id && !!password;
const describeLive = live ? describe : describe.skip;

describeLive("PTT terminal (live)", () => {
  it("logs in, mails the test account itself in Chinese, and logs out", async () => {
    const stamp = new Date().toISOString();
    const result = await sendPttMail({
      pttId: id!,
      password: password!,
      to: id!,
      subject: `Re: 【測試】PTT Alertor 寄信測試 ${stamp}`,
      body: [
        "第一行：你好，這是自動寄信測試。",
        "第二行：價格 3,500 元，請問還在嗎？",
        "第三行：謝謝！",
      ].join("\n"),
    });
    expect(result).toEqual({ outcome: "sent" });
  }, 180_000);
});
