import { sendPttMail, verifyPttLogin } from "../services/pttTerminal";

/**
 * Live test against the real PTT. It logs in and mails the test account itself, so it runs
 * only when PTT_LIVE=1 and both credentials are set; module test runs never send mail.
 *
 *   PTT_LIVE=1 PTT_TEST_ID=... PTT_TEST_PASSWORD=... npx jest src/modules/mail/tests/pttTerminal.test.ts
 *
 * After it passes, open the test account's PTT mailbox and confirm the subject and the
 * three body lines arrive as readable Chinese (this is the Big5 input check).
 */
const id = process.env.PTT_TEST_ID;
const password = process.env.PTT_TEST_PASSWORD;
const live = process.env.PTT_LIVE === "1" && !!id && !!password;
const describeLive = live ? describe : describe.skip;

describeLive("PTT terminal (live)", () => {
  it("logs in and logs out", async () => {
    await expect(verifyPttLogin(id!, password!)).resolves.toBeUndefined();
  }, 120_000);

  it("mails the test account itself with a Chinese subject and multi-line body", async () => {
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
    expect(result).toMatchObject({ outcome: "sent" });
  }, 180_000);
});
