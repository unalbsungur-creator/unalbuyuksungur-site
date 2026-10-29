/* Isolated, pure calendar/SLA prototype. No network, storage, reservation, payment or approval. Never publish. */
export const TIME_ZONE = "Europe/Istanbul";
export const TARIFFS = Object.freeze({ STANDARD: "STANDARD", URGENT: "URGENT" });
export const DAY_TYPES = Object.freeze({
    WEEKDAY: "WEEKDAY", WEEKEND: "WEEKEND", HOLIDAY: "HOLIDAY", HALF_DAY: "HALF_DAY"
});
export const DAY_KINDS = Object.freeze({
    HOLIDAY: "HOLIDAY", HALF_DAY: "HALF_DAY", ADMINISTRATIVE_LEAVE: "ADMINISTRATIVE_LEAVE"
});
export const APPROVER_ROLES = Object.freeze({ ADMIN: "ADMIN", PRODUCER: "PRODUCER" });
export const REVISION_OUTCOMES = Object.freeze({
    REVISION_ELIGIBLE: "REVISION_ELIGIBLE",
    REVISION_ELIGIBLE_EXTENDED: "REVISION_ELIGIBLE_EXTENDED",
    NEW_ORDER_REVIEW_REQUIRED: "NEW_ORDER_REVIEW_REQUIRED"
});
export const DURATION_SOURCES = Object.freeze({
    SYNTHETIC_FIXTURE: "SYNTHETIC_FIXTURE", APPROVED_MEASUREMENT: "APPROVED_MEASUREMENT"
});
// Package durations await measurement; no value may be invented here.
export const PACKAGE_DURATIONS = Object.freeze({ START: null, PLUS: null, PREMIUM: null });
export const SLOT_MINUTES = 30;
export const MIN_NOTICE_MS = 2 * 3600e3;
export const HOLD_TTL_MS = 10 * 60e3;
export const LAST_MINUTE_MS = 120 * 60e3;
export const REVISION_EXTENSION_MS = 6 * 3600e3;

const DAY_START = 9 * 60, STANDARD_END = 18 * 60, DAY_END = 24 * 60;
const MAX_DAYS = 3700;
const LOADED = new WeakSet();

export class CalendarError extends Error {
    constructor(code) { super(code); this.name = "CalendarError"; this.code = code; }
}

function requireThat(condition, code) {
    if (!condition) throw new CalendarError(code);
}

function freezeDeep(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freezeDeep);
        Object.freeze(value);
    }
    return value;
}

function text(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function opaque(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

let formatter;
function zoneFormatter() {
    if (!formatter) {
        try {
            formatter = new Intl.DateTimeFormat("en-CA", {
                timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
                hour: "2-digit", minute: "2-digit", second: "2-digit"
            });
        } catch {
            throw new CalendarError("TIMEZONE_UNAVAILABLE");
        }
        requireThat(formatter.resolvedOptions().timeZone === TIME_ZONE, "TIMEZONE_UNAVAILABLE");
    }
    return formatter;
}

function validDate(y, m, d) {
    const back = new Date(Date.UTC(y, m - 1, d));
    return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

function parseLocalDate(value) {
    const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    requireThat(match && validDate(+match[1], +match[2], +match[3]), "INVALID_DATE");
    return { y: +match[1], m: +match[2], d: +match[3] };
}

function parseClock(value) {
    const match = typeof value === "string" && /^(\d{2}):(\d{2})$/.exec(value);
    requireThat(match && +match[1] < 24 && +match[2] < 60, "INVALID_TIME");
    return +match[1] * 60 + +match[2];
}

/** Accepts epoch milliseconds or an ISO instant with an explicit Z/±hh:mm offset.
 * Offset-less local strings are ambiguous and rejected; so are zone names and rolled-over dates. */
export function parseInstant(value) {
    if (typeof value === "number") {
        requireThat(Number.isSafeInteger(value), "INVALID_INSTANT");
        return value;
    }
    const match = typeof value === "string" &&
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    requireThat(match, "INVALID_INSTANT");
    const [, y, mo, d, h, mi, s = "0", ms = "0", zone, sign, oh, om] = match;
    requireThat(validDate(+y, +mo, +d) && +h < 24 && +mi < 60 && +s < 60, "INVALID_INSTANT");
    requireThat(zone === "Z" || (+oh <= 14 && +om < 60), "INVALID_INSTANT");
    const offset = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60e3;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms.padEnd(3, "0")) - offset;
}

function localParts(ms) {
    const parts = Object.fromEntries(zoneFormatter().formatToParts(new Date(ms))
        .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour, minuteOfHour: parts.minute,
        minute: +parts.hour * 60 + +parts.minute, second: +parts.second, millisecond: ((ms % 1000) + 1000) % 1000
    };
}

function offsetAt(ms) {
    const p = localParts(ms);
    const { y, m, d } = parseLocalDate(p.date);
    return Date.UTC(y, m - 1, d, 0, p.minute, p.second, p.millisecond) - ms;
}

// Local wall time → UTC instant via the IANA database; never a hard-coded offset.
function localToUtc(date, minute) {
    const { y, m, d } = parseLocalDate(date);
    const wall = Date.UTC(y, m - 1, d, 0, minute);
    return wall - offsetAt(wall - offsetAt(wall));
}

function addDays(date, days) {
    const { y, m, d } = parseLocalDate(date);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Istanbul display. A production day's 24:00 close is the next day's 00:00 and is shown that way. */
export function formatLocal(instant) {
    const p = localParts(parseInstant(instant));
    return `${p.date} ${p.hour}:${p.minuteOfHour}`;
}

/** Calendar data contract (the interface a future verified loader must satisfy; no network here).
 * Every covered year needs an annual approval by an ADMIN or PRODUCER. SYNTHETIC fixtures also need
 * approvals and an explicit opt-in, so test data can never masquerade as official holidays.
 * ADMINISTRATIVE_LEAVE without official holiday status is recorded but remains a standard working day. */
export function loadCalendar(data, { allowSynthetic = false } = {}) {
    requireThat(data && typeof data === "object", "CALENDAR_MISSING");
    requireThat(data.timeZone === TIME_ZONE, "INVALID_TIMEZONE");
    requireThat(text(data.version), "CALENDAR_UNVERSIONED");
    const source = data.source;
    requireThat(source && ["OFFICIAL", "SYNTHETIC"].includes(source.kind) && text(source.reference),
        "CALENDAR_SOURCE_INVALID");
    requireThat(source.kind === "OFFICIAL" || allowSynthetic, "SYNTHETIC_CALENDAR");
    requireThat(data.coverage && typeof data.coverage === "object" && Array.isArray(data.days), "CALENDAR_MISSING");
    const from = parseLocalDate(data.coverage.from), to = parseLocalDate(data.coverage.to);
    requireThat(data.coverage.from <= data.coverage.to, "INVALID_COVERAGE");
    requireThat(Array.isArray(data.annualApprovals), "CALENDAR_UNAPPROVED");
    const approvals = new Map();
    for (const approval of data.annualApprovals) {
        requireThat(approval && Number.isSafeInteger(approval.year) && !approvals.has(approval.year) &&
            text(approval.approvedBy) && Object.hasOwn(APPROVER_ROLES, approval.approverRole) &&
            text(approval.reference), "CALENDAR_UNAPPROVED");
        try { parseInstant(approval.approvedAt); } catch { throw new CalendarError("CALENDAR_UNAPPROVED"); }
        approvals.set(approval.year, {
            year: approval.year, approvedBy: approval.approvedBy, approverRole: approval.approverRole,
            approvedAt: parseInstant(approval.approvedAt), reference: approval.reference
        });
    }
    for (let year = from.y; year <= to.y; year += 1) requireThat(approvals.has(year), "CALENDAR_UNAPPROVED");
    const days = new Map();
    for (const day of data.days) {
        parseLocalDate(day?.date);
        requireThat(day.date >= data.coverage.from && day.date <= data.coverage.to, "DAY_OUTSIDE_COVERAGE");
        requireThat(!days.has(day.date), "DUPLICATE_DAY");
        requireThat(Object.hasOwn(DAY_KINDS, day.kind), "INVALID_DAY_KIND");
        // A missing half-day start is kept as null: standard work is then withheld, never guessed.
        const halfDayStart = day.kind === DAY_KINDS.HALF_DAY && day.halfDayStart != null
            ? parseClock(day.halfDayStart) : null;
        days.set(day.date, { kind: day.kind, halfDayStart });
    }
    const calendar = freezeDeep({
        timeZone: TIME_ZONE, version: data.version, source: { kind: source.kind, reference: source.reference },
        coverage: { from: data.coverage.from, to: data.coverage.to },
        annualApprovals: [...approvals.values()], days: Object.fromEntries(days)
    });
    LOADED.add(calendar);
    return calendar;
}

function requireCalendar(calendar) {
    requireThat(calendar && LOADED.has(calendar), "CALENDAR_MISSING");
}

function requireTariff(tariff) {
    requireThat(Object.hasOwn(TARIFFS, tariff), "INVALID_TARIFF");
}

/** Classifies an Istanbul local date and returns its windows as local minutes [start, end). */
export function classifyDay(date, calendar) {
    requireCalendar(calendar);
    const { y, m, d } = parseLocalDate(date);
    requireThat(date >= calendar.coverage.from && date <= calendar.coverage.to, "CALENDAR_MISSING");
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
    const entry = calendar.days[date];
    let dayType = weekday >= 6 ? DAY_TYPES.WEEKEND : DAY_TYPES.WEEKDAY;
    let standardEnd = dayType === DAY_TYPES.WEEKDAY ? STANDARD_END : DAY_START;
    let halfDayStartKnown = null;
    if (entry?.kind === DAY_KINDS.HOLIDAY) {
        dayType = DAY_TYPES.HOLIDAY;
        standardEnd = DAY_START;
    } else if (entry?.kind === DAY_KINDS.HALF_DAY) {
        dayType = weekday >= 6 ? DAY_TYPES.WEEKEND : DAY_TYPES.HALF_DAY;
        halfDayStartKnown = entry.halfDayStart !== null;
        // Urgent applies from the official half-day start; unknown start → no standard window.
        standardEnd = dayType === DAY_TYPES.HALF_DAY && halfDayStartKnown
            ? Math.min(STANDARD_END, Math.max(DAY_START, entry.halfDayStart)) : DAY_START;
    }
    return freezeDeep({
        date, weekday, dayType, halfDayStartKnown, calendarVersion: calendar.version,
        administrativeLeave: entry?.kind === DAY_KINDS.ADMINISTRATIVE_LEAVE,
        windows: {
            STANDARD: standardEnd > DAY_START ? [[DAY_START, standardEnd]] : [],
            URGENT: [[DAY_START, DAY_END]]
        }
    });
}

function windowsUtc(date, tariff, calendar) {
    // Minute 1440 resolves to the next local midnight, i.e. the exclusive 24:00 close.
    return classifyDay(date, calendar).windows[tariff]
        .map(([start, end]) => [localToUtc(date, start), localToUtc(date, end)]);
}

function* windowsFrom(ms, tariff, calendar) {
    let date = localParts(ms).date;
    for (let i = 0; i < MAX_DAYS; i += 1, date = addDays(date, 1)) {
        for (const window of windowsUtc(date, tariff, calendar)) {
            if (window[1] > ms) yield window;
        }
    }
    throw new CalendarError("CALENDAR_MISSING");
}

/** True when the instant lies inside an eligible [start, end) window of the tariff. */
export function isEligible(instant, tariff, calendar) {
    const ms = parseInstant(instant);
    requireTariff(tariff);
    return windowsUtc(localParts(ms).date, tariff, calendar).some(([start, end]) => ms >= start && ms < end);
}

/** Earliest eligible instant at or after the given instant. 00:00 is never a start: it maps to 09:00. */
export function nextEligibleTime(instant, tariff, calendar) {
    const ms = parseInstant(instant);
    requireTariff(tariff);
    const [start] = windowsFrom(ms, tariff, calendar).next().value;
    return Math.max(ms, start);
}

/** Eligible working time inside [from, to). */
export function countWorkingTime(from, to, tariff, calendar) {
    const start = parseInstant(from), end = parseInstant(to);
    requireTariff(tariff);
    requireThat(end >= start, "INVALID_RANGE");
    let total = 0;
    for (const [ws, we] of windowsFrom(start, tariff, calendar)) {
        if (ws >= end) break;
        total += Math.min(we, end) - Math.max(ws, start);
    }
    return total;
}

/** Adds working time, skipping every ineligible interval. A result equal to a window's
 * exclusive end means the work completes exactly at that close (e.g. 18:00 or 24:00). */
export function addWorkingTime(instant, durationMs, tariff, calendar) {
    const start = parseInstant(instant);
    requireTariff(tariff);
    requireThat(Number.isSafeInteger(durationMs) && durationMs > 0, "INVALID_DURATION");
    let remaining = durationMs;
    for (const [ws, we] of windowsFrom(start, tariff, calendar)) {
        const from = Math.max(ws, start);
        const take = Math.min(remaining, we - from);
        remaining -= take;
        if (remaining === 0) return freezeDeep({ at: from + take, endsAtWindowClose: from + take === we });
    }
    throw new CalendarError("CALENDAR_MISSING");
}

// A deadline ending at a 24:00 close belongs to the production day before it, while being displayed
// as the next day's 00:00. It never implies that work may start at 00:00.
function describeEnd(at, endsAtWindowClose) {
    const p = localParts(at);
    const midnight = endsAtWindowClose && p.minute === 0 && p.second === 0 && p.millisecond === 0;
    return {
        endsAtWindowClose, endsAtProductionDayClose: midnight,
        productionDate: localParts(at - 1).date, display: formatLocal(at)
    };
}

/** Rejects unmeasured package durations; no real package SLA exists until measured and approved. */
export function packageDurationMs(packageId) {
    requireThat(Object.hasOwn(PACKAGE_DURATIONS, packageId), "INVALID_PACKAGE");
    requireThat(Number.isSafeInteger(PACKAGE_DURATIONS[packageId]), "DURATION_NOT_MEASURED");
    return PACKAGE_DURATIONS[packageId];
}

/** SLA deadline from the approved scheduled start (PD-01). The caller states where the duration came
 * from; only an approved measurement with a policy version yields a customer commitment. */
export function computeDeadline({ slaStart, durationMs, durationSource, durationPolicyVersion, tariff, calendar }) {
    const start = parseInstant(slaStart);
    requireTariff(tariff);
    requireThat(Object.hasOwn(DURATION_SOURCES, durationSource), "DURATION_SOURCE_REQUIRED");
    requireThat(durationSource !== DURATION_SOURCES.APPROVED_MEASUREMENT || text(durationPolicyVersion),
        "DURATION_POLICY_REQUIRED");
    requireThat(isEligible(start, tariff, calendar), "SLA_START_NOT_ELIGIBLE");
    const result = addWorkingTime(start, durationMs, tariff, calendar);
    return freezeDeep({
        slaStart: start, deadline: result.at, tariff, durationMs, durationSource,
        durationPolicyVersion: durationPolicyVersion ?? null,
        commitment: durationSource === DURATION_SOURCES.APPROVED_MEASUREMENT,
        ...describeEnd(result.at, result.endsAtWindowClose), calendarVersion: calendar.version
    });
}

const REVISION_FIELDS = ["deadline", "evaluatedAt", "tariff", "calendar", "relatedOrderId"];

/** Classifies a revision request against the committed deadline. `evaluatedAt` is the trusted server time.
 * - remaining > 120 min: ordinary revision window, deadline unchanged.
 * - 0 < remaining ≤ 120 min (wall-clock, inclusive): committed deadline + 6 eligible hours of the order's
 *   approved tariff; the extension never restarts from the evaluation instant.
 * - remaining ≤ 0: NEW_ORDER_REVIEW_REQUIRED. No revision right is consumed, nothing is created or charged,
 *   and production cannot start without customer consent and verified payment.
 * Consuming a revision right on acceptance is the order core's responsibility, not this module's. */
export function evaluateRevisionRequest(request) {
    requireThat(request && typeof request === "object" &&
        Object.keys(request).every(key => REVISION_FIELDS.includes(key)), "INVALID_REQUEST");
    const { tariff, calendar, relatedOrderId = null } = request;
    const due = parseInstant(request.deadline), evaluatedAt = parseInstant(request.evaluatedAt);
    requireTariff(tariff);
    requireCalendar(calendar);
    requireThat(relatedOrderId === null || opaque(relatedOrderId), "INVALID_ORDER_REFERENCE");
    const remainingMs = due - evaluatedAt;
    const base = { previousDeadline: due, evaluatedAt, remainingMs, tariff, calendarVersion: calendar.version };
    if (remainingMs <= 0) {
        return freezeDeep({
            ...base, outcome: REVISION_OUTCOMES.NEW_ORDER_REVIEW_REQUIRED, deadline: due, extended: false,
            consumesRevision: false,
            newOrderReview: {
                relatedOrderId, autoCreateOrder: false, autoCharge: false,
                requiresCustomerConsent: true, requiresPaymentVerification: true, productionMayStart: false
            }
        });
    }
    if (remainingMs > LAST_MINUTE_MS) {
        return freezeDeep({
            ...base, outcome: REVISION_OUTCOMES.REVISION_ELIGIBLE, deadline: due, extended: false,
            consumesRevision: true, newOrderReview: null
        });
    }
    const next = addWorkingTime(due, REVISION_EXTENSION_MS, tariff, calendar);
    return freezeDeep({
        ...base, outcome: REVISION_OUTCOMES.REVISION_ELIGIBLE_EXTENDED, deadline: next.at, extended: true,
        consumesRevision: true, newOrderReview: null, ...describeEnd(next.at, next.endsAtWindowClose)
    });
}

/** Conditions a booking confirmation must satisfy in a later, separate task. This module performs none
 * of them; it only declares them so confirmation cannot silently skip a check. */
export function confirmationRequirements(tariff) {
    requireTariff(tariff);
    const checks = ["RECHECK_MIN_NOTICE", "RECHECK_SLOT_ELIGIBILITY", "RECHECK_CALENDAR_VERSION",
        "ATOMIC_CAPACITY_RESERVATION"];
    if (tariff === TARIFFS.URGENT) checks.push("PRODUCER_APPROVAL", "URGENT_PAYMENT_VERIFICATION");
    return Object.freeze(checks);
}

/** Validates a production-start slot at selection time. `now` must come from the trusted server clock.
 * The same validation MUST be repeated with a fresh server time at confirmation (see the requirements). */
export function validateSlot({ slotStart, tariff, now, calendar }) {
    const start = parseInstant(slotStart), current = parseInstant(now);
    requireTariff(tariff);
    requireCalendar(calendar);
    const p = localParts(start);
    requireThat(p.minute % SLOT_MINUTES === 0 && p.second === 0 && p.millisecond === 0, "SLOT_NOT_ALIGNED");
    requireThat(start >= current, "SLOT_IN_PAST");
    requireThat(start - current >= MIN_NOTICE_MS, "MIN_NOTICE_VIOLATION");
    const end = start + SLOT_MINUTES * 60e3;
    const day = classifyDay(p.date, calendar);
    requireThat(p.minute >= DAY_START, "SLOT_FORBIDDEN_WINDOW");
    const fits = windowsUtc(p.date, tariff, calendar).some(([ws, we]) => start >= ws && end <= we);
    requireThat(fits, tariff === TARIFFS.STANDARD ? "STANDARD_NOT_AVAILABLE" : "SLOT_NOT_ELIGIBLE");
    return freezeDeep({
        slotStart: start, slotEnd: end, tariff, dayType: day.dayType, display: formatLocal(start),
        calendarVersion: calendar.version, confirmationRequirements: confirmationRequirements(tariff)
    });
}

/** Lists valid slots for up to 31 Istanbul local days. Informational only: no capacity is checked. */
export function listSlots({ fromDate, days, tariff, now, calendar }) {
    parseLocalDate(fromDate);
    requireThat(Number.isSafeInteger(days) && days >= 1 && days <= 31, "INVALID_RANGE");
    requireTariff(tariff);
    const slots = [];
    for (let i = 0; i < days; i += 1) {
        const date = addDays(fromDate, i);
        for (const [ws, we] of windowsUtc(date, tariff, calendar)) {
            for (let t = ws; t + SLOT_MINUTES * 60e3 <= we; t += SLOT_MINUTES * 60e3) {
                try {
                    slots.push(validateSlot({ slotStart: t, tariff, now, calendar }).slotStart);
                } catch (error) {
                    if (!(error instanceof CalendarError) || !["SLOT_IN_PAST", "MIN_NOTICE_VIOLATION",
                        "SLOT_NOT_ALIGNED"].includes(error.code)) throw error;
                }
            }
        }
    }
    return Object.freeze(slots);
}

/** Hold timing only; persistence and atomic capacity are a later, separate task. */
export function holdExpiresAt(now) {
    return parseInstant(now) + HOLD_TTL_MS;
}

export function isHoldActive({ expiresAt, now }) {
    return parseInstant(now) < parseInstant(expiresAt);
}

/** Binds slot validation to a server clock. Requests carry only slotStart and tariff;
 * any client-supplied time field is rejected rather than silently ignored. */
export function createSlotValidator({ calendar, serverClock }) {
    requireCalendar(calendar);
    requireThat(typeof serverClock === "function", "INVALID_CLOCK");
    return Object.freeze({
        validate(request) {
            requireThat(request && typeof request === "object", "INVALID_REQUEST");
            requireThat(Object.keys(request).every(key => key === "slotStart" || key === "tariff"),
                "INVALID_REQUEST");
            return validateSlot({ slotStart: request.slotStart, tariff: request.tariff, now: serverClock(), calendar });
        }
    });
}
