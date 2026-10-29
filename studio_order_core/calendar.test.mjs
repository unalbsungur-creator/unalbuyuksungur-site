import test from "node:test";
import assert from "node:assert/strict";
import {
    CalendarError, TARIFFS, DAY_TYPES, REVISION_OUTCOMES, DURATION_SOURCES, PACKAGE_DURATIONS, HOLD_TTL_MS,
    loadCalendar, classifyDay, parseInstant, formatLocal, isEligible, nextEligibleTime, countWorkingTime,
    addWorkingTime, computeDeadline, packageDurationMs, evaluateRevisionRequest, confirmationRequirements,
    validateSlot, listSlots, holdExpiresAt, isHoldActive, createSlotValidator
} from "./calendar.mjs";

// SYNTHETIC fixture only. These dates are not official Turkish holidays and must never be used as such.
// 2031-03-03 Mon … 2031-03-07 Fri, 03-08 Sat, 03-09 Sun, 03-11 Tue (half-day 13:00),
// 03-12 Wed (holiday), 03-13 Thu (administrative leave), 03-14 Fri (half-day with missing start time).
const APPROVAL_2031 = {
    year: 2031, approvedBy: "synthetic-producer", approverRole: "PRODUCER",
    approvedAt: "2031-01-02T09:00:00Z", reference: "task-124-synthetic-approval"
};
const FIXTURE = {
    timeZone: "Europe/Istanbul", version: "synthetic-2031.2",
    source: { kind: "SYNTHETIC", reference: "task-124-test-fixture" },
    coverage: { from: "2031-01-01", to: "2031-12-31" },
    annualApprovals: [APPROVAL_2031],
    days: [
        { date: "2031-03-11", kind: "HALF_DAY", halfDayStart: "13:00" },
        { date: "2031-03-12", kind: "HOLIDAY" },
        { date: "2031-03-13", kind: "ADMINISTRATIVE_LEAVE" },
        { date: "2031-03-14", kind: "HALF_DAY", halfDayStart: null }
    ]
};
const CAL = loadCalendar(FIXTURE, { allowSynthetic: true });
const { STANDARD, URGENT } = TARIFFS;
const { SYNTHETIC_FIXTURE } = DURATION_SOURCES;
const H = 3600e3, M = 60e3;
// Istanbul wall time written with its explicit offset; the module itself converts through tzdb.
const at = local => parseInstant(`${local}+03:00`);
const code = expected => error => error instanceof CalendarError && error.code === expected;
const deadline = (slaStart, hours, tariff) => computeDeadline({ slaStart: at(slaStart), durationMs: hours * H,
    durationSource: SYNTHETIC_FIXTURE, tariff, calendar: CAL });
const deadlineOf = (slaStart, hours, tariff) => deadline(slaStart, hours, tariff).deadline;
const revision = (due, evaluatedAt, tariff = STANDARD, extra = {}) =>
    evaluateRevisionRequest({ deadline: due, evaluatedAt, tariff, calendar: CAL, ...extra });
const slot = (local, tariff, now) => validateSlot({ slotStart: at(local), tariff, now: at(now), calendar: CAL });

// ---- Görev 123 scenarios (kept; expectations updated only where Görev 124 decided them) ----

test("123/1-2: weekday standard window opens at 09:00 and closes at 18:00", () => {
    assert.equal(isEligible(at("2031-03-03T09:00:00"), STANDARD, CAL), true);
    assert.equal(isEligible(at("2031-03-03T08:59:59.999"), STANDARD, CAL), false);
    assert.equal(isEligible(at("2031-03-07T17:59:59.999"), STANDARD, CAL), true);
    assert.equal(isEligible(at("2031-03-07T18:00:00"), STANDARD, CAL), false);
    assert.equal(isEligible(at("2031-03-07T18:00:00"), URGENT, CAL), true);
    assert.equal(nextEligibleTime(at("2031-03-07T18:00:00"), STANDARD, CAL), at("2031-03-10T09:00:00"));
    // The tzdb conversion agrees with an independently written UTC instant.
    assert.equal(isEligible("2031-03-03T06:00:00Z", STANDARD, CAL), true);
});

test("123/3-4: Saturday has no standard window but is fully urgent from 09:00", () => {
    const day = classifyDay("2031-03-08", CAL);
    assert.equal(day.dayType, DAY_TYPES.WEEKEND);
    assert.deepEqual(day.windows.STANDARD, []);
    assert.equal(isEligible(at("2031-03-08T10:00:00"), STANDARD, CAL), false);
    assert.equal(isEligible(at("2031-03-08T10:00:00"), URGENT, CAL), true);
    assert.equal(slot("2031-03-08T10:00:00", URGENT, "2031-03-07T10:00:00").dayType, DAY_TYPES.WEEKEND);
    assert.throws(() => slot("2031-03-08T10:00:00", STANDARD, "2031-03-07T10:00:00"), code("STANDARD_NOT_AVAILABLE"));
});

test("123/5: 00:00-09:00 is forbidden for every tariff and day type", () => {
    for (const date of ["2031-03-03", "2031-03-08", "2031-03-12", "2031-03-11", "2031-03-13"]) {
        for (const tariff of [STANDARD, URGENT]) {
            assert.equal(isEligible(at(`${date}T00:30:00`), tariff, CAL), false);
            assert.equal(isEligible(at(`${date}T08:59:59.999`), tariff, CAL), false);
            assert.throws(() => slot(`${date}T00:30:00`, tariff, "2031-03-01T10:00:00"), code("SLOT_FORBIDDEN_WINDOW"));
        }
    }
});

test("123/6: Friday 17:30 standard SLA pauses for the weekend (synthetic 2 h duration)", () => {
    const result = deadline("2031-03-07T17:30:00", 2, STANDARD);
    assert.equal(result.deadline, at("2031-03-10T10:30:00"));
    assert.equal(result.calendarVersion, "synthetic-2031.2");
    assert.throws(() => deadline("2031-03-08T10:00:00", 1, STANDARD), code("SLA_START_NOT_ELIGIBLE"));
});

test("123/7: Friday 19:00 urgent SLA runs to 24:00, resumes Saturday 09:00 (synthetic 6 h)", () => {
    assert.equal(deadlineOf("2031-03-07T19:00:00", 6, URGENT), at("2031-03-08T10:00:00"));
    assert.throws(() => deadline("2031-03-07T19:00:00", 1, STANDARD), code("SLA_START_NOT_ELIGIBLE"));
});

test("123/8-9: a holiday refuses standard work and allows urgent work", () => {
    assert.equal(classifyDay("2031-03-12", CAL).dayType, DAY_TYPES.HOLIDAY);
    assert.equal(isEligible(at("2031-03-12T10:00:00"), STANDARD, CAL), false);
    // Standard SLA: Tuesday half-day gives 1 h before 13:00, Wednesday holiday is skipped.
    assert.equal(deadlineOf("2031-03-11T12:00:00", 2, STANDARD), at("2031-03-13T10:00:00"));
    assert.equal(deadlineOf("2031-03-12T14:00:00", 2, URGENT), at("2031-03-12T16:00:00"));
});

test("123/11-12: revision with exactly 120 minutes extends; 120 min + 1 ms does not", () => {
    const due = at("2031-03-03T15:00:00");
    const exact = revision(due, at("2031-03-03T13:00:00"));
    assert.equal(exact.extended, true);
    assert.equal(exact.deadline, at("2031-03-04T12:00:00"));
    const over = revision(due, at("2031-03-03T12:59:59.999"));
    assert.equal(over.extended, false);
    assert.equal(over.deadline, due);
});

test("123/revision-threshold: wall-clock time decides; working hours are not used", () => {
    // Friday 17:00 → Monday 09:30 is 64.5 h of real time but only 1.5 standard working hours.
    const result = revision(at("2031-03-10T09:30:00"), at("2031-03-07T17:00:00"));
    assert.equal(result.remainingMs, 64.5 * H);
    assert.equal(countWorkingTime(at("2031-03-07T17:00:00"), at("2031-03-10T09:30:00"), STANDARD, CAL), 1.5 * H);
    assert.equal(result.outcome, REVISION_OUTCOMES.REVISION_ELIGIBLE);
    assert.equal(result.extended, false);
    // The superseded interpretation switch is no longer accepted.
    for (const thresholdMode of ["WORKING", "ELAPSED"]) {
        assert.throws(() => revision(at("2031-03-10T09:30:00"), at("2031-03-07T17:00:00"), STANDARD, { thresholdMode }),
            code("INVALID_REQUEST"));
    }
});

test("123/14: SLA crossing the night ban skips 00:00-09:00 and never ends inside it", () => {
    assert.equal(deadlineOf("2031-03-03T22:00:00", 3, URGENT), at("2031-03-04T10:00:00"));
    assert.equal(countWorkingTime(at("2031-03-03T22:00:00"), at("2031-03-04T10:00:00"), URGENT, CAL), 3 * H);
    for (let hour = 9; hour < 24; hour += 1) {
        for (const minutes of [30, 90, 400, 1000, 3000]) {
            for (const tariff of [STANDARD, URGENT]) {
                const start = at(`2031-03-0${tariff === STANDARD ? 3 : 8}T${String(hour).padStart(2, "0")}:00:00`);
                if (!isEligible(start, tariff, CAL)) continue;
                const result = computeDeadline({ slaStart: start, durationMs: minutes * M,
                    durationSource: SYNTHETIC_FIXTURE, tariff, calendar: CAL });
                const local = new Date(result.deadline + 3 * H).getUTCHours();
                assert.ok(local >= 9 || result.endsAtProductionDayClose, `forbidden end for ${hour}:00 +${minutes}m`);
                assert.equal(countWorkingTime(start, result.deadline, tariff, CAL), minutes * M);
            }
        }
    }
});

test("123/16: slots are 30-minute aligned and must fit wholly inside an eligible window", () => {
    const now = "2031-03-01T10:00:00";
    for (const local of ["2031-03-03T09:15:00", "2031-03-03T09:30:01", "2031-03-03T09:30:00.500"]) {
        assert.throws(() => slot(local, STANDARD, now), code("SLOT_NOT_ALIGNED"));
    }
    assert.equal(slot("2031-03-03T17:30:00", STANDARD, now).slotEnd, at("2031-03-03T18:00:00"));
    assert.throws(() => slot("2031-03-03T18:00:00", STANDARD, now), code("STANDARD_NOT_AVAILABLE"));
    assert.equal(slot("2031-03-03T23:30:00", URGENT, now).slotEnd, at("2031-03-04T00:00:00"));
    const list = (fromDate, tariff, current = now) => listSlots({ fromDate, days: 1, tariff, now: at(current), calendar: CAL });
    assert.equal(list("2031-03-03", STANDARD).length, 18);
    assert.equal(list("2031-03-08", URGENT).length, 30);
    assert.equal(list("2031-03-11", STANDARD).length, 8);
    assert.equal(list("2031-03-03", STANDARD, "2031-03-03T10:00:00")[0], at("2031-03-03T12:00:00"));
});

test("123/hold timing: 10-minute TTL, inactive from the expiry instant onwards", () => {
    const now = at("2031-03-03T10:00:00");
    const expiresAt = holdExpiresAt(now);
    assert.equal(expiresAt - now, HOLD_TTL_MS);
    assert.equal(isHoldActive({ expiresAt, now: expiresAt - 1 }), true);
    assert.equal(isHoldActive({ expiresAt, now: expiresAt }), false);
});

test("123/18: invalid time zone and ambiguous or malformed instants are rejected", () => {
    assert.throws(() => loadCalendar({ ...FIXTURE, timeZone: "Europe/Berlin" }, { allowSynthetic: true }),
        code("INVALID_TIMEZONE"));
    for (const value of ["2031-03-03T09:00:00", "2031-03-03T09:00:00[Europe/Istanbul]", "2031-02-30T10:00:00Z",
        "2031-03-03T24:00:00Z", "2031-03-03T09:00:00+25:00", "03/03/2031 09:00", 1.5, Number.NaN, null, {}]) {
        assert.throws(() => parseInstant(value), code("INVALID_INSTANT"), String(value));
    }
    assert.throws(() => isEligible(at("2031-03-03T10:00:00"), "EXPRESS", CAL), code("INVALID_TARIFF"));
    assert.throws(() => addWorkingTime(at("2031-03-03T10:00:00"), 0, URGENT, CAL), code("INVALID_DURATION"));
    assert.throws(() => classifyDay("2031-02-29", CAL), code("INVALID_DATE"));
});

test("123/19: client clocks cannot reach slot validation; only the server clock decides", () => {
    const validator = createSlotValidator({ calendar: CAL, serverClock: () => at("2031-03-03T08:00:00") });
    assert.throws(() => validator.validate({ slotStart: at("2031-03-03T09:00:00"), tariff: STANDARD }),
        code("MIN_NOTICE_VIOLATION"));
    for (const field of ["now", "clientNow", "serverNow"]) {
        assert.throws(() => validator.validate({ slotStart: at("2031-03-03T09:00:00"), tariff: STANDARD,
            [field]: at("2031-03-01T00:00:00") }), code("INVALID_REQUEST"));
    }
    assert.equal(validator.validate({ slotStart: at("2031-03-03T10:00:00"), tariff: STANDARD }).slotStart,
        at("2031-03-03T10:00:00"));
    assert.throws(() => createSlotValidator({ calendar: CAL }), code("INVALID_CLOCK"));
});

// ---- Görev 124 approved rules ----

test("124/1-3: 121 min → no extension; exactly 120 and 119 min → +6 on the committed deadline", () => {
    const due = at("2031-03-03T15:00:00");
    const r121 = revision(due, due - 121 * M);
    assert.equal(r121.outcome, REVISION_OUTCOMES.REVISION_ELIGIBLE);
    assert.equal(r121.deadline, due);
    assert.equal(r121.consumesRevision, true);
    for (const minutes of [120, 119]) {
        const result = revision(due, due - minutes * M);
        assert.equal(result.outcome, REVISION_OUTCOMES.REVISION_ELIGIBLE_EXTENDED);
        assert.equal(result.remainingMs, minutes * M);
        assert.equal(result.deadline, at("2031-03-04T12:00:00"));
        assert.equal(result.previousDeadline, due);
    }
});

test("124/4-5: at the deadline or after it → NEW_ORDER_REVIEW_REQUIRED, no automatic action", () => {
    const due = at("2031-03-03T15:00:00");
    for (const evaluatedAt of [due, due + M]) {
        const result = revision(due, evaluatedAt, STANDARD, { relatedOrderId: "synthetic-order-0001" });
        assert.equal(result.outcome, REVISION_OUTCOMES.NEW_ORDER_REVIEW_REQUIRED);
        assert.equal(result.deadline, due);
        assert.equal(result.extended, false);
        assert.equal(result.consumesRevision, false);
        assert.deepEqual(result.newOrderReview, {
            relatedOrderId: "synthetic-order-0001", autoCreateOrder: false, autoCharge: false,
            requiresCustomerConsent: true, requiresPaymentVerification: true, productionMayStart: false
        });
    }
    assert.equal(revision(due, due).newOrderReview.relatedOrderId, null);
    for (const relatedOrderId of ["short", "has space 123", "../../etc/passwd", 42]) {
        assert.throws(() => revision(due, due, STANDARD, { relatedOrderId }), code("INVALID_ORDER_REFERENCE"));
    }
});

test("124/6: +6 standard hours from the committed deadline skip evenings, weekends and holidays", () => {
    assert.equal(revision(at("2031-03-03T15:00:00"), at("2031-03-03T14:00:00")).deadline, at("2031-03-04T12:00:00"));
    assert.equal(revision(at("2031-03-07T17:00:00"), at("2031-03-07T16:00:00")).deadline, at("2031-03-10T14:00:00"));
    // Tuesday half-day 12:00: 1 h to 13:00, Wednesday holiday skipped, Thursday (administrative leave) 09–14.
    assert.equal(revision(at("2031-03-11T12:00:00"), at("2031-03-11T11:00:00")).deadline, at("2031-03-13T14:00:00"));
});

test("124/7: +6 urgent hours from the committed deadline run 09:00-24:00 every day", () => {
    assert.equal(revision(at("2031-03-08T20:00:00"), at("2031-03-08T19:00:00"), URGENT).deadline,
        at("2031-03-09T11:00:00"));
    assert.equal(revision(at("2031-03-12T10:00:00"), at("2031-03-12T09:30:00"), URGENT).deadline,
        at("2031-03-12T16:00:00"));
});

test("124/C: the extension never restarts from the evaluation instant", () => {
    const due = at("2031-03-03T15:00:00");
    const results = [120, 90, 30, 1].map(minutes => revision(due, due - minutes * M).deadline);
    assert.deepEqual(new Set(results), new Set([at("2031-03-04T12:00:00")]));
    assert.notEqual(results[0], addWorkingTime(due - 30 * M, 6 * H, STANDARD, CAL).at);
});

test("124/8: night ban — no work or delivery counts in 00:00-09:00 for any tariff", () => {
    for (const tariff of [STANDARD, URGENT]) {
        assert.equal(nextEligibleTime(at("2031-03-04T00:00:00"), tariff, CAL), at("2031-03-04T09:00:00"));
        assert.equal(countWorkingTime(at("2031-03-04T00:00:00"), at("2031-03-04T09:00:00"), tariff, CAL), 0);
    }
    assert.equal(revision(at("2031-03-03T23:00:00"), at("2031-03-03T22:00:00"), URGENT).deadline,
        at("2031-03-04T14:00:00"));
});

test("124/9: 24:00 close is shown as next-day 00:00 and is not a start of new work", () => {
    const result = deadline("2031-03-03T22:00:00", 2, URGENT);
    assert.equal(result.deadline, at("2031-03-04T00:00:00"));
    assert.equal(result.endsAtProductionDayClose, true);
    assert.equal(result.productionDate, "2031-03-03");
    assert.equal(result.display, "2031-03-04 00:00");
    assert.equal(isEligible(result.deadline, URGENT, CAL), false);
    assert.equal(nextEligibleTime(result.deadline, URGENT, CAL), at("2031-03-04T09:00:00"));
    // A last-minute revision on a 24:00 deadline resumes at 09:00, not at 00:00.
    const extended = revision(result.deadline, result.deadline - 60 * M, URGENT);
    assert.equal(extended.deadline, at("2031-03-04T15:00:00"));
    assert.equal(extended.endsAtProductionDayClose, false);
    const ordinary = deadline("2031-03-03T10:00:00", 2, URGENT);
    assert.equal(ordinary.endsAtProductionDayClose, false);
    assert.equal(ordinary.productionDate, "2031-03-03");
    assert.equal(ordinary.display, "2031-03-03 12:00");
});

test("124/10: urgent slots may be requested inside weekday standard hours, with urgent conditions", () => {
    const urgent = slot("2031-03-04T10:00:00", URGENT, "2031-03-03T10:00:00");
    assert.equal(urgent.dayType, DAY_TYPES.WEEKDAY);
    assert.deepEqual([...urgent.confirmationRequirements].slice(-2), ["PRODUCER_APPROVAL", "URGENT_PAYMENT_VERIFICATION"]);
    const standard = slot("2031-03-04T10:00:00", STANDARD, "2031-03-03T10:00:00");
    assert.equal(standard.confirmationRequirements.includes("PRODUCER_APPROVAL"), false);
});

test("124/11-12: holiday refuses standard slots and offers urgent slots", () => {
    assert.throws(() => slot("2031-03-12T14:00:00", STANDARD, "2031-03-10T10:00:00"), code("STANDARD_NOT_AVAILABLE"));
    const urgent = slot("2031-03-12T14:00:00", URGENT, "2031-03-10T10:00:00");
    assert.equal(urgent.dayType, DAY_TYPES.HOLIDAY);
    assert.equal(urgent.confirmationRequirements.includes("URGENT_PAYMENT_VERIFICATION"), true);
});

test("124/13: administrative leave without holiday status is a standard working day", () => {
    const day = classifyDay("2031-03-13", CAL);
    assert.equal(day.dayType, DAY_TYPES.WEEKDAY);
    assert.equal(day.administrativeLeave, true);
    assert.deepEqual(day.windows.STANDARD, [[540, 1080]]);
    assert.equal(slot("2031-03-13T10:00:00", STANDARD, "2031-03-10T10:00:00").dayType, DAY_TYPES.WEEKDAY);
});

test("124/14: half-day boundary — standard ends at the official start; partial slots are not offered", () => {
    assert.equal(classifyDay("2031-03-11", CAL).dayType, DAY_TYPES.HALF_DAY);
    assert.equal(isEligible(at("2031-03-11T12:59:59.999"), STANDARD, CAL), true);
    assert.equal(isEligible(at("2031-03-11T13:00:00"), STANDARD, CAL), false);
    assert.equal(isEligible(at("2031-03-11T13:00:00"), URGENT, CAL), true);
    assert.equal(slot("2031-03-11T12:30:00", STANDARD, "2031-03-10T09:00:00").slotEnd, at("2031-03-11T13:00:00"));
    assert.throws(() => slot("2031-03-11T13:00:00", STANDARD, "2031-03-10T09:00:00"), code("STANDARD_NOT_AVAILABLE"));
    // A half-day starting at 12:45 leaves 12:30-13:00 only partly standard → that standard slot is withheld.
    const offGrid = loadCalendar({ ...FIXTURE, days: [{ date: "2031-03-11", kind: "HALF_DAY", halfDayStart: "12:45" }] },
        { allowSynthetic: true });
    assert.equal(validateSlot({ slotStart: at("2031-03-11T12:00:00"), tariff: STANDARD, now: at("2031-03-10T09:00:00"),
        calendar: offGrid }).slotEnd, at("2031-03-11T12:30:00"));
    assert.throws(() => validateSlot({ slotStart: at("2031-03-11T12:30:00"), tariff: STANDARD,
        now: at("2031-03-10T09:00:00"), calendar: offGrid }), code("STANDARD_NOT_AVAILABLE"));
    // An unknown official start withholds standard for the day; the hour is never invented.
    const unknown = classifyDay("2031-03-14", CAL);
    assert.equal(unknown.halfDayStartKnown, false);
    assert.deepEqual(unknown.windows.STANDARD, []);
    assert.equal(isEligible(at("2031-03-14T10:00:00"), URGENT, CAL), true);
});

test("124/15: missing calendar data offers neither standard nor urgent slots", () => {
    assert.throws(() => loadCalendar(undefined), code("CALENDAR_MISSING"));
    assert.throws(() => loadCalendar({ ...FIXTURE, days: undefined }, { allowSynthetic: true }), code("CALENDAR_MISSING"));
    assert.throws(() => loadCalendar({ ...FIXTURE, coverage: undefined }, { allowSynthetic: true }),
        code("CALENDAR_MISSING"));
    assert.throws(() => loadCalendar({ ...FIXTURE, version: "" }, { allowSynthetic: true }), code("CALENDAR_UNVERSIONED"));
    assert.throws(() => loadCalendar({ ...FIXTURE, source: { kind: "SYNTHETIC" } }, { allowSynthetic: true }),
        code("CALENDAR_SOURCE_INVALID"));
    assert.throws(() => loadCalendar(FIXTURE), code("SYNTHETIC_CALENDAR"));
    for (const tariff of [STANDARD, URGENT]) {
        assert.throws(() => slot("2032-01-05T10:00:00", tariff, "2032-01-01T10:00:00"), code("CALENDAR_MISSING"));
        // A hand-made or copied calendar that did not pass loadCalendar is never trusted.
        assert.throws(() => validateSlot({ slotStart: at("2031-03-04T10:00:00"), tariff, now: at("2031-03-03T10:00:00"),
            calendar: { ...CAL } }), code("CALENDAR_MISSING"));
        assert.throws(() => validateSlot({ slotStart: at("2031-03-04T10:00:00"), tariff, now: at("2031-03-03T10:00:00"),
            calendar: undefined }), code("CALENDAR_MISSING"));
    }
    assert.throws(() => deadline("2031-12-31T22:00:00", 4, URGENT), code("CALENDAR_MISSING"));
    assert.throws(() => loadCalendar({ ...FIXTURE, days: [...FIXTURE.days, { date: "2031-03-12", kind: "HOLIDAY" }] },
        { allowSynthetic: true }), code("DUPLICATE_DAY"));
    assert.throws(() => loadCalendar({ ...FIXTURE, days: [{ date: "2031-03-11", kind: "HALF_DAY", halfDayStart: "13" }] },
        { allowSynthetic: true }), code("INVALID_TIME"));
});

test("124/16: missing or incomplete annual approval rejects the whole calendar", () => {
    const variants = [
        { annualApprovals: undefined }, { annualApprovals: [] },
        { annualApprovals: [{ ...APPROVAL_2031, approvedBy: "" }] },
        { annualApprovals: [{ ...APPROVAL_2031, approverRole: "CUSTOMER" }] },
        { annualApprovals: [{ ...APPROVAL_2031, approvedAt: "yesterday" }] },
        { annualApprovals: [{ ...APPROVAL_2031, reference: " " }] },
        { annualApprovals: [APPROVAL_2031, APPROVAL_2031] },
        { coverage: { from: "2031-01-01", to: "2032-12-31" } }
    ];
    for (const variant of variants) {
        for (const kind of ["SYNTHETIC", "OFFICIAL"]) {
            assert.throws(() => loadCalendar({ ...FIXTURE, source: { kind, reference: "fixture-shape-only" }, ...variant },
                { allowSynthetic: true }), code("CALENDAR_UNAPPROVED"), JSON.stringify(variant));
        }
    }
    const official = loadCalendar({ ...FIXTURE, source: { kind: "OFFICIAL", reference: "fixture-shape-only" },
        annualApprovals: [{ ...APPROVAL_2031, approverRole: "ADMIN" }] });
    assert.equal(official.source.kind, "OFFICIAL");
    assert.equal(official.annualApprovals[0].approverRole, "ADMIN");
});

test("124/17: past slots are refused", () => {
    assert.throws(() => slot("2031-03-03T09:00:00", STANDARD, "2031-03-03T09:00:00.001"), code("SLOT_IN_PAST"));
    assert.throws(() => slot("2031-03-03T09:00:00", URGENT, "2031-03-05T09:00:00"), code("SLOT_IN_PAST"));
});

test("124/18: 2-hour notice at selection; confirmation must re-check it", () => {
    assert.equal(slot("2031-03-03T09:00:00", STANDARD, "2031-03-03T07:00:00").slotStart, at("2031-03-03T09:00:00"));
    assert.throws(() => slot("2031-03-03T09:00:00", STANDARD, "2031-03-03T07:00:00.001"), code("MIN_NOTICE_VIOLATION"));
    assert.throws(() => slot("2031-03-03T09:00:00", URGENT, "2031-03-03T07:30:00"), code("MIN_NOTICE_VIOLATION"));
    for (const tariff of [STANDARD, URGENT]) {
        assert.equal(confirmationRequirements(tariff)[0], "RECHECK_MIN_NOTICE");
        assert.ok(confirmationRequirements(tariff).includes("ATOMIC_CAPACITY_RESERVATION"));
    }
    // A slot valid at selection is no longer valid when confirmation comes later with a fresh server time.
    assert.throws(() => slot("2031-03-03T09:00:00", STANDARD, "2031-03-03T07:05:00"), code("MIN_NOTICE_VIOLATION"));
});

test("124/H: package durations await measurement; only approved measurements create commitments", () => {
    assert.deepEqual(PACKAGE_DURATIONS, { START: null, PLUS: null, PREMIUM: null });
    for (const packageId of ["START", "PLUS", "PREMIUM"]) {
        assert.throws(() => packageDurationMs(packageId), code("DURATION_NOT_MEASURED"));
    }
    assert.throws(() => packageDurationMs("GOLD"), code("INVALID_PACKAGE"));
    assert.equal(deadline("2031-03-03T10:00:00", 2, STANDARD).commitment, false);
    const base = { slaStart: at("2031-03-03T10:00:00"), durationMs: 2 * H, tariff: STANDARD, calendar: CAL };
    assert.throws(() => computeDeadline(base), code("DURATION_SOURCE_REQUIRED"));
    assert.throws(() => computeDeadline({ ...base, durationSource: "APPROVED_MEASUREMENT" }), code("DURATION_POLICY_REQUIRED"));
    assert.equal(computeDeadline({ ...base, durationSource: "APPROVED_MEASUREMENT",
        durationPolicyVersion: "synthetic-policy-shape" }).commitment, true);
});

test("124/19 (123/20): identical inputs give identical frozen results without reading the system clock", () => {
    const originalNow = Date.now;
    Date.now = () => { throw new Error("system clock must not be read"); };
    try {
        const run = () => ({
            deadline: deadline("2031-03-07T17:30:00", 7, STANDARD),
            extended: revision(at("2031-03-03T15:00:00"), at("2031-03-03T14:00:00")),
            review: revision(at("2031-03-03T15:00:00"), at("2031-03-03T15:00:00"), URGENT),
            slots: listSlots({ fromDate: "2031-03-07", days: 3, tariff: URGENT, now: at("2031-03-01T00:00:00"),
                calendar: CAL }),
            display: formatLocal(at("2031-03-04T00:00:00"))
        });
        const first = run();
        assert.deepEqual(run(), first);
        for (const value of [first.deadline, first.extended, first.review, first.review.newOrderReview, first.slots]) {
            assert.ok(Object.isFrozen(value));
        }
        assert.ok(Object.isFrozen(CAL) && Object.isFrozen(CAL.days) && Object.isFrozen(CAL.annualApprovals));
    } finally {
        Date.now = originalNow;
    }
});

test("124/20: a new-order review leaves the current order's revision rights untouched", () => {
    // Synthetic order snapshot; the module receives only its opaque reference, never the order itself.
    const order = Object.freeze({ id: "synthetic-order-0042", packageId: "START", revisionsUsed: 1, revisionsAllowed: 3 });
    const before = structuredClone(order);
    const due = at("2031-03-03T15:00:00");
    const result = revision(due, due + 5 * M, STANDARD, { relatedOrderId: order.id });
    assert.equal(result.consumesRevision, false);
    assert.equal(result.newOrderReview.relatedOrderId, order.id);
    // Simulated caller: rights are only consumed when the module says so.
    const after = result.consumesRevision ? { ...order, revisionsUsed: order.revisionsUsed + 1 } : order;
    assert.deepEqual(after, before);
    assert.equal(after.revisionsAllowed - after.revisionsUsed, 2);
    assert.throws(() => revision(due, due, STANDARD, { order }), code("INVALID_REQUEST"));
});
