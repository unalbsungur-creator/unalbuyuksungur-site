import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createCore, OrderError, PACKAGES, STATES } from "./core.mjs";
import { loadCalendar } from "./calendar.mjs";

const SERVER = Symbol("synthetic-server-session");
const TEST_KEY = "synthetic-fixture-only-not-a-production-secret";
const FIXED_TIME = "2026-10-28T09:00:00.000Z";
// Synthetic booking-service record: Wednesday 13:00 Istanbul start, Friday 15:00 Istanbul deadline.
const PLANNED_START = "2026-10-28T10:00:00.000Z";
const DEADLINE = "2026-10-30T12:00:00.000Z";
// SYNTHETIC calendar: no holidays are modelled; it is not an official Turkish calendar.
const CALENDAR = loadCalendar({
    timeZone: "Europe/Istanbul", version: "synthetic-core-2026.1",
    source: { kind: "SYNTHETIC", reference: "task-128-core-fixture" },
    coverage: { from: "2026-01-01", to: "2026-12-31" },
    annualApprovals: [{ year: 2026, approvedBy: "synthetic-producer", approverRole: "PRODUCER",
        approvedAt: "2026-01-02T09:00:00Z", reference: "task-128-synthetic-approval" }],
    days: []
}, { allowSynthetic: true });

function hmac(fields) {
    return createHmac("sha256", TEST_KEY).update(JSON.stringify(fields)).digest("hex");
}

function sign(proof) {
    return hmac([proof.orderId, proof.reference, proof.amountKurus, proof.currency, proof.status, proof.source]);
}

function signBooking(record) {
    return hmac(["booking", record.orderId, record.bookingId, record.status, record.source, record.scheduledStart,
        record.tariff, record.deadline, JSON.stringify(record.urgent ?? null)]);
}

function signRestoration(record) {
    return hmac(["restoration", record.orderId, record.revisionId, record.reasonCode, record.authorizationRef,
        record.source]);
}

function signReview(record) {
    return hmac(["review", record.orderId, record.type ?? null, record.reviewId ?? null, record.outcome ?? null,
        record.authorizationRef, record.source]);
}

function signatureMatches(signature, expected) {
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

function setup(overrides = {}) {
    let now = FIXED_TIME;
    const core = createCore({
        authorize: (principal) => principal.auth === SERVER,
        verifyPayment: (proof) => signatureMatches(proof.signature, sign(proof)),
        verifyEmail: (proof) => proof.code === "SYNTHETIC-ONE-USE-CODE",
        verifyBooking: (record) => signatureMatches(record.signature, signBooking(record)),
        verifyRestoration: (record) => signatureMatches(record.signature, signRestoration(record)),
        verifyReview: (record) => signatureMatches(record.signature, signReview(record)),
        calendar: CALENDAR,
        clock: () => now,
        ...overrides
    });
    let counter = 0;
    function actor(role, order, auth = SERVER) {
        return { role, orderId: order.id, auth };
    }
    async function send(order, kind, role, data = {}, options = {}) {
        const requestId = options.requestId || `synthetic-request-${++counter}`;
        const command = { kind, requestId, expectedVersion: options.version ?? order.version, data };
        return core.dispatch(order, command, actor(role, order, options.auth ?? SERVER));
    }
    function payment(order, extra = {}) {
        const proof = {
            orderId: order.id, reference: `SYNTHORDER${order.id.slice(0, 12).replaceAll("-", "")}`,
            amountKurus: PACKAGES[order.packageId].priceKurus, currency: "TRY",
            status: "paid_unreversed", source: "seller_reconciliation", ...extra
        };
        return { ...proof, signature: sign(proof) };
    }
    function booking(order, extra = {}) {
        const record = {
            orderId: order.id, bookingId: `synthetic-booking-${order.id.slice(0, 8)}`, status: "CONFIRMED",
            source: "booking_service", scheduledStart: PLANNED_START, tariff: "STANDARD", deadline: DEADLINE,
            urgent: null, ...extra
        };
        return { ...record, signature: signBooking(record) };
    }
    function restoration(order, revisionId, extra = {}) {
        const record = {
            orderId: order.id, revisionId, reasonCode: "PRODUCER_NON_DELIVERY",
            authorizationRef: `synthetic-authorization-${++counter}`, source: "producer_console", ...extra
        };
        return { ...record, signature: signRestoration(record) };
    }
    function restore(order, revisionId, record = restoration(order, revisionId), role = "creative", options = {}) {
        return send(order, "restore_revision_right", role, { revisionId, restoration: record }, options);
    }
    function reviewRecord(order, type, extra = {}) {
        const record = {
            orderId: order.id, type, authorizationRef: `synthetic-review-${++counter}`, source: "finance_console", ...extra
        };
        return { ...record, signature: signReview(record) };
    }
    function resolution(order, reviewId, outcome, extra = {}) {
        const record = {
            orderId: order.id, reviewId, outcome, authorizationRef: `synthetic-decision-${++counter}`,
            source: "finance_console", ...extra
        };
        return { ...record, signature: signReview(record) };
    }
    function openReview(order, type, record = reviewRecord(order, type), role = "finance", options = {}) {
        return send(order, "open_review", role, { review: record }, options);
    }
    function resolveReview(order, outcome, record = resolution(order, order.reviews.at(-1).reviewId, outcome),
        role = "finance", options = {}) {
        return send(order, "resolve_review", role, { resolution: record }, options);
    }
    const setNow = value => { now = value; };
    return {
        core, actor, send, payment, booking, restoration, restore, reviewRecord, resolution, openReview,
        resolveReview, setNow
    };
}

async function booked(packageId = "START", h = setup()) {
    let order = h.core.createOrder(packageId);
    order = await h.send(order, "submit", "customer");
    order = await h.send(order, "verify_payment", "finance", { proof: h.payment(order) });
    order = await h.send(order, "request_email", "customer");
    order = await h.send(order, "verify_email", "customer",
        { proof: { orderId: order.id, code: "SYNTHETIC-ONE-USE-CODE" } });
    order = await h.send(order, "request_booking", "customer");
    return { ...h, order };
}

async function ready(packageId = "START", bookingExtra = {}, h = setup()) {
    const b = await booked(packageId, h);
    const order = await b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order, bookingExtra) });
    return { ...b, order };
}

async function producing(packageId = "START", bookingExtra = {}, h = setup()) {
    const r = await ready(packageId, bookingExtra, h);
    let order = await r.send(r.order, "start_production", "creative");
    order = await r.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
    return { ...r, order };
}

test("package mathematics, immutable records and unpredictable order identifiers", () => {
    const { core } = setup();
    assert.deepEqual(Object.entries(PACKAGES).map(([name, p]) => [name, p.priceKurus, p.revisions, p.alternatives]),
        [["START", 69000, 3, 8], ["PLUS", 119000, 5, 12], ["PREMIUM", 229000, 10, 22]]);
    for (const p of Object.values(PACKAGES)) assert.equal(p.alternatives, 2 + 2 * p.revisions);
    const a = core.createOrder("START"), b = core.createOrder("START");
    assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
    assert.notEqual(a.id, b.id);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.events));
    assert.equal(a.slaStartsAt, null);
    assert.equal(a.booking, null);
    assert.throws(() => core.createOrder("OTHER"), /INVALID_PACKAGE/);
});

test("only authorized roles and server-issued payment evidence pass the gate", async () => {
    const h = setup();
    let order = h.core.createOrder("START");
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: h.payment(order) }), /INVALID_TRANSITION/);
    await assert.rejects(h.send(order, "submit", "customer", {}, { auth: Symbol("browser-claim") }), /UNAUTHORIZED/);
    await assert.rejects(h.core.dispatch(order, {
        kind: "submit", requestId: "synthetic-wrong-order",
        expectedVersion: 0
    }, h.actor("customer", h.core.createOrder("START"))), /UNAUTHORIZED/);
    order = await h.send(order, "submit", "customer");
    const proof = h.payment(order);
    await assert.rejects(h.send(order, "verify_payment", "customer", { proof }), /UNAUTHORIZED/);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: { ...proof, signature: "0".repeat(64) } }), /UNTRUSTED_PAYMENT/);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: { ...proof, status: "created" } }), /PAYMENT_MISMATCH/);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: h.payment(order, { amountKurus: 100 }) }), /PAYMENT_MISMATCH/);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: h.payment(order, { currency: "USD" }) }), /PAYMENT_MISMATCH/);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: h.payment(order, { orderId: h.core.createOrder("START").id }) }), /PAYMENT_MISMATCH/);
    const untrusted = createCore({ authorize: () => true });
    const other = untrusted.createOrder("START");
    const pending = await untrusted.dispatch(other, {
        kind: "submit", requestId: "synthetic-other-submit", expectedVersion: 0
    }, h.actor("customer", other));
    await assert.rejects(untrusted.dispatch(pending, {
        kind: "verify_payment", requestId: "synthetic-no-verifier",
        expectedVersion: pending.version, data: { proof: h.payment(pending) }
    }, h.actor("finance", pending)), /UNTRUSTED_PAYMENT/);
    order = await h.send(order, "verify_payment", "finance", { proof });
    assert.equal(order.state, STATES.PAYMENT_VERIFIED);
    assert.equal(order.productionStartedAt, null);
    assert.equal(order.slaStartsAt, null);
    await assert.rejects(h.send(order, "request_booking", "customer"), /INVALID_TRANSITION/);
});

test("payment retries are no-ops; collisions, stale versions and repeated email proofs are rejected", async () => {
    const h = setup();
    let order = await h.send(h.core.createOrder("PLUS"), "submit", "customer");
    const proof = h.payment(order);
    const id = "synthetic-payment-once";
    const verified = await h.send(order, "verify_payment", "finance", { proof }, { requestId: id });
    assert.strictEqual(await h.send(verified, "verify_payment", "finance", { proof }, { requestId: id, version: order.version }), verified);
    await assert.rejects(h.send(verified, "verify_payment", "finance", { proof: { ...proof, signature: "0".repeat(64) } },
        { requestId: id }), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(h.send(verified, "request_email", "customer", {}, { version: order.version }), /VERSION_CONFLICT/);
    order = await h.send(verified, "request_email", "customer");
    await assert.rejects(h.send(order, "verify_email", "customer", { proof: { orderId: order.id, code: "wrong" } }), /UNTRUSTED_EMAIL/);
    const noEmailVerifier = createCore({ authorize: () => true, verifyPayment: () => true });
    let other = noEmailVerifier.createOrder("START");
    other = await noEmailVerifier.dispatch(other, {
        kind: "submit", requestId: "synthetic-email-submit", expectedVersion: other.version
    }, h.actor("customer", other));
    other = await noEmailVerifier.dispatch(other, {
        kind: "verify_payment", requestId: "synthetic-email-payment", expectedVersion: other.version,
        data: { proof: h.payment(other) }
    }, h.actor("finance", other));
    other = await noEmailVerifier.dispatch(other, {
        kind: "request_email", requestId: "synthetic-email-request", expectedVersion: other.version
    }, h.actor("customer", other));
    await assert.rejects(noEmailVerifier.dispatch(other, {
        kind: "verify_email", requestId: "synthetic-no-email",
        expectedVersion: other.version, data: { proof: { orderId: other.id } }
    }, h.actor("customer", other)), /UNTRUSTED_EMAIL/);
    order = await h.send(order, "verify_email", "customer", { proof: { orderId: order.id, code: "SYNTHETIC-ONE-USE-CODE" } });
    await assert.rejects(h.send(order, "verify_email", "customer", { proof: { orderId: order.id, code: "SYNTHETIC-ONE-USE-CODE" } }), /INVALID_TRANSITION/);
});

for (const packageId of Object.keys(PACKAGES)) {
    test(`${packageId}: SLA from planned start, one right per accepted round, max rights and single delivery`, async () => {
        const h = await ready(packageId);
        let order = h.order;
        assert.equal(order.slaStartsAt, PLANNED_START);
        assert.equal(order.productionStartedAt, null);
        await assert.rejects(h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] }), /INVALID_TRANSITION/);
        order = await h.send(order, "start_production", "creative");
        assert.equal(order.productionStartedAt, FIXED_TIME);
        assert.equal(order.slaStartsAt, PLANNED_START);
        await assert.rejects(h.send(order, "start_production", "creative"), /INVALID_TRANSITION/);
        await assert.rejects(h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a1"] }), /DUPLICATE_OPTION/);
        order = await h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
        for (let round = 1; round <= PACKAGES[packageId].revisions; round++) {
            order = await h.send(order, "request_revision", "customer");
            assert.equal(order.revisionsUsed, round);
            await assert.rejects(h.send(order, "request_revision", "customer"), /INVALID_TRANSITION/);
            await assert.rejects(h.send(order, "revision_options", "creative", { options: ["synthetic-a1", "synthetic-a3"] }), /DUPLICATE_OPTION/);
            const ids = [`synthetic-r${round}-a`, `synthetic-r${round}-b`];
            const requestId = `synthetic-revision-round-${round}`;
            order = await h.send(order, "revision_options", "creative", { options: ids }, { requestId });
            const snapshot = order;
            order = await h.send(order, "revision_options", "creative", { options: ids }, { requestId });
            assert.strictEqual(order, snapshot);
            assert.equal(order.revisionsUsed, round);
        }
        assert.equal(order.options.length, PACKAGES[packageId].alternatives);
        await assert.rejects(h.send(order, "request_revision", "customer"), /REVISION_LIMIT/);
        await assert.rejects(h.send(order, "select_final", "customer", { selectedOption: "synthetic-unknown" }), /UNKNOWN_OPTION/);
        order = await h.send(order, "select_final", "customer", { selectedOption: "synthetic-a1" });
        await assert.rejects(h.send(order, "complete", "creative", { mp3Ref: "synthetic-mp3", wavFeasible: true }), /INVALID_DELIVERY/);
        order = await h.send(order, "complete", "creative", { mp3Ref: "synthetic-mp3", wavRef: "synthetic-wav", wavFeasible: true });
        assert.deepEqual(order.delivery, {
            selectedOption: "synthetic-a1", mp3Ref: "synthetic-mp3",
            wavRef: "synthetic-wav", commercialRights: false
        });
        assert.equal(order.state, STATES.COMPLETED);
        await assert.rejects(h.send(order, "request_revision", "customer"), /INVALID_TRANSITION/);
    });
}

test("early selection, optional WAV and separate service boundary", async () => {
    const h = await ready("PREMIUM");
    let order = await h.send(h.order, "start_production", "creative");
    order = await h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
    order = await h.send(order, "select_final", "customer", { selectedOption: "synthetic-a2" });
    order = await h.send(order, "complete", "creative", { mp3Ref: "synthetic-mp3", wavFeasible: false });
    assert.equal(order.revisionsUsed, 0);
    assert.equal(order.delivery.wavRef, null);
    await assert.rejects(h.send(order, "new_story", "customer"), /UNKNOWN_ACTION/);
    await assert.rejects(h.send(order, "grant_commercial_rights", "finance"), /UNKNOWN_ACTION/);
    await assert.rejects(h.send(order, "__proto__", "finance"), /UNKNOWN_ACTION/);
});

test("cancellation, refund and disputes freeze further work", async () => {
    const h = await ready();
    const cancelled = await h.send(h.order, "cancel", "finance");
    assert.equal(cancelled.state, STATES.CANCELLED);
    await assert.rejects(h.send(cancelled, "start_production", "creative"), /INVALID_TRANSITION/);
    // Görev 130: disputes and refund reviews open only through a server-verified review record.
    const disputeHarness = await ready();
    const disputed = await disputeHarness.openReview(disputeHarness.order, "DISPUTE");
    assert.equal(disputed.state, STATES.DISPUTED);
    await assert.rejects(disputeHarness.send(disputed, "start_production", "creative"), /REVIEW_IN_PROGRESS/);
    const reviewHarness = await ready();
    const review = await reviewHarness.openReview(reviewHarness.order, "REFUND");
    assert.equal(review.state, STATES.REFUND_REVIEW);
    await assert.rejects(reviewHarness.send(review, "start_production", "creative"), /REVIEW_IN_PROGRESS/);
});

test("audit entries are chained, immutable and contain no raw payment, email or booking proof", async () => {
    const h = await ready();
    const order = h.order;
    assert.equal(order.events.length, order.version);
    for (let i = 0; i < order.events.length; i++) {
        assert.equal(order.events[i].sequence, i + 1);
        assert.equal(order.events[i].previousHash, i ? order.events[i - 1].hash : null);
        assert.match(order.events[i].hash, /^[a-f0-9]{64}$/);
        assert.equal(order.events[i].at, FIXED_TIME);
        assert.ok(Object.isFrozen(order.events[i]));
    }
    const events = JSON.stringify(order.events);
    assert.ok(!events.includes("SYNTHETIC-ONE-USE-CODE"));
    assert.ok(!events.includes("paid_unreversed"));
    assert.ok(!events.includes(h.booking(order).signature) && !events.includes("booking_service"));
    assert.throws(() => { order.events[0].kind = "changed"; }, TypeError);
    assert.ok(OrderError.prototype instanceof Error);
});

test("forged paid snapshot and paymentVerified field cannot cross the payment gate", async () => {
    const h = setup();
    const draft = h.core.createOrder("START");
    const forged = { ...draft, state: STATES.PAYMENT_VERIFIED, paymentReference: "synthetic-fake-reference", paymentVerified: true };
    await assert.rejects(h.send(forged, "request_email", "customer"), /INVALID_TRANSITION/);
    await assert.rejects(h.send({ ...draft, paymentVerified: true }, "request_email", "customer"), /INVALID_TRANSITION/);
    const pending = await h.send(forged, "submit", "customer");
    assert.equal(pending.state, STATES.PAYMENT_PENDING);
    assert.equal(pending.paymentReference, null);
    assert.equal(Object.hasOwn(pending, "paymentVerified"), false);
    await assert.rejects(h.send({ ...pending, state: STATES.PAYMENT_VERIFIED }, "request_email", "customer"), /INVALID_TRANSITION/);
});

test("reloaded handles use authoritative state; an unrelated core fails closed", async () => {
    const h = setup();
    let order = h.core.createOrder("PLUS");
    const reload = snapshot => JSON.parse(JSON.stringify(snapshot));
    order = await h.send(reload(order), "submit", "customer");
    const payment = h.payment(order);
    order = await h.send(reload(order), "verify_payment", "finance", { proof: payment });
    order = await h.send(reload(order), "request_email", "customer");
    const foreign = createCore({ authorize: () => true, verifyPayment: () => true });
    await assert.rejects(foreign.dispatch(reload(order), {
        kind: "verify_payment", requestId: "synthetic-foreign-order", expectedVersion: order.version,
        data: { proof: payment }
    }, h.actor("finance", order)), /UNKNOWN_ORDER/);
    await assert.rejects(h.send({ ...reload(order), state: STATES.PAYMENT_PENDING }, "verify_payment", "finance"),
        /INVALID_TRANSITION/);
});

test("duplicate payment notifications remain idempotent and never accept untrusted proof", async () => {
    const h = setup();
    let order = await h.send(h.core.createOrder("START"), "submit", "customer");
    const proof = h.payment(order);
    order = await h.send(order, "verify_payment", "finance", { proof }, { requestId: "synthetic-payment-first" });
    const version = order.version;
    assert.strictEqual(await h.send(order, "verify_payment", "finance", { proof }, { requestId: "synthetic-payment-second" }), order);
    assert.equal(order.version, version);
    await assert.rejects(h.send(order, "verify_payment", "finance", { proof: { ...proof, signature: "0".repeat(64) } }),
        /UNTRUSTED_PAYMENT/);
    await assert.rejects(h.send(order, "verify_payment", "customer", { proof }), /UNAUTHORIZED/);
    const other = await h.send(h.core.createOrder("START"), "submit", "customer");
    await assert.rejects(h.send(other, "verify_payment", "finance", { proof }), /PAYMENT_MISMATCH/);
    await assert.rejects(h.send(other, "verify_payment", "finance"), /PAYMENT_MISMATCH/);
    await assert.rejects(h.send(other, "verify_payment", "finance",
        { proof: h.payment(other, { reference: proof.reference }) }), /PAYMENT_REFERENCE_USED/);
    assert.equal(other.state, STATES.PAYMENT_PENDING);
});

test("forged cancellation cannot reactivate; package and revision limits remain enforced", async () => {
    const h = setup();
    const draft = h.core.createOrder("START");
    await assert.rejects(h.send({ ...draft, packageId: "PREMIUM" }, "submit", "customer"), /INVALID_ORDER/);
    const cancelled = await h.send(draft, "cancel", "finance");
    await assert.rejects(h.send({ ...cancelled, state: STATES.DRAFT, paymentVerified: true }, "submit", "customer"),
        /INVALID_TRANSITION/);
    await assert.rejects(h.send({ ...cancelled, state: STATES.PAYMENT_PENDING }, "verify_payment", "finance"),
        /INVALID_TRANSITION/);
    const production = await producing("START");
    let order = production.order;
    for (let i = 0; i < PACKAGES.START.revisions; i++) {
        order = await production.send(order, "request_revision", "customer");
        order = await production.send(order, "revision_options", "creative",
            { options: [`synthetic-x${i + 3}-a`, `synthetic-x${i + 3}-b`] });
    }
    assert.equal(order.options.length, PACKAGES.START.alternatives);
    await assert.rejects(production.send({ ...order, revisionsUsed: 0, options: [] }, "request_revision", "customer"), /REVISION_LIMIT/);
});

// ---- Görev 128: PD-01 SLA start ----

test("PD-01/1: the SLA starts at the confirmed booking's planned start", async () => {
    const h = await ready("PLUS");
    assert.equal(h.order.state, STATES.START_APPROVED);
    assert.equal(h.order.slaStartsAt, PLANNED_START);
    assert.deepEqual(h.order.booking, {
        bookingId: h.booking(h.order).bookingId, tariff: "STANDARD", scheduledStart: PLANNED_START,
        deadline: DEADLINE, surchargeReference: null
    });
    assert.equal(h.order.productionStartedAt, null);
    assert.equal(h.order.events.at(-1).kind, "approve_start");
});

test("PD-01/2: a late producer start never moves the SLA start or the deadline", async () => {
    const h = await ready();
    // Görev 129: every start must fall inside production hours, so 18:00 Istanbul is refused for STANDARD.
    h.setNow("2026-10-28T15:00:00.000Z");
    await assert.rejects(h.send(h.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
    h.setNow("2026-10-28T13:00:00.000Z"); // 16:00 Istanbul, three hours after the planned start
    const order = await h.send(h.order, "start_production", "creative");
    assert.equal(order.productionStartedAt, "2026-10-28T13:00:00.000Z");
    assert.equal(order.slaStartsAt, PLANNED_START);
    assert.equal(order.booking.deadline, DEADLINE);
});

test("PD-01/3: no SLA without a confirmed booking", async () => {
    const h = await booked();
    for (const status of ["HELD", "PENDING", "CANCELLED", undefined]) {
        await assert.rejects(h.send(h.order, "approve_start", "scheduler", { booking: h.booking(h.order, { status }) }),
            /BOOKING_NOT_CONFIRMED/);
    }
    await assert.rejects(h.send(h.order, "approve_start", "scheduler"), /BOOKING_MISMATCH/);
    const before = setup();
    let early = await before.send(before.core.createOrder("START"), "submit", "customer");
    early = await before.send(early, "verify_payment", "finance", { proof: before.payment(early) });
    await assert.rejects(before.send(early, "approve_start", "scheduler", { booking: before.booking(early) }),
        /INVALID_TRANSITION/);
    const unchanged = await h.send(h.order, "approve_start", "scheduler", { booking: h.booking(h.order) });
    assert.equal(unchanged.version, h.order.version + 1);
});

test("PD-01/4: no SLA before payment verification, even with a valid-looking booking", async () => {
    const h = setup();
    const pending = await h.send(h.core.createOrder("START"), "submit", "customer");
    for (const state of [STATES.BOOKING_PENDING, STATES.START_APPROVED]) {
        await assert.rejects(h.send({ ...pending, state, paymentReference: "synthetic-fake-reference" }, "approve_start",
            "scheduler", { booking: h.booking(pending) }), /INVALID_TRANSITION/);
    }
    // A booking dated before the payment verification cannot belong to this paid order.
    const b = await booked();
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { scheduledStart: "2026-10-28T07:00:00.000Z" }) }), /INVALID_BOOKING/);
});

test("PD-01/5: urgent bookings need verified surcharge and producer approval", async () => {
    const urgentStart = "2026-10-28T16:00:00.000Z"; // 19:00 Istanbul, urgent hours only
    const cleared = { surchargeReference: "SYNTHSURCHARGE0001", surchargeVerified: true, producerApproved: true };
    const b = await booked();
    for (const urgent of [null, { ...cleared, surchargeVerified: false }, { ...cleared, producerApproved: false },
        { ...cleared, producerApproved: "true" }, { ...cleared, surchargeReference: "x" }]) {
        await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order,
            { tariff: "URGENT", scheduledStart: urgentStart, urgent }) }), /URGENT_NOT_CLEARED/);
    }
    assert.equal(b.order.slaStartsAt, null);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { scheduledStart: urgentStart }) }), /INVALID_BOOKING/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order, { urgent: cleared }) }),
        /INVALID_BOOKING/);
    const order = await b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { tariff: "URGENT", scheduledStart: urgentStart, urgent: cleared }) });
    assert.equal(order.slaStartsAt, urgentStart);
    assert.equal(order.booking.surchargeReference, "SYNTHSURCHARGE0001");
    // The same surcharge cannot clear a second order, nor can the main payment reference be reused as one.
    const other = await booked("START", b);
    await assert.rejects(other.send(other.order, "approve_start", "scheduler", { booking: other.booking(other.order,
        { tariff: "URGENT", scheduledStart: urgentStart, urgent: cleared }) }), /PAYMENT_REFERENCE_USED/);
    await assert.rejects(other.send(other.order, "approve_start", "scheduler", { booking: other.booking(other.order,
        { tariff: "URGENT", scheduledStart: urgentStart,
            urgent: { ...cleared, surchargeReference: other.order.paymentReference } }) }), /PAYMENT_REFERENCE_USED/);
});

test("PD-01/6: customer-supplied or unsigned booking evidence is rejected", async () => {
    const b = await booked();
    const record = b.booking(b.order);
    await assert.rejects(b.send(b.order, "approve_start", "customer", { booking: record }), /UNAUTHORIZED/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: record }, { auth: Symbol("browser") }),
        /UNAUTHORIZED/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: { ...record, signature: "0".repeat(64) } }),
        /UNTRUSTED_BOOKING/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: { ...record, scheduledStart: "2026-10-28T11:00:00.000Z" } }), /UNTRUSTED_BOOKING/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { orderId: b.core.createOrder("START").id }) }), /BOOKING_MISMATCH/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { source: "customer_browser" }) }), /BOOKING_MISMATCH/);
    for (const extra of [{ scheduledStart: "2026-10-29T00:30:00.000Z" }, { scheduledStart: "tomorrow" },
        { deadline: PLANNED_START }, { tariff: "EXPRESS" }]) {
        await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order, extra) }),
            /INVALID_BOOKING/);
    }
    const noVerifier = setup({ verifyBooking: undefined });
    const nb = await booked("START", noVerifier);
    await assert.rejects(nb.send(nb.order, "approve_start", "scheduler", { booking: nb.booking(nb.order) }),
        /UNTRUSTED_BOOKING/);
    const noCalendar = await booked("START", setup({ calendar: undefined }));
    await assert.rejects(noCalendar.send(noCalendar.order, "approve_start", "scheduler",
        { booking: noCalendar.booking(noCalendar.order) }), /CALENDAR_MISSING/);
    // Forged snapshot fields and booking data sent with a customer command are ignored.
    const forged = { ...b.order, slaStartsAt: "2026-01-01T00:00:00.000Z", booking: { deadline: "2099-01-01T00:00:00.000Z" } };
    await assert.rejects(b.send(forged, "start_production", "creative"), /INVALID_TRANSITION/);
    const fresh = setup();
    let order = (await booked("START", fresh)).order;
    assert.equal(order.slaStartsAt, null);
    order = await fresh.send({ ...order, slaStartsAt: PLANNED_START }, "cancel", "finance");
    assert.equal(order.slaStartsAt, null);
});

// ---- Görev 128: PD-10 revision rights ----

test("PD-10/7,8,13: acceptance consumes exactly one right atomically; delivery consumes none", async () => {
    const h = await producing("PLUS");
    const before = h.order;
    const accepted = await h.send(before, "request_revision", "customer");
    assert.equal(accepted.revisionsUsed, 1);
    assert.equal(accepted.state, STATES.REVISION_PENDING);
    assert.equal(accepted.version, before.version + 1);
    assert.deepEqual([accepted.events.at(-1).kind, accepted.events.at(-1).from, accepted.events.at(-1).to],
        ["request_revision", STATES.IN_PRODUCTION, STATES.REVISION_PENDING]);
    const delivered = await h.send(accepted, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] });
    assert.equal(delivered.revisionsUsed, 1);
    assert.equal(delivered.state, STATES.IN_PRODUCTION);
    assert.equal(delivered.options.length, 4);
    assert.equal(delivered.events.filter(event => event.kind === "request_revision").length, delivered.revisionsUsed);
    await assert.rejects(h.send(delivered, "revision_options", "creative", { options: ["synthetic-b3", "synthetic-b4"] }),
        /INVALID_TRANSITION/);
    assert.equal(delivered.booking.deadline, DEADLINE);
});

test("PD-10/9: repeating the same request never consumes a second right", async () => {
    const h = await producing();
    const accepted = await h.send(h.order, "request_revision", "customer", {}, { requestId: "synthetic-rev-once" });
    assert.strictEqual(await h.send(accepted, "request_revision", "customer", {},
        { requestId: "synthetic-rev-once", version: h.order.version }), accepted);
    await assert.rejects(h.send(accepted, "request_revision", "customer"), /INVALID_TRANSITION/);
    await assert.rejects(h.send(accepted, "request_revision", "customer", {}, { version: h.order.version }),
        /VERSION_CONFLICT/);
    assert.equal(accepted.revisionsUsed, 1);
});

test("PD-10/10: invalid or unaccepted requests consume nothing", async () => {
    const r = await ready();
    await assert.rejects(r.send(r.order, "request_revision", "customer"), /INVALID_TRANSITION/);
    let order = await r.send(r.order, "start_production", "creative");
    await assert.rejects(r.send(order, "request_revision", "customer"), /REVISION_LIMIT/);
    await assert.rejects(r.send(order, "request_revision", "creative"), /UNAUTHORIZED/);
    order = await r.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
    assert.equal(order.revisionsUsed, 0);
    // Without a committed deadline the timing rule cannot be applied, so the request fails closed.
    const noDeadline = await producing("START", { deadline: null });
    await assert.rejects(noDeadline.send(noDeadline.order, "request_revision", "customer"), /DEADLINE_UNAVAILABLE/);
    assert.equal(noDeadline.order.revisionsUsed, 0);
    const accepted = await r.send(order, "request_revision", "customer");
    assert.equal(accepted.revisionsUsed, 1);
});

test("PD-10/11,12: no acceptance at zero rights; the count never goes negative or above the package", async () => {
    const h = await producing("START");
    let order = h.order;
    const limit = PACKAGES.START.revisions;
    for (let round = 1; round <= limit; round++) {
        order = await h.send(order, "request_revision", "customer");
        assert.ok(limit - order.revisionsUsed >= 0);
        order = await h.send(order, "revision_options", "creative", { options: [`synthetic-z${round}a`, `synthetic-z${round}b`] });
    }
    assert.equal(limit - order.revisionsUsed, 0);
    await assert.rejects(h.send(order, "request_revision", "customer"), /REVISION_LIMIT/);
    await assert.rejects(h.send({ ...order, revisionsUsed: -5 }, "request_revision", "customer"), /REVISION_LIMIT/);
    await assert.rejects(h.send(order, "revision_options", "creative", { options: ["synthetic-q1", "synthetic-q2"] }),
        /INVALID_TRANSITION/);
    assert.equal(order.revisionsUsed, limit);
});

test("PD-10/14-16: at or after the deadline → new-order review; rights stay untouched", async () => {
    const h = await producing("PREMIUM");
    const order = h.order;
    for (const now of [DEADLINE, "2026-10-30T12:01:00.000Z"]) {
        h.setNow(now);
        await assert.rejects(h.send(order, "request_revision", "customer"), /NEW_ORDER_REVIEW_REQUIRED/);
    }
    assert.equal(order.revisionsUsed, 0);
    assert.equal(order.state, STATES.IN_PRODUCTION);
    // The registry still holds the same version: a later valid request applies to the unchanged order.
    h.setNow("2026-10-30T09:00:00.000Z");
    const accepted = await h.send(order, "request_revision", "customer");
    assert.equal(accepted.version, order.version + 1);
    assert.equal(accepted.revisionsUsed, 1);
});

test("PD-09 via PD-10: last-minute acceptance extends the committed deadline once", async () => {
    const h = await producing();
    h.setNow("2026-10-30T11:00:00.000Z"); // 60 minutes before the Friday 15:00 Istanbul deadline
    const accepted = await h.send(h.order, "request_revision", "customer");
    assert.equal(accepted.revisionsUsed, 1);
    // Friday 15:00-18:00 (3 h) + Monday 09:00-12:00 Istanbul (3 h).
    assert.equal(accepted.booking.deadline, "2026-11-02T09:00:00.000Z");
    assert.equal(accepted.slaStartsAt, PLANNED_START);
    const delivered = await h.send(accepted, "revision_options", "creative", { options: ["synthetic-l1", "synthetic-l2"] });
    assert.equal(delivered.booking.deadline, "2026-11-02T09:00:00.000Z");
});

test("PD-10/17: revision rights of different orders never mix", async () => {
    const shared = setup();
    const a = await producing("START", {}, shared);
    const b = await producing("START", {}, shared);
    await assert.rejects(shared.core.dispatch(b.order, {
        kind: "request_revision", requestId: "synthetic-cross-order", expectedVersion: b.order.version
    }, shared.actor("customer", a.order)), /UNAUTHORIZED/);
    let orderA = await shared.send(a.order, "request_revision", "customer");
    orderA = await shared.send(orderA, "revision_options", "creative", { options: ["synthetic-m1", "synthetic-m2"] });
    orderA = await shared.send(orderA, "request_revision", "customer");
    assert.equal(orderA.revisionsUsed, 2);
    const orderB = await shared.send(b.order, "request_revision", "customer");
    assert.equal(orderB.revisionsUsed, 1);
    await assert.rejects(shared.send({ ...b.order, id: a.order.id }, "request_revision", "customer"), /INVALID_ORDER|VERSION_CONFLICT/);
});

// ---- Görev 129: PDR-26 automatic acceptance ----

function expectedNotificationId(orderId, revisionId) {
    return createHash("sha256").update(JSON.stringify(["REVISION_ACCEPTED", orderId, revisionId])).digest("hex");
}

test("PDR-26/1,2,3,6: a valid request is accepted automatically with one right and a pending producer notice", async () => {
    const h = await producing("PLUS");
    const accepted = await h.send(h.order, "request_revision", "customer");
    assert.equal(accepted.state, STATES.REVISION_PENDING);
    assert.equal(accepted.revisionsUsed, 1);
    assert.deepEqual(accepted.revisions, [{ revisionId: "revision-0001", status: "ACCEPTED", acceptedAt: FIXED_TIME,
        acceptRequestId: accepted.events.at(-1).requestId, deliveredAt: null, restoration: null }]);
    assert.deepEqual(accepted.notifications, [{
        notificationId: expectedNotificationId(accepted.id, "revision-0001"), kind: "REVISION_ACCEPTED",
        recipient: "PRODUCER", orderId: accepted.id, revisionId: "revision-0001", createdAt: FIXED_TIME,
        dispatch: "PENDING_OUTBOX"
    }]);
    // No producer command was needed, and the core exposes no sending capability or delivery claim.
    assert.deepEqual(Object.keys(h.core), ["createOrder", "dispatch"]);
    const delivered = await h.send(accepted, "revision_options", "creative", { options: ["synthetic-n1", "synthetic-n2"] });
    assert.equal(delivered.revisionsUsed, 1);
    assert.equal(delivered.revisions[0].status, "DELIVERED");
    assert.equal(delivered.notifications[0].dispatch, "PENDING_OUTBOX");
    assert.ok(!JSON.stringify(delivered.notifications).match(/sent|delivered/i));
});

test("PDR-26/4,5: a repeated request neither consumes a second right nor duplicates the notice", async () => {
    const h = await producing();
    const first = await h.send(h.order, "request_revision", "customer", {}, { requestId: "synthetic-auto-accept" });
    const again = await h.send(first, "request_revision", "customer", {}, { requestId: "synthetic-auto-accept",
        version: h.order.version });
    assert.strictEqual(again, first);
    assert.equal(again.revisionsUsed, 1);
    assert.equal(again.notifications.length, 1);
    // The logical id is derived from order and revision, so any re-emission maps to the same notice.
    assert.equal(again.notifications[0].notificationId, expectedNotificationId(first.id, "revision-0001"));
    await assert.rejects(h.send(first, "request_revision", "customer"), /INVALID_TRANSITION/);
});

test("PDR-26/7: invalid requests create no revision, right consumption or notice", async () => {
    const r = await ready();
    let order = await r.send(r.order, "start_production", "creative");
    await assert.rejects(r.send(order, "request_revision", "customer"), /REVISION_LIMIT/);
    order = await r.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
    r.setNow(DEADLINE);
    await assert.rejects(r.send(order, "request_revision", "customer"), /NEW_ORDER_REVIEW_REQUIRED/);
    await assert.rejects(r.send(order, "request_revision", "creative"), /UNAUTHORIZED/);
    assert.deepEqual([order.revisionsUsed, order.revisions.length, order.notifications.length], [0, 0, 0]);
});

// ---- Görev 129: PDR-27 right restoration ----

test("PDR-27/8: restoration needs a previously accepted revision", async () => {
    const h = await producing();
    await assert.rejects(h.restore(h.order, "revision-0001"), /UNKNOWN_REVISION/);
    const accepted = await h.send(h.order, "request_revision", "customer");
    await assert.rejects(h.restore(accepted, "revision-0002"), /UNKNOWN_REVISION/);
    await assert.rejects(h.restore(accepted, undefined), /UNKNOWN_REVISION/);
    assert.equal(accepted.revisionsUsed, 1);
});

test("PDR-27/9,14: a producer non-delivery restores one right with an atomic audit record", async () => {
    for (const role of ["creative", "admin"]) {
        const h = await producing("START");
        const accepted = await h.send(h.order, "request_revision", "customer");
        const source = role === "creative" ? "producer_console" : "admin_console";
        const record = h.restoration(accepted, "revision-0001", { source });
        const restored = await h.restore(accepted, "revision-0001", record, role, { requestId: `synthetic-restore-${role}` });
        assert.equal(restored.revisionsUsed, 0);
        assert.equal(restored.state, STATES.IN_PRODUCTION);
        assert.equal(restored.version, accepted.version + 1);
        const event = restored.events.at(-1);
        const audit = {
            orderId: accepted.id, revisionId: "revision-0001", reasonCode: "PRODUCER_NON_DELIVERY",
            authorizationRef: record.authorizationRef, at: FIXED_TIME, idempotencyKey: `synthetic-restore-${role}`
        };
        assert.deepEqual(event.audit, audit);
        assert.deepEqual([event.kind, event.role, event.from, event.to],
            ["restore_revision_right", role, STATES.REVISION_PENDING, STATES.IN_PRODUCTION]);
        assert.deepEqual(restored.revisions[0], { ...accepted.revisions[0], status: "RESTORED", restoration: audit });
        assert.ok(!JSON.stringify(restored.events).includes(record.signature));
        // The restored right can be used again for a new, separately identified revision.
        const next = await h.send(restored, "request_revision", "customer");
        assert.equal(next.revisions.at(-1).revisionId, "revision-0002");
        assert.equal(next.revisionsUsed, 1);
        assert.equal(next.notifications.length, 2);
    }
});

test("PDR-27/10: one restoration per revision and per authorization reference", async () => {
    const h = await producing("PLUS");
    const accepted = await h.send(h.order, "request_revision", "customer");
    const record = h.restoration(accepted, "revision-0001");
    const restored = await h.restore(accepted, "revision-0001", record, "creative", { requestId: "synthetic-restore-once" });
    assert.strictEqual(await h.restore(restored, "revision-0001", record, "creative",
        { requestId: "synthetic-restore-once", version: accepted.version }), restored);
    await assert.rejects(h.restore(restored, "revision-0001"), /ALREADY_RESTORED/);
    const second = await h.send(restored, "request_revision", "customer");
    await assert.rejects(h.restore(second, "revision-0002", h.restoration(second, "revision-0002",
        { authorizationRef: record.authorizationRef })), /RESTORATION_REFERENCE_USED/);
    assert.equal(second.revisionsUsed, 1);
});

test("PDR-27/11: customer claims, free-text reasons and unsigned records cannot restore a right", async () => {
    const h = await producing();
    const accepted = await h.send(h.order, "request_revision", "customer");
    const record = h.restoration(accepted, "revision-0001");
    await assert.rejects(h.restore(accepted, "revision-0001", record, "customer"), /UNAUTHORIZED/);
    await assert.rejects(h.restore(accepted, "revision-0001", record, "finance"), /UNAUTHORIZED/);
    await assert.rejects(h.restore(accepted, "revision-0001", record, "creative", { auth: Symbol("browser") }), /UNAUTHORIZED/);
    await assert.rejects(h.restore(accepted, "revision-0001", { ...record, signature: "0".repeat(64) }), /UNTRUSTED_RESTORATION/);
    await assert.rejects(h.restore(accepted, "revision-0001", { ...record, authorizationRef: "synthetic-forged-ref" }),
        /UNTRUSTED_RESTORATION/);
    for (const reasonCode of ["CUSTOMER_REQUEST", "producer did not deliver", undefined]) {
        await assert.rejects(h.restore(accepted, "revision-0001", h.restoration(accepted, "revision-0001", { reasonCode })),
            /INVALID_RESTORATION/);
    }
    await assert.rejects(h.restore(accepted, "revision-0001", h.restoration(accepted, "revision-0001",
        { source: "customer_portal" })), /RESTORATION_MISMATCH/);
    await assert.rejects(h.restore(accepted, "revision-0001", h.restoration(accepted, "revision-0001",
        { source: "admin_console" })), /RESTORATION_MISMATCH/);
    const noVerifier = await producing("START", {}, setup({ verifyRestoration: undefined }));
    const pending = await noVerifier.send(noVerifier.order, "request_revision", "customer");
    await assert.rejects(noVerifier.restore(pending, "revision-0001"), /UNTRUSTED_RESTORATION/);
    assert.equal(accepted.revisionsUsed, 1);
});

test("PDR-27/12: a restoration record cannot be applied to another order", async () => {
    const shared = setup();
    const a = await producing("START", {}, shared);
    const b = await producing("START", {}, shared);
    const acceptedA = await shared.send(a.order, "request_revision", "customer");
    const acceptedB = await shared.send(b.order, "request_revision", "customer");
    const recordA = shared.restoration(acceptedA, "revision-0001");
    await assert.rejects(shared.restore(acceptedB, "revision-0001", recordA), /RESTORATION_MISMATCH/);
    const restoredA = await shared.restore(acceptedA, "revision-0001", recordA);
    assert.equal(restoredA.revisionsUsed, 0);
    const stillB = await shared.send(acceptedB, "revision_options", "creative", { options: ["synthetic-o1", "synthetic-o2"] });
    assert.equal(stillB.revisionsUsed, 1);
});

test("PDR-27/13: restorations never push rights above the package or below zero", async () => {
    const h = await producing("START");
    const limit = PACKAGES.START.revisions;
    let order = h.order;
    let restorations = 0;
    for (let round = 1; order.revisionsUsed < limit; round++) {
        order = await h.send(order, "request_revision", "customer");
        assert.ok(order.revisionsUsed <= limit && limit - order.revisionsUsed >= 0);
        if (round === 2) {
            order = await h.restore(order, order.revisions.at(-1).revisionId);
            restorations += 1;
            assert.ok(limit - order.revisionsUsed <= limit);
            continue;
        }
        order = await h.send(order, "revision_options", "creative", { options: [`synthetic-k${round}a`, `synthetic-k${round}b`] });
    }
    assert.equal(restorations, 1);
    assert.equal(order.revisionsUsed, limit);
    assert.equal(order.revisions.filter(revision => revision.status === "DELIVERED").length, limit);
    assert.equal(order.options.length, PACKAGES.START.alternatives);
    await assert.rejects(h.send(order, "request_revision", "customer"), /REVISION_LIMIT/);
    await assert.rejects(h.restore(order, "revision-0001"), /REVISION_ALREADY_DELIVERED/);
});

test("PDR-27/15: a failed restoration changes neither rights, audit nor reference registry", async () => {
    const h = await producing();
    const accepted = await h.send(h.order, "request_revision", "customer");
    const good = h.restoration(accepted, "revision-0001");
    await assert.rejects(h.restore(accepted, "revision-0001", { ...good, signature: "f".repeat(64) }), /UNTRUSTED_RESTORATION/);
    await assert.rejects(h.restore(accepted, "revision-0001", h.restoration(accepted, "revision-0001",
        { authorizationRef: good.authorizationRef, reasonCode: "OTHER" })), /INVALID_RESTORATION/);
    // The registry still holds the accepted version, and the reference was not consumed by the failures.
    const restored = await h.restore(accepted, "revision-0001", good);
    assert.equal(restored.version, accepted.version + 1);
    assert.equal(restored.events.filter(event => event.audit).length, 1);
    assert.equal(restored.revisionsUsed, 0);
});

test("PDR-27/16: a delivered revision cannot be restored", async () => {
    const h = await producing();
    const accepted = await h.send(h.order, "request_revision", "customer");
    const delivered = await h.send(accepted, "revision_options", "creative", { options: ["synthetic-d1", "synthetic-d2"] });
    await assert.rejects(h.restore(delivered, "revision-0001"), /REVISION_ALREADY_DELIVERED/);
    const selected = await h.send(delivered, "select_final", "customer", { selectedOption: "synthetic-d1" });
    await assert.rejects(h.restore(selected, "revision-0001"), /INVALID_TRANSITION/);
    assert.equal(selected.revisionsUsed, 1);
});

// ---- Görev 129: early production ----

const LATER_START = "2026-10-29T07:00:00.000Z"; // Thursday 10:00 Istanbul

test("EARLY/17,18,19: early start is allowed; SLA start and deadline stay as committed", async () => {
    const h = await ready("START", { scheduledStart: LATER_START });
    h.setNow("2026-10-28T12:00:00.000Z"); // Wednesday 15:00 Istanbul, before the planned start
    const order = await h.send(h.order, "start_production", "creative");
    assert.equal(order.state, STATES.IN_PRODUCTION);
    assert.equal(order.productionStartedAt, "2026-10-28T12:00:00.000Z");
    assert.equal(order.slaStartsAt, LATER_START);
    assert.equal(order.booking.scheduledStart, LATER_START);
    assert.equal(order.booking.deadline, DEADLINE);
    assert.ok(Date.parse(order.productionStartedAt) < Date.parse(order.slaStartsAt));
});

test("EARLY/20,21: early production cannot bypass booking or payment verification", async () => {
    const b = await booked();
    b.setNow("2026-10-28T12:00:00.000Z");
    await assert.rejects(b.send(b.order, "start_production", "creative"), /INVALID_TRANSITION/);
    await assert.rejects(b.send({ ...b.order, state: STATES.START_APPROVED, slaStartsAt: LATER_START },
        "start_production", "creative"), /INVALID_TRANSITION/);
    const h = setup();
    const pending = await h.send(h.core.createOrder("START"), "submit", "customer");
    await assert.rejects(h.send({ ...pending, state: STATES.START_APPROVED, paymentReference: "synthetic-fake-reference" },
        "start_production", "creative"), /INVALID_TRANSITION/);
    await assert.rejects(b.send(b.order, "start_production", "customer"), /UNAUTHORIZED/);
});

test("EARLY/22: urgent early production needs the producer approval and surcharge first", async () => {
    const urgentStart = "2026-10-29T17:00:00.000Z"; // Thursday 20:00 Istanbul
    const cleared = { surchargeReference: "SYNTHSURCHARGE0129", surchargeVerified: true, producerApproved: true };
    const b = await booked();
    await assert.rejects(b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order,
        { tariff: "URGENT", scheduledStart: urgentStart, urgent: { ...cleared, producerApproved: false } }) }),
    /URGENT_NOT_CLEARED/);
    b.setNow("2026-10-28T16:00:00.000Z"); // Wednesday 19:00 Istanbul
    await assert.rejects(b.send(b.order, "start_production", "creative"), /INVALID_TRANSITION/);
    b.setNow(FIXED_TIME);
    const approved = await b.send(b.order, "approve_start", "scheduler", { booking: b.booking(b.order,
        { tariff: "URGENT", scheduledStart: urgentStart, urgent: cleared }) });
    b.setNow("2026-10-28T16:00:00.000Z");
    const order = await b.send(approved, "start_production", "creative");
    assert.equal(order.productionStartedAt, "2026-10-28T16:00:00.000Z");
    assert.equal(order.slaStartsAt, urgentStart);
});

test("EARLY/23,24: early starts respect the night ban and standard hours", async () => {
    const standard = await ready("START", { scheduledStart: LATER_START });
    for (const now of ["2026-10-28T21:30:00.000Z", "2026-10-29T05:59:59.999Z", "2026-10-28T16:00:00.000Z",
        "2026-10-28T15:00:00.000Z"]) {
        standard.setNow(now); // 00:30, 08:59:59.999, 19:00 and 18:00 Istanbul
        await assert.rejects(standard.send(standard.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
    }
    assert.equal(standard.order.state, STATES.START_APPROVED);
    assert.equal(standard.order.productionStartedAt, null);
    standard.setNow("2026-10-29T06:00:00.000Z"); // 09:00 Istanbul, still before the 10:00 plan
    assert.equal((await standard.send(standard.order, "start_production", "creative")).slaStartsAt, LATER_START);
    const urgent = await ready("START", { tariff: "URGENT", scheduledStart: "2026-10-29T17:00:00.000Z",
        urgent: { surchargeReference: "SYNTHSURCHARGE0130", surchargeVerified: true, producerApproved: true } });
    for (const now of ["2026-10-28T21:30:00.000Z", "2026-10-29T05:59:59.999Z"]) {
        urgent.setNow(now);
        await assert.rejects(urgent.send(urgent.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
    }
});

// ---- Görev 130 / Decision A: late starts follow the booked tariff's production hours ----

const LATE_STANDARD = "2026-10-29T07:00:00.000Z"; // Thursday 10:00 Istanbul, after the Wednesday 13:00 plan
const URGENT_START = "2026-10-29T17:00:00.000Z"; // Thursday 20:00 Istanbul

function holidayCalendar() {
    // SYNTHETIC: Thursday 2026-10-29 is marked as a holiday only for this fixture.
    return loadCalendar({
        timeZone: "Europe/Istanbul", version: "synthetic-core-2026.2",
        source: { kind: "SYNTHETIC", reference: "task-130-holiday-fixture" },
        coverage: { from: "2026-01-01", to: "2026-12-31" },
        annualApprovals: [{ year: 2026, approvedBy: "synthetic-producer", approverRole: "PRODUCER",
            approvedAt: "2026-01-02T09:00:00Z", reference: "task-130-synthetic-approval" }],
        days: [{ date: "2026-10-29", kind: "HOLIDAY" }]
    }, { allowSynthetic: true });
}

function urgentBooking(reference, scheduledStart = URGENT_START) {
    return { tariff: "URGENT", scheduledStart,
        urgent: { surchargeReference: reference, surchargeVerified: true, producerApproved: true } };
}

test("PH/1,4,5: a late standard start inside weekday hours is accepted; SLA start and deadline stay", async () => {
    for (const now of [LATE_STANDARD, "2026-10-30T14:59:59.999Z"]) { // Thursday 10:00, Friday 17:59:59.999
        const h = await ready();
        h.setNow(now);
        const order = await h.send(h.order, "start_production", "creative");
        assert.equal(order.state, STATES.IN_PRODUCTION);
        assert.equal(order.productionStartedAt, now);
        assert.ok(Date.parse(order.productionStartedAt) > Date.parse(order.slaStartsAt));
        assert.equal(order.slaStartsAt, PLANNED_START);
        assert.equal(order.booking.scheduledStart, PLANNED_START);
        assert.equal(order.booking.deadline, DEADLINE);
    }
});

test("PH/2: a late standard start at night, after 18:00, at weekends or on a holiday is rejected", async () => {
    const h = await ready();
    for (const now of ["2026-10-28T15:00:00.000Z", "2026-10-28T21:30:00.000Z", "2026-10-29T05:59:59.999Z",
        "2026-10-31T08:00:00.000Z", "2026-11-01T08:00:00.000Z"]) {
        h.setNow(now); // Wed 18:00, Thu 00:30, Thu 08:59:59.999, Sat 11:00, Sun 11:00 Istanbul
        await assert.rejects(h.send(h.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
    }
    assert.equal(h.order.state, STATES.START_APPROVED);
    assert.equal(h.order.productionStartedAt, null);
    const holiday = await ready("START", {}, setup({ calendar: holidayCalendar() }));
    holiday.setNow(LATE_STANDARD);
    await assert.rejects(holiday.send(holiday.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
});

test("PH/3,4,5: a late urgent start is accepted 09:00-24:00 every day and rejected at night", async () => {
    const late = await ready("START", urgentBooking("SYNTHSURCHARGE1301"));
    late.setNow("2026-10-29T20:59:59.999Z"); // Thursday 23:59:59.999 Istanbul, after the 20:00 plan
    const order = await late.send(late.order, "start_production", "creative");
    assert.equal(order.productionStartedAt, "2026-10-29T20:59:59.999Z");
    assert.equal(order.slaStartsAt, URGENT_START);
    assert.equal(order.booking.deadline, DEADLINE);
    const night = await ready("START", urgentBooking("SYNTHSURCHARGE1302"));
    for (const now of ["2026-10-29T21:00:00.000Z", "2026-10-30T05:59:59.999Z"]) { // Fri 00:00, Fri 08:59:59.999
        night.setNow(now);
        await assert.rejects(night.send(night.order, "start_production", "creative"), /OUTSIDE_PRODUCTION_HOURS/);
    }
    // A holiday closes the standard window only; the urgent window stays open.
    const holiday = await ready("START", urgentBooking("SYNTHSURCHARGE1303", "2026-10-29T06:00:00.000Z"),
        setup({ calendar: holidayCalendar() }));
    holiday.setNow(LATE_STANDARD); // Thursday (holiday) 10:00, after the 09:00 plan
    const onHoliday = await holiday.send(holiday.order, "start_production", "creative");
    assert.equal(onHoliday.slaStartsAt, "2026-10-29T06:00:00.000Z");
    assert.equal(onHoliday.booking.deadline, DEADLINE);
});

// ---- Görev 130 / Decision B: revision rights during cancellation, refund and dispute reviews ----

const REVIEW_TYPES = [["CANCELLATION", STATES.CANCELLATION_REVIEW], ["REFUND", STATES.REFUND_REVIEW],
    ["DISPUTE", STATES.DISPUTED]];

async function pendingRevision(packageId = "PLUS", h = setup()) {
    const p = await producing(packageId, {}, h);
    const order = await p.send(p.order, "request_revision", "customer");
    assert.equal(order.state, STATES.REVISION_PENDING);
    assert.equal(order.revisionsUsed, 1);
    return { ...p, order };
}

test("RB/6,7,8,9: each review type opens in its own state and keeps rights, revisions and history", async () => {
    for (const [type, state] of REVIEW_TYPES) {
        const h = await pendingRevision();
        const before = h.order;
        const order = await h.openReview(before, type);
        assert.equal(order.state, state);
        assert.equal(order.revisionsUsed, before.revisionsUsed);
        assert.deepEqual(order.revisions, before.revisions);
        assert.deepEqual(order.notifications, before.notifications);
        assert.deepEqual(order.events.slice(0, -1), before.events);
        assert.equal(order.reviews.length, 1);
        assert.equal(order.reviews[0].type, type);
        assert.equal(order.reviews[0].status, "OPEN");
        assert.equal(order.reviews[0].resumeState, STATES.REVISION_PENDING);
        assert.equal(order.events.at(-1).audit.type, type);
        assert.equal(order.events.at(-1).audit.reviewId, "review-0001");
        assert.ok(Object.isFrozen(order.reviews[0]));
    }
    // A completed order may enter a refund or dispute review, but not a cancellation review.
    const h = await producing();
    let done = await h.send(h.order, "select_final", "customer", { selectedOption: "synthetic-a1" });
    done = await h.send(done, "complete", "creative", { mp3Ref: "synthetic-mp3", wavFeasible: false });
    await assert.rejects(h.openReview(done, "CANCELLATION"), /INVALID_TRANSITION/);
    assert.equal((await h.openReview(done, "DISPUTE")).state, STATES.DISPUTED);
});

test("RB/10,11,12: during a review no revision is accepted, delivered or restored", async () => {
    for (const [type] of REVIEW_TYPES) {
        const h = await pendingRevision();
        const order = await h.openReview(h.order, type);
        await assert.rejects(h.send(order, "request_revision", "customer"), /REVIEW_IN_PROGRESS/);
        await assert.rejects(h.send(order, "revision_options", "creative",
            { options: ["synthetic-b1", "synthetic-b2"] }), /REVIEW_IN_PROGRESS/);
        await assert.rejects(h.restore(order, "revision-0001"), /REVIEW_IN_PROGRESS/);
        await assert.rejects(h.restore(order, "revision-0001",
            h.restoration(order, "revision-0001", { source: "admin_console" }), "admin"), /REVIEW_IN_PROGRESS/);
        await assert.rejects(h.send(order, "select_final", "customer", { selectedOption: "synthetic-a1" }),
            /REVIEW_IN_PROGRESS/);
        await assert.rejects(h.send(order, "cancel", "finance"), /REVIEW_IN_PROGRESS/);
        // The canonical record is unchanged: the next authorized decision still applies to this version.
        const resumed = await h.resolveReview(order, "CONTINUE");
        assert.equal(resumed.version, order.version + 1);
        assert.equal(resumed.revisionsUsed, 1);
        assert.deepEqual(resumed.revisions, order.revisions);
        assert.deepEqual(resumed.notifications, order.notifications);
    }
    // A production-phase cancellation can no longer bypass the review.
    const p = await producing();
    await assert.rejects(p.send(p.order, "cancel", "finance"), /INVALID_TRANSITION/);
});

test("RB/13: forged, unsigned, foreign or customer-sent review operations are rejected", async () => {
    const h = await pendingRevision();
    const order = h.order;
    const other = await pendingRevision();
    const unsigned = { ...h.reviewRecord(order, "REFUND"), signature: undefined };
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(order, "REFUND"), "customer"), /UNAUTHORIZED/);
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(order, "REFUND"), "creative"), /UNAUTHORIZED/);
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(order, "REFUND"), "finance",
        { auth: Symbol("browser") }), /UNAUTHORIZED/);
    await assert.rejects(h.openReview(order, "REFUND", unsigned), /UNTRUSTED_REVIEW/);
    await assert.rejects(h.openReview(order, "REFUND", { ...h.reviewRecord(order, "REFUND"), type: "DISPUTE" }),
        /UNTRUSTED_REVIEW/);
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(other.order, "REFUND")), /INVALID_REVIEW/);
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(order, "REFUND", { source: "admin_console" })),
        /INVALID_REVIEW/);
    await assert.rejects(h.openReview(order, "__proto__", h.reviewRecord(order, "__proto__")), /INVALID_REVIEW/);
    await assert.rejects(h.openReview(order, "REFUND", h.reviewRecord(order, "REFUND", { authorizationRef: "free text" })),
        /INVALID_REVIEW/);
    for (const legacy of ["dispute", "refund_review"]) {
        await assert.rejects(h.send(order, legacy, "customer"), /UNKNOWN_ACTION/);
        await assert.rejects(h.send(order, legacy, "finance"), /UNKNOWN_ACTION/);
    }
    const noVerifier = await pendingRevision("PLUS", setup({ verifyReview: undefined }));
    await assert.rejects(noVerifier.openReview(noVerifier.order, "REFUND"), /UNTRUSTED_REVIEW/);
    assert.equal(order.state, STATES.REVISION_PENDING);
    // An admin console record with the admin role is accepted.
    const admin = await h.openReview(order, "DISPUTE",
        h.reviewRecord(order, "DISPUTE", { source: "admin_console" }), "admin");
    assert.equal(admin.state, STATES.DISPUTED);
});

test("RB/14: a repeated review start never changes rights or opens a second review", async () => {
    const h = await pendingRevision();
    const record = h.reviewRecord(h.order, "CANCELLATION");
    const opened = await h.openReview(h.order, "CANCELLATION", record, "finance", { requestId: "synthetic-review-open" });
    const replay = await h.openReview(h.order, "CANCELLATION", record, "finance", { requestId: "synthetic-review-open" });
    assert.equal(replay, opened);
    await assert.rejects(h.openReview(opened, "CANCELLATION"), /REVIEW_IN_PROGRESS/);
    await assert.rejects(h.openReview(opened, "DISPUTE"), /REVIEW_IN_PROGRESS/);
    assert.equal(opened.reviews.length, 1);
    assert.equal(opened.revisionsUsed, 1);
    // One authorization reference opens at most one review, also across orders.
    const shared = setup();
    const a = await pendingRevision("PLUS", shared);
    const b = await pendingRevision("PLUS", shared);
    const first = shared.reviewRecord(a.order, "REFUND");
    await shared.openReview(a.order, "REFUND", first);
    const reused = shared.reviewRecord(b.order, "REFUND", { authorizationRef: first.authorizationRef });
    await assert.rejects(shared.openReview(b.order, "REFUND", reused), /REVIEW_REFERENCE_USED/);
    assert.equal(b.order.state, STATES.REVISION_PENDING);
});

test("RB/15: an authorized CONTINUE decision resumes the previous workflow with the same rights", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "DISPUTE");
    const resumed = await h.resolveReview(reviewed, "CONTINUE");
    assert.equal(resumed.state, STATES.REVISION_PENDING);
    assert.equal(resumed.revisionsUsed, 1);
    assert.equal(resumed.reviews[0].status, "RESOLVED");
    assert.equal(resumed.reviews[0].resolution.outcome, "CONTINUE");
    let order = await h.send(resumed, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] });
    assert.equal(order.state, STATES.IN_PRODUCTION);
    order = await h.send(order, "request_revision", "customer");
    assert.equal(order.revisionsUsed, 2);
    const production = await producing();
    const back = await production.resolveReview(await production.openReview(production.order, "REFUND"), "CONTINUE");
    assert.equal(back.state, STATES.IN_PRODUCTION);
});

test("RB/16: an authorized REFUND decision is recorded without moving money or resetting rights", async () => {
    let paymentChecks = 0;
    const h = await pendingRevision("PLUS", setup({
        verifyPayment: (proof) => { paymentChecks += 1; return signatureMatches(proof.signature, sign(proof)); }
    }));
    const reviewed = await h.openReview(h.order, "REFUND");
    const checksBefore = paymentChecks;
    const closed = await h.resolveReview(reviewed, "REFUND");
    assert.equal(paymentChecks, checksBefore);
    assert.equal(closed.state, STATES.CLOSED);
    assert.equal(closed.paymentReference, h.order.paymentReference);
    assert.equal(closed.reviews[0].resolution.outcome, "REFUND");
    assert.equal(closed.reviews[0].resolution.moneyMovement, "NONE");
    assert.equal(closed.revisionsUsed, 1);
    assert.deepEqual(closed.revisions, h.order.revisions);
    await assert.rejects(h.send(closed, "request_revision", "customer"), /INVALID_TRANSITION/);
    await assert.rejects(h.restore(closed, "revision-0001"), /INVALID_TRANSITION/);
});

test("RB/17: an authorized CLOSE decision closes the order and blocks new revisions", async () => {
    for (const [type] of REVIEW_TYPES) {
        const h = await producing();
        const closed = await h.resolveReview(await h.openReview(h.order, type), "CLOSE");
        assert.equal(closed.state, STATES.CLOSED);
        assert.equal(closed.revisionsUsed, 0);
        await assert.rejects(h.send(closed, "request_revision", "customer"), /INVALID_TRANSITION/);
        await assert.rejects(h.send(closed, "revision_options", "creative",
            { options: ["synthetic-b1", "synthetic-b2"] }), /INVALID_TRANSITION/);
        await assert.rejects(h.openReview(closed, "DISPUTE"), /INVALID_TRANSITION/);
        await assert.rejects(h.resolveReview(closed, "CONTINUE"), /INVALID_TRANSITION/);
    }
});

test("RB/18: the suspension is lifted only by a verified, authorized decision for the open review", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "CANCELLATION");
    const id = reviewed.reviews[0].reviewId;
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "customer"),
        /UNAUTHORIZED/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "creative"),
        /UNAUTHORIZED/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "finance",
        { auth: Symbol("browser") }), /UNAUTHORIZED/);
    const unsigned = { ...h.resolution(reviewed, id, "CONTINUE"), signature: undefined };
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", unsigned), /UNTRUSTED_REVIEW/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE",
        { ...h.resolution(reviewed, id, "CLOSE"), outcome: "CONTINUE" }), /UNTRUSTED_REVIEW/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, "review-0002", "CONTINUE")),
        /INVALID_REVIEW/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "RESET_RIGHTS")),
        /INVALID_REVIEW/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.reviewRecord(reviewed, "CANCELLATION")),
        /INVALID_REVIEW/);
    // A forged snapshot cannot leave the review either.
    await assert.rejects(h.send({ ...reviewed, state: STATES.REVISION_PENDING, reviews: [] }, "revision_options",
        "creative", { options: ["synthetic-b1", "synthetic-b2"] }), /REVIEW_IN_PROGRESS/);
    // Failed attempts registered nothing: the unsigned record's reference is still usable once signed.
    const signedAgain = h.resolution(reviewed, id, "CONTINUE", { authorizationRef: unsigned.authorizationRef });
    const resumed = await h.resolveReview(reviewed, "CONTINUE", signedAgain);
    assert.equal(resumed.version, reviewed.version + 1);
    assert.equal(resumed.state, STATES.REVISION_PENDING);
    const again = await h.openReview(resumed, "REFUND");
    await assert.rejects(h.resolveReview(again, "CONTINUE", h.resolution(again, again.reviews.at(-1).reviewId,
        "CONTINUE", { authorizationRef: signedAgain.authorizationRef })), /REVIEW_REFERENCE_USED/);
});

test("RB/19: revision records, audit entries and the event chain from before the review are kept", async () => {
    const h = await pendingRevision();
    const restored = await h.restore(h.order, "revision-0001");
    const accepted = await h.send(restored, "request_revision", "customer");
    const reviewed = await h.openReview(accepted, "DISPUTE");
    const resumed = await h.resolveReview(reviewed, "CONTINUE");
    assert.deepEqual(resumed.events.slice(0, accepted.events.length), accepted.events);
    assert.deepEqual(resumed.revisions, accepted.revisions);
    assert.deepEqual(resumed.revisions[0].restoration, restored.revisions[0].restoration);
    for (let i = 1; i < resumed.events.length; i++) {
        assert.equal(resumed.events[i].previousHash, resumed.events[i - 1].hash);
    }
    const kinds = resumed.events.slice(-2).map(event => [event.kind, event.audit.reviewId]);
    assert.deepEqual(kinds, [["open_review", "review-0001"], ["resolve_review", "review-0001"]]);
});

test("RB/20: a restored right is never restored twice, also after a review resumes", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "CANCELLATION");
    const resumed = await h.resolveReview(reviewed, "CONTINUE");
    const restored = await h.restore(resumed, "revision-0001");
    assert.equal(restored.revisionsUsed, 0);
    const second = await h.resolveReview(await h.openReview(restored, "DISPUTE"), "CONTINUE");
    assert.equal(second.state, STATES.IN_PRODUCTION);
    await assert.rejects(h.restore(second, "revision-0001"), /ALREADY_RESTORED/);
    assert.equal(second.revisionsUsed, 0);
});

test("RB/21: opening or resolving a review never moves the SLA start or the committed deadline", async () => {
    for (const outcome of ["CONTINUE", "REFUND", "CLOSE"]) {
        const h = await pendingRevision();
        h.setNow("2026-10-29T09:00:00.000Z");
        const reviewed = await h.openReview(h.order, "REFUND");
        h.setNow("2026-11-05T09:00:00.000Z"); // a week later
        const resolved = await h.resolveReview(reviewed, outcome);
        for (const order of [reviewed, resolved]) {
            assert.equal(order.slaStartsAt, h.order.slaStartsAt);
            assert.deepEqual(order.booking, h.order.booking);
            assert.equal(order.productionStartedAt, h.order.productionStartedAt);
        }
    }
});
