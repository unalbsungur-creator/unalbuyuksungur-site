import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { APPROVED_REVIEW_POLICY, createCore, OrderError, PACKAGES, PROPOSAL_VISIBILITY, proposalVisibility, STATES }
    from "./core.mjs";
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
    return hmac(["restoration", record.kind ?? null, record.orderId, record.revisionId, record.reasonCode ?? null,
        record.authorizationRef, record.source, record.actorId ?? null, record.evidenceRef ?? null,
        record.restorationId ?? null, record.decision ?? null]);
}

function signReview(record) {
    return hmac(["review", record.orderId, record.type ?? null, record.reviewId ?? null, record.outcome ?? null,
        record.authorizationRef, record.source, record.actorId ?? null, record.reasonCode ?? null]);
}

// Synthetic server session: binds an actor id to a role. A client cannot mint one without the server key.
function session(actorId, role) {
    return hmac(["session", actorId, role]);
}

function signReplan(record) {
    return hmac(["replan", record.kind, record.orderId, record.proposedDeadline, record.replanId ?? null,
        record.decision ?? null, record.authorizationRef ?? null, record.confirmationRef ?? null, record.source,
        record.actorId ?? null]);
}

function signatureMatches(signature, expected) {
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

function setup(overrides = {}) {
    let now = FIXED_TIME;
    const core = createCore({
        authorize: (principal) => principal.auth === SERVER && (principal.actorId === undefined ||
            signatureMatches(principal.session, session(principal.actorId, principal.role))),
        verifyPayment: (proof) => signatureMatches(proof.signature, sign(proof)),
        verifyEmail: (proof) => proof.code === "SYNTHETIC-ONE-USE-CODE",
        verifyBooking: (record) => signatureMatches(record.signature, signBooking(record)),
        verifyRestoration: (record) => signatureMatches(record.signature, signRestoration(record)),
        verifyReview: (record) => signatureMatches(record.signature, signReview(record)),
        verifyReplan: (record) => signatureMatches(record.signature, signReplan(record)),
        calendar: CALENDAR,
        clock: () => now,
        ...overrides
    });
    let counter = 0;
    function actor(role, order, auth = SERVER, actorId = undefined) {
        return actorId === undefined ? { role, orderId: order.id, auth }
            : { role, orderId: order.id, auth, actorId, session: session(actorId, role) };
    }
    async function send(order, kind, role, data = {}, options = {}) {
        const requestId = options.requestId || `synthetic-request-${++counter}`;
        const command = { kind, requestId, expectedVersion: options.version ?? order.version, data };
        const principal = actor(role, order, options.auth ?? SERVER, options.actorId);
        if (Object.hasOwn(options, "session")) principal.session = options.session;
        return core.dispatch(order, command, principal);
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
    // Görev 141: restoration people; the role follows the console source of the record.
    const producerSide = (source, step) => `synthetic-${source === "admin_console" ? "admin" : "creative"}-${step}`;
    function restoration(order, revisionId, extra = {}) {
        const source = extra.source ?? "producer_console";
        const record = {
            kind: "RESTORATION_PROPOSAL", orderId: order.id, revisionId, reasonCode: "PRODUCER_NON_DELIVERY",
            authorizationRef: `synthetic-authorization-${++counter}`, source, actorId: producerSide(source, "proposer"),
            evidenceRef: `synthetic-evidence-${counter}`, ...extra
        };
        return { ...record, signature: signRestoration(record) };
    }
    function restorationDecision(order, decision, pending = order.restorations.at(-1), extra = {}) {
        const source = extra.source ?? "producer_console";
        const record = {
            kind: "RESTORATION_DECISION", orderId: order.id, restorationId: pending.restorationId,
            revisionId: pending.revisionId, evidenceRef: pending.proposal.evidenceRef, decision,
            ...(decision === "REJECT" ? { reasonCode: "SYNTHETIC_EVIDENCE_INSUFFICIENT" } : {}),
            authorizationRef: `synthetic-restoration-decision-${++counter}`, source,
            actorId: producerSide(source, "approver"), ...extra
        };
        return { ...record, signature: signRestoration(record) };
    }
    function proposeRestoration(order, revisionId, record = restoration(order, revisionId), role = "creative",
        options = {}) {
        return send(order, "propose_revision_restoration", role, { revisionId, restoration: record },
            { actorId: record?.actorId, ...options });
    }
    function decideRestoration(order, decision, record = restorationDecision(order, decision), role = "creative",
        options = {}) {
        return send(order, "decide_revision_restoration", role, { restorationId: record?.restorationId, decision: record },
            { actorId: record?.actorId, ...options });
    }
    /** The full approved restoration: proposal by one person, approval by a second person of the same role.
     * The approval is derived from the proposal so that a retried pair is idempotent end to end. */
    async function restore(order, revisionId, record = restoration(order, revisionId), role = "creative", options = {}) {
        const proposed = await proposeRestoration(order, revisionId, record, role, options);
        const pending = proposed.restorations.findLast(item => item.revisionId === revisionId);
        const source = role === "admin" ? "admin_console" : "producer_console";
        const approval = { kind: "RESTORATION_DECISION", orderId: proposed.id, restorationId: pending.restorationId,
            revisionId, evidenceRef: pending.proposal.evidenceRef, decision: "APPROVE",
            authorizationRef: `${record.authorizationRef}-approval`, source, actorId: producerSide(source, "approver") };
        return decideRestoration(proposed, "APPROVE", { ...approval, signature: signRestoration(approval) }, role, {
            ...options, requestId: options.requestId ? `${options.requestId}-approve` : undefined,
            version: options.version === undefined ? undefined : options.version + 1
        });
    }
    // Görev 135: by default one synthetic person opens and a different person of the same team decides.
    const staff = (source, step) => `synthetic-${source === "admin_console" ? "admin" : "finance"}-${step}`;
    function reviewRecord(order, type, extra = {}) {
        const source = extra.source ?? "finance_console";
        const record = {
            orderId: order.id, type, authorizationRef: `synthetic-review-${++counter}`, source,
            actorId: staff(source, "opener"), ...extra
        };
        return { ...record, signature: signReview(record) };
    }
    function resolution(order, reviewId, outcome, extra = {}) {
        const source = extra.source ?? "finance_console";
        const record = {
            orderId: order.id, reviewId, outcome, authorizationRef: `synthetic-decision-${++counter}`,
            source, actorId: staff(source, "decider"), ...extra
        };
        return { ...record, signature: signReview(record) };
    }
    // The principal's actor id defaults to the one named in the record; tests override it to forge mismatches.
    function openReview(order, type, record = reviewRecord(order, type), role = "finance", options = {}) {
        return send(order, "open_review", role, { review: record }, { actorId: record?.actorId, ...options });
    }
    function resolveReview(order, outcome, record = resolution(order, order.reviews.at(-1).reviewId, outcome),
        role = "finance", options = {}) {
        return send(order, "resolve_review", role, { resolution: record }, { actorId: record?.actorId, ...options });
    }
    function proposal(order, proposedDeadline, extra = {}) {
        const source = extra.source ?? "producer_console";
        const record = {
            kind: "DELIVERY_PROPOSAL", orderId: order.id, proposedDeadline,
            authorizationRef: `synthetic-proposal-${++counter}`, source, actorId: producerSide(source, "planner"),
            ...extra
        };
        return { ...record, signature: signReplan(record) };
    }
    function confirmation(order, decision, replan = order.deliveryReplans.at(-1), extra = {}) {
        const record = {
            kind: "DELIVERY_CONFIRMATION", orderId: order.id, replanId: replan.replanId,
            proposedDeadline: replan.proposedDeadline, decision, confirmationRef: `synthetic-confirmation-${++counter}`,
            source: "customer_confirmation_service", ...extra
        };
        return { ...record, signature: signReplan(record) };
    }
    function propose(order, proposedDeadline, record = proposal(order, proposedDeadline), role = "creative", options = {}) {
        return send(order, "propose_delivery_date", role, { proposal: record }, { actorId: record?.actorId, ...options });
    }
    function confirm(order, decision, record = confirmation(order, decision), role = "customer", options = {}) {
        return send(order, "confirm_delivery_date", role, { confirmation: record }, options);
    }
    const setNow = value => { now = value; };
    return {
        core, actor, send, payment, booking, restoration, restorationDecision, proposeRestoration, decideRestoration,
        restore, reviewRecord, resolution, openReview, resolveReview, proposal, confirmation, propose, confirm, setNow
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
    // Görev 140 added only the read-only viewProposal; still nothing that sends or notifies.
    assert.deepEqual(Object.keys(h.core), ["createOrder", "dispatch", "viewProposal"]);
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
        // Görev 141: proposal and approval are two atomic transitions; only the approval restores the right.
        assert.equal(restored.version, accepted.version + 2);
        const [proposalEvent, approvalEvent] = restored.events.slice(-2);
        const proposal = {
            orderId: accepted.id, restorationId: "restoration-0001", revisionId: "revision-0001", step: "PROPOSAL",
            reasonCode: "PRODUCER_NON_DELIVERY", evidenceRef: record.evidenceRef, actorId: record.actorId,
            actorType: "HUMAN", role, authorizationRef: record.authorizationRef, at: FIXED_TIME,
            idempotencyKey: `synthetic-restore-${role}`
        };
        const approval = {
            orderId: accepted.id, restorationId: "restoration-0001", revisionId: "revision-0001", step: "DECISION",
            decision: "APPROVE", reasonCode: null, evidenceRef: record.evidenceRef, actorId: `synthetic-${role}-approver`,
            actorType: "HUMAN", role, authorizationRef: `${record.authorizationRef}-approval`, at: FIXED_TIME,
            idempotencyKey: `synthetic-restore-${role}-approve`
        };
        assert.deepEqual([proposalEvent.audit, approvalEvent.audit], [proposal, approval]);
        assert.deepEqual([proposalEvent.kind, proposalEvent.from, proposalEvent.to],
            ["propose_revision_restoration", STATES.REVISION_PENDING, STATES.REVISION_PENDING]);
        assert.deepEqual([approvalEvent.kind, approvalEvent.role, approvalEvent.from, approvalEvent.to],
            ["decide_revision_restoration", role, STATES.REVISION_PENDING, STATES.IN_PRODUCTION]);
        assert.deepEqual(restored.revisions[0],
            { ...accepted.revisions[0], status: "RESTORED", restoration: { proposal, approval } });
        assert.deepEqual(restored.restorations, [{ restorationId: "restoration-0001", revisionId: "revision-0001",
            status: "APPROVED", proposal, decision: approval }]);
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
    // Görev 141: exactly the proposal and the approval were recorded, nothing from the failed attempts.
    assert.equal(restored.version, accepted.version + 2);
    assert.equal(restored.events.filter(event => event.audit).length, 2);
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

// ---- Görev 134 / Decision 134-A: delivery replanning after a review ----

const AFTER_DEADLINE = "2026-11-02T07:00:00.000Z"; // Monday 10:00 Istanbul, after the Friday 15:00 deadline
const NEW_DEADLINE = "2026-11-04T12:00:00.000Z"; // Wednesday 15:00 Istanbul

/** A revision is pending, a dispute review ran past the deadline and was resolved with CONTINUE. */
async function overdueAfterReview(h = setup()) {
    const p = await pendingRevision("PLUS", h);
    const reviewed = await p.openReview(p.order, "DISPUTE");
    p.setNow(AFTER_DEADLINE);
    const order = await p.resolveReview(reviewed, "CONTINUE");
    assert.equal(order.state, STATES.REVISION_PENDING);
    return { ...p, before: p.order, order };
}

test("DR/1,2,13: CONTINUE creates no new date; booked deadline, SLA start and delay history are kept", async () => {
    const h = await overdueAfterReview();
    assert.equal(h.order.booking.deadline, DEADLINE);
    assert.equal(h.order.slaStartsAt, PLANNED_START);
    assert.equal(h.order.replannedDeadline, null);
    assert.deepEqual(h.order.deliveryReplans, []);
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const confirmed = await h.confirm(proposed, "ACCEPT");
    assert.equal(confirmed.replannedDeadline, NEW_DEADLINE);
    assert.equal(confirmed.booking.deadline, DEADLINE);
    assert.deepEqual(confirmed.booking, h.before.booking);
    assert.equal(confirmed.slaStartsAt, PLANNED_START);
    const [replan] = confirmed.deliveryReplans;
    assert.equal(replan.missedDeadline, DEADLINE);
    assert.equal(replan.bookedDeadline, DEADLINE);
    assert.equal(replan.proposal.at, AFTER_DEADLINE);
    assert.deepEqual(confirmed.events.slice(0, h.order.events.length), h.order.events);
    assert.ok(Object.isFrozen(replan));
});

test("DR/3,4: only a verified producer or admin proposal is accepted, and only after a missed deadline", async () => {
    const h = await overdueAfterReview();
    for (const role of ["customer", "finance", "scheduler"]) {
        await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(h.order, NEW_DEADLINE), role), /UNAUTHORIZED/);
    }
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(h.order, NEW_DEADLINE), "creative",
        { auth: Symbol("browser") }), /UNAUTHORIZED/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, { ...h.proposal(h.order, NEW_DEADLINE), signature: undefined }),
        /UNTRUSTED_PROPOSAL/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE,
        { ...h.proposal(h.order, NEW_DEADLINE), proposedDeadline: "2026-11-05T12:00:00.000Z" }), /UNTRUSTED_PROPOSAL/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(h.order, NEW_DEADLINE, { source: "admin_console" })),
        /INVALID_PROPOSAL/);
    const other = await overdueAfterReview();
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(other.order, NEW_DEADLINE)), /INVALID_PROPOSAL/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(h.order, NEW_DEADLINE, { kind: "DELIVERY_CONFIRMATION" })),
        /INVALID_PROPOSAL/);
    const unverified = await overdueAfterReview(setup({ verifyReplan: undefined }));
    await assert.rejects(unverified.propose(unverified.order, NEW_DEADLINE), /UNTRUSTED_PROPOSAL/);
    assert.equal(h.order.deliveryReplans.length, 0);
    // Producer and admin console proposals are accepted.
    const byProducer = await h.propose(h.order, NEW_DEADLINE);
    assert.equal(byProducer.deliveryReplans[0].proposedBy, "creative");
    const byAdmin = await other.propose(other.order, NEW_DEADLINE,
        other.proposal(other.order, NEW_DEADLINE, { source: "admin_console" }), "admin");
    assert.equal(byAdmin.deliveryReplans[0].proposedBy, "admin");
    // One open proposal at a time; an authorization reference is used once.
    await assert.rejects(h.propose(byProducer, "2026-11-05T12:00:00.000Z"), /REPLAN_PENDING/);
    // No proposal while the commitment is still running, nor for an order that was never reviewed.
    const running = await pendingRevision();
    const resumed = await running.resolveReview(await running.openReview(running.order, "REFUND"), "CONTINUE");
    await assert.rejects(running.propose(resumed, NEW_DEADLINE), /DEADLINE_NOT_MISSED/);
    const unreviewed = await pendingRevision();
    unreviewed.setNow(AFTER_DEADLINE);
    await assert.rejects(unreviewed.propose(unreviewed.order, NEW_DEADLINE), /REPLAN_NOT_ALLOWED/);
});

test("DR/5,6: a proposal becomes the deadline only with a verified customer confirmation", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    assert.equal(proposed.replannedDeadline, null);
    assert.equal(proposed.deliveryReplans[0].status, "PROPOSED");
    await assert.rejects(h.send(proposed, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] }),
        /DELIVERY_REPLAN_REQUIRED/);
    const confirmed = await h.confirm(proposed, "ACCEPT");
    assert.equal(confirmed.replannedDeadline, NEW_DEADLINE);
    assert.equal(confirmed.deliveryReplans[0].status, "CONFIRMED");
    assert.equal(confirmed.deliveryReplans[0].confirmation.decision, "ACCEPT");
    assert.equal(confirmed.events.at(-1).audit.replanId, "replan-0001");
    // Time-bound work resumes against the confirmed date.
    let order = await h.send(confirmed, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] });
    order = await h.send(order, "request_revision", "customer");
    assert.equal(order.revisionsUsed, 2);
    assert.equal(order.replannedDeadline, NEW_DEADLINE);
    assert.equal(order.booking.deadline, DEADLINE);
});

test("DR/7,8: forged, free-form, foreign or non-customer confirmations are rejected", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const other = await overdueAfterReview();
    const otherProposed = await other.propose(other.order, NEW_DEADLINE);
    await assert.rejects(h.confirm(proposed, "ACCEPT", { ...h.confirmation(proposed, "ACCEPT"), signature: undefined }),
        /UNTRUSTED_CONFIRMATION/);
    await assert.rejects(h.confirm(proposed, "ACCEPT", { ...h.confirmation(proposed, "REJECT"), decision: "ACCEPT" }),
        /UNTRUSTED_CONFIRMATION/);
    // A free-form customer claim without the confirmation service's record shape is not a confirmation.
    await assert.rejects(h.confirm(proposed, "ACCEPT", { accepted: true, orderId: proposed.id }), /INVALID_CONFIRMATION/);
    await assert.rejects(h.confirm(proposed, "ACCEPT", h.confirmation(proposed, "ACCEPT", undefined, { source: "browser" })),
        /INVALID_CONFIRMATION/);
    await assert.rejects(h.confirm(proposed, "MAYBE", h.confirmation(proposed, "MAYBE")), /INVALID_CONFIRMATION/);
    await assert.rejects(h.confirm(proposed, "ACCEPT",
        h.confirmation(proposed, "ACCEPT", undefined, { proposedDeadline: "2026-11-05T12:00:00.000Z" })),
    /INVALID_CONFIRMATION/);
    await assert.rejects(h.confirm(proposed, "ACCEPT",
        h.confirmation(proposed, "ACCEPT", undefined, { replanId: "replan-0002" })), /INVALID_CONFIRMATION/);
    // Another order's genuine confirmation cannot be replayed here.
    await assert.rejects(h.confirm(proposed, "ACCEPT", other.confirmation(otherProposed, "ACCEPT")), /INVALID_CONFIRMATION/);
    // Another order's customer, staff roles and browser sessions cannot confirm.
    const foreignCustomer = { role: "customer", orderId: otherProposed.id, auth: SERVER };
    await assert.rejects(h.core.dispatch(proposed, { kind: "confirm_delivery_date", requestId: "synthetic-foreign-01",
        expectedVersion: proposed.version, data: { confirmation: h.confirmation(proposed, "ACCEPT") } }, foreignCustomer),
    /UNAUTHORIZED/);
    for (const role of ["creative", "admin", "finance"]) {
        await assert.rejects(h.confirm(proposed, "ACCEPT", h.confirmation(proposed, "ACCEPT"), role), /UNAUTHORIZED/);
    }
    await assert.rejects(h.confirm(proposed, "ACCEPT", h.confirmation(proposed, "ACCEPT"), "customer",
        { auth: Symbol("browser") }), /UNAUTHORIZED/);
    // A server verifier that does not vouch for confirmations rejects even a well-formed, signed one.
    const proposalsOnly = await overdueAfterReview(setup({
        verifyReplan: (record) => record.kind === "DELIVERY_PROPOSAL" && signatureMatches(record.signature, signReplan(record))
    }));
    const pending = await proposalsOnly.propose(proposalsOnly.order, NEW_DEADLINE);
    await assert.rejects(proposalsOnly.confirm(pending, "ACCEPT"), /UNTRUSTED_CONFIRMATION/);
    assert.equal(proposed.replannedDeadline, null);
    // Failed attempts registered nothing; the genuine confirmation still applies once.
    assert.equal((await h.confirm(proposed, "ACCEPT")).replannedDeadline, NEW_DEADLINE);
});

test("DR/9: a repeated confirmation never creates a second transition", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const record = h.confirmation(proposed, "ACCEPT");
    const first = await h.confirm(proposed, "ACCEPT", record, "customer", { requestId: "synthetic-confirm-once" });
    const replay = await h.confirm(proposed, "ACCEPT", record, "customer", { requestId: "synthetic-confirm-once" });
    assert.equal(replay, first);
    await assert.rejects(h.confirm(first, "ACCEPT", record), /REPLAN_NOT_PENDING/);
    // A later proposal cannot be confirmed with the old, already used confirmation.
    h.setNow("2026-11-05T07:00:00.000Z"); // Thursday 10:00, after the confirmed Wednesday date
    const again = await h.propose(first, "2026-11-06T12:00:00.000Z");
    await assert.rejects(h.confirm(again, "ACCEPT", record), /INVALID_CONFIRMATION/);
    const reused = h.confirmation(again, "ACCEPT", undefined, { confirmationRef: record.confirmationRef });
    await assert.rejects(h.confirm(again, "ACCEPT", reused), /REPLAN_REFERENCE_USED/);
    assert.equal(again.events.length, first.events.length + 1);
    assert.equal(again.deliveryReplans[1].missedDeadline, NEW_DEADLINE);
});

test("DR/10: a rejected proposal leaves every commitment unchanged", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const rejected = await h.confirm(proposed, "REJECT");
    assert.equal(rejected.deliveryReplans[0].status, "REJECTED");
    assert.equal(rejected.replannedDeadline, null);
    assert.deepEqual(rejected.booking, h.order.booking);
    assert.equal(rejected.slaStartsAt, PLANNED_START);
    await assert.rejects(h.send(rejected, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] }),
        /DELIVERY_REPLAN_REQUIRED/);
    const next = await h.propose(rejected, "2026-11-05T12:00:00.000Z");
    assert.equal(next.deliveryReplans.length, 2);
});

test("DR/11: a date outside the tariff's hours or the approved calendar is never proposed or confirmed", async () => {
    const h = await overdueAfterReview();
    for (const date of ["2026-11-07T12:00:00.000Z", "2026-11-04T06:00:00.000Z", "2026-11-04T17:00:00.000Z"]) {
        await assert.rejects(h.propose(h.order, date), /DEADLINE_NOT_ELIGIBLE/); // Sat 15:00, Wed 09:00, Wed 20:00
    }
    await assert.rejects(h.propose(h.order, "2027-01-05T12:00:00.000Z"), /CALENDAR_MISSING/);
    await assert.rejects(h.propose(h.order, "not-a-date"), /INVALID_PROPOSAL/);
    assert.equal((await h.propose(h.order, "2026-11-04T15:00:00.000Z")).deliveryReplans[0].proposedDeadline,
        "2026-11-04T15:00:00.000Z"); // Wednesday 18:00 close of the standard window
    const holidayLoaded = loadCalendar({
        timeZone: "Europe/Istanbul", version: "synthetic-core-2026.3",
        source: { kind: "SYNTHETIC", reference: "task-134-holiday-fixture" },
        coverage: { from: "2026-01-01", to: "2026-12-31" },
        annualApprovals: [{ year: 2026, approvedBy: "synthetic-producer", approverRole: "PRODUCER",
            approvedAt: "2026-01-02T09:00:00Z", reference: "task-134-synthetic-approval" }],
        days: [{ date: "2026-11-04", kind: "HOLIDAY" }]
    }, { allowSynthetic: true });
    const onHoliday = await overdueAfterReview(setup({ calendar: holidayLoaded }));
    await assert.rejects(onHoliday.propose(onHoliday.order, NEW_DEADLINE), /DEADLINE_NOT_ELIGIBLE/);
});

test("DR/12: a past date is rejected when proposed and when confirmed", async () => {
    const h = await overdueAfterReview();
    for (const date of ["2026-10-30T12:00:00.000Z", AFTER_DEADLINE]) {
        await assert.rejects(h.propose(h.order, date), /DEADLINE_IN_PAST/);
    }
    // Görev 135: a date inside the 48-hour answer window, so the date passes before the proposal expires.
    const proposed = await h.propose(h.order, "2026-11-03T12:00:00.000Z"); // Tuesday 15:00 Istanbul
    h.setNow("2026-11-03T12:00:00.000Z"); // the proposed date itself has arrived, 29 hours after the proposal
    await assert.rejects(h.confirm(proposed, "ACCEPT"), /DEADLINE_IN_PAST/);
    assert.equal(proposed.replannedDeadline, null);
    assert.equal((await h.confirm(proposed, "REJECT")).deliveryReplans[0].status, "REJECTED");
});

test("DR/14: after a review, time-bound work is blocked until a new date is confirmed", async () => {
    const pending = await overdueAfterReview();
    await assert.rejects(pending.send(pending.order, "revision_options", "creative",
        { options: ["synthetic-b1", "synthetic-b2"] }), /DELIVERY_REPLAN_REQUIRED/);
    // A producer non-delivery restoration is not time-bound and stays available.
    assert.equal((await pending.restore(pending.order, "revision-0001")).revisionsUsed, 0);
    const production = await producing();
    const reviewed = await production.openReview(production.order, "REFUND");
    production.setNow(AFTER_DEADLINE);
    const resumed = await production.resolveReview(reviewed, "CONTINUE");
    await assert.rejects(production.send(resumed, "request_revision", "customer"), /DELIVERY_REPLAN_REQUIRED/);
    const selected = await production.send(resumed, "select_final", "customer", { selectedOption: "synthetic-a1" });
    await assert.rejects(production.send(selected, "complete", "creative", { mp3Ref: "synthetic-mp3", wavFeasible: false }),
        /DELIVERY_REPLAN_REQUIRED/);
    const started = await ready();
    const inProduction = await started.send(started.order, "start_production", "creative");
    const paused = await started.openReview(inProduction, "CANCELLATION");
    started.setNow(AFTER_DEADLINE);
    const back = await started.resolveReview(paused, "CONTINUE");
    await assert.rejects(started.send(back, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] }),
        /DELIVERY_REPLAN_REQUIRED/);
    // Orders that never went through a review keep the existing behaviour after the deadline.
    const plain = await producing();
    plain.setNow(AFTER_DEADLINE);
    await assert.rejects(plain.send(plain.order, "request_revision", "customer"), /NEW_ORDER_REVIEW_REQUIRED/);
});

// ---- Görev 134 / Decision 134-B: pending revisions on a closed order ----

test("PF/15,16,17,18: closing keeps pending revisions and rights, flags them for review and moves no money", async () => {
    let paymentChecks = 0;
    const h = await pendingRevision("PLUS", setup({
        verifyPayment: (proof) => { paymentChecks += 1; return signatureMatches(proof.signature, sign(proof)); }
    }));
    const checksBefore = paymentChecks;
    const closed = await h.resolveReview(await h.openReview(h.order, "REFUND"), "CLOSE");
    assert.equal(paymentChecks, checksBefore);
    assert.equal(closed.state, STATES.CLOSED);
    assert.deepEqual(closed.revisions, h.order.revisions);
    assert.equal(closed.revisions[0].status, "ACCEPTED");
    assert.equal(closed.revisions[0].deliveredAt, null);
    assert.equal(closed.revisionsUsed, 1);
    assert.equal(closed.paymentReference, h.order.paymentReference);
    assert.deepEqual(closed.financialAssessments, [{
        assessmentId: "assessment-0001", orderId: closed.id, reviewId: "review-0001", revisionId: "revision-0001",
        reason: "ACCEPTED_NOT_DELIVERED", status: "PENDING_FINANCIAL_REVIEW", amountKurus: null,
        moneyMovement: "NONE", createdAt: FIXED_TIME
    }]);
    assert.ok(Object.isFrozen(closed.financialAssessments[0]));
    // CONTINUE and a close without pending revisions create no assessment.
    const resumed = await pendingRevision();
    assert.deepEqual((await resumed.resolveReview(await resumed.openReview(resumed.order, "DISPUTE"), "CONTINUE"))
        .financialAssessments, []);
    const empty = await producing();
    assert.deepEqual((await empty.resolveReview(await empty.openReview(empty.order, "DISPUTE"), "REFUND"))
        .financialAssessments, []);
});

test("PF/19,20: restored or delivered revisions are not flagged; a closed order takes no restoration or revision", async () => {
    const h = await pendingRevision("PLUS");
    let order = await h.restore(h.order, "revision-0001"); // revision-0001 RESTORED, rights back to 0
    order = await h.send(order, "request_revision", "customer"); // revision-0002
    order = await h.send(order, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] });
    order = await h.send(order, "request_revision", "customer"); // revision-0003 stays pending
    const closed = await h.resolveReview(await h.openReview(order, "CANCELLATION"), "CLOSE");
    assert.deepEqual(closed.revisions.map(revision => revision.status), ["RESTORED", "DELIVERED", "ACCEPTED"]);
    assert.deepEqual(closed.financialAssessments.map(item => item.revisionId), ["revision-0003"]);
    assert.equal(closed.revisionsUsed, 2);
    await assert.rejects(h.restore(closed, "revision-0001"), /INVALID_TRANSITION/);
    await assert.rejects(h.restore(closed, "revision-0003"), /INVALID_TRANSITION/);
    await assert.rejects(h.send(closed, "request_revision", "customer"), /INVALID_TRANSITION/);
    await assert.rejects(h.propose(closed, NEW_DEADLINE), /INVALID_TRANSITION/);
    assert.equal(closed.revisionsUsed, 2);
});

// ---- Görev 135: approved review policy UNAI-REVIEW-POLICY-v1.0 ----

const POLICY_REFERENCE = "UNAI-REVIEW-POLICY-v1.0";
const ADMIN = { source: "admin_console" };

test("AP/1,2: finance and admin can each open all three review types; actor and policy are recorded", async () => {
    for (const [type, state] of REVIEW_TYPES) {
        for (const [role, extra] of [["finance", {}], ["admin", ADMIN]]) {
            const h = await pendingRevision();
            const order = await h.openReview(h.order, type, h.reviewRecord(h.order, type, extra), role);
            assert.equal(order.state, state);
            const opening = order.reviews[0].opening;
            assert.equal(opening.actorId, `synthetic-${role}-opener`);
            assert.equal(opening.role, role);
            assert.equal(opening.policyReference, POLICY_REFERENCE);
            assert.equal(opening.at, FIXED_TIME);
            assert.match(opening.authorizationRef, /^synthetic-review-/);
            assert.deepEqual(order.events.at(-1).audit, opening);
        }
    }
});

test("AP/3,4,5,6,17: finance decides every outcome; admin CONTINUE or CLOSE but never REFUND", async () => {
    let accepted = 0;
    for (const [type] of REVIEW_TYPES) {
        for (const outcome of ["CONTINUE", "REFUND", "CLOSE"]) {
            const h = await pendingRevision();
            const open = await h.openReview(h.order, type);
            const done = await h.resolveReview(open, outcome);
            const resolution = done.reviews[0].resolution;
            assert.deepEqual([resolution.outcome, resolution.role, resolution.actorId, resolution.policyReference],
                [outcome, "finance", "synthetic-finance-decider", POLICY_REFERENCE]);
            accepted += 1;
        }
        for (const outcome of ["CONTINUE", "CLOSE"]) {
            const h = await pendingRevision();
            const open = await h.openReview(h.order, type);
            const record = h.resolution(open, open.reviews[0].reviewId, outcome,
                { ...ADMIN, reasonCode: "SYNTHETIC_CASE_RESOLVED" });
            const done = await h.resolveReview(open, outcome, record, "admin");
            assert.deepEqual([done.reviews[0].resolution.role, done.reviews[0].resolution.policyReference],
                ["admin", POLICY_REFERENCE]);
            accepted += 1;
        }
        const h = await pendingRevision();
        const open = await h.openReview(h.order, type);
        await assert.rejects(h.resolveReview(open, "REFUND", h.resolution(open, open.reviews[0].reviewId, "REFUND",
            { ...ADMIN, reasonCode: "SYNTHETIC_CASE_RESOLVED" }), "admin"), /REVIEW_OUTCOME_NOT_PERMITTED/);
        assert.equal(open.state, REVIEW_TYPES.find(([t]) => t === type)[1]);
    }
    assert.equal(accepted, 15);
});

test("AP/7,18: only the approved 15-combination policy applies; no injected policy can widen it", async () => {
    assert.deepEqual(APPROVED_REVIEW_POLICY, {
        status: "APPROVED", reference: POLICY_REFERENCE, matrix: Object.fromEntries(REVIEW_TYPES.map(([type]) =>
            [type, { finance: ["CONTINUE", "REFUND", "CLOSE"], admin: ["CONTINUE", "CLOSE"] }]))
    });
    assert.ok(Object.isFrozen(APPROVED_REVIEW_POLICY.matrix.REFUND.admin));
    const combinations = Object.values(APPROVED_REVIEW_POLICY.matrix)
        .flatMap(roles => Object.values(roles)).reduce((sum, outcomes) => sum + outcomes.length, 0);
    assert.equal(combinations, 15);
    assert.equal("INTERIM_REVIEW_POLICY" in await import("./core.mjs"), false);
    const valid = { status: "APPROVED", reference: "synthetic-narrowed-policy" };
    for (const policy of [
        { ...valid, matrix: { REFUND: { admin: ["REFUND"] } } }, // the old interim grant
        { ...valid, matrix: { REFUND_ALL: { finance: ["CLOSE"] } } }, { ...valid, matrix: { REFUND: { customer: ["CLOSE"] } } },
        { ...valid, matrix: { REFUND: { creative: ["CONTINUE"] } } }, { ...valid, matrix: { REFUND: { finance: ["RESET_RIGHTS"] } } },
        { ...valid, matrix: { REFUND: { finance: ["CLOSE", "CLOSE"] } } }, { ...valid, matrix: { REFUND: { finance: "CLOSE" } } },
        { ...valid, matrix: JSON.parse('{"__proto__": {"finance": ["CLOSE"]}}') },
        { status: "INTERIM_UNAPPROVED", reference: "task-130-behaviour", matrix: {} },
        { status: "APPROVED", matrix: {} }, { ...valid }, null]) {
        assert.throws(() => setup({ reviewPolicy: policy }), /INVALID_REVIEW_POLICY/);
    }
    // A narrower approved policy is enforced as given and copied at creation.
    const narrowed = { ...valid, matrix: { REFUND: { finance: ["CONTINUE", "REFUND"] }, DISPUTE: { admin: ["CONTINUE"] } } };
    const h = await pendingRevision("PLUS", setup({ reviewPolicy: narrowed }));
    narrowed.matrix.REFUND.finance.push("CLOSE");
    narrowed.matrix.CANCELLATION = { finance: ["CLOSE"] };
    await assert.rejects(h.openReview(h.order, "CANCELLATION"), /REVIEW_NOT_PERMITTED/);
    await assert.rejects(h.openReview(h.order, "DISPUTE"), /REVIEW_NOT_PERMITTED/);
    const reviewed = await h.openReview(h.order, "REFUND");
    const close = h.resolution(reviewed, reviewed.reviews[0].reviewId, "CLOSE");
    await assert.rejects(h.resolveReview(reviewed, "CLOSE", close), /REVIEW_OUTCOME_NOT_PERMITTED/);
    const refund = await h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, reviewed.reviews[0].reviewId,
        "REFUND", { authorizationRef: close.authorizationRef }));
    assert.equal(refund.reviews[0].resolution.policyReference, "synthetic-narrowed-policy");
});

// ---- Görev 135: four eyes and trusted actor identity ----

test("FE/8: the actor who opened a review can never decide it, whatever role they use", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "REFUND");
    const id = reviewed.reviews[0].reviewId;
    const opener = "synthetic-finance-opener";
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE", { actorId: opener })),
        /FOUR_EYES_VIOLATION/);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE", h.resolution(reviewed, id, "CLOSE",
        { ...ADMIN, actorId: opener, reasonCode: "SYNTHETIC_CASE_RESOLVED" }), "admin"), /FOUR_EYES_VIOLATION/);
    const admin = await pendingRevision();
    const byAdmin = await admin.openReview(admin.order, "DISPUTE", admin.reviewRecord(admin.order, "DISPUTE", ADMIN), "admin");
    await assert.rejects(admin.resolveReview(byAdmin, "CONTINUE", admin.resolution(byAdmin, byAdmin.reviews[0].reviewId,
        "CONTINUE", { ...ADMIN, actorId: "synthetic-admin-opener" }), "admin"), /FOUR_EYES_VIOLATION/);
    // A rejected decision changed nothing and registered nothing.
    const blocked = h.resolution(reviewed, id, "CONTINUE", { actorId: opener });
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", blocked), /FOUR_EYES_VIOLATION/);
    const resumed = await h.resolveReview(reviewed, "CONTINUE",
        h.resolution(reviewed, id, "CONTINUE", { authorizationRef: blocked.authorizationRef }));
    assert.equal(resumed.version, reviewed.version + 1);
    assert.equal(resumed.events.length, reviewed.events.length + 1);
    assert.equal(resumed.revisionsUsed, reviewed.revisionsUsed);
});

test("FE/9,10: a different actor with the same role decides; their own role is authorized separately", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "CANCELLATION");
    const id = reviewed.reviews[0].reviewId;
    const colleague = h.resolution(reviewed, id, "CONTINUE", { actorId: "synthetic-finance-colleague" });
    // The colleague's session must be for the role they act in: a finance session cannot act as admin.
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE",
        { ...ADMIN, actorId: "synthetic-finance-colleague" }), "admin",
    { session: session("synthetic-finance-colleague", "finance") }), /UNAUTHORIZED/);
    for (const role of ["creative", "customer", "scheduler"]) {
        await assert.rejects(h.resolveReview(reviewed, "CONTINUE", colleague, role), /UNAUTHORIZED/);
    }
    const done = await h.resolveReview(reviewed, "CONTINUE", colleague);
    assert.equal(done.reviews[0].opening.role, done.reviews[0].resolution.role);
    assert.notEqual(done.reviews[0].opening.actorId, done.reviews[0].resolution.actorId);
});

test("FE/11,12: forged, mismatched or missing actor identities are rejected", async () => {
    const h = await pendingRevision();
    const record = h.reviewRecord(h.order, "DISPUTE");
    // A client-made session for any actor id fails the server's authentication.
    await assert.rejects(h.openReview(h.order, "DISPUTE", record, "finance", { session: "0".repeat(64) }), /UNAUTHORIZED/);
    await assert.rejects(h.openReview(h.order, "DISPUTE", record, "finance", { session: undefined }), /UNAUTHORIZED/);
    // A genuine session of another actor cannot use a record issued to this actor.
    await assert.rejects(h.openReview(h.order, "DISPUTE", record, "finance", { actorId: "synthetic-finance-other" }),
        /INVALID_REVIEW/);
    await assert.rejects(h.openReview(h.order, "DISPUTE", { ...record, actorId: "synthetic-finance-other" }),
        /UNTRUSTED_REVIEW/);
    // Missing or malformed actor ids fail closed.
    await assert.rejects(h.openReview(h.order, "DISPUTE", record, "finance", { actorId: undefined }), /ACTOR_REQUIRED/);
    await assert.rejects(h.openReview(h.order, "DISPUTE", h.reviewRecord(h.order, "DISPUTE", { actorId: undefined })),
        /ACTOR_REQUIRED/);
    await assert.rejects(h.openReview(h.order, "DISPUTE", h.reviewRecord(h.order, "DISPUTE", { actorId: "free text" })),
        /ACTOR_REQUIRED/);
    const reviewed = await h.openReview(h.order, "DISPUTE", record);
    const id = reviewed.reviews[0].reviewId;
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "finance",
        { actorId: undefined }), /ACTOR_REQUIRED/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "finance",
        { session: "f".repeat(64) }), /UNAUTHORIZED/);
    await assert.rejects(h.resolveReview(reviewed, "CONTINUE", h.resolution(reviewed, id, "CONTINUE"), "finance",
        { actorId: "synthetic-finance-third" }), /INVALID_REVIEW/);
    assert.equal(reviewed.reviews[0].status, "OPEN");
});

test("FE/13,14: authorization references are single-use and bound to their own order", async () => {
    const shared = setup();
    const a = await pendingRevision("PLUS", shared);
    const b = await pendingRevision("PLUS", shared);
    const opening = shared.reviewRecord(a.order, "REFUND");
    const openA = await shared.openReview(a.order, "REFUND", opening);
    await assert.rejects(shared.openReview(b.order, "REFUND", opening), /INVALID_REVIEW/);
    await assert.rejects(shared.openReview(b.order, "REFUND",
        shared.reviewRecord(b.order, "REFUND", { authorizationRef: opening.authorizationRef })), /REVIEW_REFERENCE_USED/);
    const openB = await shared.openReview(b.order, "REFUND");
    const decision = shared.resolution(openA, openA.reviews[0].reviewId, "CONTINUE");
    await assert.rejects(shared.resolveReview(openB, "CONTINUE", decision), /INVALID_REVIEW/);
    await shared.resolveReview(openA, "CONTINUE", decision);
    await assert.rejects(shared.resolveReview(openB, "CONTINUE", shared.resolution(openB, openB.reviews[0].reviewId,
        "CONTINUE", { authorizationRef: decision.authorizationRef })), /REVIEW_REFERENCE_USED/);
    assert.equal(openB.state, STATES.REFUND_REVIEW);
});

test("FE/15,16: an admin CLOSE needs a verified reason code and is fully audited", async () => {
    const h = await pendingRevision();
    const reviewed = await h.openReview(h.order, "CANCELLATION");
    const id = reviewed.reviews[0].reviewId;
    await assert.rejects(h.resolveReview(reviewed, "CLOSE", h.resolution(reviewed, id, "CLOSE", ADMIN), "admin"),
        /CLOSE_REASON_REQUIRED/);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE",
        h.resolution(reviewed, id, "CLOSE", { ...ADMIN, reasonCode: "müşteri istedi" }), "admin"), /INVALID_REVIEW/);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE",
        { ...h.resolution(reviewed, id, "CLOSE", ADMIN), reasonCode: "SYNTHETIC_ADDED_LATER" }, "admin"), /UNTRUSTED_REVIEW/);
    const closed = await h.resolveReview(reviewed, "CLOSE",
        h.resolution(reviewed, id, "CLOSE", { ...ADMIN, reasonCode: "SYNTHETIC_DUPLICATE_ORDER" }), "admin");
    const resolution = closed.reviews[0].resolution;
    assert.equal(closed.state, STATES.CLOSED);
    assert.deepEqual([resolution.outcome, resolution.reasonCode, resolution.actorId, resolution.role,
        resolution.policyReference, resolution.at, resolution.moneyMovement],
    ["CLOSE", "SYNTHETIC_DUPLICATE_ORDER", "synthetic-admin-decider", "admin", POLICY_REFERENCE, FIXED_TIME, "NONE"]);
    assert.equal(closed.events.at(-1).audit.reasonCode, "SYNTHETIC_DUPLICATE_ORDER");
    assert.equal(closed.revisionsUsed, 1);
    assert.equal(closed.financialAssessments.length, 1);
    // Finance closes without a reason code, as before.
    const f = await pendingRevision();
    assert.equal((await f.resolveReview(await f.openReview(f.order, "DISPUTE"), "CLOSE")).state, STATES.CLOSED);
});

// ---- Görev 135: 48-hour answer window for delivery-date proposals ----

const PROPOSAL_EXPIRES = "2026-11-04T07:00:00.000Z"; // AFTER_DEADLINE + 48 hours

function expireProposal(h, order, role = "creative", options = {}) {
    // Görev 141: a manual expiry record names the verified person who made it.
    return h.send(order, "expire_delivery_proposal", role, {}, { actorId: `synthetic-${role}-operator`, ...options });
}

test("EX/19,20: a proposal lives exactly 48 hours; an answer just before the end is accepted", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const [replan] = proposed.deliveryReplans;
    assert.equal(replan.createdAt, AFTER_DEADLINE);
    assert.equal(replan.expiresAt, PROPOSAL_EXPIRES);
    assert.equal(Date.parse(replan.expiresAt) - Date.parse(replan.createdAt), 48 * 60 * 60 * 1000);
    assert.equal(replan.proposal.expiresAt, PROPOSAL_EXPIRES);
    h.setNow("2026-11-04T06:59:59.999Z");
    const confirmed = await h.confirm(proposed, "ACCEPT");
    assert.equal(confirmed.replannedDeadline, NEW_DEADLINE);
});

test("EX/21,22,27: at or after expiry no answer is accepted and the proposal never comes back", async () => {
    for (const now of [PROPOSAL_EXPIRES, "2026-11-04T08:00:00.000Z"]) {
        const h = await overdueAfterReview();
        const proposed = await h.propose(h.order, NEW_DEADLINE);
        h.setNow(now);
        const accept = h.confirmation(proposed, "ACCEPT");
        await assert.rejects(h.confirm(proposed, "ACCEPT", accept), /PROPOSAL_EXPIRED/);
        await assert.rejects(h.confirm(proposed, "REJECT"), /PROPOSAL_EXPIRED/);
        assert.equal(proposed.replannedDeadline, null);
        const expired = await expireProposal(h, proposed);
        assert.equal(expired.deliveryReplans[0].status, "EXPIRED");
        // The record keeps the real end of the window apart from the moment the expiry was noticed.
        assert.equal(expired.deliveryReplans[0].expiry.expiredAt, PROPOSAL_EXPIRES);
        assert.equal(expired.deliveryReplans[0].expiry.recordedAt, now);
        // Neither the old confirmation, a fresh one, nor an earlier clock can revive it.
        await assert.rejects(h.confirm(expired, "ACCEPT", accept), /REPLAN_NOT_PENDING/);
        h.setNow("2026-11-03T07:00:00.000Z");
        await assert.rejects(h.confirm(expired, "ACCEPT"), /REPLAN_NOT_PENDING/);
        await assert.rejects(expireProposal(h, expired), /REPLAN_NOT_PENDING/);
        assert.equal(expired.deliveryReplans[0].expiresAt, PROPOSAL_EXPIRES);
    }
});

test("EX/23,24,25,26: expiry is recorded and changes no SLA, deadline, delay history, right or money", async () => {
    let paymentChecks = 0;
    const h = await overdueAfterReview(setup({
        verifyPayment: (proof) => { paymentChecks += 1; return signatureMatches(proof.signature, sign(proof)); }
    }));
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const checksBefore = paymentChecks;
    h.setNow("2026-11-04T06:59:59.999Z");
    await assert.rejects(expireProposal(h, proposed), /PROPOSAL_NOT_EXPIRED/);
    h.setNow(PROPOSAL_EXPIRES);
    await assert.rejects(expireProposal(h, proposed, "customer"), /UNAUTHORIZED/);
    const expired = await expireProposal(h, proposed, "admin");
    const [replan] = expired.deliveryReplans;
    assert.deepEqual(replan.expiry, {
        orderId: expired.id, replanId: "replan-0001", expiredAt: PROPOSAL_EXPIRES, recordedAt: PROPOSAL_EXPIRES,
        recordedBy: "expire_delivery_proposal", role: "admin", idempotencyKey: expired.events.at(-1).requestId,
        // Görev 141: the verified person who recorded the manual expiry.
        actorId: "synthetic-admin-operator", actorType: "HUMAN", reason: "MANUAL_EXPIRY_RECORD"
    });
    assert.deepEqual(expired.events.at(-1).audit, replan.expiry);
    assert.equal(replan.missedDeadline, DEADLINE);
    assert.equal(expired.state, proposed.state);
    assert.equal(expired.slaStartsAt, PLANNED_START);
    assert.deepEqual(expired.booking, proposed.booking);
    assert.equal(expired.replannedDeadline, null);
    assert.equal(expired.revisionsUsed, proposed.revisionsUsed);
    assert.deepEqual(expired.revisions, proposed.revisions);
    assert.deepEqual(expired.financialAssessments, []);
    assert.equal(expired.paymentReference, proposed.paymentReference);
    assert.equal(paymentChecks, checksBefore);
    // Time-bound work is still blocked: an expired proposal is not a commitment.
    await assert.rejects(h.send(expired, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] }),
        /DELIVERY_REPLAN_REQUIRED/);
});

test("EX/28,29: one active proposal at a time; a new one starts its own 48 hours after the old one ends", async () => {
    const h = await overdueAfterReview();
    const first = await h.propose(h.order, NEW_DEADLINE);
    h.setNow("2026-11-04T06:59:59.999Z");
    await assert.rejects(h.propose(first, "2026-11-06T12:00:00.000Z"), /REPLAN_PENDING/);
    h.setNow(PROPOSAL_EXPIRES);
    const second = await h.propose(first, "2026-11-06T12:00:00.000Z");
    const [old, fresh] = second.deliveryReplans;
    assert.equal(old.status, "EXPIRED");
    assert.equal(old.expiry.recordedBy, "propose_delivery_date");
    assert.equal(old.proposedDeadline, NEW_DEADLINE);
    assert.deepEqual([fresh.status, fresh.createdAt, fresh.expiresAt],
        ["PROPOSED", PROPOSAL_EXPIRES, "2026-11-06T07:00:00.000Z"]);
    assert.equal(second.deliveryReplans.filter(replan => replan.status === "PROPOSED").length, 1);
    // The old proposal's confirmation does not fit the new one.
    await assert.rejects(h.confirm(second, "ACCEPT", h.confirmation(second, "ACCEPT", old)), /INVALID_CONFIRMATION/);
    assert.equal((await h.confirm(second, "ACCEPT")).replannedDeadline, "2026-11-06T12:00:00.000Z");
});

test("EX/30: another order's customer or confirmation cannot answer a proposal", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const other = await overdueAfterReview();
    const otherProposed = await other.propose(other.order, NEW_DEADLINE);
    await assert.rejects(h.confirm(proposed, "ACCEPT", other.confirmation(otherProposed, "ACCEPT")), /INVALID_CONFIRMATION/);
    await assert.rejects(h.core.dispatch(proposed, { kind: "confirm_delivery_date", requestId: "synthetic-foreign-02",
        expectedVersion: proposed.version, data: { confirmation: h.confirmation(proposed, "ACCEPT") } },
    { role: "customer", orderId: otherProposed.id, auth: SERVER }), /UNAUTHORIZED/);
});

test("EX/31: acceptance and expiry racing at the same instant resolve by trusted time, in any order", async () => {
    for (const [now, winner] of [["2026-11-04T06:59:59.999Z", "ACCEPTED"], [PROPOSAL_EXPIRES, "EXPIRED"]]) {
        for (const confirmFirst of [true, false]) {
            const h = await overdueAfterReview();
            const proposed = await h.propose(h.order, NEW_DEADLINE);
            h.setNow(now);
            const attempts = [() => h.confirm(proposed, "ACCEPT"), () => expireProposal(h, proposed)];
            const [confirmed, expired] = await Promise.allSettled(confirmFirst ? attempts.map(run => run())
                : attempts.reverse().map(run => run()).reverse());
            const won = winner === "ACCEPTED" ? confirmed : expired;
            const lost = winner === "ACCEPTED" ? expired : confirmed;
            assert.equal(won.status, "fulfilled");
            assert.equal(lost.status, "rejected");
            assert.match(lost.reason.code, winner === "ACCEPTED"
                ? /PROPOSAL_NOT_EXPIRED|REPLAN_NOT_PENDING|VERSION_CONFLICT/ : /PROPOSAL_EXPIRED|REPLAN_NOT_PENDING|VERSION_CONFLICT/);
            assert.equal(won.value.deliveryReplans[0].status, winner === "ACCEPTED" ? "CONFIRMED" : "EXPIRED");
            assert.equal(won.value.replannedDeadline, winner === "ACCEPTED" ? NEW_DEADLINE : null);
        }
    }
});

// ---- Görev 140: proposal visibility ----

const { ACTIVE, ACCEPTED, REJECTED, EXPIRED } = PROPOSAL_VISIBILITY;

test("VIS/1,2,3,4,5: visible states follow the stored status and the trusted clock; expiresAt is already EXPIRED",
    async () => {
        const h = await overdueAfterReview();
        const proposed = await h.propose(h.order, NEW_DEADLINE);
        const view = h.core.viewProposal(proposed, "replan-0001");
        assert.deepEqual(view, {
            orderId: proposed.id, replanId: "replan-0001", visibleStatus: ACTIVE, storedStatus: "PROPOSED",
            proposedDeadline: NEW_DEADLINE, createdAt: AFTER_DEADLINE, expiresAt: PROPOSAL_EXPIRES, evaluatedAt: AFTER_DEADLINE
        });
        assert.ok(Object.isFrozen(view));
        h.setNow("2026-11-04T06:59:59.999Z");
        assert.equal(h.core.viewProposal(proposed, "replan-0001").visibleStatus, ACTIVE);
        h.setNow(PROPOSAL_EXPIRES);
        assert.deepEqual([h.core.viewProposal(proposed, "replan-0001").visibleStatus,
            h.core.viewProposal(proposed, "replan-0001").storedStatus], [EXPIRED, "PROPOSED"]);
        const marked = await expireProposal(h, proposed);
        assert.equal(h.core.viewProposal(marked, "replan-0001").visibleStatus, EXPIRED);
        const accepted = await overdueAfterReview();
        const confirmed = await accepted.confirm(await accepted.propose(accepted.order, NEW_DEADLINE), "ACCEPT");
        assert.equal(accepted.core.viewProposal(confirmed, "replan-0001").visibleStatus, ACCEPTED);
        const refused = await overdueAfterReview();
        const rejected = await refused.confirm(await refused.propose(refused.order, NEW_DEADLINE), "REJECT");
        assert.equal(refused.core.viewProposal(rejected, "replan-0001").visibleStatus, REJECTED);
        // A closed proposal never comes back as ACTIVE, whatever the time.
        for (const status of ["CONFIRMED", "REJECTED", "EXPIRED"]) {
            assert.notEqual(proposalVisibility({ ...proposed.deliveryReplans[0], status }, proposed.id, AFTER_DEADLINE), ACTIVE);
        }
    });

test("VIS/6,7,8: reading the visible state changes nothing, writes no audit and uses no reference", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    h.setNow(PROPOSAL_EXPIRES);
    for (let i = 0; i < 3; i++) assert.equal(h.core.viewProposal(proposed, "replan-0001").visibleStatus, EXPIRED);
    // The canonical order is unchanged: the next command still applies to the same version, and the expiry
    // is not recorded and the window not extended by the reads.
    const expired = await expireProposal(h, proposed);
    assert.equal(expired.version, proposed.version + 1);
    assert.equal(expired.events.length, proposed.events.length + 1);
    assert.equal(expired.deliveryReplans[0].expiresAt, PROPOSAL_EXPIRES);
    // Reads before the expiry did not consume the customer's confirmation reference either.
    const fresh = await overdueAfterReview();
    const pending = await fresh.propose(fresh.order, NEW_DEADLINE);
    const answer = fresh.confirmation(pending, "ACCEPT");
    fresh.core.viewProposal(pending, "replan-0001");
    fresh.core.viewProposal(pending, "replan-0001");
    assert.equal((await fresh.confirm(pending, "ACCEPT", answer)).deliveryReplans[0].status, "CONFIRMED");
});

test("VIS/9,14: broken time data, unknown status or another order's record never show as ACTIVE", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const replan = proposed.deliveryReplans[0];
    const cases = [
        [{ ...replan, createdAt: "2026-11-02T07:00:00" }, proposed.id, AFTER_DEADLINE, /INVALID_PROPOSAL_TIME/],
        [{ ...replan, expiresAt: undefined }, proposed.id, AFTER_DEADLINE, /INVALID_PROPOSAL_TIME/],
        [{ ...replan, expiresAt: "2026-11-04T07:00:00" }, proposed.id, AFTER_DEADLINE, /INVALID_PROPOSAL_TIME/],
        [{ ...replan, expiresAt: replan.createdAt }, proposed.id, AFTER_DEADLINE, /INVALID_PROPOSAL_TIME/],
        [replan, proposed.id, "2026-11-02T10:00:00", /INVALID_CLOCK/],
        [replan, proposed.id, undefined, /INVALID_CLOCK/],
        [{ ...replan, status: "ACTIVE" }, proposed.id, AFTER_DEADLINE, /INVALID_PROPOSAL_STATUS/],
        [replan, "another-order-id", AFTER_DEADLINE, /PROPOSAL_MISMATCH/],
        [{ ...replan, proposal: { ...replan.proposal, replanId: "replan-0002" } }, proposed.id, AFTER_DEADLINE,
            /PROPOSAL_MISMATCH/],
        [null, proposed.id, AFTER_DEADLINE, /PROPOSAL_MISMATCH/]
    ];
    for (const [record, orderId, now, error] of cases) {
        assert.throws(() => proposalVisibility(record, orderId, now), error);
    }
    // The core read uses only the canonical order and the trusted clock.
    const other = await overdueAfterReview();
    const foreign = await other.propose(other.order, NEW_DEADLINE);
    assert.throws(() => h.core.viewProposal(foreign, "replan-0001"), /UNKNOWN_ORDER/);
    assert.throws(() => h.core.viewProposal({ ...proposed, packageId: "PREMIUM" }, "replan-0001"), /INVALID_ORDER/);
    assert.throws(() => h.core.viewProposal(proposed, "replan-0009"), /UNKNOWN_PROPOSAL/);
    // Snapshot contents are ignored: an emptied or rewritten copy still reads the canonical proposal.
    assert.equal(h.core.viewProposal({ ...proposed, deliveryReplans: [] }, "replan-0001").visibleStatus, ACTIVE);
    // A caller-supplied time is never used in place of the trusted clock, in either direction.
    const early = h.core.viewProposal({ ...proposed, now: PROPOSAL_EXPIRES }, "replan-0001");
    assert.deepEqual([early.visibleStatus, early.evaluatedAt], [ACTIVE, AFTER_DEADLINE]);
    h.setNow(PROPOSAL_EXPIRES);
    const late = h.core.viewProposal({ ...proposed, now: AFTER_DEADLINE, evaluatedAt: AFTER_DEADLINE }, "replan-0001");
    assert.deepEqual([late.visibleStatus, late.evaluatedAt], [EXPIRED, PROPOSAL_EXPIRES]);
    // Commands ignore time fields sent with the request as well.
    await assert.rejects(h.confirm(proposed, "ACCEPT", { ...h.confirmation(proposed, "ACCEPT"), now: AFTER_DEADLINE,
        at: AFTER_DEADLINE }), /PROPOSAL_EXPIRED/);
    h.setNow("2026-11-02T10:00:00"); // zone-less trusted clock
    assert.throws(() => h.core.viewProposal(proposed, "replan-0001"), /INVALID_CLOCK/);
});

// ---- Görev 140: explicit time zones and UTC normalization ----

test("TZ/10,11,12,13,17: trusted times need an explicit zone and are stored as UTC ISO", async () => {
    const h = setup();
    const draft = h.core.createOrder("START");
    h.setNow("2026-10-28T12:00:00"); // zone-less: never read as server local time
    await assert.rejects(h.send(draft, "submit", "customer"), /INVALID_CLOCK/);
    h.setNow("2026-10-28T12:00:00.000+03:00");
    const submitted = await h.send(draft, "submit", "customer");
    assert.equal(submitted.version, 1);
    assert.equal(submitted.events[0].at, "2026-10-28T09:00:00.000Z");
    h.setNow("2026-10-28T04:30:00-05:00");
    const paid = await h.send(submitted, "verify_payment", "finance", { proof: h.payment(submitted) });
    assert.equal(paid.events.at(-1).at, "2026-10-28T09:30:00.000Z");
    h.setNow("2026-10-28T09:30:00Z");
    assert.equal((await h.send(paid, "request_email", "customer")).events.at(-1).at, "2026-10-28T09:30:00.000Z");
    // Booking times from the booking service: offsets are normalized, zone-less values refused.
    const offset = await ready("START", { scheduledStart: "2026-10-28T13:00:00+03:00", deadline: "2026-10-30T15:00:00+03:00" });
    assert.equal(offset.order.slaStartsAt, PLANNED_START);
    assert.equal(offset.order.booking.scheduledStart, PLANNED_START);
    assert.equal(offset.order.booking.deadline, DEADLINE);
    const b = await booked();
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { scheduledStart: "2026-10-28T13:00:00" }) }), /INVALID_BOOKING/);
    await assert.rejects(b.send(b.order, "approve_start", "scheduler",
        { booking: b.booking(b.order, { deadline: "2026-10-30T15:00:00" }) }), /INVALID_BOOKING/);
});

test("TZ/14,15: impossible dates, times and offsets are rejected", async () => {
    const h = await overdueAfterReview();
    for (const date of ["2026-02-30T12:00:00Z", "2026-13-04T12:00:00Z", "2026-11-31T12:00:00Z",
        "2026-11-04T24:00:00Z", "2026-11-04T12:60:00Z", "2026-11-04T12:00:60Z", "2026-11-04 12:00:00Z",
        "2026-11-04T12:00:00+15:00", "2026-11-04T15:00:00+03:60", "2026-11-04T15:00:00+0300",
        "2026-11-04T15:00:00+3:00", "2026-11-04T15:00:00GMT", "2026-11-04T12:00:00.0000Z", "2026-11-04"]) {
        await assert.rejects(h.propose(h.order, date), /INVALID_PROPOSAL/, date);
    }
    assert.equal(h.order.deliveryReplans.length, 0);
    h.setNow("2026-11-02T07:00:00+03:60");
    await assert.rejects(h.propose(h.order, NEW_DEADLINE), /INVALID_CLOCK/);
});

test("TZ/16,17: the same instant in different offsets is the same date; 48 hours are counted in UTC", async () => {
    const h = await overdueAfterReview();
    h.setNow("2026-11-02T10:00:00.000+03:00"); // = AFTER_DEADLINE
    const proposed = await h.propose(h.order, "2026-11-04T15:00:00+03:00"); // = NEW_DEADLINE
    const [replan] = proposed.deliveryReplans;
    assert.deepEqual([replan.proposedDeadline, replan.createdAt, replan.expiresAt],
        [NEW_DEADLINE, AFTER_DEADLINE, PROPOSAL_EXPIRES]);
    // The zone-less spelling that a lenient parser on this machine would read as exactly NEW_DEADLINE.
    const local = new Date(NEW_DEADLINE);
    const pad = value => String(value).padStart(2, "0");
    const zoneless = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T` +
        `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
    assert.equal(Date.parse(zoneless), Date.parse(NEW_DEADLINE));
    // Another instant or a zone-less value does not match the proposal.
    for (const date of [zoneless, "2026-11-04T12:00:00", "2026-11-04T12:00:01Z", "2026-11-04T15:00:00+02:00"]) {
        await assert.rejects(h.confirm(proposed, "ACCEPT",
            h.confirmation(proposed, "ACCEPT", undefined, { proposedDeadline: date })), /INVALID_CONFIRMATION/, date);
    }
    // The same instant written in any explicit offset matches and commits the same UTC date.
    for (const date of ["2026-11-04T13:00:00+01:00", "2026-11-04T10:00:00.000-02:00", "2026-11-04T12:00:00Z"]) {
        const o = await overdueAfterReview();
        const p = await o.propose(o.order, NEW_DEADLINE);
        const confirmed = await o.confirm(p, "ACCEPT", o.confirmation(p, "ACCEPT", undefined, { proposedDeadline: date }));
        assert.deepEqual([confirmed.replannedDeadline, confirmed.booking.deadline], [NEW_DEADLINE, DEADLINE], date);
    }
});

// ---- Görev 140: trusted time never runs backwards ----

test("CHR/18,19,20,21: a backwards clock is refused before any state, right or reference changes", async () => {
    // Revision acceptance: no right is consumed.
    const p = await producing("PLUS");
    p.setNow("2026-10-28T08:59:59.999Z"); // 1 ms before the last event
    await assert.rejects(p.send(p.order, "request_revision", "customer"), /CLOCK_REGRESSION/);
    p.setNow(FIXED_TIME);
    const accepted = await p.send(p.order, "request_revision", "customer");
    assert.deepEqual([accepted.version, accepted.revisionsUsed], [p.order.version + 1, 1]);
    // Review decision: no closing, no financial assessment, no reference consumed.
    const r = await pendingRevision();
    r.setNow("2026-10-29T09:00:00.000Z");
    const reviewed = await r.openReview(r.order, "REFUND");
    const decision = r.resolution(reviewed, reviewed.reviews[0].reviewId, "CLOSE");
    r.setNow("2026-10-29T08:00:00.000Z");
    await assert.rejects(r.resolveReview(reviewed, "CLOSE", decision), /CLOCK_REGRESSION/);
    r.setNow("2026-10-29T09:00:00.000Z");
    const closed = await r.resolveReview(reviewed, "CLOSE", decision);
    assert.deepEqual([closed.version, closed.financialAssessments.length], [reviewed.version + 1, 1]);
    // Customer confirmation: the proposal stays open and the confirmation reference unused.
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    const answer = h.confirmation(proposed, "ACCEPT");
    h.setNow("2026-11-02T06:59:59.999Z");
    await assert.rejects(h.confirm(proposed, "ACCEPT", answer), /CLOCK_REGRESSION/);
    assert.throws(() => h.core.viewProposal(proposed, "replan-0001"), /CLOCK_REGRESSION/);
    h.setNow("2026-11-03T07:00:00.000Z");
    const confirmed = await h.confirm(proposed, "ACCEPT", answer);
    assert.deepEqual([confirmed.version, confirmed.replannedDeadline, confirmed.slaStartsAt],
        [proposed.version + 1, NEW_DEADLINE, PLANNED_START]);
    assert.equal(confirmed.deliveryReplans[0].missedDeadline, DEADLINE);
});

test("CHR/22,23: equal timestamps and retried requests keep working; normal order of time is unchanged", async () => {
    const h = setup();
    let order = h.core.createOrder("START");
    order = await h.send(order, "submit", "customer", {}, { requestId: "synthetic-same-time-1" });
    order = await h.send(order, "verify_payment", "finance", { proof: h.payment(order) });
    assert.equal(order.events[0].at, order.events[1].at); // two transitions at the same instant
    // A retried request returns the committed result even if the clock has since moved backwards.
    h.setNow("2026-10-28T08:00:00.000Z");
    const replay = await h.send(order, "submit", "customer", {}, { requestId: "synthetic-same-time-1", version: 0 });
    assert.strictEqual(replay, order);
    // Strictly increasing times across a whole flow behave as before.
    const flow = setup();
    const times = ["2026-10-28T08:00:00.000Z", "2026-10-28T08:10:00.000Z", "2026-10-28T08:20:00.000Z",
        "2026-10-28T08:30:00.000Z", "2026-10-28T08:40:00.000Z"];
    let o = flow.core.createOrder("START");
    for (const [kind, role, data] of [["submit", "customer", {}], ["verify_payment", "finance", null],
        ["request_email", "customer", {}], ["verify_email", "customer", null], ["request_booking", "customer", {}]]) {
        flow.setNow(times[o.version]);
        o = await flow.send(o, kind, role, data ?? (kind === "verify_payment" ? { proof: flow.payment(o) }
            : { proof: { orderId: o.id, code: "SYNTHETIC-ONE-USE-CODE" } }));
    }
    assert.deepEqual(o.events.map(event => event.at), times);
    assert.equal(o.state, STATES.BOOKING_PENDING);
});

// ---- Görev 141: four-eyes revision right restoration (K-08) ----

const PROPOSER = "synthetic-creative-proposer";
const ADMIN_SIDE = { source: "admin_console" };

async function proposedRestoration(packageId = "PLUS", h = setup()) {
    const p = await pendingRevision(packageId, h);
    const record = p.restoration(p.order, "revision-0001");
    const order = await p.proposeRestoration(p.order, "revision-0001", record);
    return { ...p, accepted: p.order, record, order };
}

test("RS/1,5,26: a verified person proposes; the proposal is audited and changes no right", async () => {
    const h = await proposedRestoration();
    const [item] = h.order.restorations;
    assert.deepEqual([item.restorationId, item.revisionId, item.status, item.decision],
        ["restoration-0001", "revision-0001", "PENDING_APPROVAL", null]);
    assert.deepEqual(item.proposal, {
        orderId: h.order.id, restorationId: "restoration-0001", revisionId: "revision-0001", step: "PROPOSAL",
        reasonCode: "PRODUCER_NON_DELIVERY", evidenceRef: h.record.evidenceRef, actorId: PROPOSER, actorType: "HUMAN",
        role: "creative", authorizationRef: h.record.authorizationRef, at: FIXED_TIME,
        idempotencyKey: h.order.events.at(-1).requestId
    });
    assert.deepEqual(h.order.events.at(-1).audit, item.proposal);
    assert.deepEqual([h.order.state, h.order.revisionsUsed], [STATES.REVISION_PENDING, 1]);
    assert.deepEqual(h.order.revisions, h.accepted.revisions);
    assert.ok(Object.isFrozen(item.proposal));
});

test("RS/2,3,4,24,27: missing, forged, foreign or SYSTEM identities cannot propose; failures consume nothing", async () => {
    const h = await pendingRevision();
    const order = h.order;
    const record = h.restoration(order, "revision-0001");
    await assert.rejects(h.proposeRestoration(order, "revision-0001", record, "creative", { actorId: undefined }),
        /ACTOR_REQUIRED/);
    await assert.rejects(h.proposeRestoration(order, "revision-0001", record, "creative", { session: "0".repeat(64) }),
        /UNAUTHORIZED/);
    // A genuine session of another person cannot use a record issued to the proposer.
    await assert.rejects(h.proposeRestoration(order, "revision-0001", record, "creative",
        { actorId: "synthetic-creative-other" }), /RESTORATION_MISMATCH/);
    await assert.rejects(h.proposeRestoration(order, "revision-0001", { ...record, actorId: "synthetic-creative-other" },
        "creative", { actorId: "synthetic-creative-other" }), /UNTRUSTED_RESTORATION/);
    const other = await pendingRevision();
    await assert.rejects(h.proposeRestoration(order, "revision-0001", h.restoration(other.order, "revision-0001")),
        /RESTORATION_MISMATCH/);
    await assert.rejects(h.proposeRestoration(order, "revision-0001",
        h.restoration(order, "revision-0001", { evidenceRef: undefined })), /INVALID_RESTORATION/);
    // SYSTEM is not a person and cannot be claimed by any caller, in any spelling or role.
    for (const actorId of ["SYSTEM-scheduler", "system_job_0001", "System-0000001"]) {
        await assert.rejects(h.proposeRestoration(order, "revision-0001",
            h.restoration(order, "revision-0001", { actorId })), /RESERVED_ACTOR/, actorId);
    }
    await assert.rejects(h.proposeRestoration(order, "revision-0001", h.restoration(order, "revision-0001",
        { actorId: "SYSTEM" })), /ACTOR_REQUIRED/);
    await assert.rejects(h.proposeRestoration(order, "revision-0001", record, "system"), /UNAUTHORIZED/);
    // Nothing was registered: the original record still proposes once.
    const proposed = await h.proposeRestoration(order, "revision-0001", record);
    assert.deepEqual([proposed.version, proposed.restorations.length], [order.version + 1, 1]);
});

test("RS/13: one open proposal per revision; a reference is used once", async () => {
    const h = await proposedRestoration();
    await assert.rejects(h.proposeRestoration(h.order, "revision-0001"), /RESTORATION_PENDING/);
    await assert.rejects(h.proposeRestoration(h.order, "revision-0001",
        h.restoration(h.order, "revision-0001", ADMIN_SIDE), "admin"), /RESTORATION_PENDING/);
    // References are unique within one core's registry, across all of its orders.
    const shared = setup();
    const a = await pendingRevision("PLUS", shared);
    const b = await pendingRevision("PLUS", shared);
    const recordA = shared.restoration(a.order, "revision-0001");
    await shared.proposeRestoration(a.order, "revision-0001", recordA);
    await assert.rejects(shared.proposeRestoration(b.order, "revision-0001", shared.restoration(b.order, "revision-0001",
        { authorizationRef: recordA.authorizationRef })), /RESTORATION_REFERENCE_USED/);
});

test("RS/6,14,15: a second person approves; exactly one right comes back, once", async () => {
    for (const [role, extra] of [["creative", {}], ["admin", ADMIN_SIDE]]) {
        const h = await proposedRestoration();
        const record = h.restorationDecision(h.order, "APPROVE", undefined, extra);
        const approved = await h.decideRestoration(h.order, "APPROVE", record, role, { requestId: `synthetic-approve-${role}` });
        assert.deepEqual([approved.revisionsUsed, approved.state, approved.revisions[0].status, approved.restorations[0].status],
            [0, STATES.IN_PRODUCTION, "RESTORED", "APPROVED"]);
        assert.deepEqual([approved.restorations[0].decision.actorId, approved.restorations[0].decision.role],
            [record.actorId, role]);
        const replay = await h.decideRestoration(h.order, "APPROVE", record, role,
            { requestId: `synthetic-approve-${role}`, version: h.order.version });
        assert.strictEqual(replay, approved);
        await assert.rejects(h.decideRestoration(approved, "APPROVE", h.restorationDecision(approved, "APPROVE",
            approved.restorations[0], extra), role), /RESTORATION_NOT_PENDING|INVALID_TRANSITION/);
        await assert.rejects(h.proposeRestoration(approved, "revision-0001"), /ALREADY_RESTORED/);
        assert.equal(approved.revisionsUsed, 0);
    }
});

test("RS/7,8,9,25: the proposer, the same person in another role, or SYSTEM can never approve", async () => {
    const h = await proposedRestoration();
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, { actorId: PROPOSER })), /FOUR_EYES_VIOLATION/);
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, { ...ADMIN_SIDE, actorId: PROPOSER }), "admin"),
    /FOUR_EYES_VIOLATION/);
    await assert.rejects(h.decideRestoration(h.order, "REJECT",
        h.restorationDecision(h.order, "REJECT", undefined, { actorId: PROPOSER })), /FOUR_EYES_VIOLATION/);
    for (const actorId of ["SYSTEM", "SYSTEM-approver"]) {
        await assert.rejects(h.decideRestoration(h.order, "APPROVE",
            h.restorationDecision(h.order, "APPROVE", undefined, { actorId })), /ACTOR_REQUIRED|RESERVED_ACTOR/);
    }
    assert.deepEqual([h.order.revisionsUsed, h.order.restorations[0].status], [1, "PENDING_APPROVAL"]);
});

test("RS/10,11,12: an unauthorized person, another order's or another revision's decision cannot approve", async () => {
    const h = await proposedRestoration();
    const record = h.restorationDecision(h.order, "APPROVE");
    for (const role of ["customer", "finance", "scheduler"]) {
        await assert.rejects(h.decideRestoration(h.order, "APPROVE", record, role), /UNAUTHORIZED/);
    }
    await assert.rejects(h.decideRestoration(h.order, "APPROVE", record, "creative", { session: "f".repeat(64) }),
        /UNAUTHORIZED/);
    await assert.rejects(h.decideRestoration(h.order, "APPROVE", { ...record, signature: undefined }),
        /UNTRUSTED_RESTORATION/);
    // A genuine session of a third person cannot use the decision record issued to the approver.
    await assert.rejects(h.decideRestoration(h.order, "APPROVE", record, "creative", { actorId: "synthetic-creative-third" }),
        /RESTORATION_MISMATCH/);
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, ADMIN_SIDE)), /RESTORATION_MISMATCH/);
    // Another order's genuine proposal and decision do not fit this order.
    const other = await proposedRestoration();
    await assert.rejects(h.decideRestoration(h.order, "APPROVE", other.restorationDecision(other.order, "APPROVE")),
        /RESTORATION_MISMATCH/);
    // A decision naming another revision, other evidence or an unknown proposal is refused.
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, { revisionId: "revision-0002" })), /RESTORATION_MISMATCH/);
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, { evidenceRef: "synthetic-evidence-other" })),
    /RESTORATION_MISMATCH/);
    await assert.rejects(h.decideRestoration(h.order, "APPROVE",
        h.restorationDecision(h.order, "APPROVE", undefined, { restorationId: "restoration-0009" })),
    /UNKNOWN_RESTORATION/);
    // None of the failures consumed the genuine decision.
    assert.equal((await h.decideRestoration(h.order, "APPROVE", record)).revisionsUsed, 0);
});

test("RS/16,17: a rejection keeps the right, is audited and can never be approved later", async () => {
    const h = await proposedRestoration();
    await assert.rejects(h.decideRestoration(h.order, "REJECT",
        h.restorationDecision(h.order, "REJECT", undefined, { reasonCode: undefined })), /REJECTION_REASON_REQUIRED/);
    await assert.rejects(h.decideRestoration(h.order, "REJECT",
        h.restorationDecision(h.order, "REJECT", undefined, { reasonCode: "kanıt yetersiz" })), /RESTORATION_MISMATCH/);
    const rejected = await h.decideRestoration(h.order, "REJECT");
    const decision = rejected.restorations[0].decision;
    assert.deepEqual([rejected.restorations[0].status, decision.decision, decision.reasonCode, decision.actorId],
        ["REJECTED", "REJECT", "SYNTHETIC_EVIDENCE_INSUFFICIENT", "synthetic-creative-approver"]);
    assert.deepEqual([rejected.revisionsUsed, rejected.state, rejected.revisions], [1, STATES.REVISION_PENDING,
        h.order.revisions]);
    await assert.rejects(h.decideRestoration(rejected, "APPROVE",
        h.restorationDecision(rejected, "APPROVE", rejected.restorations[0])), /RESTORATION_NOT_PENDING/);
    // A new proposal under the usual eligibility rules may follow, and needs its own second person.
    const again = await h.proposeRestoration(rejected, "revision-0001");
    const approved = await h.decideRestoration(again, "APPROVE");
    assert.deepEqual([approved.restorations.map(item => item.status), approved.revisionsUsed], [["REJECTED", "APPROVED"], 0]);
    // A revision delivered while a proposal waits is no longer eligible at approval time.
    const late = await proposedRestoration();
    const delivered = await late.send(late.order, "revision_options", "creative", { options: ["synthetic-l1", "synthetic-l2"] });
    await assert.rejects(late.decideRestoration(delivered, "APPROVE",
        late.restorationDecision(delivered, "APPROVE", delivered.restorations[0])), /RESTORATION_NOT_ELIGIBLE/);
});

test("RS/18: the old single-step command can no longer restore a right", async () => {
    const h = await pendingRevision();
    const legacy = { orderId: h.order.id, revisionId: "revision-0001", reasonCode: "PRODUCER_NON_DELIVERY",
        authorizationRef: "synthetic-legacy-0001", source: "producer_console" };
    for (const [role, actorId] of [["creative", "synthetic-creative-legacy"], ["admin", "synthetic-admin-legacy"]]) {
        await assert.rejects(h.send(h.order, "restore_revision_right", role,
            { revisionId: "revision-0001", restoration: { ...legacy, signature: signRestoration(legacy) } }, { actorId }),
        /RESTORATION_REQUIRES_APPROVAL/);
    }
    await assert.rejects(h.send(h.order, "restore_revision_right", "customer", { revisionId: "revision-0001" }),
        /UNAUTHORIZED/);
    assert.deepEqual([h.order.revisionsUsed, h.order.revisions[0].status], [1, "ACCEPTED"]);
    // The same legacy reference is still unused: it was never registered.
    const proposed = await h.proposeRestoration(h.order, "revision-0001",
        h.restoration(h.order, "revision-0001", { authorizationRef: legacy.authorizationRef }));
    assert.equal(proposed.restorations[0].proposal.authorizationRef, legacy.authorizationRef);
});

test("RS/19,20,28: reviews, closed orders and a backwards clock block restoration steps", async () => {
    const h = await proposedRestoration();
    const reviewed = await h.openReview(h.order, "DISPUTE");
    await assert.rejects(h.decideRestoration(reviewed, "APPROVE", h.restorationDecision(reviewed, "APPROVE")),
        /REVIEW_IN_PROGRESS/);
    await assert.rejects(h.proposeRestoration(reviewed, "revision-0001"), /REVIEW_IN_PROGRESS/);
    const closed = await h.resolveReview(reviewed, "CLOSE");
    await assert.rejects(h.decideRestoration(closed, "APPROVE", h.restorationDecision(closed, "APPROVE")),
        /INVALID_TRANSITION/);
    assert.deepEqual([closed.revisionsUsed, closed.restorations[0].status], [1, "PENDING_APPROVAL"]);
    // Görev 140 time integrity: an approval at a backwards clock is refused and consumes nothing.
    const t = await pendingRevision();
    t.setNow("2026-10-28T10:00:00.000Z");
    const proposed = await t.proposeRestoration(t.order, "revision-0001");
    const approval = t.restorationDecision(proposed, "APPROVE");
    t.setNow(FIXED_TIME);
    await assert.rejects(t.decideRestoration(proposed, "APPROVE", approval), /CLOCK_REGRESSION/);
    t.setNow("2026-10-28T10:00:00.000Z");
    assert.equal((await t.decideRestoration(proposed, "APPROVE", approval)).revisionsUsed, 0);
});

// ---- Görev 141: verified identity for delivery proposals and manual expiry; the SYSTEM actor ----

test("ID/21,22,26: a delivery-date proposal needs a verified person, recorded in the audit", async () => {
    const h = await overdueAfterReview();
    const record = h.proposal(h.order, NEW_DEADLINE);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, record, "creative", { actorId: undefined }), /ACTOR_REQUIRED/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, record, "creative", { session: "0".repeat(64) }), /UNAUTHORIZED/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, record, "creative", { actorId: "synthetic-creative-other" }),
        /INVALID_PROPOSAL/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, { ...record, actorId: "synthetic-creative-other" }, "creative",
        { actorId: "synthetic-creative-other" }), /UNTRUSTED_PROPOSAL/);
    await assert.rejects(h.propose(h.order, NEW_DEADLINE, h.proposal(h.order, NEW_DEADLINE,
        { actorId: "SYSTEM-planner" })), /RESERVED_ACTOR/);
    const proposed = await h.propose(h.order, NEW_DEADLINE, record);
    const audit = proposed.deliveryReplans[0].proposal;
    assert.deepEqual([audit.actorId, audit.actorType, audit.role, audit.authorizationRef, audit.at],
        ["synthetic-creative-planner", "HUMAN", "creative", record.authorizationRef, AFTER_DEADLINE]);
    // The customer confirmation and the 48-hour rule are unchanged.
    const confirmed = await h.confirm(proposed, "ACCEPT");
    assert.deepEqual([confirmed.replannedDeadline, confirmed.slaStartsAt, confirmed.booking.deadline],
        [NEW_DEADLINE, PLANNED_START, DEADLINE]);
});

test("ID/23: a manual expiry needs a verified person; SYSTEM cannot act manually", async () => {
    const h = await overdueAfterReview();
    const proposed = await h.propose(h.order, NEW_DEADLINE);
    h.setNow(PROPOSAL_EXPIRES);
    await assert.rejects(expireProposal(h, proposed, "creative", { actorId: undefined }), /ACTOR_REQUIRED/);
    await assert.rejects(expireProposal(h, proposed, "creative", { actorId: "SYSTEM-expirer" }), /RESERVED_ACTOR/);
    await assert.rejects(expireProposal(h, proposed, "creative", { session: "0".repeat(64) }), /UNAUTHORIZED/);
    const expired = await expireProposal(h, proposed, "creative");
    assert.deepEqual([expired.deliveryReplans[0].expiry.actorId, expired.deliveryReplans[0].expiry.actorType,
        expired.deliveryReplans[0].expiry.recordedAt], ["synthetic-creative-operator", "HUMAN", PROPOSAL_EXPIRES]);
    assert.equal(h.core.viewProposal(expired, "replan-0001").visibleStatus, PROPOSAL_VISIBILITY.EXPIRED);
    assert.deepEqual([expired.revisionsUsed, expired.slaStartsAt, expired.financialAssessments],
        [proposed.revisionsUsed, PLANNED_START, []]);
});

test("SYS/24,25: SYSTEM only closes an elapsed proposal inside a person's transaction; no caller can be SYSTEM", async () => {
    const h = await overdueAfterReview();
    const first = await h.propose(h.order, NEW_DEADLINE);
    h.setNow(PROPOSAL_EXPIRES);
    const second = await h.propose(first, "2026-11-06T12:00:00.000Z");
    assert.deepEqual(second.deliveryReplans[0].expiry, {
        orderId: second.id, replanId: "replan-0001", expiredAt: PROPOSAL_EXPIRES, recordedAt: PROPOSAL_EXPIRES,
        recordedBy: "propose_delivery_date", actorId: "SYSTEM", actorType: "SYSTEM", role: null,
        reason: "EXPIRED_BEFORE_NEW_PROPOSAL", triggeredBy: { actorId: "synthetic-creative-planner", role: "creative" },
        idempotencyKey: second.events.at(-1).requestId
    });
    // The new proposal itself is attributed to the person, not to SYSTEM.
    assert.deepEqual([second.deliveryReplans[1].proposal.actorId, second.deliveryReplans[1].proposal.actorType],
        ["synthetic-creative-planner", "HUMAN"]);
    // No command accepts a SYSTEM-shaped caller: reviews included.
    const r = await pendingRevision();
    await assert.rejects(r.openReview(r.order, "REFUND", r.reviewRecord(r.order, "REFUND", { actorId: "SYSTEM-reviewer" })),
        /RESERVED_ACTOR/);
    const reviewed = await r.openReview(r.order, "REFUND");
    await assert.rejects(r.resolveReview(reviewed, "CONTINUE", r.resolution(reviewed, reviewed.reviews[0].reviewId,
        "CONTINUE", { actorId: "system-decider" })), /RESERVED_ACTOR/);
    assert.equal(reviewed.state, STATES.REFUND_REVIEW);
});
