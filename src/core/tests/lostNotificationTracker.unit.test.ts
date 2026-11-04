import { LostNotificationTracker } from "../lostNotificationTracker";

const THIRTY_MIN_MS = 30 * 60_000;
const START = new Date("2026-11-04T00:00:00Z");

/**
 * A time relative to the start of each test.
 * @param ms - Milliseconds after the start.
 * @returns The date.
 */
function at(ms: number): Date {
  return new Date(START.getTime() + ms);
}

let tracker: LostNotificationTracker;

beforeEach(() => {
  tracker = new LostNotificationTracker();
});

describe("LostNotificationTracker", () => {
  it("reports the first loss at once", () => {
    expect(tracker.record("react@Soho", at(0))).toEqual({ count: 1, latest: "react@Soho" });
  });

  it("accumulates losses inside the window and reports them once it has passed", () => {
    tracker.record("a@Soho", at(0));

    expect(tracker.record("b@Soho", at(1000))).toBeNull();
    expect(tracker.record("c@CodeJob", at(THIRTY_MIN_MS - 1))).toBeNull();

    expect(tracker.record("d@CodeJob", at(THIRTY_MIN_MS))).toEqual({
      count: 3,
      latest: "d@CodeJob",
    });
  });

  it("lets takeDue report accumulated losses with no further loss", () => {
    tracker.record("a@Soho", at(0));
    tracker.record("b@Soho", at(1000));

    expect(tracker.takeDue(at(THIRTY_MIN_MS - 1))).toBeNull();
    expect(tracker.takeDue(at(THIRTY_MIN_MS))).toEqual({ count: 1, latest: "b@Soho" });
  });

  it("does not report the same losses twice", () => {
    tracker.record("a@Soho", at(0));

    expect(tracker.takeDue(at(THIRTY_MIN_MS * 2))).toBeNull();
  });

  it("starts a new window after each report", () => {
    tracker.record("a@Soho", at(0));
    tracker.record("b@Soho", at(1000));
    tracker.takeDue(at(THIRTY_MIN_MS));

    expect(tracker.record("c@Soho", at(THIRTY_MIN_MS + 1000))).toBeNull();
    expect(tracker.takeDue(at(THIRTY_MIN_MS * 2))).toEqual({ count: 1, latest: "c@Soho" });
  });
});
