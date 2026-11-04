import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { APPROVED_CLOSE_REASONS, APPROVED_REVIEW_POLICY, CLOSE_DECISION_FIELDS, CLOSE_EVIDENCE_FIELDS,
    closeDecisionBinding, createCore, FINANCIAL_CASE_POLICY, OrderError, PACKAGES, PROPOSAL_VISIBILITY, proposalVisibility, STATES }
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
    if (record.outcome === "CLOSE") return hmac(["close-decision", closeDecisionBinding(record)]);
    return hmac(["review", record.orderId, record.type ?? null, record.reviewId ?? null, record.outcome ?? null,
        record.authorizationRef, record.source, record.actorId ?? null, record.reasonCode ?? null,
        record.closeReasonPolicy ?? null, JSON.stringify(record.evidence ?? null)]);
}

// Synthetic evidence service: it alone can vouch for a close evidence reference (Görev 147).
function signEvidence(evidence) {
    return hmac(["evidence", evidence.evidenceId, evidence.orderId, evidence.reviewId, evidence.evidenceKind,
        evidence.source, evidence.createdAt, evidence.digest, evidence.financialObligation,
        evidence.linkedOrderId ?? null, evidence.finding ?? null]);
}

function syntheticAttestation(evidence, request) {
    if (!evidence || !signatureMatches(evidence.signature, signEvidence(evidence))) return null;
    return {
        status: "VERIFIED", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" },
        evidenceId: evidence.evidenceId, evidenceKind: evidence.evidenceKind, source: evidence.source,
        orderId: evidence.orderId, reviewId: evidence.reviewId,
        createdAt: new Date(Date.parse(evidence.createdAt)).toISOString(), digest: evidence.digest,
        financialObligation: evidence.financialObligation, linkedOrderId: evidence.linkedOrderId ?? null,
        finding: evidence.finding ?? null, closeReasonPolicy: request.closeReasonPolicy, reasonCode: request.reasonCode,
        decision: request.decision, decisionBinding: request.decisionBinding
    };
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

const CLOSE_POLICY = "UNAI-CLOSE-REASONS-v1.0";
const CLOSE_EVIDENCE = {
    DUPLICATE_ORDER: { evidenceKind: "DUPLICATE_PAYMENT_RECONCILIATION", source: "payment_provider_reconciliation",
        financialObligation: "RESOLVED" }, // linkedOrderId: the harness's paid twin order (Görev 150)
    CUSTOMER_WITHDREW_AFTER_SETTLEMENT: { evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION",
        source: "customer_confirmation_service", financialObligation: "NONE" },
    DISPUTE_RESOLVED_BY_PROVIDER: { evidenceKind: "PROVIDER_DISPUTE_OUTCOME", source: "payment_provider_reconciliation",
        financialObligation: "NONE" },
    FRAUD_CONFIRMED: { evidenceKind: "RISK_REVIEW_RECORD", source: "risk_review_console", financialObligation: "NONE",
        finding: "CONFIRMED" }
};

// `inherited` (Görev 169, F168-02): settings moved off the configuration object onto its prototype, as a polluted
// prototype would supply them; they are removed from the own configuration first. `factory` (Görev 170): the core
// to build; the central-gate lock passes a temporary probe copy of core.mjs, every other test the real createCore.
function setup(overrides = {}, inherited = null, factory = createCore) {
    let now = FIXED_TIME;
    const config = {
        authorize: (principal) => principal.auth === SERVER && (principal.actorId === undefined ||
            signatureMatches(principal.session, session(principal.actorId, principal.role))),
        verifyPayment: (proof) => signatureMatches(proof.signature, sign(proof)),
        verifyEmail: (proof) => proof.code === "SYNTHETIC-ONE-USE-CODE",
        verifyBooking: (record) => signatureMatches(record.signature, signBooking(record)),
        verifyRestoration: (record) => signatureMatches(record.signature, signRestoration(record)),
        verifyReview: (record, order, context) => context === undefined
            ? signatureMatches(record.signature, signReview(record))
            : { verified: signatureMatches(record.signature, hmac(["close-decision", context.binding])),
                binding: context.binding },
        verifyReplan: (record) => signatureMatches(record.signature, signReplan(record)),
        verifyEvidence: syntheticAttestation,
        allowSyntheticEvidence: true, // test fixture only: the synthetic evidence service is never a production verifier
        environment: "TEST", // Görev 152 (F151-04): the only environment in which the flag above is accepted
        calendar: CALENDAR,
        clock: () => now,
        ...overrides
    };
    if (inherited) for (const key of Object.keys(inherited)) delete config[key];
    const core = factory(inherited ? Object.assign(Object.create(inherited), config) : config);
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
    // Görev 147: a close evidence reference as the synthetic evidence service issues it, for one code.
    function evidence(order, reviewId, code, extra = {}) {
        const record = {
            evidenceId: `synthetic-close-evidence-${++counter}`, orderId: order.id, reviewId, ...CLOSE_EVIDENCE[code],
            ...(code === "DUPLICATE_ORDER" ? { linkedOrderId: twinId } : {}),
            createdAt: now, digest: createHash("sha256").update(`synthetic-evidence-content-${counter}`).digest("hex"),
            ...extra
        };
        return { ...record, signature: signEvidence(record) };
    }
    function closeFields(order, reviewId, code, evidenceExtra = {}) {
        return { reasonCode: code, closeReasonPolicy: CLOSE_POLICY, evidence: evidence(order, reviewId, code, evidenceExtra) };
    }
    // A CLOSE without an explicit reasonCode gets an approved code that fits the review type, with its evidence.
    function resolution(order, reviewId, outcome, extra = {}) {
        const source = extra.source ?? "finance_console";
        const type = order.reviews.find(review => review.reviewId === reviewId)?.type;
        const close = outcome === "CLOSE" && !Object.hasOwn(extra, "reasonCode")
            ? closeFields(order, reviewId, type === "DISPUTE" ? "DISPUTE_RESOLVED_BY_PROVIDER" : "DUPLICATE_ORDER") : {};
        const record = {
            orderId: order.id, reviewId, outcome, authorizationRef: `synthetic-decision-${++counter}`,
            source, actorId: staff(source, "decider"), ...close, ...extra
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
    // Görev 150 (F-02): a paid order of the same core that a DUPLICATE_ORDER evidence names as the other order.
    let twinId = null;
    const setTwin = id => { twinId = id; };
    const twin = () => twinId;
    return {
        core, actor, send, payment, booking, restoration, restorationDecision, proposeRestoration, decideRestoration,
        restore, reviewRecord, evidence, closeFields, resolution, openReview, resolveReview, proposal, confirmation, propose, confirm, setNow,
        setTwin, twin
    };
}

async function paidOrder(h, packageId = "START", tag = "twin") {
    let order = h.core.createOrder(packageId);
    order = await h.send(order, "submit", "customer", {}, { requestId: `synthetic-${tag}-submit-${order.id}` });
    return h.send(order, "verify_payment", "finance", { proof: h.payment(order) },
        { requestId: `synthetic-${tag}-paid-${order.id}` });
}

async function booked(packageId = "START", h = setup()) {
    h.setTwin((await paidOrder(h, packageId)).id); // the paid twin a DUPLICATE_ORDER close refers to
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
        const h = await producing("PLUS"); // Görev 148: no undelivered revision, so CLOSE is possible
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

test("PF/15,16,17,18: a REFUND keeps pending revisions and rights, flags them for review and moves no money", async () => {
    let paymentChecks = 0;
    const h = await pendingRevision("PLUS", setup({
        verifyPayment: (proof) => { paymentChecks += 1; return signatureMatches(proof.signature, sign(proof)); }
    }));
    const checksBefore = paymentChecks;
    const reviewed = await h.openReview(h.order, "REFUND");
    // Görev 148 (D-3): a CLOSE no longer settles an undelivered revision; it waits for the financial case process.
    await assert.rejects(h.resolveReview(reviewed, "CLOSE"), /FINANCIAL_CASE_REQUIRED/);
    const closed = await h.resolveReview(reviewed, "REFUND");
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
    // CONTINUE and a closing without pending revisions create no assessment.
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
    const reviewed = await h.openReview(order, "CANCELLATION");
    await assert.rejects(h.resolveReview(reviewed, "CLOSE"), /FINANCIAL_CASE_REQUIRED/); // Görev 148: revision-0003
    const closed = await h.resolveReview(reviewed, "REFUND");
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

test("AP/3,4,5,6,17: finance decides every outcome; admin CONTINUE, CLOSE where a close reason allows it, never REFUND", async () => {
    let accepted = 0;
    for (const [type] of REVIEW_TYPES) {
        for (const outcome of ["CONTINUE", "REFUND", "CLOSE"]) {
            const h = await producing("PLUS"); // Görev 148: CLOSE needs an order without an undelivered revision
            const open = await h.openReview(h.order, type);
            const done = await h.resolveReview(open, outcome);
            const resolution = done.reviews[0].resolution;
            assert.deepEqual([resolution.outcome, resolution.role, resolution.actorId, resolution.policyReference],
                [outcome, "finance", "synthetic-finance-decider", POLICY_REFERENCE]);
            accepted += 1;
        }
        for (const outcome of ["CONTINUE", "CLOSE"]) {
            const h = await producing("PLUS");
            const open = await h.openReview(h.order, type);
            const record = h.resolution(open, open.reviews[0].reviewId, outcome,
                outcome === "CONTINUE" ? { ...ADMIN, reasonCode: "SYNTHETIC_CASE_RESOLVED" } : ADMIN);
            if (outcome === "CLOSE" && type !== "DISPUTE") {
                // Görev 147: the policy allows the combination, but no live close reason is open to admin here.
                await assert.rejects(h.resolveReview(open, outcome, record, "admin"), /CLOSE_REASON_ROLE_NOT_PERMITTED/);
                continue;
            }
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
    assert.equal(accepted, 13); // 15 policy combinations less the two admin CLOSEs no close reason allows
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
    await assertCanonicalUnchanged(h, reviewed);
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

test("FE/15,16 (Görev 147, K-06): every CLOSE, by admin or finance, needs an approved reason and evidence, fully audited", async () => {
    const h = await producing("PLUS");
    const reviewed = await h.openReview(h.order, "DISPUTE");
    const id = reviewed.reviews[0].reviewId;
    // No reason code: refused for admin and, unlike before Görev 147, for finance too.
    await assert.rejects(h.resolveReview(reviewed, "CLOSE",
        h.resolution(reviewed, id, "CLOSE", { ...ADMIN, reasonCode: undefined }), "admin"), /CLOSE_REASON_REQUIRED/);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE", h.resolution(reviewed, id, "CLOSE", { reasonCode: undefined })),
        /CLOSE_REASON_REQUIRED/);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE",
        h.resolution(reviewed, id, "CLOSE", { ...ADMIN, reasonCode: "müşteri istedi" }), "admin"), /INVALID_REVIEW/);
    // Evidence swapped after the decision was signed, even for genuine evidence of the same kind: refused.
    const signed = h.resolution(reviewed, id, "CLOSE", ADMIN);
    await assert.rejects(h.resolveReview(reviewed, "CLOSE",
        { ...signed, evidence: h.evidence(reviewed, id, "DISPUTE_RESOLVED_BY_PROVIDER") }, "admin"), /UNTRUSTED_REVIEW/);
    const closed = await h.resolveReview(reviewed, "CLOSE", signed, "admin");
    const resolution = closed.reviews[0].resolution;
    assert.equal(closed.state, STATES.CLOSED);
    assert.deepEqual([resolution.outcome, resolution.reasonCode, resolution.closeReasonPolicy, resolution.actorId,
        resolution.actorType, resolution.role, resolution.policyReference, resolution.at, resolution.moneyMovement],
    ["CLOSE", "DISPUTE_RESOLVED_BY_PROVIDER", CLOSE_POLICY, "synthetic-admin-decider", "HUMAN", "admin",
        POLICY_REFERENCE, FIXED_TIME, "NONE"]);
    // Only the reference, kind, source, time, digest and stated money outcome are kept.
    assert.deepEqual(resolution.evidence, {
        evidenceId: signed.evidence.evidenceId, evidenceKind: "PROVIDER_DISPUTE_OUTCOME",
        source: "payment_provider_reconciliation", createdAt: FIXED_TIME, digest: signed.evidence.digest,
        financialObligation: "NONE", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" } // Görev 150
    });
    const { moneyMovement, ...eventAudit } = resolution;
    assert.equal(moneyMovement, "NONE");
    assert.deepEqual(closed.events.at(-1).audit, eventAudit);
    // Rights are untouched and nothing is flagged or settled (undelivered revisions block a CLOSE: Görev 148).
    assert.deepEqual([closed.revisionsUsed, closed.revisions, closed.financialAssessments], [0, [], []]);
    // Finance closes with an approved code and evidence.
    const f = await producing("PLUS");
    const financeClosed = await f.resolveReview(await f.openReview(f.order, "CANCELLATION"), "CLOSE");
    assert.deepEqual([financeClosed.state, financeClosed.reviews[0].resolution.reasonCode],
        [STATES.CLOSED, "DUPLICATE_ORDER"]);
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
    const decision = r.resolution(reviewed, reviewed.reviews[0].reviewId, "REFUND"); // Görev 148: not CLOSE
    r.setNow("2026-10-29T08:00:00.000Z");
    await assert.rejects(r.resolveReview(reviewed, "REFUND", decision), /CLOCK_REGRESSION/);
    r.setNow("2026-10-29T09:00:00.000Z");
    const closed = await r.resolveReview(reviewed, "REFUND", decision);
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
    await assert.rejects(h.resolveReview(reviewed, "CLOSE"), /FINANCIAL_CASE_REQUIRED/); // Görev 148
    const closed = await h.resolveReview(reviewed, "REFUND");
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

// ---- Görev 147 (142B): versioned close reasons UNAI-CLOSE-REASONS-v1.0 and close evidence (K-05/06/07) ----

async function inReview(type, h = setup()) {
    const p = await producing("PLUS", {}, h); // no undelivered revision: Görev 148 is tested apart (D3/*)
    const reviewed = await p.openReview(p.order, type);
    return { ...p, reviewed, id: reviewed.reviews[0].reviewId };
}

function closeAs(h, order, code, { role = "finance", record = {}, evidence = {} } = {}) {
    const reviewId = order.reviews.at(-1).reviewId;
    const extra = { ...(role === "admin" ? ADMIN : {}), ...h.closeFields(order, reviewId, code, evidence), ...record };
    return h.resolveReview(order, "CLOSE", h.resolution(order, reviewId, "CLOSE", extra), role);
}

test("CR/1: the closed list holds exactly the four approved codes with their types, roles and evidence", () => {
    assert.equal(APPROVED_CLOSE_REASONS.status, "APPROVED");
    assert.equal(APPROVED_CLOSE_REASONS.reference, CLOSE_POLICY);
    const table = Object.fromEntries(Object.entries(APPROVED_CLOSE_REASONS.codes).map(([code, rule]) =>
        [code, [rule.types, rule.roles, rule.evidenceKind, rule.evidenceSource, rule.obligations, rule.legalReview]]));
    assert.deepEqual(table, {
        DUPLICATE_ORDER: [["CANCELLATION", "REFUND"], ["finance"], "DUPLICATE_PAYMENT_RECONCILIATION",
            "payment_provider_reconciliation", ["NONE", "RESOLVED"], "NOT_REQUIRED"],
        CUSTOMER_WITHDREW_AFTER_SETTLEMENT: [["CANCELLATION", "REFUND", "DISPUTE"], ["finance", "admin"],
            "CUSTOMER_CLOSURE_CONFIRMATION", "customer_confirmation_service", ["NONE"], "PENDING"],
        DISPUTE_RESOLVED_BY_PROVIDER: [["DISPUTE"], ["finance", "admin"], "PROVIDER_DISPUTE_OUTCOME",
            "payment_provider_reconciliation", ["NONE"], "NOT_REQUIRED"],
        FRAUD_CONFIRMED: [["CANCELLATION", "REFUND", "DISPUTE"], ["finance"], "RISK_REVIEW_RECORD", "risk_review_console",
            ["NONE"], "PENDING"]
    });
    assert.equal(APPROVED_CLOSE_REASONS.codes.FRAUD_CONFIRMED.finding, "CONFIRMED");
    assert.ok(Object.isFrozen(APPROVED_CLOSE_REASONS.codes.DUPLICATE_ORDER.roles));
    assert.throws(() => { APPROVED_CLOSE_REASONS.codes.DUPLICATE_ORDER.roles.push("admin"); }, TypeError);
});

test("CR/2,3: removed, unknown and look-alike codes and a wrong policy version are refused", async () => {
    const h = await inReview("CANCELLATION");
    for (const code of ["TERMS_VIOLATION", "CUSTOMER_UNREACHABLE", "SYNTHETIC_ANY_CODE", "FRAUD_SUSPECTED", "OTHER"]) {
        await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER", { record: { reasonCode: code } }),
            /CLOSE_REASON_UNKNOWN/, code);
    }
    for (const version of ["UNAI-CLOSE-REASONS-v0.9", "UNAI-CLOSE-REASONS-v1.1", undefined]) {
        await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER", { record: { closeReasonPolicy: version } }),
            /CLOSE_REASON_POLICY_MISMATCH/);
    }
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("CR/4: a code is refused for a review type it does not cover", async () => {
    const c = await inReview("CANCELLATION");
    await assert.rejects(closeAs(c, c.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /CLOSE_REASON_NOT_FOR_TYPE/);
    const r = await inReview("REFUND");
    await assert.rejects(closeAs(r, r.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /CLOSE_REASON_NOT_FOR_TYPE/);
    const d = await inReview("DISPUTE");
    await assert.rejects(closeAs(d, d.reviewed, "DUPLICATE_ORDER"), /CLOSE_REASON_NOT_FOR_TYPE/);
    for (const x of [c, r, d]) await assertCanonicalUnchanged(x, x.reviewed);
});

test("CR/5,6: finance-only codes are refused to admin, including FRAUD_CONFIRMED (K-07)", async () => {
    for (const type of ["CANCELLATION", "REFUND"]) {
        const h = await inReview(type);
        await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER", { role: "admin" }), /CLOSE_REASON_ROLE_NOT_PERMITTED/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    for (const type of ["CANCELLATION", "REFUND", "DISPUTE"]) {
        const h = await inReview(type);
        await assert.rejects(closeAs(h, h.reviewed, "FRAUD_CONFIRMED", { role: "admin" }), /CLOSE_REASON_ROLE_NOT_PERMITTED/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    // Other roles never reach the close reasons at all.
    const h = await inReview("DISPUTE");
    for (const role of ["creative", "customer", "scheduler"]) {
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER", { role }), /UNAUTHORIZED/);
    }
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("CR/9,10,11: missing, foreign, malformed or wrongly typed evidence is refused", async () => {
    const shared = setup();
    const a = await inReview("CANCELLATION", shared);
    const b = await inReview("CANCELLATION", shared);
    const cases = [
        [{ record: { evidence: undefined } }, /EVIDENCE_REQUIRED/],
        [{ record: { evidence: null } }, /EVIDENCE_REQUIRED/],
        [{ evidence: { orderId: b.reviewed.id } }, /EVIDENCE_MISMATCH/], // another order's evidence
        [{ evidence: { reviewId: "review-0002" } }, /EVIDENCE_MISMATCH/], // another review's evidence
        [{ evidence: { digest: "not-a-digest" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { createdAt: "2026-10-28T09:00:00" } }, /EVIDENCE_MISMATCH/], // zone-less time
        [{ evidence: { financialObligation: "PAID" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { linkedOrderId: undefined } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { linkedOrderId: a.reviewed.id } }, /EVIDENCE_MISMATCH/], // an order is no duplicate of itself
        [{ evidence: { finding: "CONFIRMED" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { content: "synthetic free text" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION" } }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidence: { source: "admin_console" } }, /EVIDENCE_KIND_NOT_ALLOWED/]
    ];
    for (const [options, error] of cases) {
        await assert.rejects(closeAs(a, a.reviewed, "DUPLICATE_ORDER", options), error);
    }
    // Evidence of an earlier review of the same order: a resumed and reopened review has a new id.
    const resumed = await a.resolveReview(a.reviewed, "CONTINUE");
    const again = await a.openReview(resumed, "REFUND");
    const stale = a.evidence(again, a.id, "DUPLICATE_ORDER");
    await assert.rejects(closeAs(a, again, "DUPLICATE_ORDER", { record: { evidence: stale } }), /EVIDENCE_MISMATCH/);
    await assertCanonicalUnchanged(a, again);
});

test("CR/12: authorizations and evidence references are single-use, across orders too", async () => {
    const shared = setup();
    const a = await inReview("REFUND", shared);
    const b = await inReview("REFUND", shared);
    const first = shared.resolution(a.reviewed, a.id, "CLOSE");
    await shared.resolveReview(a.reviewed, "CLOSE", first);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", shared.resolution(b.reviewed, b.id, "CLOSE",
        { authorizationRef: first.authorizationRef })), /REVIEW_REFERENCE_USED/);
    // The same evidence id, re-bound to the other order by the evidence service, is still used up.
    await assert.rejects(closeAs(shared, b.reviewed, "DUPLICATE_ORDER",
        { evidence: { evidenceId: first.evidence.evidenceId } }), /EVIDENCE_REFERENCE_USED/);
    assert.equal((await closeAs(shared, b.reviewed, "DUPLICATE_ORDER")).state, STATES.CLOSED);
});

test("CR/13: the person who opened the review cannot close it, whatever role or code they use", async () => {
    const h = await inReview("DISPUTE");
    await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER",
        { record: { actorId: "synthetic-finance-opener" } }), /FOUR_EYES_VIOLATION/);
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE",
        { ...ADMIN, actorId: "synthetic-finance-opener" }), "admin",
    { session: session("synthetic-finance-opener", "admin") }), /FOUR_EYES_VIOLATION/);
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("CR/14: a suspicion of fraud never closes; confirmed fraud and customer withdrawal await legal review", async () => {
    for (const type of ["CANCELLATION", "REFUND", "DISPUTE"]) {
        const h = await inReview(type);
        await assert.rejects(closeAs(h, h.reviewed, "FRAUD_CONFIRMED", { evidence: { finding: "SUSPECTED" } }),
            /CLOSE_FINDING_NOT_CONFIRMED/);
        await assert.rejects(closeAs(h, h.reviewed, "FRAUD_CONFIRMED", { evidence: { finding: undefined } }),
            /EVIDENCE_MISMATCH/);
        // Even a confirmed, genuine finding is not usable live until legal review clears the code.
        await assert.rejects(closeAs(h, h.reviewed, "FRAUD_CONFIRMED"), /CLOSE_REASON_PENDING_LEGAL_REVIEW/);
        for (const role of ["finance", "admin"]) {
            await assert.rejects(closeAs(h, h.reviewed, "CUSTOMER_WITHDREW_AFTER_SETTLEMENT", { role }),
                /CLOSE_REASON_PENDING_LEGAL_REVIEW/);
        }
        await assertCanonicalUnchanged(h, h.reviewed);
    }
});

test("CR/15: unverified evidence is refused; without an evidence service every CLOSE is blocked", async () => {
    const h = await inReview("DISPUTE");
    const forged = h.closeFields(h.reviewed, h.id, "DISPUTE_RESOLVED_BY_PROVIDER");
    forged.evidence = { ...forged.evidence, signature: "0".repeat(64) };
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE", forged)),
        /UNTRUSTED_EVIDENCE/);
    const altered = h.closeFields(h.reviewed, h.id, "DISPUTE_RESOLVED_BY_PROVIDER");
    altered.evidence = { ...altered.evidence, digest: "a".repeat(64) }; // content changed after it was vouched for
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE", altered)),
        /UNTRUSTED_EVIDENCE/);
    for (const verifyEvidence of [undefined, null, "true"]) {
        const b = await inReview("DISPUTE", setup({ verifyEvidence }));
        await assert.rejects(closeAs(b, b.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /CLOSE_EVIDENCE_UNVERIFIABLE/);
        // CONTINUE and REFUND need no close evidence and are unaffected.
        assert.equal((await b.resolveReview(b.reviewed, "CONTINUE")).state, STATES.IN_PRODUCTION);
    }
    // A service that answers anything but true is a refusal.
    const loose = await inReview("DISPUTE", setup({ verifyEvidence: () => "yes" }));
    await assert.rejects(closeAs(loose, loose.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /UNTRUSTED_EVIDENCE/);
});

test("CR/16: a CLOSE that leaves money owed to or returned to the customer waits for the financial case process", async () => {
    const c = await inReview("CANCELLATION");
    await assert.rejects(closeAs(c, c.reviewed, "DUPLICATE_ORDER", { evidence: { financialObligation: "OPEN" } }),
        /FINANCIAL_CASE_REQUIRED/);
    const d = await inReview("DISPUTE");
    for (const financialObligation of ["OPEN", "RESOLVED"]) {
        for (const role of ["finance", "admin"]) {
            await assert.rejects(closeAs(d, d.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER",
                { role, evidence: { financialObligation } }), /FINANCIAL_CASE_REQUIRED/);
        }
        await assert.rejects(closeAs(d, d.reviewed, "CUSTOMER_WITHDREW_AFTER_SETTLEMENT",
            { evidence: { financialObligation } }), /FINANCIAL_CASE_REQUIRED/);
    }
    // A reconciled duplicate payment, or a duplicate without a second payment, may close; no money moves here.
    for (const financialObligation of ["RESOLVED", "NONE"]) {
        const h = await inReview("REFUND");
        const closed = await closeAs(h, h.reviewed, "DUPLICATE_ORDER", { evidence: { financialObligation } });
        assert.deepEqual([closed.state, closed.reviews[0].resolution.evidence.financialObligation,
            closed.reviews[0].resolution.moneyMovement, closed.paymentReference],
        [STATES.CLOSED, financialObligation, "NONE", h.order.paymentReference]);
        assert.equal(closed.reviews[0].resolution.evidence.linkedOrderId, h.twin());
    }
    for (const x of [c, d]) await assertCanonicalUnchanged(x, x.reviewed);
    // An undelivered revision right blocks a CLOSE as well: Görev 148, D3/*.
});

test("CR/17: a retried CLOSE is idempotent and consumes its references once", async () => {
    const h = await inReview("REFUND");
    const record = h.resolution(h.reviewed, h.id, "CLOSE");
    const options = { requestId: "synthetic-close-retry", actorId: record.actorId };
    const closed = await h.send(h.reviewed, "resolve_review", "finance", { resolution: record }, options);
    const retried = await h.send(h.reviewed, "resolve_review", "finance", { resolution: record }, options);
    assert.strictEqual(retried, closed);
    assert.equal(closed.events.filter(event => event.kind === "resolve_review").length, 1);
    // The same request id with different evidence is a conflict, not a second close.
    const other = { ...record, ...h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER") };
    await assert.rejects(h.send(closed, "resolve_review", "finance",
        { resolution: { ...other, signature: signReview(other) } }, options), /IDEMPOTENCY_CONFLICT/);
});

test("CR/18: refused CLOSE attempts change nothing and consume no authorization or evidence", async () => {
    const h = await inReview("CANCELLATION");
    const good = h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER");
    const authorizationRef = "synthetic-close-kept-authorization";
    const attempts = [
        [{ ...good, reasonCode: "TERMS_VIOLATION" }, /CLOSE_REASON_UNKNOWN/],
        [{ ...good, evidence: { ...good.evidence, financialObligation: "OPEN" } }, /FINANCIAL_CASE_REQUIRED/],
        [{ ...good, evidence: { ...good.evidence, signature: "0".repeat(64) } }, /UNTRUSTED_EVIDENCE/],
        [{ ...good, actorId: "synthetic-finance-opener" }, /FOUR_EYES_VIOLATION/]
    ];
    for (const [extra, error] of attempts) {
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE",
            h.resolution(h.reviewed, h.id, "CLOSE", { ...extra, authorizationRef })), error);
    }
    // Evidence from before the order existed, or from the future, is refused before anything is consumed.
    for (const createdAt of ["2026-10-27T09:00:00Z", "2026-10-28T09:00:01Z"]) {
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE",
            { ...h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER", { createdAt, evidenceId: good.evidence.evidenceId }),
                authorizationRef })), /EVIDENCE_TIME_INVALID/);
    }
    // Evidence passed into a CONTINUE or REFUND is refused, not silently ignored.
    await assert.rejects(h.resolveReview(h.reviewed, "REFUND", h.resolution(h.reviewed, h.id, "REFUND",
        { ...good, reasonCode: undefined, authorizationRef })), /INVALID_REVIEW/);
    // The same authorization and evidence still work once, at the same version, on the same event history.
    const closed = await h.resolveReview(h.reviewed, "CLOSE",
        h.resolution(h.reviewed, h.id, "CLOSE", { ...good, authorizationRef }));
    assert.deepEqual([closed.version, closed.reviews[0].resolution.evidence.evidenceId, closed.revisionsUsed,
        closed.financialAssessments], [h.reviewed.version + 1, good.evidence.evidenceId, 0, []]);
    assert.deepEqual(closed.events.slice(0, -1), h.reviewed.events);
});

test("CR/19: evidence from before the review is admitted for external records; times are normalized and checked", async () => {
    const h = setup();
    const p = await producing("PLUS", {}, h);
    h.setNow("2026-10-29T09:00:00.000Z");
    const reviewed = await p.openReview(p.order, "DISPUTE");
    // A provider outcome recorded before the review opened, but after the order existed, is admitted.
    const closed = await closeAs(p, reviewed, "DISPUTE_RESOLVED_BY_PROVIDER",
        { evidence: { createdAt: "2026-10-28T12:00:00+03:00" } });
    assert.equal(closed.reviews[0].resolution.evidence.createdAt, FIXED_TIME); // normalized to UTC
    // A backwards clock is reported as such, before the evidence time is judged.
    const r = await inReview("REFUND");
    const decision = r.resolution(r.reviewed, r.id, "CLOSE");
    r.setNow("2026-10-28T08:00:00.000Z");
    await assert.rejects(r.resolveReview(r.reviewed, "CLOSE", decision), /CLOCK_REGRESSION/);
});

// ---- Görev 148 (D-3): no CLOSE while an undelivered revision right awaits a financial assessment ----

const CLOSE_CODE = { CANCELLATION: "DUPLICATE_ORDER", REFUND: "DUPLICATE_ORDER", DISPUTE: "DISPUTE_RESOLVED_BY_PROVIDER" };

test("D3/1,2: finance and admin CLOSE are refused while an accepted revision is undelivered", async () => {
    for (const [type, state] of REVIEW_TYPES) {
        const h = await pendingRevision("PLUS");
        const reviewed = await h.openReview(h.order, type);
        await assert.rejects(closeAs(h, reviewed, CLOSE_CODE[type]), /FINANCIAL_CASE_REQUIRED/);
        // Admin is refused for the pending revision before any close-reason rule is even looked at.
        for (const code of Object.keys(APPROVED_CLOSE_REASONS.codes)) {
            await assert.rejects(closeAs(h, reviewed, code, { role: "admin" }), /FINANCIAL_CASE_REQUIRED/);
        }
        const resumed = await assertCanonicalUnchanged(h, reviewed);
        assert.deepEqual([resumed.events.at(-1).from, resumed.state], [state, STATES.REVISION_PENDING]);
    }
});

test("D3/3: any undelivered revision blocks, also beside settled ones and with a restoration pending", async () => {
    const h = await pendingRevision("PLUS");
    let order = await h.restore(h.order, "revision-0001"); // RESTORED
    order = await h.send(order, "request_revision", "customer"); // revision-0002
    order = await h.send(order, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] }); // DELIVERED
    order = await h.send(order, "request_revision", "customer"); // revision-0003 ACCEPTED
    const reviewed = await h.openReview(order, "CANCELLATION");
    assert.deepEqual(reviewed.revisions.map(revision => revision.status), ["RESTORED", "DELIVERED", "ACCEPTED"]);
    await assert.rejects(closeAs(h, reviewed, "DUPLICATE_ORDER"), /FINANCIAL_CASE_REQUIRED/);
    // A REFUND flags exactly the undelivered one, as before.
    const refunded = await h.resolveReview(reviewed, "REFUND");
    assert.deepEqual(refunded.financialAssessments.map(item => item.revisionId), ["revision-0003"]);
    // A restoration that is only proposed settles nothing: the revision is still accepted and undelivered.
    const p = await proposedRestoration();
    const disputed = await p.openReview(p.order, "DISPUTE");
    assert.equal(disputed.restorations[0].status, "PENDING_APPROVAL");
    await assert.rejects(closeAs(p, disputed, "DISPUTE_RESOLVED_BY_PROVIDER"), /FINANCIAL_CASE_REQUIRED/);
});

test("D3/4,5: settled revisions and orders without revisions can still be closed", async () => {
    // Restored and delivered revisions need no financial assessment.
    const h = await pendingRevision("PLUS");
    let order = await h.restore(h.order, "revision-0001");
    order = await h.send(order, "request_revision", "customer");
    order = await h.send(order, "revision_options", "creative", { options: ["synthetic-b1", "synthetic-b2"] });
    const reviewed = await h.openReview(order, "CANCELLATION");
    const closed = await closeAs(h, reviewed, "DUPLICATE_ORDER");
    assert.deepEqual([closed.state, closed.revisions.map(revision => revision.status), closed.financialAssessments,
        closed.revisionsUsed], [STATES.CLOSED, ["RESTORED", "DELIVERED"], [], 1]);
    // A normal order in production, and a completed order, close as in Görev 147.
    for (const type of ["CANCELLATION", "DISPUTE"]) {
        const n = await producing("PLUS");
        assert.equal((await closeAs(n, await n.openReview(n.order, type), CLOSE_CODE[type])).state, STATES.CLOSED);
    }
    const c = await producing("PLUS");
    let done = await c.send(c.order, "select_final", "customer", { selectedOption: "synthetic-a1" });
    done = await c.send(done, "complete", "creative", { mp3Ref: "synthetic-mp3-final", wavFeasible: false });
    const completed = await closeAs(c, await c.openReview(done, "DISPUTE"), "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.deepEqual([completed.state, completed.delivery.mp3Ref], [STATES.CLOSED, "synthetic-mp3-final"]);
});

test("D3/6,7,8,9,10: a refused CLOSE keeps the review open and consumes no right, authorization or evidence", async () => {
    const shared = setup();
    const h = await pendingRevision("PLUS", shared);
    const reviewed = await h.openReview(h.order, "REFUND");
    const id = reviewed.reviews[0].reviewId;
    const record = h.resolution(reviewed, id, "CLOSE");
    await assert.rejects(h.resolveReview(reviewed, "CLOSE", record), /FINANCIAL_CASE_REQUIRED/);
    // The canonical order did not move: a decision from the same snapshot is accepted at the same version, the review
    // was still open, the right untouched, and the only assessment is the REFUND's own. The refused CLOSE's
    // authorization is still unused.
    const refunded = await h.resolveReview(reviewed, "REFUND",
        h.resolution(reviewed, id, "REFUND", { authorizationRef: record.authorizationRef }));
    assert.deepEqual([refunded.version, refunded.state, refunded.reviews[0].resolution.authorizationRef,
        refunded.revisionsUsed, refunded.revisions[0].status, refunded.events.length],
    [reviewed.version + 1, STATES.CLOSED, record.authorizationRef, 1, "ACCEPTED", reviewed.events.length + 1]);
    assert.deepEqual(refunded.financialAssessments.map(item => [item.reviewId, item.revisionId]),
        [[id, "revision-0001"]]);
    // The evidence of the refused CLOSE is still unused: the evidence service may bind it to another order.
    const other = await producing("PLUS", {}, shared);
    const open = await other.openReview(other.order, "REFUND");
    const closed = await closeAs(other, open, "DUPLICATE_ORDER", { evidence: { evidenceId: record.evidence.evidenceId } });
    assert.equal(closed.reviews[0].resolution.evidence.evidenceId, record.evidence.evidenceId);
});

test("D3/11: a repeated refused request gets the same answer and still changes nothing", async () => {
    const h = await pendingRevision("PLUS");
    const reviewed = await h.openReview(h.order, "DISPUTE");
    const record = h.resolution(reviewed, reviewed.reviews[0].reviewId, "CLOSE");
    const options = { requestId: "synthetic-refused-close", actorId: record.actorId };
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(h.send(reviewed, "resolve_review", "finance", { resolution: record }, options),
            /FINANCIAL_CASE_REQUIRED/);
    }
    // The refused request id was never recorded: it is free for a permitted decision.
    const resumed = await h.send(reviewed, "resolve_review", "finance",
        { resolution: h.resolution(reviewed, reviewed.reviews[0].reviewId, "CONTINUE") }, options);
    assert.deepEqual([resumed.state, resumed.events.at(-1).requestId], [STATES.REVISION_PENDING, options.requestId]);
});

test("D3/12: only the order's own server-side revisions count, never another order or a client snapshot", async () => {
    const shared = setup();
    const pending = await pendingRevision("PLUS", shared);
    const clean = await producing("PLUS", {}, shared);
    const pendingReview = await pending.openReview(pending.order, "DISPUTE");
    const cleanReview = await clean.openReview(clean.order, "DISPUTE");
    // A snapshot that hides the undelivered revision does not lift the block.
    await assert.rejects(closeAs(pending, { ...pendingReview, revisions: [], revisionsUsed: 0 },
        "DISPUTE_RESOLVED_BY_PROVIDER"), /FINANCIAL_CASE_REQUIRED/);
    // Another order's pending revision, also shown in a forged snapshot, does not block this order.
    const closed = await closeAs(clean, { ...cleanReview, revisions: pendingReview.revisions },
        "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.deepEqual([closed.state, closed.revisions, closed.financialAssessments], [STATES.CLOSED, [], []]);
    await assert.rejects(closeAs(pending, pendingReview, "DISPUTE_RESOLVED_BY_PROVIDER"), /FINANCIAL_CASE_REQUIRED/);
});

test("D3/13: CONTINUE and REFUND on an order with an undelivered revision work as before", async () => {
    for (const [type] of REVIEW_TYPES) {
        const c = await pendingRevision("PLUS");
        const resumed = await c.resolveReview(await c.openReview(c.order, type), "CONTINUE");
        assert.deepEqual([resumed.state, resumed.revisionsUsed, resumed.financialAssessments],
            [STATES.REVISION_PENDING, 1, []]);
        const r = await pendingRevision("PLUS");
        const refunded = await r.resolveReview(await r.openReview(r.order, type), "REFUND");
        assert.deepEqual([refunded.state, refunded.revisionsUsed, refunded.revisions[0].status,
            refunded.reviews[0].resolution.moneyMovement, refunded.financialAssessments[0].status],
        [STATES.CLOSED, 1, "ACCEPTED", "NONE", "PENDING_FINANCIAL_REVIEW"]);
    }
});

// ---- Görev 150: F-01 evidence attestation, F-02 linked order, F-03 decision binding, F-04/F-05 test gaps ----

/** F-05: proof from the canonical order, never from the frozen input snapshot. A decision at the snapshot's version
 * is accepted only if nothing was committed since, and its result is built from the canonical record: the review was
 * still open in the snapshot's state, with the same events, rights, restorations and assessments. */
async function assertCanonicalUnchanged(h, snapshot) {
    const review = snapshot.reviews.at(-1);
    const resumed = await h.resolveReview(snapshot, "CONTINUE", h.resolution(snapshot, review.reviewId, "CONTINUE"));
    assert.equal(resumed.version, snapshot.version + 1);
    assert.equal(resumed.events.at(-1).from, snapshot.state);
    assert.deepEqual(resumed.events.slice(0, -1), snapshot.events);
    assert.deepEqual([resumed.reviews.at(-1).opening, resumed.revisions, resumed.revisionsUsed, resumed.restorations,
        resumed.financialAssessments, resumed.paymentReference],
    [review.opening, snapshot.revisions, snapshot.revisionsUsed, snapshot.restorations, snapshot.financialAssessments,
        snapshot.paymentReference]);
    return resumed;
}

// A synthetic stand-in that reports itself as a production service, to exercise a core without the test flag.
function productionShaped(evidence, request) {
    const attestation = syntheticAttestation(evidence, request);
    return attestation && { ...attestation, verifier: { kind: "PRODUCTION", id: "synthetic-production-shaped" } };
}

test("LO/1: a DUPLICATE_ORDER naming an order the core does not know is refused (Görev 149 PROBE-4)", async () => {
    const h = await inReview("REFUND");
    const record = h.resolution(h.reviewed, h.id, "CLOSE", h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER",
        { linkedOrderId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }));
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /LINKED_ORDER_NOT_FOUND/);
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("LO/2,3: self links, unpaid orders and an order already closed as the duplicate are refused", async () => {
    const h = await inReview("CANCELLATION");
    await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: h.reviewed.id } }),
        /EVIDENCE_MISMATCH/);
    const unpaid = await h.send(h.core.createOrder("START"), "submit", "customer");
    await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: unpaid.id } }),
        /LINKED_ORDER_INVALID/);
    // Two orders cannot close each other: once A is closed as the duplicate of B, B cannot be closed as A's.
    // (Görev 152: B must be a standing order when A closes, so B opens its own review only afterwards.)
    const shared = setup();
    const a = await inReview("REFUND", shared);
    const b = await producing("PLUS", {}, shared);
    await closeAs(shared, a.reviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: b.order.id } });
    const bReviewed = await shared.openReview(b.order, "REFUND");
    await assert.rejects(closeAs(shared, bReviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: a.reviewed.id } }),
        /LINKED_ORDER_INVALID/);
    await assertCanonicalUnchanged(h, h.reviewed);
    await assertCanonicalUnchanged(shared, bReviewed);
});

test("LO/3: the evidence service must name the same linked order as the decision", async () => {
    const other = { id: null };
    const h = await inReview("REFUND", setup({
        verifyEvidence: (evidence, request) => ({ ...syntheticAttestation(evidence, request), linkedOrderId: other.id })
    }));
    other.id = (await paidOrder(h, "START", "other")).id; // genuine and paid, but not the order in the decision
    await assert.rejects(closeAs(h, h.reviewed, "DUPLICATE_ORDER"), /UNTRUSTED_EVIDENCE/);
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("EV/4,5: a missing service, a bare true or an incomplete attestation is refused", async () => {
    for (const verifyEvidence of [undefined, () => true, () => ({ status: "VERIFIED" }), () => null]) {
        const h = await inReview("DISPUTE", setup({ verifyEvidence }));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"),
            verifyEvidence === undefined ? /CLOSE_EVIDENCE_UNVERIFIABLE/ : /UNTRUSTED_EVIDENCE/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    // Every attested field is required, and so are the status and the verifier.
    const omitted = ["evidenceId", "evidenceKind", "source", "orderId", "reviewId", "createdAt", "digest",
        "financialObligation", "linkedOrderId", "finding", "closeReasonPolicy", "reasonCode", "decision",
        "decisionBinding", "status", "verifier"];
    for (const field of omitted) {
        const h = await inReview("DISPUTE", setup({
            verifyEvidence: (evidence, request) => {
                const attestation = { ...syntheticAttestation(evidence, request) };
                delete attestation[field];
                return attestation;
            }
        }));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /UNTRUSTED_EVIDENCE/, field);
    }
    for (const verifier of [{ kind: "TEST" }, { kind: "TEST", id: "synthetic-unknown-kind" }, { kind: "PRODUCTION" },
        { kind: "PRODUCTION", id: "x" }, "PRODUCTION"]) {
        const h = await inReview("DISPUTE", setup({
            verifyEvidence: (evidence, request) => ({ ...syntheticAttestation(evidence, request), verifier })
        }));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /UNTRUSTED_EVIDENCE/);
    }
});

test("EV/6,7,8,9: an attestation for another order, review, kind, time, outcome or finding is refused", async () => {
    const shared = setup();
    const other = await inReview("DISPUTE", shared);
    const wrong = {
        orderId: other.reviewed.id, reviewId: "review-0002", evidenceKind: "PROVIDER_DISPUTE_OUTCOME_V2",
        source: "risk_review_console", createdAt: "2026-10-28T08:00:00.000Z", digest: "c".repeat(64),
        financialObligation: "RESOLVED", finding: "CONFIRMED", linkedOrderId: other.reviewed.id,
        closeReasonPolicy: "UNAI-CLOSE-REASONS-v1.1", reasonCode: "FRAUD_CONFIRMED", decision: "CONTINUE",
        decisionBinding: "[]", evidenceId: "synthetic-some-other-evidence", status: "PENDING"
    };
    for (const [field, value] of Object.entries(wrong)) {
        const h = await inReview("DISPUTE", setup({
            verifyEvidence: (evidence, request) => ({ ...syntheticAttestation(evidence, request), [field]: value })
        }));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /UNTRUSTED_EVIDENCE/, field);
        if (field === "finding") await assertCanonicalUnchanged(h, h.reviewed);
    }
    // The fraud path itself stays behind the legal gate: a suspicion never reaches the evidence service at all.
    let calls = 0;
    const f = await inReview("REFUND", setup({ verifyEvidence: (e, r) => { calls += 1; return syntheticAttestation(e, r); } }));
    await assert.rejects(closeAs(f, f.reviewed, "FRAUD_CONFIRMED", { evidence: { finding: "SUSPECTED" } }),
        /CLOSE_FINDING_NOT_CONFIRMED/);
    await assert.rejects(closeAs(f, f.reviewed, "FRAUD_CONFIRMED"), /CLOSE_REASON_PENDING_LEGAL_REVIEW/);
    assert.equal(calls, 0);
});

test("EV/16: a production verifier closes on a core without the test flag; a synthetic one never does", async () => {
    const prod = await inReview("DISPUTE", setup({ allowSyntheticEvidence: false, verifyEvidence: productionShaped }));
    const closed = await closeAs(prod, prod.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.deepEqual([closed.state, closed.reviews[0].resolution.evidence.verifier],
        [STATES.CLOSED, { kind: "PRODUCTION", id: "synthetic-production-shaped" }]);
    for (const allowSyntheticEvidence of [false, undefined, "true", 1]) {
        const h = await inReview("DISPUTE", setup({ allowSyntheticEvidence }));
        const record = h.resolution(h.reviewed, h.id, "CLOSE");
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    // A DUPLICATE_ORDER with a genuine paid twin closes with a production verifier as well.
    const dup = await inReview("REFUND", setup({ allowSyntheticEvidence: false, verifyEvidence: productionShaped }));
    const dupClosed = await closeAs(dup, dup.reviewed, "DUPLICATE_ORDER");
    assert.deepEqual([dupClosed.state, dupClosed.reviews[0].resolution.evidence.linkedOrderId], [STATES.CLOSED, dup.twin()]);
});

test("SB/10,11: any signed decision field changed after signing is refused, the evidence still being genuine", async () => {
    const shared = setup();
    const h = await inReview("REFUND", shared);
    const otherTwin = await paidOrder(shared, "START", "second-twin");
    const signed = h.resolution(h.reviewed, h.id, "CLOSE");
    const resign = evidence => ({ ...evidence, signature: signEvidence(evidence) });
    const changes = {
        evidenceId: resign({ ...signed.evidence, evidenceId: "synthetic-swapped-evidence" }),
        createdAt: resign({ ...signed.evidence, createdAt: "2026-10-28T12:00:00+03:00" }),
        digest: resign({ ...signed.evidence, digest: "d".repeat(64) }),
        financialObligation: resign({ ...signed.evidence, financialObligation: "NONE" }),
        linkedOrderId: resign({ ...signed.evidence, linkedOrderId: otherTwin.id })
    };
    for (const [field, evidence] of Object.entries(changes)) {
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", { ...signed, evidence }), /UNTRUSTED_REVIEW/, field);
    }
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE",
        { ...signed, authorizationRef: "synthetic-swapped-authorization" }), /UNTRUSTED_REVIEW/);
    // Unchanged, the same decision closes once: nothing above consumed its authorization or evidence.
    const closed = await h.resolveReview(h.reviewed, "CLOSE", signed);
    assert.deepEqual([closed.version, closed.reviews[0].resolution.authorizationRef,
        closed.reviews[0].resolution.evidence.evidenceId, closed.reviews[0].resolution.evidence.linkedOrderId],
    [h.reviewed.version + 1, signed.authorizationRef, signed.evidence.evidenceId, h.twin()]);
});

test("SB/10: the review adapter must confirm the exact binding; signature and evidence stay separate checks", async () => {
    const adapters = [
        () => true,
        (record, order, context) => ({ verified: true, binding: context ? `${context.binding} ` : undefined }),
        (record, order, context) => ({ verified: "true", binding: context?.binding }),
        (record, order, context) => (context ? { binding: context.binding } : signatureMatches(record.signature,
            signReview(record)))
    ];
    for (const verifyReview of adapters) {
        const h = await inReview("DISPUTE", setup({
            verifyReview: (record, order, context) => (context === undefined
                ? signatureMatches(record.signature, signReview(record)) : verifyReview(record, order, context))
        }));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /UNTRUSTED_REVIEW/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    assert.equal(closeDecisionBinding({ outcome: "CLOSE" }), closeDecisionBinding({ outcome: "CLOSE", extra: 1 }));
    // A genuine signature does not vouch for the evidence, and genuine evidence does not vouch for the signature.
    const h = await inReview("DISPUTE");
    const forged = h.closeFields(h.reviewed, h.id, "DISPUTE_RESOLVED_BY_PROVIDER");
    forged.evidence = { ...forged.evidence, signature: "0".repeat(64) };
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE", forged)),
        /UNTRUSTED_EVIDENCE/);
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE",
        { ...h.resolution(h.reviewed, h.id, "CLOSE"), signature: "0".repeat(64) }), /UNTRUSTED_REVIEW/);
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("CC/12,13,14,15: a linked order or the order itself changing during verification refuses the CLOSE safely", async () => {
    // The twin changes while the evidence service is being asked.
    let hook = null;
    const shared = setup({
        verifyEvidence: async (evidence, request) => {
            if (hook) { const run = hook; hook = null; await run(); }
            return syntheticAttestation(evidence, request);
        }
    });
    const h = await inReview("REFUND", shared);
    const twinBefore = await shared.send(await paidOrder(shared, "START", "racing-twin"), "request_email", "customer");
    const record = h.resolution(h.reviewed, h.id, "CLOSE",
        h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER", { linkedOrderId: twinBefore.id }));
    hook = async () => { await shared.send(twinBefore, "verify_email", "customer",
        { proof: { orderId: twinBefore.id, code: "SYNTHETIC-ONE-USE-CODE" } }); };
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /LINKED_ORDER_CHANGED/);
    // Nothing was consumed: the very same decision closes once the twin is stable.
    const closed = await h.resolveReview(h.reviewed, "CLOSE", record);
    assert.deepEqual([closed.version, closed.reviews[0].resolution.authorizationRef,
        closed.reviews[0].resolution.evidence.evidenceId], [h.reviewed.version + 1, record.authorizationRef,
        record.evidence.evidenceId]);
    assert.deepEqual(closed.events.slice(0, -1), h.reviewed.events);
    // The order itself is resolved by someone else while the evidence is checked: the CLOSE loses, consuming nothing.
    const o = await inReview("DISPUTE", shared);
    let resumed = null;
    hook = async () => { resumed = await o.resolveReview(o.reviewed, "CONTINUE"); };
    const close = o.resolution(o.reviewed, o.id, "CLOSE");
    await assert.rejects(o.resolveReview(o.reviewed, "CLOSE", close), /VERSION_CONFLICT/);
    const again = await o.openReview(resumed, "DISPUTE");
    const reclosed = await closeAs(o, again, "DISPUTE_RESOLVED_BY_PROVIDER",
        { evidence: { evidenceId: close.evidence.evidenceId } });
    assert.equal(reclosed.state, STATES.CLOSED);
    // Two CLOSEs racing with one evidence id: exactly one wins.
    const p = await inReview("DISPUTE", shared);
    const q = await inReview("DISPUTE", shared);
    const evidenceId = "synthetic-racing-evidence";
    const results = await Promise.allSettled([
        closeAs(shared, p.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER", { evidence: { evidenceId } }),
        closeAs(shared, q.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER", { evidence: { evidenceId } })]);
    assert.deepEqual(results.map(r => r.status === "fulfilled" ? "CLOSED" : r.reason.code).sort(),
        ["CLOSED", "EVIDENCE_REFERENCE_USED"]);
});

test("ST/F-04: evidence from before the review is stale for codes that need fresh records; the legal gate stays shut", async () => {
    const h = setup();
    const p = await producing("PLUS", {}, h);
    h.setNow("2026-10-29T09:00:00.000Z");
    const reviewed = await p.openReview(p.order, "REFUND");
    for (const code of ["CUSTOMER_WITHDREW_AFTER_SETTLEMENT", "FRAUD_CONFIRMED"]) {
        // Recorded the day before the review opened: refused as stale, whatever the legal state.
        await assert.rejects(closeAs(p, reviewed, code, { evidence: { createdAt: FIXED_TIME } }), /EVIDENCE_STALE/);
        // Recorded after the review opened: still stopped by the legal gate, which this task does not open.
        await assert.rejects(closeAs(p, reviewed, code), /CLOSE_REASON_PENDING_LEGAL_REVIEW/);
    }
    // At the opening instant itself the evidence is fresh.
    await assert.rejects(closeAs(p, reviewed, "FRAUD_CONFIRMED", { evidence: { createdAt: "2026-10-29T12:00:00+03:00" } }),
        /CLOSE_REASON_PENDING_LEGAL_REVIEW/);
    // External records may predate the review (D-1).
    assert.equal((await closeAs(p, reviewed, "DUPLICATE_ORDER", { evidence: { createdAt: FIXED_TIME } })).state,
        STATES.CLOSED);
});

// ---- Görev 152: F151-01 cancelled linked order, F151-02 decision immutability, F151-07 full binding coverage,
// ---- F151-04 synthetic evidence only in a declared TEST environment ----

test("LS/1: a cancelled, closed or reviewed order is no standing original, even though it was paid (F151-01)", async () => {
    const shared = setup();
    const h = await inReview("REFUND", shared);
    // Paid, then cancelled before production: the payment reference survives, the order does not stand.
    const cancelled = await shared.send(await paidOrder(shared, "START", "cancelled-twin"), "cancel", "finance");
    assert.deepEqual([cancelled.state, cancelled.paymentReference !== null], [STATES.CANCELLED, true]);
    const record = h.resolution(h.reviewed, h.id, "CLOSE",
        h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER", { linkedOrderId: cancelled.id }));
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /LINKED_ORDER_INVALID/);
    // Closed by a review, under a review of its own, or never paid: refused as well.
    const closedOther = await inReview("REFUND", shared);
    const refunded = await shared.resolveReview(closedOther.reviewed, "REFUND");
    const underReview = (await inReview("DISPUTE", shared)).reviewed;
    const unpaid = await shared.send(shared.core.createOrder("START"), "submit", "customer");
    for (const linked of [refunded, underReview, unpaid]) {
        await assert.rejects(closeAs(shared, h.reviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: linked.id } }),
            /LINKED_ORDER_INVALID/, linked.state);
    }
    // Nothing was consumed: the same authorization, with evidence naming a standing order, closes once.
    const standing = h.twin();
    const valid = h.resolution(h.reviewed, h.id, "CLOSE", {
        ...h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER", { evidenceId: record.evidence.evidenceId }),
        authorizationRef: record.authorizationRef
    });
    const closed = await h.resolveReview(h.reviewed, "CLOSE", valid);
    assert.deepEqual([closed.version, closed.reviews[0].resolution.evidence.linkedOrderId,
        closed.reviews[0].resolution.authorizationRef], [h.reviewed.version + 1, standing, record.authorizationRef]);
    assert.deepEqual(closed.events.slice(0, -1), h.reviewed.events);
});

test("LS/2: standing originals in production or completed are accepted; a cancellation mid-check is refused", async () => {
    const shared = setup();
    for (const make of [
        async () => (await producing("PLUS", {}, shared)).order,
        async () => {
            const c = await producing("PLUS", {}, shared);
            const chosen = await shared.send(c.order, "select_final", "customer", { selectedOption: "synthetic-a1" });
            return shared.send(chosen, "complete", "creative", { mp3Ref: "synthetic-mp3-original", wavFeasible: false });
        }]) {
        const original = await make();
        const h = await inReview("CANCELLATION", shared);
        const closed = await closeAs(shared, h.reviewed, "DUPLICATE_ORDER", { evidence: { linkedOrderId: original.id } });
        assert.deepEqual([closed.state, closed.reviews[0].resolution.evidence.linkedOrderId], [STATES.CLOSED, original.id]);
    }
    // The original is cancelled while the evidence service is being asked: the CLOSE does not commit.
    let hook = null;
    const racing = setup({
        verifyEvidence: async (evidence, request) => {
            if (hook) { const run = hook; hook = null; await run(); }
            return syntheticAttestation(evidence, request);
        }
    });
    const h = await inReview("REFUND", racing);
    const twin = await paidOrder(racing, "START", "cancelled-midway");
    const record = h.resolution(h.reviewed, h.id, "CLOSE",
        h.closeFields(h.reviewed, h.id, "DUPLICATE_ORDER", { linkedOrderId: twin.id }));
    hook = async () => { await racing.send(twin, "cancel", "finance"); };
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /LINKED_ORDER_CHANGED/);
    // On a retry the cancelled original is now seen as such.
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /LINKED_ORDER_INVALID/);
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("IM/1: verifiers get a deep-frozen copy; no decision or evidence field can be changed through them (F151-02)", async () => {
    const attempts = [];
    const tryChange = (target, key, value) => {
        try { target[key] = value; attempts.push("changed"); } catch { attempts.push("refused"); }
    };
    const h = await inReview("REFUND", setup({
        verifyReview: (record, order, context) => {
            if (context !== undefined) {
                tryChange(record, "reasonCode", "FRAUD_CONFIRMED");
                tryChange(record, "orderId", "synthetic-other-order");
                tryChange(record, "reviewId", "review-0009");
                tryChange(record.evidence, "evidenceId", "synthetic-swapped-in-review");
                tryChange(record.evidence, "linkedOrderId", "ffffffff-ffff-4fff-8fff-ffffffffffff");
                return { verified: signatureMatches(record.signature, hmac(["close-decision", context.binding])),
                    binding: context.binding };
            }
            return signatureMatches(record.signature, signReview(record));
        },
        verifyEvidence: (evidence, request) => {
            tryChange(evidence, "evidenceId", "synthetic-swapped-in-evidence");
            tryChange(evidence, "digest", "e".repeat(64));
            tryChange(request, "evidenceId", "synthetic-swapped-request");
            return syntheticAttestation(evidence, request);
        }
    }));
    const record = h.resolution(h.reviewed, h.id, "CLOSE");
    const closed = await h.resolveReview(h.reviewed, "CLOSE", record);
    assert.ok(attempts.length === 8 && attempts.every(result => result === "refused"), attempts.join(","));
    // The audit holds exactly the values that were signed and attested.
    const resolution = closed.reviews[0].resolution;
    assert.deepEqual([resolution.orderId, resolution.reviewId, resolution.reasonCode, resolution.evidence.evidenceId,
        resolution.evidence.digest, resolution.evidence.linkedOrderId],
    [h.reviewed.id, h.id, "DUPLICATE_ORDER", record.evidence.evidenceId, record.evidence.digest, h.twin()]);
});

test("IM/2: the caller changing its own objects during verification changes nothing; non-data is refused", async () => {
    let hook = null;
    const shared = setup({
        verifyEvidence: async (evidence, request) => {
            if (hook) { const run = hook; hook = null; await run(); }
            return syntheticAttestation(evidence, request);
        }
    });
    const h = await inReview("REFUND", shared);
    const record = h.resolution(h.reviewed, h.id, "CLOSE");
    const original = structuredClone(record);
    hook = async () => {
        record.reasonCode = "FRAUD_CONFIRMED";
        record.orderId = "synthetic-other-order";
        record.evidence.evidenceId = "synthetic-swapped-by-caller";
        record.evidence.linkedOrderId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        record.evidence.financialObligation = "OPEN";
    };
    const closed = await h.resolveReview(h.reviewed, "CLOSE", record);
    const resolution = closed.reviews[0].resolution;
    assert.deepEqual([resolution.orderId, resolution.reasonCode, resolution.evidence.evidenceId,
        resolution.evidence.linkedOrderId, resolution.evidence.financialObligation],
    [original.orderId, original.reasonCode, original.evidence.evidenceId, original.evidence.linkedOrderId,
        original.evidence.financialObligation]);
    // Only the attested evidence id was consumed; the id the caller swapped in is still free.
    await assert.rejects(closeAs(shared, (await inReview("REFUND", shared)).reviewed, "DUPLICATE_ORDER",
        { evidence: { evidenceId: original.evidence.evidenceId } }), /EVIDENCE_REFERENCE_USED/);
    const later = await inReview("REFUND", shared);
    assert.equal((await closeAs(shared, later.reviewed, "DUPLICATE_ORDER",
        { evidence: { evidenceId: "synthetic-swapped-by-caller" } })).state, STATES.CLOSED);
    // Functions, getters that throw, and other non-data never reach a check.
    const n = await inReview("DISPUTE");
    const good = n.resolution(n.reviewed, n.id, "CLOSE");
    const throwing = { ...good };
    Object.defineProperty(throwing, "reasonCode", { enumerable: true, get() { throw new Error("synthetic getter"); } });
    for (const resolution of [{ ...good, reasonCode: () => "DISPUTE_RESOLVED_BY_PROVIDER" }, throwing,
        { ...good, evidence: { ...good.evidence, digest: Symbol("digest") } }]) {
        await assert.rejects(n.send(n.reviewed, "resolve_review", "finance", { resolution }, { actorId: good.actorId }),
            /INVALID_COMMAND/);
    }
    // A getter is read once into the core's copy: the decision is judged and recorded on that single value.
    let reads = 0;
    const flipping = { ...good };
    Object.defineProperty(flipping, "reasonCode", {
        enumerable: true, get() { reads += 1; return reads === 1 ? "DISPUTE_RESOLVED_BY_PROVIDER" : "FRAUD_CONFIRMED"; }
    });
    const settled = await n.send(n.reviewed, "resolve_review", "finance", { resolution: flipping }, { actorId: good.actorId });
    assert.deepEqual([reads, settled.reviews[0].resolution.reasonCode], [1, "DISPUTE_RESOLVED_BY_PROVIDER"]);
});

test("BC/1: the decision binding covers every decision and evidence field, derived from the code (F151-07)", async () => {
    const h = await inReview("REFUND");
    const record = h.resolution(h.reviewed, h.id, "CLOSE");
    const bound = new Set(CLOSE_DECISION_FIELDS);
    assert.equal(bound.size, CLOSE_DECISION_FIELDS.length); // no field listed twice
    // Every field of a real CLOSE decision, and every field an evidence reference may carry, is bound;
    // only the signatures themselves are outside the binding they sign.
    for (const key of Object.keys(record).filter(key => key !== "signature" && key !== "evidence")) {
        assert.ok(bound.has(key), `decision field ${key} is not bound`);
    }
    for (const key of CLOSE_EVIDENCE_FIELDS.filter(key => key !== "signature")) {
        assert.ok(bound.has(`evidence.${key}`), `evidence field ${key} is not bound`);
    }
    assert.ok([...bound].every(path => path.split(".").length <= 2 &&
        (!path.includes(".") || path.startsWith("evidence."))));
    // Each listed field changes the binding when changed or removed, one at a time.
    const full = { ...record, evidence: { ...record.evidence, finding: "CONFIRMED" } };
    const base = closeDecisionBinding(full);
    assert.equal(JSON.parse(base).length, CLOSE_DECISION_FIELDS.length + 1);
    for (const path of CLOSE_DECISION_FIELDS) {
        const [head, tail] = path.split(".");
        for (const change of ["tampered", "removed"]) {
            const copy = structuredClone(full);
            const target = tail ? copy[head] : copy;
            const key = tail ?? head;
            if (change === "removed") delete target[key];
            else target[key] = `${target[key]}-tampered`;
            assert.notEqual(closeDecisionBinding(copy), base, `${path} ${change}`);
        }
    }
});

test("BC/2: changing or removing any single bound field after signing is refused and consumes nothing", async () => {
    const h = await inReview("REFUND");
    const signed = h.resolution(h.reviewed, h.id, "CLOSE");
    const resign = evidence => ({ ...evidence, signature: signEvidence(evidence) });
    const codes = {};
    for (const path of CLOSE_DECISION_FIELDS) {
        const [head, tail] = path.split(".");
        for (const change of ["tampered", "removed"]) {
            const copy = structuredClone(signed);
            const target = tail ? copy[head] : copy;
            const key = tail ?? head;
            if (change === "removed") delete target[key];
            else target[key] = key === "finding" ? "CONFIRMED" : `${target[key]}-tampered`;
            // The evidence is re-signed by the evidence service each time, so only the decision signature binds it.
            if (tail) copy.evidence = resign(copy.evidence);
            // Removing a field this decision does not carry (finding on a DUPLICATE_ORDER) is no change at all.
            if (closeDecisionBinding(copy) === closeDecisionBinding(signed)) continue;
            const error = await h.resolveReview(h.reviewed, "CLOSE", copy).then(() => null, e => e);
            assert.ok(error instanceof OrderError, `${path} ${change} was accepted or failed oddly: ${error}`);
            codes[`${path} ${change}`] = error.code;
        }
    }
    // Every bound field was changed at least once; only absent-field removals were skipped.
    assert.deepEqual(new Set(Object.keys(codes).map(entry => entry.split(' ')[0])), new Set(CLOSE_DECISION_FIELDS));
    assert.ok(Object.keys(codes).length >= CLOSE_DECISION_FIELDS.length * 2 - 1);
    // The untouched decision then closes once, on the same history: no audit, right or reference was consumed.
    const closed = await h.resolveReview(h.reviewed, "CLOSE", signed);
    assert.deepEqual([closed.version, closed.revisionsUsed, closed.financialAssessments,
        closed.reviews[0].resolution.authorizationRef, closed.reviews[0].resolution.evidence.evidenceId],
    [h.reviewed.version + 1, h.reviewed.revisionsUsed, [], signed.authorizationRef, signed.evidence.evidenceId]);
    assert.deepEqual(closed.events.slice(0, -1), h.reviewed.events);
});

test("SE/1: synthetic evidence is accepted only in a declared TEST core; bad or missing settings fail safe (F151-04)", async () => {
    // The flag outside TEST, or with no environment at all (production by default), stops the core at creation.
    for (const environment of [undefined, "PRODUCTION", "STAGING"]) {
        assert.throws(() => createCore({ allowSyntheticEvidence: true, environment }), /SYNTHETIC_EVIDENCE_NOT_ALLOWED/);
    }
    for (const environment of ["prod", "test", "", null, 1, { name: "TEST" }]) {
        assert.throws(() => createCore({ environment }), /INVALID_ENVIRONMENT/);
    }
    assert.doesNotThrow(() => createCore({ environment: "PRODUCTION" }));
    // A TEST core without the flag, and a production core, refuse the synthetic verifier at the decision.
    for (const overrides of [{ allowSyntheticEvidence: false }, { allowSyntheticEvidence: false, environment: "PRODUCTION" },
        { allowSyntheticEvidence: false, environment: "STAGING" }]) {
        const h = await inReview("DISPUTE", setup(overrides));
        await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
        await assertCanonicalUnchanged(h, h.reviewed);
    }
    // The client cannot switch it on: flags in the command data or on the principal are not configuration.
    const p = await inReview("DISPUTE", setup({ allowSyntheticEvidence: false, environment: "PRODUCTION" }));
    const record = p.resolution(p.reviewed, p.id, "CLOSE");
    await assert.rejects(p.send(p.reviewed, "resolve_review", "finance",
        { resolution: record, allowSyntheticEvidence: true, environment: "TEST" }, { actorId: record.actorId }),
    /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    const principal = { ...p.actor("finance", p.reviewed, SERVER, record.actorId), allowSyntheticEvidence: true,
        environment: "TEST" };
    await assert.rejects(p.core.dispatch(p.reviewed, { kind: "resolve_review", requestId: "synthetic-client-flag",
        expectedVersion: p.reviewed.version, data: { resolution: record }, allowSyntheticEvidence: true,
        environment: "TEST" }, principal), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    await assertCanonicalUnchanged(p, p.reviewed);
    // A production verifier works in a production core; its kind is what the audit records.
    const prod = await inReview("DISPUTE", setup({ allowSyntheticEvidence: false, environment: "PRODUCTION",
        verifyEvidence: productionShaped }));
    const closed = await closeAs(prod, prod.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.equal(closed.reviews[0].resolution.evidence.verifier.kind, "PRODUCTION");
});

test("BC/3: only DUPLICATE_ORDER may name a linked order; any other code carrying one is refused (F151-07)", async () => {
    const h = await inReview("DISPUTE");
    const twin = h.twin();
    await assert.rejects(closeAs(h, h.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER", { evidence: { linkedOrderId: twin } }),
        /EVIDENCE_MISMATCH/);
    for (const code of ["CUSTOMER_WITHDREW_AFTER_SETTLEMENT", "FRAUD_CONFIRMED"]) {
        await assert.rejects(closeAs(h, h.reviewed, code, { evidence: { linkedOrderId: twin } }), /EVIDENCE_MISMATCH/);
    }
    await assertCanonicalUnchanged(h, h.reviewed);
});

// ---- Görev 154 (F153-01): one trusted command and principal snapshot per dispatch ----

const serverAuthorize = principal => principal.auth === SERVER && (principal.actorId === undefined ||
    signatureMatches(principal.session, session(principal.actorId, principal.role)));

// A core whose authorize and evidence verifier can run a hook while the dispatch awaits them.
function hookedSetup() {
    const hooks = { authorize: null, evidence: null, seen: [] };
    const take = name => { const run = hooks[name]; hooks[name] = null; return run; };
    const h = setup({
        authorize: async principal => {
            hooks.seen.push(principal);
            const run = take("authorize");
            if (run) await run();
            return serverAuthorize(principal);
        },
        verifyEvidence: async (evidence, request) => {
            const run = take("evidence");
            if (run) await run();
            return syntheticAttestation(evidence, request);
        }
    });
    return { h, hooks };
}

test("FA/1: the Görev 153 F153-01 attempt: a changed command or principal changes no event, audit or key", async () => {
    const { h: base, hooks } = hookedSetup();
    const h = await inReview("REFUND", base);
    const record = h.resolution(h.reviewed, h.id, "CLOSE");
    const command = { kind: "resolve_review", requestId: "synthetic-f153-close", expectedVersion: h.reviewed.version,
        data: { resolution: record } };
    const principal = { ...h.actor("finance", h.reviewed, SERVER, record.actorId), claims: { team: "finance", level: 1 } };
    hooks.evidence = async () => {
        command.kind = "cancel";
        command.requestId = "synthetic-f153-other";
        command.expectedVersion = 999;
        principal.role = "admin";
        principal.actorId = "synthetic-finance-opener";
        principal.orderId = "synthetic-other-order";
        principal.claims.team = "admin";
        principal.claims.level = 9;
    };
    const closed = await h.core.dispatch(h.reviewed, command, principal);
    assert.deepEqual([command.kind, principal.role, principal.claims.team], ["cancel", "admin", "admin"]); // really changed
    // The event and the audit hold the values that were checked when the dispatch began.
    const event = closed.events.at(-1);
    assert.deepEqual([event.kind, event.requestId, event.role, event.from, event.to, event.sequence],
        ["resolve_review", "synthetic-f153-close", "finance", STATES.REFUND_REVIEW, STATES.CLOSED, h.reviewed.version + 1]);
    assert.deepEqual([event.audit.actorId, event.audit.role, event.audit.actorType, event.audit.idempotencyKey],
        ["synthetic-finance-decider", "finance", "HUMAN", "synthetic-f153-close"]);
    assert.deepEqual(closed.reviews[0].resolution, { ...event.audit, moneyMovement: "NONE" });
    // Four eyes holds in the record: the decider is not the opener.
    assert.notEqual(event.audit.actorId, closed.reviews[0].opening.actorId);
    // Idempotency used the checked request id: it replays, and the swapped-in id was never recorded.
    const replay = await h.core.dispatch(h.reviewed, { kind: "resolve_review", requestId: "synthetic-f153-close",
        expectedVersion: h.reviewed.version, data: { resolution: record } }, h.actor("finance", h.reviewed, SERVER,
        record.actorId));
    assert.strictEqual(replay, closed);
    assert.equal(closed.events.some(item => item.requestId === "synthetic-f153-other"), false);
});

test("FA/2: authorization, roles, four eyes and order binding use the snapshot; changing the caller's objects cannot help", async () => {
    const { h: base, hooks } = hookedSetup();
    const h = await inReview("REFUND", base);
    // The opener tries to decide and swaps in a colleague's id while authorized: still four eyes.
    const byOpener = h.resolution(h.reviewed, h.id, "CONTINUE", { actorId: "synthetic-finance-opener" });
    const opener = h.actor("finance", h.reviewed, SERVER, "synthetic-finance-opener");
    hooks.authorize = async () => { opener.actorId = "synthetic-finance-decider"; };
    await assert.rejects(h.core.dispatch(h.reviewed, { kind: "resolve_review", requestId: "synthetic-f154-four-eyes",
        expectedVersion: h.reviewed.version, data: { resolution: byOpener } }, opener), /FOUR_EYES_VIOLATION/);
    // An admin tries a REFUND (finance only) and switches to finance while authorized: no escalation.
    const adminRecord = h.resolution(h.reviewed, h.id, "REFUND", ADMIN);
    const admin = h.actor("admin", h.reviewed, SERVER, adminRecord.actorId);
    hooks.authorize = async () => { admin.role = "finance"; };
    await assert.rejects(h.core.dispatch(h.reviewed, { kind: "resolve_review", requestId: "synthetic-f154-escalate",
        expectedVersion: h.reviewed.version, data: { resolution: adminRecord } }, admin), /REVIEW_OUTCOME_NOT_PERMITTED/);
    // A stale version made current while authorized is still stale.
    const stale = { kind: "resolve_review", requestId: "synthetic-f154-stale", expectedVersion: h.reviewed.version - 1,
        data: { resolution: h.resolution(h.reviewed, h.id, "CONTINUE") } };
    const staleActor = { ...h.actor("finance", h.reviewed, SERVER, stale.data.resolution.actorId), claims: { team: "x" } };
    hooks.authorize = async () => { stale.expectedVersion = h.reviewed.version; };
    await assert.rejects(h.core.dispatch(h.reviewed, stale, staleActor), /VERSION_CONFLICT/);
    // authorize itself receives the deep-frozen snapshot, never the caller's object.
    const seen = hooks.seen.at(-1);
    assert.ok(seen !== staleActor && Object.isFrozen(seen) && Object.isFrozen(seen.claims) && seen.claims !== staleActor.claims);
    assert.deepEqual(seen, staleActor);
    // None of the refused attempts left a trace on the canonical order.
    await assertCanonicalUnchanged(h, h.reviewed);
    // A customer's order binding is checked on the snapshot too: retargeting while authorized changes nothing.
    const c = await producing("PLUS", {}, base);
    const customer = h.actor("customer", c.order);
    hooks.authorize = async () => { customer.orderId = "synthetic-other-order"; customer.role = "finance"; };
    const requested = await h.core.dispatch(c.order, { kind: "request_revision", requestId: "synthetic-f154-customer",
        expectedVersion: c.order.version, data: {} }, customer);
    assert.deepEqual([requested.state, requested.events.at(-1).role, requested.revisionsUsed],
        [STATES.REVISION_PENDING, "customer", 1]);
});

test("FA/3: a version made stale or current while authorized, and each field read only once", async () => {
    const { h: base, hooks } = hookedSetup();
    const h = await inReview("DISPUTE", base);
    // A current version later overwritten by the caller still counts as current.
    const current = { kind: "resolve_review", requestId: "synthetic-f154-current", expectedVersion: h.reviewed.version,
        data: { resolution: h.resolution(h.reviewed, h.id, "CONTINUE") } };
    hooks.authorize = async () => { current.expectedVersion = 0; current.data.resolution.outcome = "REFUND"; };
    const resumed = await h.core.dispatch(h.reviewed, current, h.actor("finance", h.reviewed, SERVER,
        current.data.resolution.actorId));
    assert.deepEqual([resumed.version, resumed.reviews[0].resolution.outcome, resumed.events.at(-1).requestId],
        [h.reviewed.version + 1, "CONTINUE", "synthetic-f154-current"]);
    // Getters on the command and the principal are read once into the snapshot.
    const g = await inReview("DISPUTE", base);
    const record = g.resolution(g.reviewed, g.id, "CONTINUE");
    let kindReads = 0;
    let roleReads = 0;
    const command = { requestId: "synthetic-f154-getters", expectedVersion: g.reviewed.version, data: { resolution: record } };
    Object.defineProperty(command, "kind", { enumerable: true, get() { kindReads += 1; return kindReads === 1 ? "resolve_review" : "cancel"; } });
    const principal = { ...g.actor("finance", g.reviewed, SERVER, record.actorId) };
    delete principal.role;
    Object.defineProperty(principal, "role", { enumerable: true, get() { roleReads += 1; return roleReads === 1 ? "finance" : "admin"; } });
    const done = await g.core.dispatch(g.reviewed, command, principal);
    assert.deepEqual([kindReads, roleReads, done.events.at(-1).kind, done.events.at(-1).role],
        [1, 1, "resolve_review", "finance"]);
});

test("FA/4: commands and principals that cannot be copied are refused safely and leave no trace", async () => {
    const h = await inReview("DISPUTE");
    const record = h.resolution(h.reviewed, h.id, "CONTINUE");
    const base = { kind: "resolve_review", requestId: "synthetic-f154-bad", expectedVersion: h.reviewed.version,
        data: { resolution: record } };
    const actor = h.actor("finance", h.reviewed, SERVER, record.actorId);
    for (const command of [null, "resolve_review", 7, { ...base, kind: () => "resolve_review" },
        { ...base, requestId: Symbol("id") }, { ...base, data: { resolution: record, extra: () => 1 } }]) {
        await assert.rejects(h.core.dispatch(h.reviewed, command, actor), /INVALID_COMMAND/);
    }
    const throwing = { ...base };
    Object.defineProperty(throwing, "expectedVersion", { enumerable: true, get() { throw new Error("synthetic"); } });
    await assert.rejects(h.core.dispatch(h.reviewed, throwing, actor), /INVALID_COMMAND/);
    for (const principal of [{ ...actor, hook: () => true }, { ...actor, nested: { fn: () => 1 } }, null, "finance"]) {
        await assert.rejects(h.core.dispatch(h.reviewed, base, principal), /UNAUTHORIZED/);
    }
    await assertCanonicalUnchanged(h, h.reviewed);
});

test("FA/5: concurrent CLOSEs sharing one principal object each keep their own snapshot", async () => {
    const { h: base, hooks } = hookedSetup();
    const p = await inReview("DISPUTE", base);
    const record = p.resolution(p.reviewed, p.id, "CLOSE");
    const shared = p.actor("finance", p.reviewed, SERVER, record.actorId);
    hooks.evidence = async () => { shared.role = "admin"; shared.actorId = "synthetic-finance-opener"; };
    const send = requestId => p.core.dispatch(p.reviewed, { kind: "resolve_review", requestId,
        expectedVersion: p.reviewed.version, data: { resolution: record } }, shared);
    const results = await Promise.allSettled([send("synthetic-f154-race-a"), send("synthetic-f154-race-b")]);
    const outcome = results.map(result => (result.status === "fulfilled" ? "CLOSED" : result.reason.code)).sort();
    assert.deepEqual(outcome, ["CLOSED", "VERSION_CONFLICT"]);
    const winner = results.find(result => result.status === "fulfilled").value;
    assert.deepEqual([winner.events.at(-1).role, winner.events.at(-1).audit.actorId],
        ["finance", "synthetic-finance-decider"]);
});

// ---- Görev 159 (K-01 Faz 1): financial case creation ----

const CASE_POLICY = "UNAI-FINANCIAL-CASE-v1.0";

test("K1/1: a REFUND opens exactly one OPEN ORDER_REFUND case on the order, with no amount and no money moved", async () => {
    let paymentChecks = 0;
    const h = await producing("PLUS", {}, setup({
        verifyPayment: proof => { paymentChecks += 1; return signatureMatches(proof.signature, sign(proof)); }
    }));
    const checksBefore = paymentChecks;
    const reviewed = await h.openReview(h.order, "REFUND");
    const refunded = await h.resolveReview(reviewed, "REFUND");
    assert.equal(FINANCIAL_CASE_POLICY.reference, CASE_POLICY);
    assert.deepEqual(FINANCIAL_CASE_POLICY.types, ["ORDER_REFUND", "UNDELIVERED_REVISION"]);
    assert.equal(refunded.financialCases.length, 1);
    const [item] = refunded.financialCases;
    const event = refunded.events.at(-1);
    assert.deepEqual(item, {
        caseId: "case-0001", orderId: refunded.id, caseType: "ORDER_REFUND",
        dedupKey: `${refunded.id}:review-0001:ORDER_REFUND`, status: "OPEN",
        origin: { kind: "REVIEW_RESOLUTION", reviewId: "review-0001", reviewType: "REFUND", outcome: "REFUND",
            eventSequence: event.sequence },
        originDeciderActorId: "synthetic-finance-decider", createdAt: FIXED_TIME,
        createdBy: { actorId: "synthetic-finance-decider", actorType: "HUMAN", role: "finance",
            mechanism: "ON_REVIEW_RESOLUTION" },
        assignedRole: "finance", assignedActorId: null, items: [], evidenceReferences: [], proposal: null,
        decisions: [], closure: null, policyVersion: CASE_POLICY, reviewPolicyReference: POLICY_REFERENCE,
        moneyMovement: "NONE", auditTrail: [{
            step: "OPENED", caseId: "case-0001", orderId: refunded.id, caseType: "ORDER_REFUND",
            actorId: "synthetic-finance-decider", actorType: "HUMAN", role: "finance", at: FIXED_TIME,
            authorizationRef: refunded.reviews[0].resolution.authorizationRef, idempotencyKey: event.requestId,
            policyVersion: CASE_POLICY
        }]
    });
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.auditTrail[0]));
    // No amount and no claim about payment: no money moved, nothing was charged, refunded or announced.
    assert.ok(!JSON.stringify(item).includes("amount"));
    assert.deepEqual([paymentChecks, refunded.paymentReference, refunded.reviews[0].resolution.moneyMovement,
        refunded.notifications, refunded.financialAssessments],
    [checksBefore, h.order.paymentReference, "NONE", h.order.notifications, []]);
});

test("K1/2: a REFUND with an accepted, undelivered revision opens two cases of different types", async () => {
    for (const [type] of REVIEW_TYPES) {
        const h = await pendingRevision("PLUS");
        const refunded = await h.resolveReview(await h.openReview(h.order, type), "REFUND");
        assert.deepEqual(refunded.financialCases.map(item => [item.caseId, item.caseType, item.status, item.items]), [
            ["case-0001", "ORDER_REFUND", "OPEN", []],
            ["case-0002", "UNDELIVERED_REVISION", "OPEN", ["assessment-0001"]]
        ]);
        // The assessment itself is unchanged in shape; the case refers to it.
        assert.deepEqual(refunded.financialAssessments.map(item => [item.assessmentId, item.revisionId, item.status]),
            [["assessment-0001", "revision-0001", "PENDING_FINANCIAL_REVIEW"]]);
        assert.deepEqual(new Set(refunded.financialCases.map(item => item.dedupKey)).size, 2);
        assert.deepEqual([refunded.revisionsUsed, refunded.revisions[0].status], [1, "ACCEPTED"]);
    }
});

test("K1/3,4: a retried REFUND opens no new case; a second case for the same order, review and type cannot arise", async () => {
    const h = await pendingRevision("PLUS");
    const reviewed = await h.openReview(h.order, "REFUND");
    const record = h.resolution(reviewed, reviewed.reviews[0].reviewId, "REFUND");
    const options = { requestId: "synthetic-k1-refund", actorId: record.actorId };
    const refunded = await h.send(reviewed, "resolve_review", "finance", { resolution: record }, options);
    const retried = await h.send(reviewed, "resolve_review", "finance", { resolution: record }, options);
    assert.strictEqual(retried, refunded);
    assert.equal(refunded.financialCases.length, 2);
    // The same request id with different content is a conflict, not a second set of cases.
    await assert.rejects(h.send(refunded, "resolve_review", "finance",
        { resolution: h.resolution(reviewed, reviewed.reviews[0].reviewId, "REFUND") }, options), /IDEMPOTENCY_CONFLICT/);
    // A new request on the decided review, or a new review on the closed order, opens nothing.
    await assert.rejects(h.resolveReview(refunded, "REFUND"), /INVALID_TRANSITION/);
    await assert.rejects(h.openReview(refunded, "REFUND"), /INVALID_TRANSITION/);
    // A CONTINUE opens no case, so a later REFUND on the same order opens its cases under its own review.
    const c = await pendingRevision("PLUS");
    const resumed = await c.resolveReview(await c.openReview(c.order, "DISPUTE"), "CONTINUE");
    assert.deepEqual(resumed.financialCases, []);
    const later = await c.resolveReview(await c.openReview(resumed, "REFUND"), "REFUND");
    assert.deepEqual(later.financialCases.map(item => item.dedupKey), [
        `${later.id}:review-0002:ORDER_REFUND`, `${later.id}:review-0002:UNDELIVERED_REVISION`]);
});

test("K1/5,7,8,9: refused REFUNDs open no case, consume nothing and leave the order as it was", async () => {
    const h = await pendingRevision("PLUS");
    const reviewed = await h.openReview(h.order, "REFUND");
    const id = reviewed.reviews[0].reviewId;
    const other = await pendingRevision("PLUS");
    const otherReviewed = await other.openReview(other.order, "REFUND");
    const authorizationRef = "synthetic-k1-kept-authorization";
    const attempts = [
        // Unauthorized: admin may not REFUND, and other roles may not decide at all.
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND", { ...ADMIN, authorizationRef }),
            "admin"), /REVIEW_OUTCOME_NOT_PERMITTED/],
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND", { authorizationRef }), "creative"),
            /UNAUTHORIZED/],
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND", { authorizationRef }), "customer"),
            /UNAUTHORIZED/],
        // Four eyes: the opener cannot decide.
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND",
            { actorId: "synthetic-finance-opener", authorizationRef })), /FOUR_EYES_VIOLATION/],
        // A decision for another order or another review.
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(otherReviewed, otherReviewed.reviews[0].reviewId, "REFUND",
            { authorizationRef })), /INVALID_REVIEW/],
        [() => h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, "review-0002", "REFUND", { authorizationRef })),
            /INVALID_REVIEW/],
        // A forged signature.
        [() => h.resolveReview(reviewed, "REFUND", { ...h.resolution(reviewed, id, "REFUND", { authorizationRef }),
            signature: "0".repeat(64) }), /UNTRUSTED_REVIEW/]
    ];
    for (const [attempt, error] of attempts) await assert.rejects(attempt(), error);
    // A backwards clock is refused before anything is written.
    h.setNow("2026-10-28T08:00:00.000Z");
    await assert.rejects(h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND", { authorizationRef })),
        /CLOCK_REGRESSION/);
    h.setNow(FIXED_TIME);
    // The valid decision then commits at the same version, with the same authorization, on the same history:
    // its cases are the first and only ones, so no refused attempt left a partial case behind.
    const refunded = await h.resolveReview(reviewed, "REFUND", h.resolution(reviewed, id, "REFUND", { authorizationRef }));
    assert.deepEqual([refunded.version, refunded.financialCases.map(item => item.caseId),
        refunded.financialAssessments.length, refunded.reviews[0].resolution.authorizationRef],
    [reviewed.version + 1, ["case-0001", "case-0002"], 1, authorizationRef]);
    assert.deepEqual(refunded.events.slice(0, -1), reviewed.events);
});

test("K1/6: concurrent REFUNDs on one order open one set of cases; other orders keep their own", async () => {
    const shared = setup();
    const a = await pendingRevision("PLUS", shared);
    const reviewed = await a.openReview(a.order, "REFUND");
    const results = await Promise.allSettled([1, 2].map(() => a.resolveReview(reviewed, "REFUND")));
    assert.deepEqual(results.map(r => (r.status === "fulfilled" ? "REFUNDED" : r.reason.code)).sort(),
        ["REFUNDED", "VERSION_CONFLICT"]);
    const winner = results.find(r => r.status === "fulfilled").value;
    assert.deepEqual(winner.financialCases.map(item => item.caseId), ["case-0001", "case-0002"]);
    // Two orders refunded at the same time each open their own cases, keyed by their own order.
    const b = await producing("PLUS", {}, shared);
    const c = await producing("PLUS", {}, shared);
    const [rb, rc] = await Promise.all([b, c].map(async x => x.resolveReview(await x.openReview(x.order, "REFUND"),
        "REFUND")));
    assert.deepEqual([rb.financialCases[0].orderId, rc.financialCases[0].orderId], [rb.id, rc.id]);
    assert.deepEqual([rb.financialCases.length, rc.financialCases.length], [1, 1]);
});

test("K1/10: CLOSE, CONTINUE and cancel behave as before and open no case", async () => {
    // CLOSE (Görev 147/148 policy unchanged): no case, no case reference in the audit.
    const p = await producing("PLUS");
    const closed = await p.resolveReview(await p.openReview(p.order, "DISPUTE"), "CLOSE");
    assert.deepEqual([closed.state, closed.financialCases, "financialCaseIds" in closed.reviews[0].resolution],
        [STATES.CLOSED, [], false]);
    // D-3 still refuses a CLOSE with an undelivered revision.
    const d = await pendingRevision("PLUS");
    await assert.rejects(d.resolveReview(await d.openReview(d.order, "CANCELLATION"), "CLOSE"), /FINANCIAL_CASE_REQUIRED/);
    // CONTINUE resumes and opens nothing.
    const r = await pendingRevision("PLUS");
    const resumed = await r.resolveReview(await r.openReview(r.order, "REFUND"), "CONTINUE");
    assert.deepEqual([resumed.state, resumed.financialCases], [STATES.REVISION_PENDING, []]);
    // cancel is unchanged: a paid order before production is cancelled with no case (Faz 3, D158-4, not this task).
    const shared = setup();
    const paid = await paidOrder(shared, "START", "k1-cancel");
    const cancelled = await shared.send(paid, "cancel", "finance");
    assert.deepEqual([cancelled.state, cancelled.financialCases, cancelled.paymentReference !== null],
        [STATES.CANCELLED, [], true]);
});

test("K1/11: the decision, its event and the case audit agree; the hash chain holds", async () => {
    const h = await pendingRevision("PLUS");
    const reviewed = await h.openReview(h.order, "CANCELLATION");
    const refunded = await h.resolveReview(reviewed, "REFUND");
    const event = refunded.events.at(-1);
    const resolution = refunded.reviews[0].resolution;
    assert.deepEqual(event.audit.financialCaseIds, ["case-0001", "case-0002"]);
    assert.deepEqual(resolution, { ...event.audit, moneyMovement: "NONE" });
    for (const item of refunded.financialCases) {
        const [opening] = item.auditTrail;
        assert.deepEqual([item.origin.eventSequence, item.origin.reviewId, opening.idempotencyKey, opening.at,
            opening.actorId, opening.authorizationRef], [event.sequence, resolution.reviewId, event.requestId, event.at,
            resolution.actorId, resolution.authorizationRef]);
        // The decider is recorded; the review's opener is a different person.
        assert.notEqual(item.originDeciderActorId, refunded.reviews[0].opening.actorId);
    }
    for (let i = 1; i < refunded.events.length; i++) {
        assert.equal(refunded.events[i].previousHash, refunded.events[i - 1].hash);
    }
});

// ---- Görev 164 (K-01 Faz 2): taking a financial case for review (OPEN → UNDER_REVIEW only) ----

const caseRef = (order, caseId = "case-0001") => ({ orderId: order.id, caseId });
const caseDigest = cases => createHash("sha256").update(JSON.stringify(cases)).digest("hex");

/** A REFUND with an accepted, undelivered revision: an ORDER_REFUND and an UNDELIVERED_REVISION case, both OPEN. */
async function refundedCases(h = setup()) {
    const p = await pendingRevision("PLUS", h);
    const refunded = await p.resolveReview(await p.openReview(p.order, "REFUND"), "REFUND");
    return { ...p, refunded };
}

function takeCase(h, order, ref = caseRef(order), role = "finance", options = {}) {
    return h.send(order, "take_case", role, { caseRef: ref },
        { ...options, actorId: Object.hasOwn(options, "actorId") ? options.actorId : `synthetic-${role}-case-reviewer` });
}

test("K2/1: finance takes an OPEN case for review; only that case changes and nothing is decided or paid", async () => {
    const h = await refundedCases();
    const taken = await takeCase(h, h.refunded);
    const [item, other] = taken.financialCases;
    const event = taken.events.at(-1);
    assert.deepEqual([item.status, item.assignedActorId, item.assignedRole],
        ["UNDER_REVIEW", "synthetic-finance-case-reviewer", "finance"]);
    assert.deepEqual(item.auditTrail, [h.refunded.financialCases[0].auditTrail[0], {
        step: "TAKEN_FOR_REVIEW", caseId: "case-0001", orderId: taken.id, caseType: "ORDER_REFUND", from: "OPEN",
        to: "UNDER_REVIEW", actorId: "synthetic-finance-case-reviewer", actorType: "HUMAN", role: "finance", at: FIXED_TIME,
        idempotencyKey: event.requestId, policyVersion: CASE_POLICY
    }]);
    assert.deepEqual(event.audit, item.auditTrail[1]);
    assert.deepEqual([event.kind, event.role, event.from, event.to, taken.version],
        ["take_case", "finance", STATES.CLOSED, STATES.CLOSED, h.refunded.version + 1]);
    // Everything except the taken case's status, assignee and trail is as it was.
    assert.deepEqual(other, h.refunded.financialCases[1]);
    const strip = ({ status, assignedActorId, auditTrail, ...rest }) => rest;
    assert.deepEqual(strip(item), strip(h.refunded.financialCases[0]));
    assert.deepEqual([taken.state, taken.reviews, taken.revisions, taken.revisionsUsed, taken.financialAssessments,
        taken.notifications, taken.paymentReference], [h.refunded.state, h.refunded.reviews, h.refunded.revisions,
        h.refunded.revisionsUsed, h.refunded.financialAssessments, h.refunded.notifications, h.refunded.paymentReference]);
    assert.ok(taken.financialCases.every(entry => entry.moneyMovement === "NONE" && entry.proposal === null &&
        entry.decisions.length === 0 && entry.closure === null));
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.auditTrail[1]));
    // The second case is taken separately.
    const both = await takeCase(h, taken, caseRef(taken, "case-0002"));
    assert.deepEqual(both.financialCases.map(entry => entry.status), ["UNDER_REVIEW", "UNDER_REVIEW"]);
});

test("K2/2: admin may take a case (D158-1); other roles, missing, forged and SYSTEM identities are refused", async () => {
    const h = await refundedCases();
    const attempts = [
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "creative"), /UNAUTHORIZED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "scheduler"), /UNAUTHORIZED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "customer"), /UNAUTHORIZED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "finance", { actorId: undefined }), /ACTOR_REQUIRED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "finance", { actorId: "SYSTEM-case-reviewer" }),
            /RESERVED_ACTOR/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "finance", { actorId: "short" }), /ACTOR_REQUIRED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "finance",
            { session: session("synthetic-other", "finance") }), /UNAUTHORIZED/],
        [() => takeCase(h, h.refunded, caseRef(h.refunded), "finance", { auth: Symbol("browser") }), /UNAUTHORIZED/]
    ];
    for (const [attempt, error] of attempts) await assert.rejects(attempt(), error);
    const byAdmin = await takeCase(h, h.refunded, caseRef(h.refunded), "admin");
    assert.deepEqual([byAdmin.financialCases[0].status, byAdmin.financialCases[0].assignedActorId,
        byAdmin.events.at(-1).audit.role], ["UNDER_REVIEW", "synthetic-admin-case-reviewer", "admin"]);
});

test("K2/3: proposing, approving, rejecting and closing are not active; the approval rules stay a design contract", async () => {
    // Görev 206 (DQ-203-01): add_case_evidence is registered (TEST only); it decides nothing.
    assert.deepEqual(FINANCIAL_CASE_POLICY.transitions, {
        take_case: { from: "OPEN", to: "UNDER_REVIEW", roles: ["finance", "admin"] },
        add_case_evidence: { from: "UNDER_REVIEW", to: "UNDER_REVIEW", roles: ["finance", "admin"] }
    });
    assert.deepEqual(FINANCIAL_CASE_POLICY.approval, {
        status: "NOT_ACTIVE", roles: ["finance"], excludedActors: ["REVIEW_OPENER", "REVIEW_RESOLVER", "PROPOSER"]
    });
    assert.ok(Object.isFrozen(FINANCIAL_CASE_POLICY.approval.excludedActors));
    const h = await refundedCases();
    const taken = await takeCase(h, h.refunded);
    for (const kind of ["propose_case_decision", "decide_case", "approve_case", "reject_case", "rework_case",
        "close_case", "supersede_case"]) {
        for (const role of ["finance", "admin"]) {
            await assert.rejects(h.send(taken, kind, role, { caseRef: caseRef(taken) },
                { actorId: "synthetic-finance-approver" }), /UNKNOWN_ACTION/);
        }
    }
    // No case can reach DECISION_PENDING, APPROVED, REJECTED or CLOSED, so APPROVED can never be read as a payment.
    assert.deepEqual(taken.financialCases.map(entry => entry.status), ["UNDER_REVIEW", "OPEN"]);
});

test("K2/4: the case is found in the canonical order only; a wrong order or case reference is refused", async () => {
    const shared = setup();
    const a = await refundedCases(shared);
    const b = await refundedCases(shared);
    // Both orders have a case-0001 (F160-01): the reference must name its own order.
    const attempts = [
        [caseRef(b.refunded), /INVALID_CASE_REFERENCE/],
        [{ caseId: "case-0001" }, /INVALID_CASE_REFERENCE/],
        [{ orderId: a.refunded.id, caseId: 1 }, /INVALID_CASE_REFERENCE/],
        [null, /INVALID_CASE_REFERENCE/],
        [caseRef(a.refunded, "case-0003"), /UNKNOWN_CASE/],
        [caseRef(a.refunded, "__proto__"), /UNKNOWN_CASE/]
    ];
    for (const [ref, error] of attempts) await assert.rejects(takeCase(a, a.refunded, ref), error);
    // A forged snapshot cannot add a case: only the canonical record is read.
    const forged = { ...a.refunded, financialCases: [{ caseId: "case-0009", status: "OPEN" }] };
    await assert.rejects(takeCase(a, forged, caseRef(a.refunded, "case-0009")), /UNKNOWN_CASE/);
    // An order with no case: a live order is refused by state, a CLOSE-d one has no case to take.
    const live = await producing("PLUS", {}, shared);
    await assert.rejects(takeCase(live, live.order), /INVALID_TRANSITION/);
    const closed = await live.resolveReview(await live.openReview(live.order, "DISPUTE"), "CLOSE");
    await assert.rejects(takeCase(live, closed), /UNKNOWN_CASE/);
    // None of this touched either order: each takes its own case-0001 now, on an unchanged version.
    const takenA = await takeCase(a, a.refunded);
    const takenB = await takeCase(b, b.refunded);
    assert.deepEqual([takenA.version, takenB.version], [a.refunded.version + 1, b.refunded.version + 1]);
    assert.deepEqual([takenA.financialCases[0].orderId, takenB.financialCases[0].orderId], [a.refunded.id, b.refunded.id]);
});

test("K2/5: a case under review cannot be taken again, by the same or another person or role", async () => {
    const h = await refundedCases();
    const taken = await takeCase(h, h.refunded);
    for (const [role, actorId] of [["finance", "synthetic-finance-case-reviewer"], ["finance", "synthetic-finance-other"],
        ["admin", "synthetic-admin-case-reviewer"]]) {
        await assert.rejects(takeCase(h, taken, caseRef(taken), role, { actorId }), /CASE_STATE_INVALID/);
    }
});

test("K2/6: version, retry and request conflicts are enforced", async () => {
    const h = await refundedCases();
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "finance", { version: h.refunded.version - 1 }),
        /VERSION_CONFLICT/);
    const options = { requestId: "synthetic-k2-take" };
    const taken = await takeCase(h, h.refunded, caseRef(h.refunded), "finance", options);
    // The same request again returns the committed order: no second audit entry and no version step.
    const retried = await takeCase(h, h.refunded, caseRef(h.refunded), "finance", options);
    assert.strictEqual(retried, taken);
    assert.equal(taken.financialCases[0].auditTrail.length, 2);
    // The same request id for another case is a conflict, not a second take.
    await assert.rejects(takeCase(h, taken, caseRef(taken, "case-0002"), "finance", options), /IDEMPOTENCY_CONFLICT/);
    // A stale order after the take is refused.
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded, "case-0002")), /VERSION_CONFLICT/);
});

test("K2/7: concurrent takes commit once; the loser changes nothing", async () => {
    for (const refs of [["case-0001", "case-0001"], ["case-0001", "case-0002"]]) {
        const base = await refundedCases();
        const results = await Promise.allSettled(refs.map((caseId, i) => takeCase(base, base.refunded,
            caseRef(base.refunded, caseId), i === 0 ? "finance" : "admin")));
        assert.deepEqual(results.map(r => (r.status === "fulfilled" ? "TAKEN" : r.reason.code)).sort(),
            ["TAKEN", "VERSION_CONFLICT"]);
        const winner = results.find(r => r.status === "fulfilled").value;
        assert.equal(winner.financialCases.filter(entry => entry.status === "UNDER_REVIEW").length, 1);
        assert.equal(winner.version, base.refunded.version + 1);
    }
});

test("K2/8: refused takes leave no partial change; the valid take then commits on the same history", async () => {
    const h = await refundedCases();
    h.setNow("2026-10-28T08:00:00.000Z");
    await assert.rejects(takeCase(h, h.refunded), /CLOCK_REGRESSION/);
    h.setNow(FIXED_TIME);
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "creative"), /UNAUTHORIZED/);
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded, "case-0007")), /UNKNOWN_CASE/);
    const taken = await takeCase(h, h.refunded);
    assert.equal(taken.version, h.refunded.version + 1);
    assert.deepEqual(taken.events.slice(0, -1), h.refunded.events);
    assert.deepEqual([taken.financialCases[0].auditTrail.length, taken.financialCases[1]],
        [2, h.refunded.financialCases[1]]);
});

test("K2/9: the principal and data are fixed before authorize; later changes cannot reach the case", async () => {
    const { h: base, hooks } = hookedSetup();
    const h = await refundedCases(base);
    const principal = h.actor("finance", h.refunded, SERVER, "synthetic-finance-case-reviewer");
    const command = { kind: "take_case", requestId: "synthetic-k2-snapshot", expectedVersion: h.refunded.version,
        data: { caseRef: caseRef(h.refunded) } };
    hooks.authorize = async () => {
        principal.actorId = "synthetic-finance-decider"; principal.role = "admin";
        command.data.caseRef.caseId = "case-0002"; command.requestId = "synthetic-other";
    };
    const taken = await h.core.dispatch(h.refunded, command, principal);
    assert.deepEqual([taken.financialCases.map(entry => entry.status), taken.financialCases[0].assignedActorId,
        taken.events.at(-1).role, taken.events.at(-1).requestId],
    [["UNDER_REVIEW", "OPEN"], "synthetic-finance-case-reviewer", "finance", "synthetic-k2-snapshot"]);
});

test("K2/10 (F160-03): every event that writes cases commits to their full content in the hash chain", async () => {
    const h = await refundedCases();
    const taken = await takeCase(h, h.refunded);
    assert.equal(h.refunded.events.at(-1).financialCasesDigest, caseDigest(h.refunded.financialCases));
    assert.equal(taken.events.at(-1).financialCasesDigest, caseDigest(taken.financialCases));
    // Events that write no case carry no digest.
    assert.ok(h.refunded.events.slice(0, -1).every(event => !("financialCasesDigest" in event)));
    // The digest is inside the hashed event, and the chain still links.
    for (const event of taken.events) {
        const { hash, ...body } = event;
        assert.equal(hash, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
    }
    for (let i = 1; i < taken.events.length; i++) assert.equal(taken.events[i].previousHash, taken.events[i - 1].hash);
    // A change to any field of any case no longer matches the committed digest.
    const altered = taken.financialCases.map((entry, i) => i === 1 ? { ...entry, assignedActorId: "synthetic-x" } : entry);
    assert.notEqual(caseDigest(altered), taken.events.at(-1).financialCasesDigest);
});

test("K2/11: REFUND case creation, CLOSE, D-3 and cancel are unchanged; no money moves", async () => {
    const h = await refundedCases();
    assert.deepEqual(h.refunded.financialCases.map(entry => [entry.caseId, entry.caseType, entry.status]),
        [["case-0001", "ORDER_REFUND", "OPEN"], ["case-0002", "UNDELIVERED_REVISION", "OPEN"]]);
    assert.deepEqual(h.refunded.reviews[0].resolution.financialCaseIds, ["case-0001", "case-0002"]);
    const d = await pendingRevision("PLUS");
    await assert.rejects(d.resolveReview(await d.openReview(d.order, "CANCELLATION"), "CLOSE"), /FINANCIAL_CASE_REQUIRED/);
    const shared = setup();
    const paid = await paidOrder(shared, "START", "k2-cancel");
    const cancelled = await shared.send(paid, "cancel", "finance");
    assert.deepEqual([cancelled.state, cancelled.financialCases], [STATES.CANCELLED, []]);
    await assert.rejects(takeCase(shared, cancelled), /INVALID_TRANSITION/);
    const taken = await takeCase(h, h.refunded);
    assert.ok(!JSON.stringify(taken.financialCases).includes("amount"));
    assert.deepEqual([taken.reviews[0].resolution.moneyMovement, taken.notifications], ["NONE", h.refunded.notifications]);
});

// ---- Görev 167 (F166-01): case commands run only in a core the server configured as TEST ----

// A core as a live server would start it: no synthetic evidence, and the environment given (or left out).
const liveSetup = environment => setup({ allowSyntheticEvidence: false, environment });

test("K3/1: TEST accepts take_case; PRODUCTION, STAGING and a missing environment refuse it", async () => {
    const inTest = await refundedCases(liveSetup("TEST"));
    assert.equal((await takeCase(inTest, inTest.refunded)).financialCases[0].status, "UNDER_REVIEW");
    for (const environment of ["PRODUCTION", "STAGING", undefined]) {
        const h = await refundedCases(liveSetup(environment));
        // Case creation itself is unchanged in every environment.
        assert.deepEqual(h.refunded.financialCases.map(entry => [entry.caseType, entry.status]),
            [["ORDER_REFUND", "OPEN"], ["UNDELIVERED_REVISION", "OPEN"]]);
        for (const role of ["finance", "admin"]) {
            await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), role), /CASE_COMMAND_NOT_ENABLED/,
                String(environment));
        }
    }
});

test("K3/2: an unknown environment never starts a core, so no case command can run in it", () => {
    for (const environment of ["test", "Test", "prod", "", null, 1, true, {}, ["TEST"], "TEST "]) {
        assert.throws(() => createCore({ environment }), /INVALID_ENVIRONMENT/, String(environment));
    }
});

test("K3/3: a TEST claim in the command, its data or the principal cannot open the gate", async () => {
    const h = await refundedCases(liveSetup("PRODUCTION"));
    const claims = { environment: "TEST", allowSyntheticEvidence: true, caseCommandsEnabled: true };
    const attempts = [
        // In the command envelope and in the data next to the case reference.
        { command: { ...claims }, data: { caseRef: caseRef(h.refunded), ...claims }, principal: {} },
        // Inside the case reference itself.
        { command: {}, data: { caseRef: { ...caseRef(h.refunded), ...claims } }, principal: {} },
        // On the authenticated principal.
        { command: {}, data: { caseRef: caseRef(h.refunded) }, principal: { ...claims } }
    ];
    for (const [i, { command, data, principal }] of attempts.entries()) {
        await assert.rejects(h.core.dispatch(h.refunded, {
            kind: "take_case", requestId: `synthetic-k3-claim-${i}`, expectedVersion: h.refunded.version, data, ...command
        }, { ...h.actor("finance", h.refunded, SERVER, "synthetic-finance-case-reviewer"), ...principal }),
        /CASE_COMMAND_NOT_ENABLED/);
    }
});

test("K3/4: role, identity and version are still checked first; the gate adds a refusal, never an opening", async () => {
    const h = await refundedCases(liveSetup("PRODUCTION"));
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "creative"), /UNAUTHORIZED/);
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "customer"), /UNAUTHORIZED/);
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "finance",
        { session: session("synthetic-other", "finance") }),
        /UNAUTHORIZED/);
    await assert.rejects(takeCase(h, h.refunded, caseRef(h.refunded), "finance", { version: h.refunded.version - 1 }),
        /VERSION_CONFLICT/);
    // Wrong order or case: refused by the gate before the reference is read; nothing is learnt about other orders.
    const other = await refundedCases(liveSetup("PRODUCTION"));
    for (const ref of [caseRef(other.refunded), caseRef(h.refunded, "case-0009"), null]) {
        await assert.rejects(takeCase(h, h.refunded, ref), /CASE_COMMAND_NOT_ENABLED/);
    }
    // In TEST the same wrong references keep their own codes.
    const t = await refundedCases(liveSetup("TEST"));
    await assert.rejects(takeCase(t, t.refunded, caseRef(other.refunded)), /INVALID_CASE_REFERENCE/);
    await assert.rejects(takeCase(t, t.refunded, caseRef(t.refunded, "case-0009")), /UNKNOWN_CASE/);
});

test("K3/5: a refused take changes nothing, records no request id and leaves the version usable", async () => {
    const h = await refundedCases(liveSetup("PRODUCTION"));
    const before = h.refunded;
    const options = { requestId: "synthetic-k3-refused" };
    // The same request twice, and two at once: each is refused on its own; no event, audit or idempotency entry is left.
    await assert.rejects(takeCase(h, before, caseRef(before), "finance", options), /CASE_COMMAND_NOT_ENABLED/);
    await assert.rejects(takeCase(h, before, caseRef(before), "finance", options), /CASE_COMMAND_NOT_ENABLED/);
    const concurrent = await Promise.allSettled([1, 2].map(i => takeCase(h, before, caseRef(before, `case-000${i}`),
        i === 1 ? "finance" : "admin")));
    assert.deepEqual(concurrent.map(r => r.reason?.code), ["CASE_COMMAND_NOT_ENABLED", "CASE_COMMAND_NOT_ENABLED"]);
    // Still the same version: a stale attempt would say VERSION_CONFLICT instead.
    await assert.rejects(takeCase(h, before, caseRef(before), "finance", { version: before.version }),
        /CASE_COMMAND_NOT_ENABLED/);
    assert.ok(Object.isFrozen(before));
    assert.deepEqual([before.financialCases.map(entry => [entry.status, entry.assignedActorId, entry.auditTrail.length]),
        before.events.at(-1).kind, before.events.at(-1).financialCasesDigest],
    [[["OPEN", null, 1], ["OPEN", null, 1]], "resolve_review", caseDigest(before.financialCases)]);
    for (let i = 1; i < before.events.length; i++) assert.equal(before.events[i].previousHash, before.events[i - 1].hash);
});

test("K3/6: in TEST the gate changes nothing for retries and concurrency", async () => {
    const h = await refundedCases(liveSetup("TEST"));
    const options = { requestId: "synthetic-k3-take" };
    const taken = await takeCase(h, h.refunded, caseRef(h.refunded), "finance", options);
    assert.strictEqual(await takeCase(h, h.refunded, caseRef(h.refunded), "finance", options), taken);
    const base = await refundedCases(liveSetup("TEST"));
    const results = await Promise.allSettled(["finance", "admin"].map(role => takeCase(base, base.refunded,
        caseRef(base.refunded), role)));
    assert.deepEqual(results.map(r => (r.status === "fulfilled" ? "TAKEN" : r.reason.code)).sort(),
        ["TAKEN", "VERSION_CONFLICT"]);
    assert.equal(taken.events.at(-1).financialCasesDigest, caseDigest(taken.financialCases));
});

test("K3/7: REFUND cases, CLOSE and cancel behave as before in a PRODUCTION core; no money moves", async () => {
    const h = await refundedCases(liveSetup("PRODUCTION"));
    assert.deepEqual([h.refunded.state, h.refunded.reviews[0].resolution.financialCaseIds,
        h.refunded.reviews[0].resolution.moneyMovement], [STATES.CLOSED, ["case-0001", "case-0002"], "NONE"]);
    assert.ok(h.refunded.financialCases.every(entry => entry.moneyMovement === "NONE" && !("amountKurus" in entry)));
    const d = await pendingRevision("PLUS", liveSetup("PRODUCTION"));
    await assert.rejects(d.resolveReview(await d.openReview(d.order, "CANCELLATION"), "CLOSE"), /FINANCIAL_CASE_REQUIRED/);
    const shared = liveSetup("PRODUCTION");
    const paid = await paidOrder(shared, "START", "k3-cancel");
    const cancelled = await shared.send(paid, "cancel", "finance");
    assert.deepEqual([cancelled.state, cancelled.financialCases, cancelled.paymentReference], [STATES.CANCELLED, [],
        paid.paymentReference]);
});

// ---- Görev 169 (F168-01): one central case gate; (F168-02): trusted settings are own data properties only ----

const CASE_COMMANDS = Object.keys(FINANCIAL_CASE_POLICY.transitions);

/** Dispatches a case command of any registered kind with a valid finance/admin identity, as take_case would be sent. */
function sendCase(h, order, kind, role, requestId) {
    return h.core.dispatch(order, { kind, requestId, expectedVersion: order.version, data: { caseRef: caseRef(order) } },
        h.actor(role, order, SERVER, `synthetic-${role}-case-reviewer`));
}

let probes = 0;
/** Nothing was committed since `snapshot`: the canonical version is still exactly snapshot.version. One version
 * ahead is stale (VERSION_CONFLICT); in a non-TEST core the snapshot's own version passes on to the gate. */
async function assertNoCommit(h, snapshot, gated = true) {
    assert.ok(Object.isFrozen(snapshot));
    const ahead = { ...snapshot, version: snapshot.version + 1 };
    await assert.rejects(sendCase(h, ahead, "take_case", "finance", `synthetic-probe-${++probes}`), /VERSION_CONFLICT/);
    if (gated) {
        await assert.rejects(sendCase(h, snapshot, "take_case", "finance", `synthetic-probe-${++probes}`),
            /CASE_COMMAND_NOT_ENABLED/);
    }
}

test("CG/1: the gate is driven by the registry: every registered case command, for every role, is refused outside TEST", async () => {
    assert.deepEqual(CASE_COMMANDS, ["take_case", "add_case_evidence"]);
    for (const environment of ["PRODUCTION", "STAGING", undefined]) {
        const h = await refundedCases(liveSetup(environment));
        for (const kind of CASE_COMMANDS) {
            for (const role of FINANCIAL_CASE_POLICY.transitions[kind].roles) {
                await assert.rejects(sendCase(h, h.refunded, kind, role, `synthetic-cg1-${kind}-${role}`),
                    /CASE_COMMAND_NOT_ENABLED/, `${kind}/${role}/${environment}`);
            }
        }
        await assertNoCommit(h, h.refunded);
    }
    // In TEST every registered command reaches its own code (it is not refused by the gate).
    for (const kind of CASE_COMMANDS) {
        const t = await refundedCases(liveSetup("TEST"));
        const role = FINANCIAL_CASE_POLICY.transitions[kind].roles[0];
        // Görev 206 (DQ-203-01): add_case_evidence reaches its own code as well; a caseRef alone is not a submission, so
        // its own first check refuses it, never the gate.
        if (kind === "add_case_evidence") {
            await assert.rejects(sendCase(t, t.refunded, kind, role, `synthetic-cg1-test-${kind}`), /INVALID_CASE_REFERENCE/);
            continue;
        }
        const done = await sendCase(t, t.refunded, kind, role, `synthetic-cg1-test-${kind}`);
        assert.equal(done.events.at(-1).kind, kind);
    }
});

test("CG/2: the registry is the only door: it is frozen, read by own key only, and look-alike names stay unknown", async () => {
    assert.ok(Object.isFrozen(FINANCIAL_CASE_POLICY.transitions));
    assert.ok(CASE_COMMANDS.every(kind => Object.isFrozen(FINANCIAL_CASE_POLICY.transitions[kind])));
    assert.throws(() => {
        FINANCIAL_CASE_POLICY.transitions.reassign_case = { from: "OPEN", to: "OPEN", roles: ["finance"] };
    }, TypeError);
    assert.ok(!Object.hasOwn(FINANCIAL_CASE_POLICY.transitions, "reassign_case"));
    for (const environment of ["TEST", "PRODUCTION"]) {
        const h = await refundedCases(liveSetup(environment));
        // Name-prefix or suffix look-alikes and prototype keys are not case commands and not commands at all.
        for (const kind of ["reassign_case", "take_case_now", "case_take", "propose_case", "approve_case", "close_case",
            "__proto__", "constructor", "toString", "hasOwnProperty", "TAKE_CASE", ""]) {
            await assert.rejects(sendCase(h, h.refunded, kind, "finance", `synthetic-cg2-${environment}-${kind || "empty"}`),
                /UNKNOWN_ACTION/, `${environment}/${kind}`);
        }
        // A command polluted onto Object.prototype is not registered and stays unknown.
        Object.prototype.reassign_case = { from: "OPEN", to: "UNDER_REVIEW", roles: ["finance", "admin"] };
        try {
            await assert.rejects(sendCase(h, h.refunded, "reassign_case", "finance", `synthetic-cg2-${environment}-polluted`),
                /UNKNOWN_ACTION/);
        } finally {
            delete Object.prototype.reassign_case;
        }
        await assertNoCommit(h, h.refunded, environment !== "TEST");
    }
});

test("CG/3: refused case commands leave state, events, audit and the hash chain untouched; the version stays usable", async () => {
    const h = await refundedCases(liveSetup("PRODUCTION"));
    const before = h.refunded;
    const digestBefore = caseDigest(before.financialCases);
    const attempts = [
        [() => takeCase(h, before), /CASE_COMMAND_NOT_ENABLED/],
        [() => takeCase(h, before, caseRef(before), "creative"), /UNAUTHORIZED/],
        [() => takeCase(h, before, caseRef(before), "customer"), /UNAUTHORIZED/],
        [() => takeCase(h, before, caseRef(before), "finance", { version: before.version + 1 }), /VERSION_CONFLICT/],
        [() => takeCase(h, before, { orderId: "synthetic-other-order", caseId: "case-0001" }), /CASE_COMMAND_NOT_ENABLED/]
    ];
    for (const [attempt, code] of attempts) await assert.rejects(attempt(), code);
    await assertNoCommit(h, before);
    assert.equal(caseDigest(before.financialCases), digestBefore);
    assert.equal(before.events.at(-1).financialCasesDigest, digestBefore);
    for (let i = 1; i < before.events.length; i++) assert.equal(before.events[i].previousHash, before.events[i - 1].hash);
    // In TEST: unauthorized roles and a wrong order or case id are still refused, and a valid take then commits on top.
    const t = await refundedCases(liveSetup("TEST"));
    const other = await refundedCases(liveSetup("TEST"));
    await assert.rejects(takeCase(t, t.refunded, caseRef(t.refunded), "scheduler"), /UNAUTHORIZED/);
    await assert.rejects(takeCase(t, t.refunded, caseRef(other.refunded)), /INVALID_CASE_REFERENCE/);
    await assert.rejects(takeCase(t, t.refunded, { orderId: t.refunded.id, caseId: "case-0099" }), /UNKNOWN_CASE/);
    await assertNoCommit(t, t.refunded, false);
    const taken = await takeCase(t, t.refunded);
    assert.equal(taken.version, t.refunded.version + 1);
    assert.equal(taken.events.at(-1).previousHash, t.refunded.events.at(-1).hash);
    assert.equal(taken.events.at(-1).financialCasesDigest, caseDigest(taken.financialCases));
});

test("CG/4: REFUND case creation, CLOSE and cancel pass the gate in every environment, as before", async () => {
    for (const environment of ["PRODUCTION", "STAGING", undefined, "TEST"]) {
        const h = await refundedCases(liveSetup(environment));
        assert.deepEqual(h.refunded.financialCases.map(entry => [entry.caseId, entry.caseType, entry.status]),
            [["case-0001", "ORDER_REFUND", "OPEN"], ["case-0002", "UNDELIVERED_REVISION", "OPEN"]]);
        assert.equal(h.refunded.events.at(-1).financialCasesDigest, caseDigest(h.refunded.financialCases));
        const shared = liveSetup(environment);
        const paid = await paidOrder(shared, "START", `cg4-cancel-${environment}`);
        const cancelled = await shared.send(paid, "cancel", "finance");
        assert.deepEqual([cancelled.state, cancelled.financialCases], [STATES.CANCELLED, []]);
    }
    const prod = await inReview("DISPUTE", setup({ allowSyntheticEvidence: false, environment: "PRODUCTION",
        verifyEvidence: productionShaped }));
    const closed = await closeAs(prod, prod.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.deepEqual([closed.state, closed.financialCases], [STATES.CLOSED, []]);
});

test("OC/1: an environment or synthetic flag inherited from the configuration's prototype is never taken (F168-02)", async () => {
    // Inherited TEST: the core is PRODUCTION, so case commands are refused.
    const h = await refundedCases(setup({ allowSyntheticEvidence: false }, { environment: "TEST" }));
    await assert.rejects(takeCase(h, h.refunded), /CASE_COMMAND_NOT_ENABLED/);
    await assertNoCommit(h, h.refunded);
    // Inherited flag with an own TEST environment: the synthetic verifier is still not allowed.
    const s = await inReview("DISPUTE", setup({ environment: "TEST" }, { allowSyntheticEvidence: true }));
    await assert.rejects(closeAs(s, s.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    await assertCanonicalUnchanged(s, s.reviewed);
    // Both inherited: a PRODUCTION core without the flag (no creation error, nothing enabled).
    const both = await refundedCases(setup({ verifyEvidence: productionShaped }, { environment: "TEST",
        allowSyntheticEvidence: true }));
    await assert.rejects(takeCase(both, both.refunded), /CASE_COMMAND_NOT_ENABLED/);
    // Global Object.prototype pollution: same result; nothing is read through the prototype chain.
    Object.prototype.environment = "TEST";
    Object.prototype.allowSyntheticEvidence = true;
    try {
        assert.doesNotThrow(() => createCore({}));
        const g = await refundedCases(setup({ allowSyntheticEvidence: false }, { environment: "PRODUCTION" }));
        await assert.rejects(takeCase(g, g.refunded), /CASE_COMMAND_NOT_ENABLED/);
        const gs = await inReview("DISPUTE", setup({ environment: "TEST" }, { allowSyntheticEvidence: false }));
        await assert.rejects(closeAs(gs, gs.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    } finally {
        delete Object.prototype.environment;
        delete Object.prototype.allowSyntheticEvidence;
    }
});

test("OC/2: only an own, primitive TEST opens TEST; boxed, accessor and unknown values are refused (F168-02)", async () => {
    // Own-property TEST is accepted.
    const own = await refundedCases(setup({ allowSyntheticEvidence: false, environment: "TEST" }));
    assert.equal((await takeCase(own, own.refunded)).financialCases[0].status, "UNDER_REVIEW");
    // Missing or undefined is PRODUCTION.
    assert.doesNotThrow(() => createCore({}));
    assert.doesNotThrow(() => createCore({ environment: undefined }));
    assert.throws(() => createCore({ environment: undefined, allowSyntheticEvidence: true }), /SYNTHETIC_EVIDENCE_NOT_ALLOWED/);
    // Boxed strings and other look-alikes never start a core.
    for (const environment of [new String("TEST"), Object("PRODUCTION"), { toString: () => "TEST" },
        { valueOf: () => "TEST" }, ["TEST"], "TEST\u0000", "ＴＥＳＴ", "TEST ", " TEST", "test", "QA",
        "DEV", "LOCAL"]) {
        assert.throws(() => createCore({ environment }), /INVALID_ENVIRONMENT/, String(environment));
    }
    // A boxed true flag is not true: the core starts without synthetic evidence.
    const flagged = await inReview("DISPUTE", setup({ environment: "TEST", allowSyntheticEvidence: new Boolean(true) }));
    await assert.rejects(closeAs(flagged, flagged.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER"), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    // An own accessor is not a data value: it is refused, and its getter is never called.
    let reads = 0;
    assert.throws(() => createCore(Object.defineProperty({}, "environment",
        { enumerable: true, get: () => { reads += 1; return "TEST"; } })), /INVALID_ENVIRONMENT/);
    assert.throws(() => createCore(Object.defineProperty({ environment: "TEST" }, "allowSyntheticEvidence",
        { enumerable: true, get: () => { reads += 1; return true; } })), /SYNTHETIC_EVIDENCE_NOT_ALLOWED/);
    assert.equal(reads, 0);
});

// ---- Görev 170: regression lock for the central case gate (entry: CASE_COMMAND_NOT_ENABLED, exit: _NOT_REGISTERED) ----
//
// The production core has one case command and no command that rewrites existing cases, so the two central checks can
// only be exercised by commands that do not exist yet. These tests build a temporary copy of the core that sits next to
// this file, OUTSIDE the repository (os.tmpdir()), add controlled probe commands to it, and drive them through the
// public createCore/dispatch API. Because the copy is made from the sibling core.mjs at run time, removing or weakening
// either central check in core.mjs makes these tests fail. core.mjs itself is never changed.
//   - probe_rewrite_cases: an UNREGISTERED command (plain roles table + switch) that modifies, deletes, reorders,
//     replaces or appends financial cases according to data.mode. Only "append" (case creation) may commit.
//   - assign_reviewer, reassign_case: REGISTERED case commands (FINANCIAL_CASE_POLICY.transitions) whose bodies carry
//     no gate of their own. "assign_reviewer" deliberately has no "case" or "take" in its name.

const PROBE_KINDS = Object.freeze({ unregistered: "probe_rewrite_cases", registered: ["assign_reviewer", "reassign_case"] });
const REWRITE_MODES = Object.freeze(["modify", "delete", "reorder", "replace", "modify_append", "delete_append"]);
let probeCoreLoad = null;

function inject(source, anchor, insert, where) {
    const count = source.split(anchor).length - 1;
    // A missing or ambiguous anchor is a failure, never a skip: the lock must not silently stop testing.
    assert.equal(count, 1, `probe injection anchor must occur exactly once: ${JSON.stringify(anchor)}`);
    return source.replace(anchor, () => (where === "before" ? insert + anchor : anchor + insert));
}

/** Loads the probe copy of the sibling core.mjs from a fresh temporary directory outside the repository. */
function probeCore() {
    probeCoreLoad ??= (async () => {
        const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        let source = (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
        // The copy shares the real calendar module (the fixtures' calendar instances), never a second copy of it.
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        source = inject(source, "function roleFor(kind, principal) {\n    const roles = {",
            `\n        ${PROBE_KINDS.unregistered}: ["finance", "admin"],`, "after");
        source = inject(source, "transitions: {", PROBE_KINDS.registered.map(kind =>
            ` ${kind}: { from: "OPEN", to: "UNDER_REVIEW", roles: ["finance", "admin"] },`).join(""), "after");
        source = inject(source, `            default: throw new OrderError("UNKNOWN_ACTION");`, `
            case "${PROBE_KINDS.unregistered}": ${PROBE_KINDS.registered.map(kind => `case "${kind}":`).join(" ")} {
                // PROBE ONLY (Görev 170): rewrites cases with no gate of its own.
                const mode = command.kind === "${PROBE_KINDS.unregistered}" ? data.mode : "modify";
                const cases = order.financialCases;
                requireThat(cases.length > 0, "PROBE_NO_CASES");
                const changed = entry => ({ ...entry, status: "UNDER_REVIEW", assignedActorId: principal.actorId ?? "probe" });
                const extra = { ...cases[0], caseId: "case-probe", status: "OPEN" };
                at = serverTime();
                if (mode === "modify") next.financialCases = cases.map((entry, i) => (i === 0 ? changed(entry) : entry));
                else if (mode === "delete") next.financialCases = cases.slice(1);
                else if (mode === "reorder") next.financialCases = [...cases].reverse();
                else if (mode === "replace") next.financialCases = cases.map(entry => structuredClone(entry));
                else if (mode === "append") next.financialCases = [...cases, extra];
                else if (mode === "modify_append") next.financialCases = [...cases.map((entry, i) => (i === 0 ? changed(entry) : entry)), extra];
                else if (mode === "delete_append") next.financialCases = [...cases.slice(1), extra, extra];
                else throw new OrderError("PROBE_MODE");
                casesChanged = true;
                break;
            }
`, "before");
        const dir = await mkdtemp(join(tmpdir(), "unai-case-gate-probe-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            // Once imported, the module lives in memory; nothing is left on disk.
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return probeCoreLoad;
}

/** A REFUND-ed order (two OPEN cases) on a probe core configured with `environment` (undefined = left out). */
async function probeCases(environment, inherited = null) {
    const probe = await probeCore();
    const overrides = { allowSyntheticEvidence: false };
    if (environment !== "LEAVE_OUT") overrides.environment = environment;
    // LEAVE_OUT removes the key from the configuration altogether (an undefined on the prototype is never read).
    else inherited ??= { environment: undefined };
    return refundedCases(setup(overrides, inherited, probe.createCore));
}

function sendProbe(h, order, kind, { role = "finance", mode, requestId, extra = {}, principal = {} } = {}) {
    return h.core.dispatch(order, { kind, requestId: requestId ?? `synthetic-probe-${kind}-${mode ?? "x"}-${role}`,
        expectedVersion: order.version, data: { caseRef: caseRef(order), ...(mode ? { mode } : {}) }, ...extra },
    { ...h.actor(role, order, SERVER, `synthetic-${role}-probe-actor`), ...principal });
}

/** Proves nothing was committed since `snapshot`: an append (allowed case creation) at exactly snapshot.version, reusing
 * a refused request id, commits as the very next event on top of unchanged state, events, cases and audit trails. */
async function assertUntouchedThenAppend(h, snapshot, reusedRequestId) {
    assert.ok(Object.isFrozen(snapshot));
    const appended = await sendProbe(h, snapshot, PROBE_KINDS.unregistered, { mode: "append", requestId: reusedRequestId });
    assert.equal(appended.version, snapshot.version + 1);
    assert.deepEqual(appended.events.slice(0, -1), snapshot.events);
    assert.equal(appended.events.at(-1).previousHash, snapshot.events.at(-1).hash);
    assert.equal(appended.events.at(-1).requestId, reusedRequestId);
    assert.deepEqual([appended.state, appended.reviews, appended.revisions, appended.financialAssessments,
        appended.notifications, appended.paymentReference], [snapshot.state, snapshot.reviews, snapshot.revisions,
        snapshot.financialAssessments, snapshot.notifications, snapshot.paymentReference]);
    // Existing cases are the very same records (content, status, assignee and audit trail); one case was appended.
    assert.equal(appended.financialCases.length, snapshot.financialCases.length + 1);
    snapshot.financialCases.forEach((entry, i) => assert.strictEqual(appended.financialCases[i], entry));
    assert.equal(appended.events.at(-1).financialCasesDigest, caseDigest(appended.financialCases));
    return appended;
}

test("GL/0: the probe commands exist only in the temporary copy; the real core does not know them", async () => {
    const h = await refundedCases(liveSetup("TEST"));
    for (const kind of [PROBE_KINDS.unregistered, ...PROBE_KINDS.registered]) {
        await assert.rejects(sendProbe(h, h.refunded, kind, { mode: "append" }), /UNKNOWN_ACTION/, kind);
    }
    assert.ok(!PROBE_KINDS.registered.some(kind => Object.hasOwn(FINANCIAL_CASE_POLICY.transitions, kind)));
    const probe = await probeCore();
    assert.deepEqual(Object.keys(probe.FINANCIAL_CASE_POLICY.transitions).sort(),
        [...Object.keys(FINANCIAL_CASE_POLICY.transitions), ...PROBE_KINDS.registered].sort());
});

test("GL/1 (exit): an unregistered command can never modify, delete, reorder or replace existing cases, in any environment", async () => {
    for (const environment of ["PRODUCTION", "STAGING", "LEAVE_OUT", undefined, "TEST"]) {
        const h = await probeCases(environment);
        const before = h.refunded;
        // REFUND case creation still works on this core.
        assert.deepEqual(before.financialCases.map(entry => [entry.caseId, entry.caseType, entry.status]),
            [["case-0001", "ORDER_REFUND", "OPEN"], ["case-0002", "UNDELIVERED_REVISION", "OPEN"]]);
        assert.equal(before.events.at(-1).financialCasesDigest, caseDigest(before.financialCases));
        const digestBefore = caseDigest(before.financialCases);
        for (const mode of REWRITE_MODES) {
            for (const role of ["finance", "admin"]) {
                await assert.rejects(sendProbe(h, before, PROBE_KINDS.unregistered, { mode, role,
                    requestId: `synthetic-gl1-${mode}-${role}` }), /CASE_COMMAND_NOT_REGISTERED/, `${environment}/${mode}/${role}`);
            }
        }
        // Concurrent rewrite attempts are each refused alone.
        const concurrent = await Promise.allSettled(REWRITE_MODES.map(mode => sendProbe(h, before, PROBE_KINDS.unregistered,
            { mode, requestId: `synthetic-gl1-concurrent-${mode}` })));
        assert.ok(concurrent.every(r => r.status === "rejected" && r.reason.code === "CASE_COMMAND_NOT_REGISTERED"));
        assert.equal(caseDigest(before.financialCases), digestBefore);
        // Nothing was committed and no refused request id was recorded: the next commit is v+1 on the same history.
        const appended = await assertUntouchedThenAppend(h, before, "synthetic-gl1-modify-finance");
        // Also after a later commit, existing cases stay protected.
        await assert.rejects(sendProbe(h, appended, PROBE_KINDS.unregistered, { mode: "modify", requestId: "synthetic-gl1-late" }),
            /CASE_COMMAND_NOT_REGISTERED/);
    }
});

test("GL/2 (exit): the exit check sits behind role, authorization and version checks and never blocks REFUND, CLOSE or cancel", async () => {
    const h = await probeCases("PRODUCTION");
    await assert.rejects(sendProbe(h, h.refunded, PROBE_KINDS.unregistered, { mode: "modify", role: "creative" }), /UNAUTHORIZED/);
    await assert.rejects(sendProbe(h, h.refunded, PROBE_KINDS.unregistered, { mode: "modify", role: "customer" }), /UNAUTHORIZED/);
    await assert.rejects(sendProbe(h, { ...h.refunded, version: h.refunded.version + 1 }, PROBE_KINDS.unregistered,
        { mode: "modify" }), /VERSION_CONFLICT/);
    await assertUntouchedThenAppend(h, h.refunded, "synthetic-gl2-append");
    const probe = await probeCore();
    // CLOSE (no case) and cancel on the probe core, in PRODUCTION, behave as on the real core.
    const prod = await inReview("DISPUTE", setup({ allowSyntheticEvidence: false, environment: "PRODUCTION",
        verifyEvidence: productionShaped }, null, probe.createCore));
    const closed = await closeAs(prod, prod.reviewed, "DISPUTE_RESOLVED_BY_PROVIDER");
    assert.deepEqual([closed.state, closed.financialCases], [STATES.CLOSED, []]);
    const shared = setup({ allowSyntheticEvidence: false, environment: "PRODUCTION" }, null, probe.createCore);
    const cancelled = await shared.send(await paidOrder(shared, "START", "gl2-cancel"), "cancel", "finance");
    assert.deepEqual([cancelled.state, cancelled.financialCases], [STATES.CANCELLED, []]);
});

test("GL/3 (entry): registered case commands inherit the gate: refused outside TEST, whatever their name", async () => {
    for (const environment of ["PRODUCTION", "STAGING", "LEAVE_OUT", undefined]) {
        const h = await probeCases(environment);
        for (const kind of PROBE_KINDS.registered) {
            for (const role of ["finance", "admin"]) {
                await assert.rejects(sendProbe(h, h.refunded, kind, { role, requestId: `synthetic-gl3-${kind}-${role}` }),
                    /CASE_COMMAND_NOT_ENABLED/, `${environment}/${kind}/${role}`);
            }
        }
        await assertUntouchedThenAppend(h, h.refunded, `synthetic-gl3-${PROBE_KINDS.registered[0]}-finance`);
    }
    // Positive control: in TEST the same bodies run and really change a case, so the refusals above are the gate's.
    for (const kind of PROBE_KINDS.registered) {
        const t = await probeCases("TEST");
        const done = await sendProbe(t, t.refunded, kind);
        assert.deepEqual([done.financialCases[0].status, done.financialCases[0].assignedActorId, done.events.at(-1).kind],
            ["UNDER_REVIEW", "synthetic-finance-probe-actor", kind]);
        assert.strictEqual(done.financialCases[1], t.refunded.financialCases[1]);
    }
});

test("GL/4 (entry): unknown environments never start; TEST claims from the client, principal or prototype never open the gate", async () => {
    const probe = await probeCore();
    for (const environment of ["test", "Test", "QA", "DEV", "", null, 1, true, {}, ["TEST"], new String("TEST"), "TEST "]) {
        assert.throws(() => probe.createCore({ environment }), /INVALID_ENVIRONMENT/, String(environment));
    }
    const h = await probeCases("PRODUCTION");
    const claims = { environment: "TEST", allowSyntheticEvidence: true, caseCommandsEnabled: true };
    for (const kind of PROBE_KINDS.registered) {
        const attempts = [
            { extra: { ...claims }, principal: {} },
            { extra: { data: { caseRef: { ...caseRef(h.refunded), ...claims }, ...claims } }, principal: {} },
            { extra: {}, principal: { ...claims } }
        ];
        for (const [i, attempt] of attempts.entries()) {
            await assert.rejects(sendProbe(h, h.refunded, kind, { ...attempt, requestId: `synthetic-gl4-${kind}-${i}` }),
                /CASE_COMMAND_NOT_ENABLED/, `${kind}/${i}`);
        }
        // Role and version are still checked first.
        await assert.rejects(sendProbe(h, h.refunded, kind, { role: "creative" }), /UNAUTHORIZED/);
        await assert.rejects(sendProbe(h, { ...h.refunded, version: h.refunded.version - 1 }, kind), /VERSION_CONFLICT/);
    }
    await assertUntouchedThenAppend(h, h.refunded, `synthetic-gl4-${PROBE_KINDS.registered[1]}-0`);
    // A TEST inherited from the configuration's prototype is not TEST.
    const inherited = await probeCases("LEAVE_OUT", { environment: "TEST" });
    for (const kind of PROBE_KINDS.registered) {
        await assert.rejects(sendProbe(inherited, inherited.refunded, kind), /CASE_COMMAND_NOT_ENABLED/);
    }
});

// ---- Görev 177 (K-01 Faz 2B-1, PA-1, F151-05): one evidence digest is consumed at most once in this core ----
//
// The registry holds for one core instance only (a restart, a second instance or a use outside the core is not seen).
// These tests use the CLOSE path; DG/11 locks the shared registry for the future case evidence command through a
// probe copy of core.mjs outside the repository (the Görev 170 technique). Shared helpers:
//   dgDigest(text)            a lowercase hex SHA-256, as the evidence service computes it from content
//   dgRecord(h, p, evidence)  a signed DISPUTE CLOSE record whose evidence carries the given fields, re-signed by the
//                             synthetic evidence service (so "same content under another id" is genuine, not forged)
//   dgClosesCleanly(h, p, r)  closes p.reviewed with r and proves nothing was committed since p.reviewed: version + 1,
//                             same events, same history; used after refusals to show they left no trace

const dgDigest = text => createHash("sha256").update(`synthetic-dg-content-${text}`).digest("hex");
const dgResign = evidence => ({ ...evidence, signature: signEvidence(evidence) });
const DG_CODE = "DISPUTE_RESOLVED_BY_PROVIDER";

function dgRecord(h, p, evidence = {}) {
    return h.resolution(p.reviewed, p.id, "CLOSE", h.closeFields(p.reviewed, p.id, DG_CODE, evidence));
}

async function dgClosesCleanly(h, p, record, options = {}) {
    const closed = await h.resolveReview(p.reviewed, "CLOSE", record, "finance", options);
    assert.equal(closed.state, STATES.CLOSED);
    assert.equal(closed.version, p.reviewed.version + 1);
    assert.deepEqual(closed.events.slice(0, -1), p.reviewed.events);
    assert.equal(closed.events.at(-1).previousHash, p.reviewed.events.at(-1).hash);
    assert.equal(closed.reviews.at(-1).resolution.evidence.digest, record.evidence.digest);
    return closed;
}

test("DG/1: a new, attested digest closes; the stored digest is the attested one; other digests stay free", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const record = dgRecord(shared, a, { digest: dgDigest("dg1-a") });
    const closed = await dgClosesCleanly(shared, a, record);
    assert.deepEqual([closed.reviews[0].resolution.evidence.digest, closed.events.at(-1).audit.evidence.digest],
        [dgDigest("dg1-a"), dgDigest("dg1-a")]);
    const b = await inReview("DISPUTE", shared);
    await dgClosesCleanly(shared, b, dgRecord(shared, b, { digest: dgDigest("dg1-b") }));
});

test("DG/2,3: a missing or malformed digest is EVIDENCE_MISMATCH and leaves nothing behind", async () => {
    const h = await inReview("DISPUTE");
    const fields = h.closeFields(h.reviewed, h.id, DG_CODE);
    const { digest, signature, ...withoutDigest } = fields.evidence;
    const good = dgDigest("dg2");
    const malformed = [good.slice(1), `${good}0`, `sha256:${good}`, ` ${good}`, `${good}\n`, good.replace(/^./, "g"),
        null, 12345, ["a".repeat(64)], { digest: good }];
    const attempts = [dgResign(withoutDigest), dgResign({ ...withoutDigest, digest: undefined }),
        ...malformed.map(value => dgResign({ ...withoutDigest, digest: value }))];
    for (const [i, evidence] of attempts.entries()) {
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", h.resolution(h.reviewed, h.id, "CLOSE",
            { ...fields, evidence })), /EVIDENCE_MISMATCH/, String(i));
    }
    // The same evidence id with a valid digest still closes: no refusal consumed anything.
    await dgClosesCleanly(h, h, h.resolution(h.reviewed, h.id, "CLOSE",
        { ...fields, evidence: dgResign({ ...withoutDigest, digest: good }) }));
});

test("DG/4: an uppercase digest is refused, never normalized into the registry", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const lower = dgDigest("dg4");
    await assert.rejects(shared.resolveReview(a.reviewed, "CLOSE", dgRecord(shared, a, { digest: lower.toUpperCase() })),
        /EVIDENCE_MISMATCH/);
    await dgClosesCleanly(shared, a, dgRecord(shared, a, { digest: lower }));
    // Once the lowercase digest is used, its uppercase spelling is still a format error, not a second spelling.
    const b = await inReview("DISPUTE", shared);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", dgRecord(shared, b, { digest: lower.toUpperCase() })),
        /EVIDENCE_MISMATCH/);
});

test("DG/5: a client digest the evidence service did not vouch for is UNTRUSTED_EVIDENCE", async () => {
    const h = await inReview("DISPUTE");
    const record = dgRecord(h, h, { digest: dgDigest("dg5") });
    const forged = { ...record, evidence: { ...record.evidence, digest: dgDigest("dg5-forged") } }; // not re-signed
    const resigned = h.resolution(h.reviewed, h.id, "CLOSE", { reasonCode: record.reasonCode,
        closeReasonPolicy: record.closeReasonPolicy, evidence: forged.evidence });
    await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", resigned), /UNTRUSTED_EVIDENCE/);
    // Neither the forged nor the genuine digest was consumed.
    await dgClosesCleanly(h, h, record);
});

test("DG/6: an attestation with another, a missing or an uppercase digest is UNTRUSTED_EVIDENCE", async () => {
    const variants = {
        other: attestation => ({ ...attestation, digest: dgDigest("dg6-attested-elsewhere") }),
        missing: ({ digest, ...attestation }) => attestation,
        uppercase: attestation => ({ ...attestation, digest: attestation.digest.toUpperCase() })
    };
    for (const [name, change] of Object.entries(variants)) {
        let faulty = true;
        const h = await inReview("DISPUTE", setup({
            verifyEvidence: (evidence, request) => {
                const attestation = syntheticAttestation(evidence, request);
                return faulty && attestation ? change(attestation) : attestation;
            }
        }));
        const record = dgRecord(h, h, { digest: dgDigest(`dg6-${name}`) });
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), /UNTRUSTED_EVIDENCE/, name);
        faulty = false;
        await dgClosesCleanly(h, h, record);
    }
});

test("DG/7,10: the same digest under another evidence id is EVIDENCE_DIGEST_USED on any other order", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const used = dgDigest("dg7");
    const first = dgRecord(shared, a, { digest: used });
    await dgClosesCleanly(shared, a, first);
    for (const label of ["b", "c"]) {
        const p = await inReview("DISPUTE", shared);
        const again = dgRecord(shared, p, { digest: used }); // another evidence id, genuinely signed
        assert.notEqual(again.evidence.evidenceId, first.evidence.evidenceId);
        await assert.rejects(shared.resolveReview(p.reviewed, "CLOSE", again), /EVIDENCE_DIGEST_USED/, label);
        // The refused evidence id was not consumed either: with fresh content it closes.
        await dgClosesCleanly(shared, p, dgRecord(shared, p,
            { evidenceId: again.evidence.evidenceId, digest: dgDigest(`dg7-${label}`) }));
    }
});

test("DG/8: a reused evidence id keeps EVIDENCE_REFERENCE_USED precedence, whatever its digest", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const first = dgRecord(shared, a, { digest: dgDigest("dg8") });
    await dgClosesCleanly(shared, a, first);
    const b = await inReview("DISPUTE", shared);
    for (const digest of [dgDigest("dg8-other"), dgDigest("dg8")]) {
        await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE",
            dgRecord(shared, b, { evidenceId: first.evidence.evidenceId, digest })), /EVIDENCE_REFERENCE_USED/);
    }
});

test("DG/9: on the same order a used digest stays used across review cycles; a closed order takes no second CLOSE", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const used = dgDigest("dg9");
    await dgClosesCleanly(shared, a, dgRecord(shared, a, { digest: used }));
    // The closed order cannot be closed again at all: its own evidence cannot come back through it.
    await assert.rejects(shared.resolveReview(a.reviewed, "CLOSE", dgRecord(shared, a, { digest: dgDigest("dg9-x") }),
        "finance", { version: a.reviewed.version + 1 }), /INVALID_TRANSITION/);
    // Another order is refused in its first review, continues, opens a second review and is refused again.
    const b = await inReview("DISPUTE", shared);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", dgRecord(shared, b, { digest: used })),
        /EVIDENCE_DIGEST_USED/);
    const resumed = await b.resolveReview(b.reviewed, "CONTINUE");
    const again = await b.openReview(resumed, "DISPUTE");
    const second = { ...b, reviewed: again, id: again.reviews.at(-1).reviewId };
    await assert.rejects(shared.resolveReview(again, "CLOSE", dgRecord(shared, second, { digest: used })),
        /EVIDENCE_DIGEST_USED/);
    await dgClosesCleanly(shared, second, dgRecord(shared, second, { digest: dgDigest("dg9-b") }));
});

test("DG/12: an idempotent retry is no second consumption; a changed retry is IDEMPOTENCY_CONFLICT", async () => {
    let calls = 0;
    const shared = setup({ verifyEvidence: (evidence, request) => { calls += 1; return syntheticAttestation(evidence, request); } });
    const a = await inReview("DISPUTE", shared);
    const record = dgRecord(shared, a, { digest: dgDigest("dg12") });
    const options = { requestId: "synthetic-dg12-close" };
    const closed = await dgClosesCleanly(shared, a, record, options);
    assert.equal(calls, 1);
    assert.strictEqual(await shared.resolveReview(a.reviewed, "CLOSE", record, "finance", options), closed);
    assert.equal(calls, 1); // the retry returns the commit; no verifier, no registry
    await assert.rejects(shared.resolveReview(a.reviewed, "CLOSE", dgRecord(shared, a, { digest: dgDigest("dg12-b") }),
        "finance", options), /IDEMPOTENCY_CONFLICT/);
    // The digest was consumed exactly once and is still consumed.
    const b = await inReview("DISPUTE", shared);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", dgRecord(shared, b, { digest: dgDigest("dg12") })),
        /EVIDENCE_DIGEST_USED/);
});

test("DG/13: a stale expectedVersion is VERSION_CONFLICT and consumes neither id nor digest", async () => {
    const h = await inReview("DISPUTE");
    const record = dgRecord(h, h, { digest: dgDigest("dg13") });
    for (const version of [h.reviewed.version - 1, h.reviewed.version + 1]) {
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record, "finance", { version }), /VERSION_CONFLICT/);
    }
    await dgClosesCleanly(h, h, record);
});

test("DG/14: concurrent CLOSEs with one digest: exactly one consumes it; on one order exactly one commits", async () => {
    // Several independent races, each between orders that share one digest under different evidence ids.
    const shared = setup();
    for (let round = 0; round < 6; round++) {
        const racers = [];
        for (let i = 0; i < 3; i++) racers.push(await inReview("DISPUTE", shared));
        const digest = dgDigest(`dg14-${round}`);
        const records = racers.map(p => dgRecord(shared, p, { digest }));
        assert.equal(new Set(records.map(r => r.evidence.evidenceId)).size, 3);
        const results = await Promise.allSettled(racers.map((p, i) => shared.resolveReview(p.reviewed, "CLOSE", records[i])));
        assert.deepEqual(results.map(r => (r.status === "fulfilled" ? "CLOSED" : r.reason.code)).sort(),
            ["CLOSED", "EVIDENCE_DIGEST_USED", "EVIDENCE_DIGEST_USED"], `round ${round}`);
    }
    // One order, two CLOSEs with different digests: one commits, the other is VERSION_CONFLICT.
    const o = await inReview("DISPUTE", shared);
    const pair = await Promise.allSettled(["dg14-x", "dg14-y"].map(text =>
        shared.resolveReview(o.reviewed, "CLOSE", dgRecord(shared, o, { digest: dgDigest(text) }))));
    assert.deepEqual(pair.map(r => (r.status === "fulfilled" ? "CLOSED" : r.reason.code)).sort(),
        ["CLOSED", "VERSION_CONFLICT"]);
    // The losing digest was not consumed.
    const loser = pair.find(r => r.status === "rejected");
    assert.ok(loser);
    const winnerDigest = pair.find(r => r.status === "fulfilled").value.reviews[0].resolution.evidence.digest;
    const freeDigest = [dgDigest("dg14-x"), dgDigest("dg14-y")].find(d => d !== winnerDigest);
    const z = await inReview("DISPUTE", shared);
    await dgClosesCleanly(shared, z, dgRecord(shared, z, { digest: freeDigest }));
});

test("DG/15,16: a failing verifier or an order changed while it waits leaves nothing; the same evidence then closes", async () => {
    // A verifier that throws, rejects or times out; the same record afterwards succeeds.
    let mode = "throw";
    const h = await inReview("DISPUTE", setup({
        verifyEvidence: async (evidence, request) => {
            if (mode === "throw") throw new Error("synthetic-evidence-service-down");
            if (mode === "reject") return Promise.reject(new Error("synthetic-evidence-service-rejected"));
            if (mode === "timeout") {
                await new Promise(resolve => setTimeout(resolve, 5));
                throw new Error("synthetic-evidence-service-timeout");
            }
            return syntheticAttestation(evidence, request);
        }
    }));
    const record = dgRecord(h, h, { digest: dgDigest("dg15") });
    for (const failing of ["throw", "reject", "timeout"]) {
        mode = failing;
        await assert.rejects(h.resolveReview(h.reviewed, "CLOSE", record), new RegExp(`synthetic-evidence-service-`), failing);
    }
    mode = "ok";
    await dgClosesCleanly(h, h, record);
    // The order changes while the evidence service is awaited: refused at commit, nothing consumed.
    const { h: hooked, hooks } = hookedSetup();
    const o = await inReview("DISPUTE", hooked);
    let resumed = null;
    hooks.evidence = async () => { resumed = await o.resolveReview(o.reviewed, "CONTINUE"); };
    const raced = dgRecord(hooked, o, { digest: dgDigest("dg15-hooked") });
    await assert.rejects(hooked.resolveReview(o.reviewed, "CLOSE", raced), /VERSION_CONFLICT/);
    const again = await o.openReview(resumed, "DISPUTE");
    const second = { ...o, reviewed: again, id: again.reviews.at(-1).reviewId };
    await dgClosesCleanly(hooked, second, dgRecord(hooked, second,
        { evidenceId: raced.evidence.evidenceId, digest: dgDigest("dg15-hooked") }));
});

test("DG/17: the digest is in the audit, the review record and the hash chain; refusals leave the chain as it was", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    const record = dgRecord(shared, a, { digest: dgDigest("dg17") });
    const closed = await dgClosesCleanly(shared, a, record);
    const event = closed.events.at(-1);
    const { moneyMovement, ...resolution } = closed.reviews[0].resolution;
    assert.deepEqual([event.audit, event.audit.evidence.digest, moneyMovement], [resolution, dgDigest("dg17"), "NONE"]);
    for (const [i, item] of closed.events.entries()) {
        const { hash, ...rest } = item;
        assert.equal(hash, createHash("sha256").update(JSON.stringify(rest)).digest("hex"), `event ${i}`);
        if (i > 0) assert.equal(item.previousHash, closed.events[i - 1].hash);
    }
    // A refused reuse on another order leaves that order's chain untouched (dgClosesCleanly checks it after).
    const b = await inReview("DISPUTE", shared);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", dgRecord(shared, b, { digest: dgDigest("dg17") })),
        /EVIDENCE_DIGEST_USED/);
    await dgClosesCleanly(shared, b, dgRecord(shared, b, { digest: dgDigest("dg17-b") }));
});

test("DG/18,19: CLOSE of every live code, REFUND cases and CONTINUE are unchanged beside the registry", async () => {
    const shared = setup();
    // DUPLICATE_ORDER (REFUND review, linked twin) and DISPUTE_RESOLVED_BY_PROVIDER, distinct digests: both close.
    const dup = await inReview("REFUND", shared);
    const dupClosed = await closeAs(shared, dup.reviewed, "DUPLICATE_ORDER", { evidence: { digest: dgDigest("dg18-dup") } });
    assert.equal(dupClosed.reviews[0].resolution.evidence.linkedOrderId, dup.twin());
    const dis = await inReview("DISPUTE", shared);
    assert.equal((await closeAs(shared, dis.reviewed, DG_CODE, { evidence: { digest: dgDigest("dg18-dis") } })).state,
        STATES.CLOSED);
    // REFUND carries no evidence and opens its cases as before; CONTINUE consumes nothing.
    const refunded = await refundedCases(shared);
    assert.deepEqual(refunded.refunded.financialCases.map(entry => [entry.caseType, entry.status, entry.evidenceReferences]),
        [["ORDER_REFUND", "OPEN", []], ["UNDELIVERED_REVISION", "OPEN", []]]);
    assert.equal(refunded.refunded.reviews.at(-1).resolution.evidence, undefined);
    const cont = await inReview("DISPUTE", shared);
    assert.equal((await cont.resolveReview(cont.reviewed, "CONTINUE")).state, STATES.IN_PRODUCTION);
    // A digest used by a CLOSE of one code is used for every code.
    const other = await inReview("DISPUTE", shared);
    await assert.rejects(closeAs(shared, other.reviewed, DG_CODE, { evidence: { digest: dgDigest("dg18-dup") } }),
        /EVIDENCE_DIGEST_USED/);
});

test("DG/20: the registry holds in PRODUCTION, STAGING and TEST alike; a refused synthetic verifier consumes nothing", async () => {
    for (const environment of ["PRODUCTION", "STAGING", "TEST", undefined]) {
        let verifier = "production";
        const shared = setup({ allowSyntheticEvidence: false, ...(environment === undefined ? {} : { environment }),
            verifyEvidence: (evidence, request) => (verifier === "production"
                ? productionShaped(evidence, request) : syntheticAttestation(evidence, request)) },
        environment === undefined ? { environment: undefined } : null);
        const a = await inReview("DISPUTE", shared);
        const used = dgDigest(`dg20-${environment}`);
        // A synthetic verifier is refused outside an allowed TEST core and leaves the digest free.
        verifier = "synthetic";
        await assert.rejects(shared.resolveReview(a.reviewed, "CLOSE", dgRecord(shared, a, { digest: used })),
            /SYNTHETIC_VERIFIER_NOT_ALLOWED/, String(environment));
        verifier = "production";
        await dgClosesCleanly(shared, a, dgRecord(shared, a, { digest: used }));
        const b = await inReview("DISPUTE", shared);
        await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE", dgRecord(shared, b, { digest: used })),
            /EVIDENCE_DIGEST_USED/, String(environment));
    }
    // CLOSE is not a case command: the TEST-only case gate never applies to it (CG/4 is unchanged).
    assert.ok(!Object.hasOwn(FINANCIAL_CASE_POLICY.transitions, "resolve_review"));
});

test("DG/21: a used digest is refused before the evidence time is judged", async () => {
    const shared = setup();
    const a = await inReview("DISPUTE", shared);
    await dgClosesCleanly(shared, a, dgRecord(shared, a, { digest: dgDigest("dg21") }));
    const future = "2026-10-29T09:00:00.000Z"; // after the fixed server time
    const b = await inReview("DISPUTE", shared);
    // Control: a fresh digest with a future time is a time error.
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE",
        dgRecord(shared, b, { digest: dgDigest("dg21-fresh"), createdAt: future })), /EVIDENCE_TIME_INVALID/);
    await assert.rejects(shared.resolveReview(b.reviewed, "CLOSE",
        dgRecord(shared, b, { digest: dgDigest("dg21"), createdAt: future })), /EVIDENCE_DIGEST_USED/);
    // Same id and same digest a second time: identity still comes first.
    const c = await inReview("DISPUTE", shared);
    const used = (await dgClosesCleanly(shared, c, dgRecord(shared, c, { digest: dgDigest("dg21-c") })))
        .reviews[0].resolution.evidence;
    const d = await inReview("DISPUTE", shared);
    await assert.rejects(shared.resolveReview(d.reviewed, "CLOSE",
        dgRecord(shared, d, { evidenceId: used.evidenceId, digest: used.digest })), /EVIDENCE_REFERENCE_USED/);
});

// DG/11: the registry is shared with the financial case evidence that does not exist yet. A probe copy of the sibling
// core.mjs (outside the repository, removed after import) registers a case command that consumes an evidence id and
// digest through the single claim gate the future add_case_evidence must use (claimEvidence, Görev 185 Architecture C;
// the probe copy adds the FINANCIAL_CASE_EVIDENCE purpose). If the gate or the shared commit block change, this test
// fails instead of being skipped.
// Görev 193 (Faz 2B-2b, DQ-191-01): probe-copy helper. A case evidence claim now carries the case, the kind and source
// of the closed policy, the evidence policy version and the expected digest basis, and its attestation states them with
// the case evidence purpose. Injected into the dgProbeCore and ecProbeCore copies only, never into core.mjs.
// Görev 197 (A194-03, DQ-196-01 item 1): the request and its attestation carry all CASE_ATTESTED_FIELDS, bound to the
// case's own order and review, as checkCaseEvidence would return them (also injected into the scProbeCore copy).
const PROBE_CASE_EVIDENCE_HELPER = `// PROBE ONLY (Görev 193, Görev 197): a policy-conforming case evidence request and attestation.
function probeCaseEvidence(item, entry, verifierKind = "SYNTHETIC") {
    const [evidenceKind, rule] = Object.entries(CASE_EVIDENCE_POLICY.kinds[item.caseType])[0];
    const request = { purpose: "FINANCIAL_CASE_EVIDENCE", ...entry, caseId: item.caseId, caseType: item.caseType,
        evidenceKind, source: rule.source, evidencePolicyVersion: CASE_EVIDENCE_POLICY.reference,
        digestBasis: rule.digestBasis, orderId: item.orderId, reviewId: item.origin.reviewId, createdAt: item.createdAt,
        decisionBinding: "synthetic-probe-decision-binding" };
    const attestation = { status: "VERIFIED", verifier: { kind: verifierKind, id: "synthetic-evidence-service" },
        purpose: "FINANCIAL_CASE_EVIDENCE", ...request };
    return { request, attestation };
}
`;
let dgProbeLoad = null;
function dgProbeCore() {
    dgProbeLoad ??= (async () => {
        const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        let source = (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        source = inject(source, "transitions: {",
            ` probe_case_evidence: { from: "OPEN", to: "OPEN", roles: ["finance", "admin"] },`, "after");
        // Görev 193 (DQ-191-01): bind the probe command to the case evidence purpose in this copy only.
        source = inject(source, `commands: ["add_case_evidence"`, `, "probe_case_evidence"`, "after");
        source = inject(source, "export function createCore(config = {}) {", PROBE_CASE_EVIDENCE_HELPER, "before");
        source = inject(source, `            default: throw new OrderError("UNKNOWN_ACTION");`, `
            case "probe_case_evidence": {
                // PROBE ONLY (Görev 177): a case evidence entry, reduced to what the shared registries see.
                inState(STATES.CLOSED);
                requireHumanActor();
                const item = order.financialCases.find(entry => entry.caseId === data.caseRef?.caseId);
                requireThat(item && data.caseRef.orderId === order.id, "UNKNOWN_CASE");
                at = serverTime();
                const evidence = probeCaseEvidence(item, { evidenceId: data.evidenceId, digest: data.digest });
                claimEvidence("FINANCIAL_CASE_EVIDENCE", evidence.request, evidence.attestation);
                next.financialCases = order.financialCases.map(entry => (entry === item ? { ...entry,
                    evidenceReferences: [...entry.evidenceReferences, { evidenceId: data.evidenceId, digest: data.digest }] }
                    : entry));
                casesChanged = true;
                break;
            }
`, "before");
        const dir = await mkdtemp(join(tmpdir(), "unai-digest-probe-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return dgProbeLoad;
}

test("DG/11: CLOSE and (future) case evidence share one registry, both ways, and two cases of one order share it too", async () => {
    // The real core has no such command.
    const real = await refundedCases(liveSetup("TEST"));
    await assert.rejects(real.core.dispatch(real.refunded, { kind: "probe_case_evidence", requestId: "synthetic-dg11-real",
        expectedVersion: real.refunded.version, data: {} }, real.actor("finance", real.refunded, SERVER, "synthetic-finance-x")),
    /UNKNOWN_ACTION/);
    const probe = await dgProbeCore();
    const h = setup({}, null, probe.createCore);
    let sequence = 0;
    const addEvidence = (order, caseId, evidenceId, digest) => h.core.dispatch(order, {
        kind: "probe_case_evidence", requestId: `synthetic-dg11-${++sequence}`, expectedVersion: order.version,
        data: { caseRef: { orderId: order.id, caseId }, evidenceId, digest }
    }, h.actor("finance", order, SERVER, "synthetic-finance-dg11"));
    const { refunded } = await refundedCases(h);
    // A CLOSE consumes D1; the case may use neither its content under another id nor its id.
    const a = await inReview("DISPUTE", h);
    const closeRecord = dgRecord(h, a, { digest: dgDigest("dg11-close") });
    await dgClosesCleanly(h, a, closeRecord);
    await assert.rejects(addEvidence(refunded, "case-0001", "synthetic-dg11-case-a", dgDigest("dg11-close")),
        /EVIDENCE_DIGEST_USED/);
    await assert.rejects(addEvidence(refunded, "case-0001", closeRecord.evidence.evidenceId, dgDigest("dg11-fresh")),
        /EVIDENCE_REFERENCE_USED/);
    // The case consumes D2 (refusals above left the version and registry as they were); the other case of the same
    // order cannot use D2 again (D165-05), and neither can a later CLOSE.
    const added = await addEvidence(refunded, "case-0001", "synthetic-dg11-case-b", dgDigest("dg11-case"));
    assert.equal(added.version, refunded.version + 1);
    assert.deepEqual(added.financialCases[0].evidenceReferences,
        [{ evidenceId: "synthetic-dg11-case-b", digest: dgDigest("dg11-case") }]);
    await assert.rejects(addEvidence(added, "case-0002", "synthetic-dg11-case-c", dgDigest("dg11-case")),
        /EVIDENCE_DIGEST_USED/);
    const q = await inReview("DISPUTE", h);
    await assert.rejects(h.resolveReview(q.reviewed, "CLOSE", dgRecord(h, q, { digest: dgDigest("dg11-case") })),
        /EVIDENCE_DIGEST_USED/);
    await assert.rejects(h.resolveReview(q.reviewed, "CLOSE",
        dgRecord(h, q, { evidenceId: "synthetic-dg11-case-b", digest: dgDigest("dg11-q") })), /EVIDENCE_REFERENCE_USED/);
    await dgClosesCleanly(h, q, dgRecord(h, q, { digest: dgDigest("dg11-q") }));
});

// ---- Görev 179 (A178-01): at commit, the evidence identity is checked before the digest ----
// Two orders send CLOSE with the same evidence id and the same digest. A deterministic barrier (no timer, no sleep)
// holds both in the evidence verifier until both have arrived, then releases them together, so both pass the
// pre-check before either commits and the loser is refused only by the commit-time checks. The clock is read exactly
// once per CLOSE, right after the pre-check (core.mjs `at = serverTime()`), which makes that order observable.
test("DG/22 (A178-01): same evidence id and digest raced past the pre-check: the loser gets EVIDENCE_REFERENCE_USED", async () => {
    for (let round = 0; round < 6; round++) {
        const log = [];
        let arrived = 0;
        let released = false;
        let open;
        const gate = new Promise(resolve => { open = resolve; });
        const h = setup({
            clock: () => { if (released) log.push("pre-check passed"); return FIXED_TIME; },
            verifyEvidence: async (evidence, request) => {
                if (!released) {
                    arrived += 1;
                    log.push("verifier");
                    if (arrived === 2) { released = true; open(); }
                    await gate;
                }
                return syntheticAttestation(evidence, request);
            }
        });
        const a = await inReview("DISPUTE", h);
        const b = await inReview("DISPUTE", h);
        const sharedId = `synthetic-dg22-shared-id-${round}`;
        const sharedDigest = dgDigest(`dg22-${round}`);
        const racers = round % 2 === 0 ? [a, b] : [b, a];
        const records = racers.map(p => dgRecord(h, p, { evidenceId: sharedId, digest: sharedDigest }));
        assert.notEqual(records[0].authorizationRef, records[1].authorizationRef);
        const results = await Promise.allSettled(racers.map((p, i) => h.resolveReview(p.reviewed, "CLOSE", records[i])
            .finally(() => log.push("settled"))));
        // Both waited in the verifier, then both passed the pre-check before either settled.
        assert.deepEqual(log, ["verifier", "verifier", "pre-check passed", "pre-check passed", "settled", "settled"],
            `round ${round}`);
        const winners = results.filter(r => r.status === "fulfilled");
        const losers = results.filter(r => r.status === "rejected");
        assert.equal(winners.length, 1, `round ${round}`);
        assert.equal(losers.length, 1, `round ${round}`);
        assert.notEqual(losers[0].reason.code, "EVIDENCE_DIGEST_USED", `round ${round}: digest checked before identity`);
        assert.equal(losers[0].reason.code, "EVIDENCE_REFERENCE_USED", `round ${round}`);

        // The winner made exactly one consumption: one new event carrying the shared id and digest.
        const winner = winners[0].value;
        const winnerRacer = racers[results.indexOf(winners[0])];
        const loserRacer = racers[results.indexOf(losers[0])];
        assert.equal(winner.id, winnerRacer.reviewed.id);
        assert.equal(winner.state, STATES.CLOSED);
        assert.equal(winner.version, winnerRacer.reviewed.version + 1);
        assert.deepEqual(winner.events.slice(0, -1), winnerRacer.reviewed.events);
        assert.deepEqual([winner.events.at(-1).audit.evidence.evidenceId, winner.events.at(-1).audit.evidence.digest],
            [sharedId, sharedDigest]);
        assert.equal(winner.events.filter(e => e.audit?.evidence?.digest === sharedDigest).length, 1);

        // Registry: the identity and the digest are held by the winner, both refused to any later order.
        const c = await inReview("DISPUTE", h);
        await assert.rejects(h.resolveReview(c.reviewed, "CLOSE",
            dgRecord(h, c, { evidenceId: sharedId, digest: dgDigest(`dg22-${round}-other`) })), /EVIDENCE_REFERENCE_USED/);
        await assert.rejects(h.resolveReview(c.reviewed, "CLOSE", dgRecord(h, c, { digest: sharedDigest })),
            /EVIDENCE_DIGEST_USED/);

        // The loser left no trace: its order, version, events and audit chain are unchanged (dgClosesCleanly closes
        // from the pre-race snapshot), and its own review reference was not consumed.
        const after = await dgClosesCleanly(h, loserRacer, dgRecord(h, loserRacer,
            { evidenceId: `synthetic-dg22-loser-id-${round}`, digest: dgDigest(`dg22-${round}-loser`) }));
        assert.equal(after.events.filter(e => e.audit?.evidence?.digest === sharedDigest).length, 0);
        assert.equal(after.events.filter(e => e.audit?.evidence?.evidenceId === sharedId).length, 0);
    }
});

// ---- Görev 185 (Faz 2B-2a, Architecture C): the single evidence claim gate and its commit invariants ----
//
// The real core has one evidence consumer (CLOSE), whose own checks run before the gate's, so most gate and invariant
// rules are unreachable through CLOSE. They are driven here through a probe copy of the sibling core.mjs (outside the
// repository, removed after import; the Görev 170/177 technique). The probe registers one case command, probe_claim,
// that claims (or deliberately does not claim) evidence and stores it on a financial case, and it adds the
// FINANCIAL_CASE_EVIDENCE purpose that 2B-2b/2B-3 will bring. A missing anchor fails the tests; nothing is skipped.
//   data.items          evidence { evidenceId, digest } to claim and store, in order
//   data.attestations   explicit attestations per item (default: a synthetic VERIFIED one for exactly that item)
//   data.mode           "claim_store" (default) | "store_only" | "claim_only" | "store_other" (store data.other instead)
//   data.raw            claims pushed straight into the claim list, bypassing the gate (frozen when data.freezeRaw);
//                       each is also stored when data.storeRaw
//   data.wait           await the probe barrier (setProbeGate) before claiming: a deterministic race, no timers
let ecProbeLoad = null;
function ecProbeCore() {
    ecProbeLoad ??= (async () => {
        const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        let source = (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        source = inject(source, "transitions: {",
            ` probe_claim: { from: "OPEN", to: "OPEN", roles: ["finance", "admin"] },`, "after");
        // Görev 193 (DQ-191-01): bind the probe command to the case evidence purpose in this copy only.
        source = inject(source, `commands: ["add_case_evidence"`, `, "probe_claim"`, "after");
        source = inject(source, "export function createCore(config = {}) {", PROBE_CASE_EVIDENCE_HELPER, "before");
        source = inject(source, "export function createCore(config = {}) {", `// PROBE ONLY (Görev 185): a test barrier.
let probeGate = async () => {};
export function setProbeGate(gate) { probeGate = gate; }
`, "before");
        source = inject(source, `            default: throw new OrderError("UNKNOWN_ACTION");`, `
            case "probe_claim": {
                // PROBE ONLY (Görev 185): claims and stores case evidence exactly as data says.
                inState(STATES.CLOSED);
                requireHumanActor();
                const item = order.financialCases.find(entry => entry.caseId === data.caseId);
                requireThat(item, "UNKNOWN_CASE");
                if (data.wait) await probeGate();
                const mode = data.mode ?? "claim_store";
                const stored = [];
                for (const [index, entry] of (data.items ?? []).entries()) {
                    const evidence = probeCaseEvidence(item, entry, data.verifierKind ?? "SYNTHETIC");
                    const attestation = Object.hasOwn(data, "attestations") ? data.attestations[index] : evidence.attestation;
                    if (mode !== "store_only") claimEvidence(data.purpose ?? "FINANCIAL_CASE_EVIDENCE", evidence.request, attestation);
                    if (mode === "store_other") stored.push({ ...data.other });
                    else if (mode !== "claim_only") stored.push({ evidenceId: entry.evidenceId, digest: entry.digest });
                }
                for (const raw of data.raw ?? []) {
                    evidenceClaims.push(data.freezeRaw ? freezeDeep({ ...raw }) : { ...raw });
                    if (data.storeRaw) stored.push({ evidenceId: raw.evidenceId, digest: raw.digest });
                }
                at = serverTime();
                next.financialCases = order.financialCases.map(entry => (entry === item
                    ? { ...entry, evidenceReferences: [...entry.evidenceReferences, ...stored] } : entry));
                casesChanged = true;
                break;
            }
`, "before");
        const dir = await mkdtemp(join(tmpdir(), "unai-claim-probe-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return ecProbeLoad;
}

const ecItem = (text, evidenceId = `synthetic-ec-${text}`) => ({ evidenceId, digest: dgDigest(`ec-${text}`) });

/** A probe-core harness: a REFUND-ed order with two OPEN cases, and probe_claim on it. */
async function ecSetup(overrides = {}) {
    const probe = await ecProbeCore();
    const h = setup(overrides, null, probe.createCore);
    const { refunded } = await refundedCases(h);
    let sequence = 0;
    const claim = (order, data, caseId = "case-0001") => h.core.dispatch(order, {
        kind: "probe_claim", requestId: `synthetic-ec-${++sequence}`, expectedVersion: order.version, data: { caseId, ...data }
    }, h.actor("finance", order, SERVER, "synthetic-finance-ec"));
    return { probe, h, refunded, claim };
}

/** After a refusal: the same snapshot still takes a valid claim as its very next version, on the same history. */
async function ecCommitsCleanly(claim, order, items, caseId = "case-0001") {
    const next = await claim(order, { items }, caseId);
    assert.equal(next.version, order.version + 1);
    assert.deepEqual(next.events.slice(0, -1), order.events);
    assert.equal(next.events.at(-1).previousHash, order.events.at(-1).hash);
    const stored = next.financialCases.find(entry => entry.caseId === caseId).evidenceReferences;
    assert.deepEqual(stored.slice(-items.length), items);
    return next;
}

test("EC/2: the gate refuses an empty, missing or malformed digest or id, and an unknown purpose; nothing is consumed", async () => {
    const { refunded, claim } = await ecSetup();
    const id = "synthetic-ec2-id";
    const malformed = ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, ` ${"a".repeat(63)}`,
        `${"a".repeat(64)}\n`, `0x${"a".repeat(62)}`];
    for (const digest of malformed) {
        await assert.rejects(claim(refunded, { items: [{ evidenceId: id, digest }] }), /EVIDENCE_MISMATCH/, JSON.stringify(digest));
    }
    for (const item of [{ evidenceId: id, digest: null }, { evidenceId: id }, { evidenceId: id, digest: 7 }]) {
        await assert.rejects(claim(refunded, { items: [item] }), /EVIDENCE_MISMATCH/, JSON.stringify(item));
    }
    for (const evidenceId of ["", "short", "with space-1234", null, "x".repeat(81)]) {
        await assert.rejects(claim(refunded, { items: [{ evidenceId, digest: dgDigest("ec2") }] }), /EVIDENCE_MISMATCH/);
    }
    await assert.rejects(claim(refunded, { items: [ecItem("ec2")], purpose: "OTHER_PURPOSE" }), /EVIDENCE_MISMATCH/);
    // Nothing was consumed: the same id and a fresh digest close cleanly on the unchanged snapshot.
    const next = await ecCommitsCleanly(claim, refunded, [{ evidenceId: id, digest: dgDigest("ec2") }]);
    // The format is judged before the registries: a malformed claim never learns whether its id or digest was used.
    await assert.rejects(claim(next, { items: [{ evidenceId: id, digest: "A".repeat(64) }] }, "case-0002"), /EVIDENCE_MISMATCH/);
    await assert.rejects(claim(next, { items: [{ evidenceId: "bad id", digest: dgDigest("ec2") }] }, "case-0002"),
        /EVIDENCE_MISMATCH/);
});

test("EC/3: claims that bypass the gate are refused at commit unless frozen, well-formed, of this order and unique", async () => {
    const { refunded, claim } = await ecSetup();
    const good = { purpose: "FINANCIAL_CASE_EVIDENCE", ...ecItem("ec3"), orderId: refunded.id, caseId: null,
        verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" } };
    const refusals = [
        { raw: [good], freezeRaw: false },                                          // not frozen: not made by the gate
        { raw: [{ ...good, digest: "B".repeat(64) }], freezeRaw: true },
        { raw: [{ ...good, digest: "" }], freezeRaw: true },
        { raw: [{ ...good, evidenceId: "bad id" }], freezeRaw: true },
        { raw: [{ ...good, purpose: "OTHER_PURPOSE" }], freezeRaw: true },
        { raw: [{ ...good, orderId: "another-order-id" }], freezeRaw: true },
        { raw: [good, { ...good, evidenceId: "synthetic-ec3-other" }], freezeRaw: true }  // one digest twice
    ];
    for (const data of refusals) {
        await assert.rejects(claim(refunded, { ...data, storeRaw: true }), /EVIDENCE_MISMATCH/, JSON.stringify(data.raw));
    }
    await ecCommitsCleanly(claim, refunded, [ecItem("ec3")]);
});

test("EC/4,5: no claim without a verified attestation for exactly this evidence id and digest", async () => {
    const { refunded, claim } = await ecSetup();
    const item = ecItem("ec4");
    const verified = { status: "VERIFIED", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" }, ...item };
    const refused = [null, true, "VERIFIED", {}, { ...verified, status: "PENDING" }, { ...verified, status: undefined },
        { ...verified, verifier: undefined }, { ...verified, verifier: null }, { ...verified, verifier: "SYNTHETIC" },
        { ...verified, verifier: { kind: "OTHER", id: "synthetic-evidence-service" } },
        { ...verified, verifier: { kind: "SYNTHETIC", id: "bad id" } },
        // EC/5: the attestation is for other evidence
        { ...verified, digest: dgDigest("ec5-other") }, { ...verified, digest: undefined },
        { ...verified, evidenceId: "synthetic-ec5-other" }, { ...verified, evidenceId: undefined }];
    for (const attestation of refused) {
        await assert.rejects(claim(refunded, { items: [item], attestations: [attestation] }), /UNTRUSTED_EVIDENCE/,
            JSON.stringify(attestation));
    }
    await ecCommitsCleanly(claim, refunded, [item]);
});

test("EC/6: the TEST-only synthetic boundary sits in the gate; a PRODUCTION verifier is accepted", async () => {
    const off = await ecSetup({ allowSyntheticEvidence: false });
    await assert.rejects(off.claim(off.refunded, { items: [ecItem("ec6-a")] }), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    const next = await off.claim(off.refunded, { items: [ecItem("ec6-a")], verifierKind: "PRODUCTION" });
    assert.equal(next.version, off.refunded.version + 1);
    const on = await ecSetup();
    await ecCommitsCleanly(on.claim, on.refunded, [ecItem("ec6-b")]);
});

test("EC/7: a repeat within one transition is refused, identity first; two distinct items are both consumed", async () => {
    const { h, refunded, claim } = await ecSetup();
    const a = ecItem("ec7-a");
    await assert.rejects(claim(refunded, { items: [a, a] }), /EVIDENCE_REFERENCE_USED/);
    await assert.rejects(claim(refunded, { items: [a, { ...a, digest: dgDigest("ec7-x") }] }), /EVIDENCE_REFERENCE_USED/);
    await assert.rejects(claim(refunded, { items: [a, { ...a, evidenceId: "synthetic-ec7-other" }] }), /EVIDENCE_DIGEST_USED/);
    const b = ecItem("ec7-b");
    const next = await ecCommitsCleanly(claim, refunded, [a, b]);
    // Both are consumed, by id and by digest, for case evidence and for CLOSE alike.
    for (const used of [a, b]) {
        await assert.rejects(claim(next, { items: [{ ...used, digest: dgDigest("ec7-fresh") }] }, "case-0002"),
            /EVIDENCE_REFERENCE_USED/);
        await assert.rejects(claim(next, { items: [{ ...used, evidenceId: "synthetic-ec7-fresh" }] }, "case-0002"),
            /EVIDENCE_DIGEST_USED/);
        const p = await inReview("DISPUTE", h);
        await assert.rejects(h.resolveReview(p.reviewed, "CLOSE", dgRecord(h, p, { digest: used.digest })), /EVIDENCE_DIGEST_USED/);
    }
});

test("EC/8: evidence stored without a claim is EVIDENCE_NOT_CLAIMED and consumes nothing", async () => {
    const { h, refunded, claim } = await ecSetup();
    const item = ecItem("ec8");
    await assert.rejects(claim(refunded, { items: [item], mode: "store_only" }), /EVIDENCE_NOT_CLAIMED/);
    // Neither the id nor the digest was consumed: a CLOSE may use both.
    const p = await inReview("DISPUTE", h);
    await dgClosesCleanly(h, p, dgRecord(h, p, { evidenceId: item.evidenceId, digest: item.digest }));
    await ecCommitsCleanly(claim, refunded, [ecItem("ec8-b")]);
});

test("EC/9: a claim without stored evidence, a stored key other than the claim, or an id-only claim is refused", async () => {
    const { refunded, claim } = await ecSetup();
    const item = ecItem("ec9");
    await assert.rejects(claim(refunded, { items: [item], mode: "claim_only" }), /EVIDENCE_NOT_CLAIMED/);
    await assert.rejects(claim(refunded, { items: [item], mode: "store_other", other: ecItem("ec9-other") }),
        /EVIDENCE_NOT_CLAIMED/);
    await assert.rejects(claim(refunded, { items: [item], mode: "store_other",
        other: { evidenceId: item.evidenceId, digest: dgDigest("ec9-other") } }), /EVIDENCE_NOT_CLAIMED/);
    // A178-03: an identity without a digest can no longer slip past the digest registry.
    await assert.rejects(claim(refunded, { raw: [{ purpose: "FINANCIAL_CASE_EVIDENCE", evidenceId: item.evidenceId,
        orderId: refunded.id }], freezeRaw: true, storeRaw: true }), /EVIDENCE_MISMATCH/);
    await ecCommitsCleanly(claim, refunded, [item]);
});

test("EC/10: case evidence (two claims) raced with a CLOSE on one id and digest past the pre-check: loser gets EVIDENCE_REFERENCE_USED", async () => {
    for (let round = 0; round < 6; round++) {
        const log = [];
        let arrived = 0;
        let released = false;
        let open;
        const gate = new Promise(resolve => { open = resolve; });
        const arrive = async () => {
            if (released) return;
            arrived += 1;
            log.push("waiting");
            if (arrived === 2) { released = true; open(); }
            await gate;
        };
        const { probe, h, refunded, claim } = await ecSetup({
            clock: () => { if (released) log.push("pre-check passed"); return FIXED_TIME; },
            verifyEvidence: async (evidence, request) => { await arrive(); return syntheticAttestation(evidence, request); }
        });
        probe.setProbeGate(arrive);
        try {
            const p = await inReview("DISPUTE", h);
            const shared = { evidenceId: `synthetic-ec10-shared-${round}`, digest: dgDigest(`ec10-${round}`) };
            const other = ecItem(`ec10-other-${round}`);
            const closing = () => h.resolveReview(p.reviewed, "CLOSE", dgRecord(h, p, shared));
            const adding = () => claim(refunded, { items: [other, shared], wait: true });
            const racers = round % 2 === 0 ? [closing, adding] : [adding, closing];
            const results = await Promise.allSettled(racers.map(run => run().finally(() => log.push("settled"))));
            assert.deepEqual(log, ["waiting", "waiting", "pre-check passed", "pre-check passed", "settled", "settled"],
                `round ${round}`);
            const codes = results.map(r => (r.status === "fulfilled" ? "COMMITTED" : r.reason.code));
            assert.equal(codes.filter(code => code === "COMMITTED").length, 1, `round ${round}`);
            const loser = codes.find(code => code !== "COMMITTED");
            assert.notEqual(loser, "EVIDENCE_DIGEST_USED", `round ${round}: digest checked before identity`);
            assert.equal(loser, "EVIDENCE_REFERENCE_USED", `round ${round}`);
        } finally {
            probe.setProbeGate(async () => {});
        }
    }
});

test("EC/11: CLOSE keeps its observed refusal order through the gate", async () => {
    let kind = "PRODUCTION";
    const h = setup({
        allowSyntheticEvidence: false,
        verifyEvidence: (evidence, request) => {
            const attestation = syntheticAttestation(evidence, request);
            return attestation && { ...attestation, verifier: { kind, id: "synthetic-evidence-service" } };
        }
    });
    const first = await inReview("DISPUTE", h);
    const firstRecord = dgRecord(h, first, { digest: dgDigest("ec11-used") });
    await dgClosesCleanly(h, first, firstRecord);
    const usedId = firstRecord.evidence.evidenceId;
    const usedDigest = dgDigest("ec11-used");
    const usedRef = firstRecord.authorizationRef;
    const p = await inReview("DISPUTE", h);
    const record = (evidence, extra = {}) =>
        h.resolution(p.reviewed, p.id, "CLOSE", { ...h.closeFields(p.reviewed, p.id, DG_CODE, evidence), ...extra });
    const cases = [
        // [verifier kind, evidence, record extra, expected]
        ["SYNTHETIC", { evidenceId: usedId, digest: usedDigest }, { authorizationRef: usedRef }, /SYNTHETIC_VERIFIER_NOT_ALLOWED/],
        ["SYNTHETIC", { digest: usedDigest }, {}, /SYNTHETIC_VERIFIER_NOT_ALLOWED/],
        ["PRODUCTION", { evidenceId: usedId, digest: usedDigest }, { authorizationRef: usedRef }, /EVIDENCE_REFERENCE_USED/],
        ["PRODUCTION", { evidenceId: usedId, digest: dgDigest("ec11-fresh") }, { authorizationRef: usedRef }, /EVIDENCE_REFERENCE_USED/],
        ["PRODUCTION", { digest: usedDigest }, { authorizationRef: usedRef }, /EVIDENCE_DIGEST_USED/],
        ["PRODUCTION", { digest: usedDigest, createdAt: "2030-01-01T00:00:00.000Z" }, {}, /EVIDENCE_DIGEST_USED/],
        ["PRODUCTION", { digest: dgDigest("ec11-fresh") }, { authorizationRef: usedRef }, /REVIEW_REFERENCE_USED/],
        ["PRODUCTION", { digest: dgDigest("ec11-fresh"), createdAt: "2030-01-01T00:00:00.000Z" }, {}, /EVIDENCE_TIME_INVALID/]
    ];
    for (const [verifierKind, evidence, extra, expected] of cases) {
        kind = verifierKind;
        await assert.rejects(h.resolveReview(p.reviewed, "CLOSE", record(evidence, extra)), expected,
            `${verifierKind} ${JSON.stringify(evidence)} ${JSON.stringify(extra)}`);
    }
    kind = "PRODUCTION";
    // Refusals after the claim consumed nothing: another order may use that digest, then this one closes.
    const q = await inReview("DISPUTE", h);
    await dgClosesCleanly(h, q, dgRecord(h, q, { digest: dgDigest("ec11-fresh") }));
    await dgClosesCleanly(h, p, record({ digest: dgDigest("ec11-other") }));
});

test("EC/12: the CLOSE audit evidence keeps its keys, order and verifier shape; the event hash covers it", async () => {
    const h = setup();
    const p = await inReview("DISPUTE", h);
    const closed = await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("ec12") }));
    const event = closed.events.at(-1);
    const evidence = event.audit.evidence;
    assert.deepEqual(Object.keys(evidence),
        ["evidenceId", "evidenceKind", "source", "createdAt", "digest", "financialObligation", "verifier"]);
    assert.deepEqual(Object.keys(evidence.verifier), ["kind", "id"]);
    assert.deepEqual(evidence.verifier, { kind: "SYNTHETIC", id: "synthetic-evidence-service" });
    assert.equal(evidence.digest, dgDigest("ec12"));
    assert.deepEqual(closed.reviews.at(-1).resolution.evidence, evidence);
    const { hash, ...hashed } = event;
    assert.equal(createHash("sha256").update(JSON.stringify(hashed)).digest("hex"), hash);
    assert.equal(Object.keys(event).at(-1), "hash");
});

// Structural locks: read the sibling core.mjs source (never changed by the tests).
async function coreSource() {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
}
function sourceBlock(source, start, end) {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.ok(to > from, `unterminated ${start}`);
    return source.slice(from, to + end.length);
}
const occurrences = (text, needle) => text.split(needle).length - 1;

test("T-S/1,5: the evidence registries are written in recordClaims only; claims are added in claimEvidence only", async () => {
    const source = await coreSource();
    const record = sourceBlock(source, "        function recordClaims() {", "\n        }\n");
    const gate = sourceBlock(source, "        const claimEvidence = (purpose, request, attestation) => {", "\n        };\n");
    for (const write of ["evidenceReferences.set(", "evidenceDigests.set("]) {
        assert.equal(occurrences(source, write), 1, write);
        assert.equal(occurrences(record, write), 1, write);
    }
    assert.equal(occurrences(source, "evidenceClaims.push("), 1);
    assert.equal(occurrences(gate, "evidenceClaims.push("), 1);
    // Nothing else deletes from or clears the evidence registries.
    assert.doesNotMatch(source, /evidence(References|Digests)\.(delete|clear)\(/);
});

test("T-S/2: the scalar evidenceRef / evidenceDigest dispatch variables are gone (restoration's record.evidenceRef field stays)", async () => {
    const source = await coreSource();
    assert.doesNotMatch(source, /\blet\s+evidence(Ref|Digest)\b/);
    assert.doesNotMatch(source, /\b(const|var)\s+evidence(Ref|Digest)\b/);
    assert.doesNotMatch(source, /(^|[^.\w])evidenceRef\s*=(?!=)/m);
    assert.doesNotMatch(source, /\bevidenceDigest\b/);
    assert.match(source, /record\.evidenceRef/); // the restoration field (F184-02), a different thing
});

test("T-S/3: the gate and commit helpers are synchronous, and nothing is awaited between re-check and write", async () => {
    const source = await coreSource();
    const blocks = {
        claimEvidence: sourceBlock(source, "        const claimEvidence = (purpose, request, attestation) => {", "\n        };\n"),
        assertClaimsFree: sourceBlock(source, "        function assertClaimsFree() {", "\n        }\n"),
        recordClaims: sourceBlock(source, "        function recordClaims() {", "\n        }\n"),
        storedEvidenceKeys: sourceBlock(source, "function storedEvidenceKeys(snapshot) {", "\n}\n"),
        claimsMatchStoredEvidence: sourceBlock(source, "function claimsMatchStoredEvidence(before, after, claims) {", "\n}\n")
    };
    for (const [name, block] of Object.entries(blocks)) {
        assert.doesNotMatch(block, /\bawait\b|\basync\b|\.then\(/, name);
    }
    assert.doesNotMatch(source, /async\s+(function\s+)?(assertClaimsFree|recordClaims|claimEvidence)\b/);
    assert.doesNotMatch(source, /claimEvidence\s*=\s*async\b/);
    // The commit block: the re-check comes after the last await of the dispatch and the writes follow without one.
    const commit = sourceBlock(source, "        event.hash = await digest(event);", "        recordClaims();");
    assert.equal(occurrences(commit, "await"), 1, "only the hash await opens the block");
    assert.equal(occurrences(commit, "assertClaimsFree();"), 1);
    assert.ok(commit.indexOf("assertClaimsFree();") < commit.indexOf("orders.set(order.id, committed);"));
});

test("T-S/4 (A178-09): the contract names add_case_evidence as the TEST-only case evidence path and names the unclaimed refusal", async () => {
    const source = await coreSource();
    assert.doesNotMatch(source, /across CLOSE and\s+\*?\s*financial cases/);
    assert.match(source, /evidence shares these registries through add_case_evidence \(Görev 206, TEST only\)/);
    assert.match(source, /evidence stored without a claim is refused \(EVIDENCE_NOT_CLAIMED\)/);
    assert.match(source, /Re-verifying evidence\s*\n?\s*\*?\s*already stored \(D165-09\) is never a claim/);
});

// ---- Görev 187 (A186-03): locks for the five gate/commit mutants the Görev 186 audit found unguarded ----
// Each test pins an existing 2B-2a contract; none assumes new production behavior.
//   EC/13  A10b  the CLOSE audit keeps exactly { kind, id } of the verifier, never the attestation's verifier object
//   EC/14  A12a  the production purpose list is exactly ["CLOSE"]; case evidence is not a purpose yet
//   EC/15  A12c  the gate judges the purpose before the registries
//   EC/16  A15c  evidence an order already stores is not new evidence of a later transition (fail-closed mutant)
//   EC/17  A15f  claims match stored evidence whatever their order (fail-closed mutant)

test("EC/13 (A10b): the CLOSE audit keeps exactly the verifier's kind and id, never extra attestation fields", async () => {
    const h = setup({
        verifyEvidence: (evidence, request) => {
            const attestation = syntheticAttestation(evidence, request);
            return attestation && { ...attestation,
                verifier: { kind: "PRODUCTION", id: "synthetic-evidence-service", extra: "synthetic-extra", note: { x: 1 } } };
        }
    });
    const p = await inReview("DISPUTE", h);
    const closed = await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("ec13") }));
    const audited = closed.events.at(-1).audit.evidence.verifier;
    assert.deepEqual(Object.keys(audited), ["kind", "id"]);
    assert.deepEqual(audited, { kind: "PRODUCTION", id: "synthetic-evidence-service" });
    assert.deepEqual(closed.reviews.at(-1).resolution.evidence.verifier, audited);
});

// A probe copy WITHOUT the purpose injection: the production purpose list is used exactly as written in core.mjs.
let purposeProbeLoad = null;
function purposeProbeCore() {
    purposeProbeLoad ??= (async () => {
        const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        let source = (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        source = inject(source, "transitions: {",
            ` probe_purpose_claim: { from: "OPEN", to: "OPEN", roles: ["finance", "admin"] },`, "after");
        source = inject(source, `            default: throw new OrderError("UNKNOWN_ACTION");`, `
            case "probe_purpose_claim": {
                // PROBE ONLY (Görev 187): claims one evidence under data.purpose and stores it on case-0001.
                inState(STATES.CLOSED);
                requireHumanActor();
                const item = order.financialCases[0];
                const evidence = { evidenceId: data.evidenceId, digest: data.digest };
                claimEvidence(data.purpose, evidence, { status: "VERIFIED",
                    verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" }, ...evidence });
                at = serverTime();
                next.financialCases = order.financialCases.map(entry => (entry === item
                    ? { ...entry, evidenceReferences: [...entry.evidenceReferences, evidence] } : entry));
                casesChanged = true;
                break;
            }
`, "before");
        const dir = await mkdtemp(join(tmpdir(), "unai-purpose-probe-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return purposeProbeLoad;
}

// Görev 193 (DQ-191-02): EC/14 now pins the approved production purpose policy. Its probe copy stays un-injected
// (DQ-191-01, F192-01), so the probe command is bound to no purpose, exactly as any unknown command in production.
test("EC/14 (A12a, DQ-191-02): the production purpose policy is exactly the approved table; an unbound or unknown purpose is refused and consumes nothing", async () => {
    const { EVIDENCE_PURPOSE_POLICY: policy, FINANCIAL_CASE_POLICY: casePolicy } = await import("./core.mjs");
    const source = await coreSource();
    assert.equal(occurrences(source, "const EVIDENCE_PURPOSES = "), 1);
    assert.equal(occurrences(source, "const EVIDENCE_PURPOSES = Object.freeze(Object.keys(EVIDENCE_PURPOSE_POLICY));"), 1);
    assert.equal(occurrences(source, "export const EVIDENCE_PURPOSE_POLICY = "), 1);
    assert.ok(Object.isFrozen(policy) && Object.values(policy).every(entry => Object.isFrozen(entry) &&
        Object.isFrozen(entry.commands)));
    assert.deepEqual(policy, {
        CLOSE: { commands: ["resolve_review"], storage: "REVIEW_RESOLUTION", attestedPurpose: null,
            evidencePolicyVersion: null },
        FINANCIAL_CASE_EVIDENCE: { commands: ["add_case_evidence"], storage: "CASE_EVIDENCE",
            attestedPurpose: "FINANCIAL_CASE_EVIDENCE", evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1" }
    });
    // Görev 206 (owner-approved minimal update): add_case_evidence is bound and registered (TEST only).
    assert.equal(Object.hasOwn(casePolicy.transitions, "add_case_evidence"), true);
    const probe = await purposeProbeCore();
    const h = setup({}, null, probe.createCore);
    const { refunded } = await refundedCases(h);
    let sequence = 0;
    const claim = (order, purpose, evidenceId, digest) => h.core.dispatch(order, {
        kind: "probe_purpose_claim", requestId: `synthetic-ec14-${++sequence}`, expectedVersion: order.version,
        data: { purpose, evidenceId, digest }
    }, h.actor("finance", order, SERVER, "synthetic-finance-ec14"));
    // Known purposes the probe command is not bound to: CLOSE belongs to resolve_review only.
    for (const purpose of ["FINANCIAL_CASE_EVIDENCE", "CLOSE"]) {
        await assert.rejects(claim(refunded, purpose, "synthetic-ec14-a", dgDigest("ec14")), /EVIDENCE_PURPOSE_MISMATCH/,
            JSON.stringify(purpose));
    }
    // Unknown or malformed purposes, prototype names included.
    for (const purpose of ["close", "CLOSE ", "", null, "OTHER_PURPOSE", "__proto__", "toString"]) {
        await assert.rejects(claim(refunded, purpose, "synthetic-ec14-a", dgDigest("ec14")), /EVIDENCE_MISMATCH/,
            JSON.stringify(purpose));
    }
    // Nothing was consumed: the one command bound to CLOSE uses the same id and digest, and the refused order still
    // takes its next transition on its unchanged version.
    const p = await inReview("DISPUTE", h);
    await dgClosesCleanly(h, p, dgRecord(h, p, { evidenceId: "synthetic-ec14-a", digest: dgDigest("ec14") }));
    const taken = await takeCase(h, refunded);
    assert.equal(taken.version, refunded.version + 1);
    assert.deepEqual(taken.events.slice(0, -1), refunded.events);
});

test("EC/15 (A12c): the gate judges the purpose before the registries: an unknown purpose with a used id or digest is EVIDENCE_MISMATCH", async () => {
    const { refunded, claim } = await ecSetup();
    const used = ecItem("ec15");
    const next = await ecCommitsCleanly(claim, refunded, [used]);
    for (const purpose of ["OTHER_PURPOSE", "close", ""]) {
        await assert.rejects(claim(next, { items: [{ ...used, digest: dgDigest("ec15-fresh") }], purpose }, "case-0002"),
            /EVIDENCE_MISMATCH/, `used id, ${JSON.stringify(purpose)}`);
        await assert.rejects(claim(next, { items: [{ ...used, evidenceId: "synthetic-ec15-fresh" }], purpose }, "case-0002"),
            /EVIDENCE_MISMATCH/, `used digest, ${JSON.stringify(purpose)}`);
    }
    // With a known purpose the same requests reach the registries, identity first.
    await assert.rejects(claim(next, { items: [{ ...used, digest: dgDigest("ec15-fresh") }] }, "case-0002"),
        /EVIDENCE_REFERENCE_USED/);
    await assert.rejects(claim(next, { items: [{ ...used, evidenceId: "synthetic-ec15-fresh" }] }, "case-0002"),
        /EVIDENCE_DIGEST_USED/);
});

test("EC/16 (A15c): evidence an order already stores is not new evidence of a later transition", async () => {
    const { h, refunded, claim } = await ecSetup();
    const first = await ecCommitsCleanly(claim, refunded, [ecItem("ec16-a")]);
    // A later transition without evidence (the real take_case) and a later claim of other evidence both commit.
    const taken = await takeCase(h, first, caseRef(first, "case-0002"));
    assert.equal(taken.version, first.version + 1);
    assert.deepEqual(taken.financialCases[0].evidenceReferences, [ecItem("ec16-a")]);
    const second = await ecCommitsCleanly(claim, taken, [ecItem("ec16-b")], "case-0001");
    assert.deepEqual(second.financialCases[0].evidenceReferences, [ecItem("ec16-a"), ecItem("ec16-b")]);
    // A CLOSE on another order of the same core is unaffected by stored evidence elsewhere.
    const p = await inReview("DISPUTE", h);
    await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("ec16-close") }));
});

test("EC/17 (A15f): claims match the stored evidence whatever their order", async () => {
    const { refunded, claim } = await ecSetup();
    const low = ecItem("ec17-a", "synthetic-ec17-aaaa");
    const high = ecItem("ec17-z", "synthetic-ec17-zzzz");
    assert.ok(JSON.stringify([high.evidenceId, high.digest]) > JSON.stringify([low.evidenceId, low.digest]));
    // Claimed and stored in descending key order, then three items in a mixed order.
    const next = await ecCommitsCleanly(claim, refunded, [high, low]);
    const mixed = [ecItem("ec17-m", "synthetic-ec17-mmmm"), ecItem("ec17-y", "synthetic-ec17-yyyy"),
        ecItem("ec17-b", "synthetic-ec17-bbbb")];
    await ecCommitsCleanly(claim, next, mixed, "case-0002");
});

// ---- Görev 193 (Faz 2B-2b): purpose binding, storage integrity, the case evidence contract, CLOSE compatibility ----
//
// No case evidence command exists. Storage and history rules are driven through a probe copy of the sibling core.mjs
// (outside the repository, removed after import) whose one registered command, probe_store, is bound to the case
// evidence purpose in the copy only. data.claims: evidence to claim (default case "case-0001", or claim.caseId);
// data.request / data.attestation: fields overriding the policy-conforming claim; data.put: what to store (default:
// the claimed evidence); data.mode: where and how it is stored, or which stored history it changes.
// Görev 197 (DQ-196-01): data.inherit (attestation fields moved to its prototype); modes for the eight mutants, the
// event log, the scan limits and non-plain data; an await hook (setProbeAwaitHook) and the scan itself exported from
// the copy (probeFindEvidence, probeEvidenceOnly, PROBE_SCAN_LIMITS). core.mjs itself is never changed.
function replaceOnce(source, anchor, replacement) {
    assert.equal(source.split(anchor).length - 1, 1, `probe replacement anchor must occur exactly once: ${anchor}`);
    return source.replace(anchor, () => replacement);
}
const PROBE_STORAGE_HELPER = `// PROBE ONLY (Görev 197): scan access, an await hook and non-plain values built inside the copy.
export const PROBE_SCAN_LIMITS = Object.freeze({ depth: EVIDENCE_SCAN_MAX_DEPTH, nodes: EVIDENCE_SCAN_MAX_NODES });
export function probeFindEvidence(root, nodes = EVIDENCE_SCAN_MAX_NODES) {
    const budget = { nodes };
    const found = findEvidence(root, [], budget);
    return { found, used: nodes - budget.nodes };
}
export function probeEvidenceOnly(before, after, audit, claims) {
    return evidenceOnlyInRegisteredPlaces(before, after, audit, claims);
}
let probeAwaitHook = null;
export function setProbeAwaitHook(hook) { probeAwaitHook = hook; }
async function probeAround(stage, pending, scope) {
    const value = await pending;
    if (probeAwaitHook) probeAwaitHook(stage, scope);
    return value;
}
function probeShape(shape, evidence) {
    const inner = evidence ?? { step: "PROBE" };
    switch (shape) {
        case "map": return new Map([["inner", inner]]);
        case "set": return new Set([inner]);
        case "date": return new Date(0);
        case "instance": return new (class ProbeRecord { constructor() { this.inner = inner; } })();
        case "symbol_key": return { [Symbol("probe")]: inner };
        case "accessor": return Object.defineProperty({}, "inner", { get: () => inner, enumerable: true });
        case "hidden": return Object.defineProperty({}, "inner", { value: inner, enumerable: false });
        case "array_key": return Object.assign([{ step: "PROBE" }], { inner });
        case "function": return { inner: () => inner };
        case "symbol_value": return { inner: Symbol("probe") };
        case "bigint": return { inner: 1n };
        case "cycle": { const loop = { inner }; loop.self = loop; return loop; }
        case "array_cycle": { const loop = [inner]; loop.push(loop); return loop; }
        case "shared": { const once = { step: "PROBE" }; return { a: once, b: [once, { c: once }] }; }
        case "null_proto": return Object.assign(Object.create(null), { inner });
        case "plain": return { inner };
        default: throw new OrderError("PROBE_MODE");
    }
}
`;
let scProbeLoad = null;
function scProbeCore() {
    scProbeLoad ??= (async () => {
        const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        let source = (await readFile(new URL("./core.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        source = inject(source, "transitions: {",
            ` probe_store: { from: "OPEN", to: "OPEN", roles: ["finance", "admin"] },`, "after");
        source = inject(source, `commands: ["add_case_evidence"`, `, "probe_store"`, "after");
        source = inject(source, "export function createCore(config = {}) {", PROBE_CASE_EVIDENCE_HELPER, "before");
        source = inject(source, "export function createCore(config = {}) {", PROBE_STORAGE_HELPER, "before");
        // Görev 197 (A194-05, DQ-196-01 item 4): in this copy only, both awaits of the commit block call the probe hook
        // once their value has arrived, i.e. while the dispatch is suspended between the pre-check and the commit.
        source = replaceOnce(source, "if (casesChanged) event.financialCasesDigest = await digest(next.financialCases);",
            `if (casesChanged) event.financialCasesDigest = await probeAround("cases", digest(next.financialCases),
            { next, audit, event, evidenceClaims });`);
        source = replaceOnce(source, "event.hash = await digest(event);",
            `event.hash = await probeAround("hash", digest(event), { next, audit, event, evidenceClaims });`);
        source = inject(source, `            default: throw new OrderError("UNKNOWN_ACTION");`, `
            case "probe_store": {
                // PROBE ONLY (Görev 193): claims case evidence and stores or rewrites evidence exactly as data says.
                inState(STATES.CLOSED);
                requireHumanActor();
                const mode = data.mode ?? "append";
                const caseOf = id => order.financialCases.find(entry => entry.caseId === id);
                const target = caseOf(data.caseId ?? "case-0001");
                const other = caseOf(data.otherCaseId ?? "case-0002");
                const claimed = [];
                for (const entry of data.claims ?? []) {
                    const evidence = probeCaseEvidence(caseOf(entry.caseId ?? target.caseId),
                        { evidenceId: entry.evidenceId, digest: entry.digest });
                    let attestation = { ...evidence.attestation, ...(data.attestation ?? {}) };
                    // Görev 197 (A194-03/A194-10): data.inherit moves the named attestation fields to its prototype.
                    if (data.inherit) {
                        const inherited = {};
                        for (const field of data.inherit) {
                            inherited[field] = attestation[field];
                            delete attestation[field];
                        }
                        attestation = Object.assign(Object.create(inherited), attestation);
                    }
                    claimEvidence("FINANCIAL_CASE_EVIDENCE", { ...evidence.request, ...(data.request ?? {}) }, attestation);
                    claimed.push({ evidenceId: entry.evidenceId, digest: entry.digest });
                }
                const put = data.put ?? claimed;
                const withCase = (item, change) => { next.financialCases = next.financialCases.map(entry =>
                    (entry.caseId === item.caseId ? change(entry) : entry)); };
                const refs = item => item.evidenceReferences;
                if (mode === "append" || mode === "audit" || mode === "trail") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: [...refs(entry), ...put] }));
                    if (mode === "audit") audit = { step: "PROBE", evidence: data.mirror };
                    if (mode === "trail") withCase(target, entry => ({ ...entry,
                        auditTrail: [...entry.auditTrail, { step: "PROBE", evidence: data.mirror }] }));
                } else if (mode === "other_case") {
                    withCase(other, entry => ({ ...entry, evidenceReferences: [...refs(entry), ...put] }));
                } else if (mode === "resolution") {
                    next.reviews = order.reviews.map((review, index) => (index === 0
                        ? { ...review, resolution: { ...review.resolution, evidence: put[0] } } : review));
                } else if (mode === "decisions") {
                    withCase(target, entry => ({ ...entry, decisions: [...entry.decisions, ...put] }));
                } else if (mode === "proposal" || mode === "closure") {
                    withCase(target, entry => ({ ...entry, [mode]: put[0] }));
                } else if (mode === "assessment") {
                    next.financialAssessments = [...order.financialAssessments, ...put];
                } else if (mode === "nested") {
                    withCase(target, entry => ({ ...entry, origin: { ...entry.origin, note: { inner: put[0] } } }));
                } else if (mode === "delete") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: refs(entry).slice(1) }));
                } else if (mode === "modify") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: refs(entry).map(item => ({ ...item })) }));
                } else if (mode === "reorder") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: [...refs(entry)].reverse() }));
                } else if (mode === "move") {
                    withCase(other, entry => ({ ...entry, evidenceReferences: [...refs(entry), ...refs(target)] }));
                    withCase(target, entry => ({ ...entry, evidenceReferences: [] }));
                } else if (mode === "copy") {
                    withCase(other, entry => ({ ...entry, evidenceReferences: [...refs(entry), ...refs(target)] }));
                } else if (mode === "drop_case") {
                    next.financialCases = order.financialCases.filter(entry => entry !== target);
                } else if (mode === "resolution_modify") {
                    next.reviews = order.reviews.map(review => (review.resolution?.evidence
                        ? { ...review, resolution: { ...review.resolution, evidence: { ...review.resolution.evidence } } }
                        : review));
                // Görev 197 (DQ-196-01): the modes below serve the eight mutants (rename, non_array,
                // delete_and_decisions), the event log (event_*), the scan limits (deep, wide) and non-plain data
                // (shape); "noop" changes nothing, for an order that holds evidence outside the cases.
                } else if (mode === "rename") {
                    withCase(target, entry => ({ ...entry, caseId: "case-0099" }));
                } else if (mode === "non_array") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: { ...refs(entry) } }));
                } else if (mode === "delete_and_decisions") {
                    withCase(target, entry => ({ ...entry, evidenceReferences: refs(entry).slice(1),
                        decisions: [...entry.decisions, ...put] }));
                } else if (mode === "event_drop") {
                    next.events = order.events.slice(1);
                } else if (mode === "event_pop") {
                    next.events = order.events.slice(0, -1);
                } else if (mode === "event_reorder") {
                    next.events = [...order.events].reverse();
                } else if (mode === "event_replace") {
                    next.events = order.events.map((event, index) => (index === 0 ? { ...event } : event));
                } else if (mode === "event_append") {
                    next.events = [...order.events, { sequence: 0, kind: "probe", audit: { evidence: put[0] ?? null } }];
                } else if (mode === "event_evidence") {
                    next.events = order.events.map((event, index) => (index === order.events.length - 1
                        ? { ...event, audit: { ...(event.audit ?? {}), evidence: put[0] } } : event));
                } else if (mode === "shape") {
                    withCase(target, entry => ({ ...entry, note: probeShape(data.shape, put[0]) }));
                } else if (mode === "deep") {
                    let value = {};
                    for (let level = 1; level < data.objects; level += 1) value = { d: value };
                    withCase(target, entry => ({ ...entry, note: value }));
                } else if (mode === "wide") {
                    withCase(target, entry => ({ ...entry, note: Array.from({ length: data.count }, () => ({})) }));
                } else if (mode !== "noop") throw new OrderError("PROBE_MODE");
                at = serverTime();
                casesChanged = true;
                break;
            }
`, "before");
        const dir = await mkdtemp(join(tmpdir(), "unai-storage-probe-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return scProbeLoad;
}

async function scSetup(overrides = {}) {
    const probe = await scProbeCore();
    const h = setup(overrides, null, probe.createCore);
    const { refunded } = await refundedCases(h);
    let sequence = 0;
    const store = (order, data) => h.core.dispatch(order, {
        kind: "probe_store", requestId: `synthetic-sc-${++sequence}`, expectedVersion: order.version, data
    }, h.actor("finance", order, SERVER, "synthetic-finance-sc"));
    return { h, refunded, store };
}
const scItem = text => ({ evidenceId: `synthetic-sc-${text}`, digest: dgDigest(`sc-${text}`) });

/** After a refusal: nothing was consumed and the snapshot still takes a clean claim as its next version. */
async function scCleanAfter(store, order, item) {
    const next = await store(order, { claims: [item] });
    assert.equal(next.version, order.version + 1);
    assert.deepEqual(next.events.slice(0, -1), order.events);
    assert.deepEqual(next.financialCases[0].evidenceReferences.at(-1), item);
    return next;
}

test("PB/3,5: a purpose is claimed only by its bound command and stored only in its place", async () => {
    const { h, refunded, store } = await scSetup();
    const a = scItem("pb5-a");
    // A command bound to case evidence only cannot claim CLOSE, whatever the evidence: refused before format and registry.
    const ec = await ecSetup();
    await assert.rejects(ec.claim(ec.refunded, { items: [ecItem("pb3")], purpose: "CLOSE" }), /EVIDENCE_PURPOSE_MISMATCH/);
    await assert.rejects(ec.claim(ec.refunded, { items: [{ evidenceId: "bad id", digest: "x" }], purpose: "CLOSE" }),
        /EVIDENCE_PURPOSE_MISMATCH/);
    // Claimed for case-0001, stored in case-0002: wrong case.
    await assert.rejects(store(refunded, { claims: [a], mode: "other_case" }), /EVIDENCE_STORAGE_INVALID/);
    // Claimed as case evidence, stored as a review's close evidence: wrong storage.
    await assert.rejects(store(refunded, { claims: [a], mode: "resolution" }), /EVIDENCE_STORAGE_INVALID/);
    // Claimed for case-0002 (its own kind), stored in case-0001.
    await assert.rejects(store(refunded, { claims: [{ ...a, caseId: "case-0002" }] }), /EVIDENCE_STORAGE_INVALID/);
    await scCleanAfter(store, refunded, a);
    // CLOSE keeps its own place.
    const p = await inReview("DISPUTE", h);
    await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("pb5-close") }));
});

test("PB/6,7: evidence-shaped objects outside the registered places are EVIDENCE_STORAGE_INVALID, claimed or not", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("pb6-a");
    for (const mode of ["decisions", "proposal", "closure", "assessment", "nested"]) {
        await assert.rejects(store(refunded, { claims: [a], mode }), /EVIDENCE_STORAGE_INVALID/, `${mode} claimed`);
        await assert.rejects(store(refunded, { put: [a], mode }), /EVIDENCE_STORAGE_INVALID/, `${mode} unclaimed`);
    }
    // An object carrying only a digest, or only an id, is evidence-shaped too.
    await assert.rejects(store(refunded, { put: [{ digest: a.digest }], mode: "decisions" }), /EVIDENCE_STORAGE_INVALID/);
    await assert.rejects(store(refunded, { put: [{ evidenceId: a.evidenceId }], mode: "proposal" }), /EVIDENCE_STORAGE_INVALID/);
    // Mirrors (the transition's audit, a case audit trail entry) may only repeat evidence stored before or claimed now.
    const b = scItem("pb7-b");
    await assert.rejects(store(refunded, { claims: [a], mode: "audit", mirror: b }), /EVIDENCE_STORAGE_INVALID/);
    await assert.rejects(store(refunded, { claims: [a], mode: "trail", mirror: b }), /EVIDENCE_STORAGE_INVALID/);
    const mirrored = await store(refunded, { claims: [a], mode: "trail", mirror: a });
    assert.deepEqual(mirrored.financialCases[0].auditTrail.at(-1).evidence, a);
    const audited = await store(mirrored, { claims: [b], mode: "audit", mirror: b });
    assert.deepEqual(audited.events.at(-1).audit.evidence, b);
});

test("PB/8: stored evidence is append-only: delete, modify, reorder, move and dropping a case are EVIDENCE_HISTORY_CHANGED", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("pb8-a");
    const b = scItem("pb8-b");
    const held = await store(refunded, { claims: [a, b] });
    for (const mode of ["delete", "modify", "reorder", "move", "drop_case"]) {
        await assert.rejects(store(held, { mode }), /EVIDENCE_HISTORY_CHANGED/, mode);
    }
    // Copying stored evidence into another case is new, unclaimed evidence.
    await assert.rejects(store(held, { mode: "copy" }), /EVIDENCE_NOT_CLAIMED/);
    // The history is intact: appending a third entry keeps the first two as the same objects.
    const c = scItem("pb8-c");
    const next = await store(held, { claims: [c] });
    assert.equal(next.financialCases[0].evidenceReferences[0], held.financialCases[0].evidenceReferences[0]);
    assert.deepEqual(next.financialCases[0].evidenceReferences, [a, b, c]);
});

test("PB/8 (close): a resolved review's close evidence cannot be changed by a later transition", async () => {
    const probe = await scProbeCore();
    const h = setup({}, null, probe.createCore);
    const p = await inReview("DISPUTE", h);
    const closed = await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("pb8-close") }));
    await assert.rejects(h.core.dispatch(closed, { kind: "probe_store", requestId: "synthetic-pb8-close",
        expectedVersion: closed.version, data: { mode: "resolution_modify" } },
    h.actor("finance", closed, SERVER, "synthetic-finance-pb8")), /EVIDENCE_HISTORY_CHANGED/);
});

test("PB/9,10,13 (gate): case evidence is claimed only for its canonical case, policy version, kind, source and digest basis", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("pb9-a");
    const requestRefusals = [
        [{ evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.0" }, /CASE_EVIDENCE_POLICY_MISMATCH/],
        [{ evidencePolicyVersion: "UNAI-FINANCIAL-CASE-v1.0" }, /CASE_EVIDENCE_POLICY_MISMATCH/],
        [{ evidencePolicyVersion: undefined }, /CASE_EVIDENCE_POLICY_MISMATCH/],
        [{ evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION", source: "customer_confirmation_service" }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidenceKind: "REVISION_DELIVERY_RECORD", source: "producer_console" }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ source: "producer_console" }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidenceKind: "toString" }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ digestBasis: "JCS_UTF8" }, /EVIDENCE_MISMATCH/],
        [{ digestBasis: undefined }, /EVIDENCE_MISMATCH/],
        [{ caseId: "case-9999" }, /EVIDENCE_MISMATCH/],
        [{ caseType: "UNDELIVERED_REVISION" }, /EVIDENCE_MISMATCH/]
    ];
    for (const [request, expected] of requestRefusals) {
        await assert.rejects(store(refunded, { claims: [a], request }), expected, JSON.stringify(request));
    }
    const attestationRefusals = [{ purpose: undefined }, { purpose: "CLOSE" }, { purpose: "financial_case_evidence" },
        { evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.0" }, { evidencePolicyVersion: undefined },
        { digestBasis: "JCS_UTF8" }, { digestBasis: undefined }, { caseId: "case-0002" },
        { evidenceKind: "PROVIDER_DISPUTE_OUTCOME" }, { source: "producer_console" }];
    for (const attestation of attestationRefusals) {
        await assert.rejects(store(refunded, { claims: [a], attestation }), /UNTRUSTED_EVIDENCE/, JSON.stringify(attestation));
    }
    await scCleanAfter(store, refunded, a);
});

test("PB/14 (gate): the TEST-only synthetic boundary holds for case evidence; the order of checks keeps purpose and format first", async () => {
    const off = await scSetup({ allowSyntheticEvidence: false });
    const a = scItem("pb14-a");
    await assert.rejects(off.store(off.refunded, { claims: [a] }), /SYNTHETIC_VERIFIER_NOT_ALLOWED/);
    const next = await off.store(off.refunded, { claims: [a], attestation: { verifier: { kind: "PRODUCTION",
        id: "synthetic-evidence-service" } } });
    assert.equal(next.version, off.refunded.version + 1);
    // A used id with a wrong policy version or kind is judged on policy first, never on the registries.
    const { refunded, store } = await scSetup();
    const used = await scCleanAfter(store, refunded, scItem("pb14-used"));
    await assert.rejects(store(used, { claims: [{ ...scItem("pb14-used"), digest: dgDigest("pb14-x") }],
        request: { evidencePolicyVersion: "v0" } }), /CASE_EVIDENCE_POLICY_MISMATCH/);
    await assert.rejects(store(used, { claims: [{ ...scItem("pb14-used"), digest: dgDigest("pb14-x") }],
        request: { evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION" } }), /EVIDENCE_KIND_NOT_ALLOWED/);
    await assert.rejects(store(used, { claims: [{ ...scItem("pb14-used"), digest: dgDigest("pb14-x") }] }),
        /EVIDENCE_REFERENCE_USED/);
});

// ---- The case evidence contract (pure functions; no command, no verifier call) ----
const cvCore = () => import("./core.mjs");
function cvRecord(order, item, evidence = {}, extra = {}) {
    const [evidenceKind, rule] = item.caseType === "ORDER_REFUND"
        ? ["PAYMENT_PROVIDER_RECORD", { source: "payment_provider_reconciliation" }]
        : ["REVISION_DELIVERY_RECORD", { source: "producer_console" }];
    return {
        kind: "CASE_EVIDENCE_SUBMISSION", orderId: order.id, caseId: item.caseId, reviewId: item.origin.reviewId,
        caseType: item.caseType, evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
        authorizationRef: "synthetic-case-auth-0001", source: "finance_console", actorId: "synthetic-finance-cv",
        evidence: { evidenceId: "synthetic-cv-evidence-1", evidenceKind, source: rule.source, orderId: order.id,
            caseId: item.caseId, reviewId: item.origin.reviewId, createdAt: item.createdAt, digest: dgDigest("cv"),
            signature: "synthetic-service-signature", ...evidence },
        signature: "synthetic-console-signature", ...extra
    };
}

test("CV/1: the case evidence policy is closed, frozen and versioned; the case policy keeps v1.0; add_case_evidence is TEST-only", async () => {
    const core = await cvCore();
    assert.ok(Object.isFrozen(core.CASE_EVIDENCE_POLICY) && Object.isFrozen(core.CASE_EVIDENCE_POLICY.kinds.ORDER_REFUND));
    assert.deepEqual(core.CASE_EVIDENCE_POLICY, {
        reference: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
        kinds: {
            ORDER_REFUND: {
                PAYMENT_PROVIDER_RECORD: { source: "payment_provider_reconciliation", digestBasis: "RAW_BYTES" },
                PROVIDER_DISPUTE_OUTCOME: { source: "payment_provider_reconciliation", digestBasis: "RAW_BYTES" }
            },
            UNDELIVERED_REVISION: { REVISION_DELIVERY_RECORD: { source: "producer_console", digestBasis: "JCS_UTF8" } }
        },
        excludedKinds: { CUSTOMER_CLOSURE_CONFIRMATION: "LEGAL_REVIEW_PENDING" }
    });
    assert.equal(core.FINANCIAL_CASE_POLICY.reference, "UNAI-FINANCIAL-CASE-v1.0");
    assert.deepEqual(Object.keys(core.FINANCIAL_CASE_POLICY.transitions), ["take_case", "add_case_evidence"]);
    assert.deepEqual(core.FINANCIAL_CASE_POLICY.transitions.add_case_evidence,
        { from: "UNDER_REVIEW", to: "UNDER_REVIEW", roles: ["finance", "admin"] });
    const { refunded, core: live, actor } = await refundedCases();
    assert.ok(refunded.financialCases.every(item => item.policyVersion === "UNAI-FINANCIAL-CASE-v1.0"));
    // Görev 206 (DQ-203-01): in TEST the command exists and refuses an empty payload; outside TEST the gate refuses it.
    await assert.rejects(live.dispatch(refunded, { kind: "add_case_evidence", requestId: "synthetic-cv1-request",
        expectedVersion: refunded.version, data: {} }, actor("finance", refunded, SERVER, "synthetic-finance-cv1")),
    /INVALID_CASE_REFERENCE/);
    const off = await refundedCases(liveSetup("PRODUCTION"));
    await assert.rejects(off.core.dispatch(off.refunded, { kind: "add_case_evidence", requestId: "synthetic-cv1-request",
        expectedVersion: off.refunded.version, data: {} }, off.actor("finance", off.refunded, SERVER, "synthetic-finance-cv1")),
    /CASE_COMMAND_NOT_ENABLED/);
});

test("CV/2: checkCaseEvidence returns the request to attest, with the expected digest basis per kind", async () => {
    const { checkCaseEvidence, caseEvidenceBinding } = await cvCore();
    const { refunded } = await refundedCases();
    const [refund, revision] = refunded.financialCases;
    const record = cvRecord(refunded, refund);
    const request = checkCaseEvidence(record, refunded, refund, "finance");
    assert.ok(Object.isFrozen(request));
    assert.deepEqual(request, {
        purpose: "FINANCIAL_CASE_EVIDENCE", evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
        evidenceId: "synthetic-cv-evidence-1", evidenceKind: "PAYMENT_PROVIDER_RECORD",
        source: "payment_provider_reconciliation", orderId: refunded.id, caseId: refund.caseId,
        reviewId: refund.origin.reviewId, caseType: "ORDER_REFUND", createdAt: refund.createdAt, digest: dgDigest("cv"),
        digestBasis: "RAW_BYTES", decisionBinding: caseEvidenceBinding(record)
    });
    assert.equal(checkCaseEvidence(cvRecord(refunded, revision), refunded, revision, "finance").digestBasis, "JCS_UTF8");
    assert.equal(checkCaseEvidence(cvRecord(refunded, refund, {}, { source: "admin_console" }), refunded, refund, "admin")
        .caseType, "ORDER_REFUND");
});

test("CV/3: checkCaseEvidence refuses shape, reference, policy, kind and time faults with the approved codes", async () => {
    const { checkCaseEvidence } = await cvCore();
    const { refunded } = await refundedCases();
    const [refund, revision] = refunded.financialCases;
    const check = (record, item = refund, role = "finance") => () => checkCaseEvidence(record, refunded, item, role);
    const before = new Date(Date.parse(refund.createdAt) - 1).toISOString();
    const cases = [
        [cvRecord(refunded, refund, {}, { extra: 1 }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, {}, { kind: "CLOSE_DECISION" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, {}, { authorizationRef: "bad ref" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, {}, { source: "admin_console" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, {}, { orderId: "another-order" }), /INVALID_CASE_REFERENCE/],
        [cvRecord(refunded, refund, {}, { caseId: revision.caseId }), /INVALID_CASE_REFERENCE/],
        [cvRecord(refunded, refund, {}, { reviewId: "review-9999" }), /INVALID_CASE_REFERENCE/],
        [cvRecord(refunded, refund, {}, { caseType: "UNDELIVERED_REVISION" }), /INVALID_CASE_REFERENCE/],
        [cvRecord(refunded, refund, {}, { evidencePolicyVersion: "UNAI-FINANCIAL-CASE-v1.0" }), /CASE_EVIDENCE_POLICY_MISMATCH/],
        [cvRecord(refunded, refund, {}, { evidencePolicyVersion: undefined }), /CASE_EVIDENCE_POLICY_MISMATCH/],
        [cvRecord(refunded, refund, { verified: true }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { evidenceId: "bad id" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { orderId: "another-order" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { caseId: revision.caseId }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { digest: dgDigest("cv").toUpperCase() }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { digest: "" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { createdAt: "2026-10-28T09:00:00" }), /EVIDENCE_MISMATCH/],
        [cvRecord(refunded, refund, { evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION", source: "customer_confirmation_service" }),
            /EVIDENCE_KIND_NOT_ALLOWED/],
        [cvRecord(refunded, refund, { evidenceKind: "REVISION_DELIVERY_RECORD", source: "producer_console" }),
            /EVIDENCE_KIND_NOT_ALLOWED/],
        [cvRecord(refunded, refund, { source: "producer_console" }), /EVIDENCE_KIND_NOT_ALLOWED/],
        [cvRecord(refunded, refund, { createdAt: before }), /EVIDENCE_STALE/]
    ];
    for (const [record, expected] of cases) assert.throws(check(record), expected, JSON.stringify(record).slice(0, 120));
    assert.throws(check(cvRecord(refunded, refund), refund, "customer"), /EVIDENCE_MISMATCH/);
    // A polluted prototype opens no kind.
    Object.prototype.SYNTHETIC_POLLUTED_KIND = { source: "payment_provider_reconciliation", digestBasis: "RAW_BYTES" };
    try {
        assert.throws(check(cvRecord(refunded, refund, { evidenceKind: "SYNTHETIC_POLLUTED_KIND" })), /EVIDENCE_KIND_NOT_ALLOWED/);
    } finally {
        delete Object.prototype.SYNTHETIC_POLLUTED_KIND;
    }
});

test("CV/4: caseEvidenceBinding covers every listed field, differs from CLOSE and leaves both signatures out", async () => {
    const { caseEvidenceBinding, CASE_EVIDENCE_BINDING_FIELDS, CASE_ATTESTED_FIELDS } = await cvCore();
    const { refunded } = await refundedCases();
    const record = cvRecord(refunded, refunded.financialCases[0]);
    const base = caseEvidenceBinding(record);
    // The lists themselves are pinned: a field dropped from either list is a test failure, not a shorter loop.
    assert.deepEqual(CASE_EVIDENCE_BINDING_FIELDS, ["orderId", "caseId", "reviewId", "caseType", "evidencePolicyVersion",
        "authorizationRef", "source", "actorId", "evidence.evidenceId", "evidence.evidenceKind", "evidence.source",
        "evidence.orderId", "evidence.caseId", "evidence.reviewId", "evidence.createdAt", "evidence.digest"]);
    assert.deepEqual(CASE_ATTESTED_FIELDS, ["purpose", "evidencePolicyVersion", "evidenceId", "evidenceKind", "source",
        "orderId", "caseId", "reviewId", "caseType", "createdAt", "digest", "digestBasis", "decisionBinding"]);
    assert.equal(JSON.parse(base).length, 1 + CASE_EVIDENCE_BINDING_FIELDS.length);
    assert.equal(JSON.parse(base)[0], "UNAI-CASE-EVIDENCE-v1");
    assert.notEqual(JSON.parse(base)[0], JSON.parse(closeDecisionBinding({}))[0]);
    for (const path of CASE_EVIDENCE_BINDING_FIELDS) {
        const changed = structuredClone(record);
        const keys = path.split(".");
        keys.slice(0, -1).reduce((value, key) => value[key], changed)[keys.at(-1)] = "synthetic-changed-value";
        assert.notEqual(caseEvidenceBinding(changed), base, path);
    }
    assert.equal(caseEvidenceBinding({ ...record, signature: "other" }), base);
    assert.equal(caseEvidenceBinding({ ...record, evidence: { ...record.evidence, signature: "other" } }), base);
    for (const field of ["purpose", "evidencePolicyVersion", "caseId", "caseType", "digest", "digestBasis", "decisionBinding"]) {
        assert.ok(CASE_ATTESTED_FIELDS.includes(field), field);
    }
});

test("CV/5: a case attestation must state every attested field, the digest basis included; the console verdict must bind", async () => {
    const { checkCaseEvidence, checkCaseEvidenceAttestation, checkCaseRecordVerdict, caseEvidenceBinding } = await cvCore();
    const { refunded } = await refundedCases();
    const record = cvRecord(refunded, refunded.financialCases[0]);
    const request = checkCaseEvidence(record, refunded, refunded.financialCases[0], "finance");
    const attested = { status: "VERIFIED", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" }, ...request };
    checkCaseEvidenceAttestation(attested, request);
    const refusals = [null, true, { ...attested, status: "PENDING" }, { ...attested, verifier: null },
        { ...attested, verifier: { kind: "OTHER", id: "synthetic-evidence-service" } }];
    for (const field of Object.keys(request)) refusals.push({ ...attested, [field]: undefined });
    refusals.push({ ...attested, digestBasis: "JCS_UTF8" }, { ...attested, purpose: "CLOSE" });
    for (const attestation of refusals) {
        assert.throws(() => checkCaseEvidenceAttestation(attestation, request), /UNTRUSTED_EVIDENCE/,
            JSON.stringify(attestation)?.slice(0, 80));
    }
    const binding = caseEvidenceBinding(record);
    checkCaseRecordVerdict({ verified: true, binding }, binding);
    for (const verdict of [true, null, { verified: true }, { verified: true, binding: `${binding}x` },
        { verified: "true", binding }]) {
        assert.throws(() => checkCaseRecordVerdict(verdict, binding), /UNTRUSTED_REVIEW/);
    }
});

// ---- DQ-191-02: the CLOSE behaviour of this core is compared with the pinned 2B-2a core (61df9c2d), never checked out:
// the pinned file is read with `git show` into a temporary copy outside the repository. Same deterministic scenarios,
// same ids: refusal codes and full committed snapshots, hashes included, must be identical.
const PINNED_2B2A = "61df9c2d308f57fb85047b7816daf3eca9211746";
let pinnedLoad = null;
function pinnedCore() {
    pinnedLoad ??= (async () => {
        const { execFileSync } = await import("node:child_process");
        const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { pathToFileURL, fileURLToPath } = await import("node:url");
        // The repository root holds the pinned commit; a copy of this file outside it (a mutation run) names the
        // repository in UNAI_PINNED_REPO. A missing commit or git fails the test, never skips it.
        const repository = process.env.UNAI_PINNED_REPO ?? fileURLToPath(new URL("..", import.meta.url));
        let source = execFileSync("git", ["show", `${PINNED_2B2A}:studio_order_core/core.mjs`],
            { cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
            .replaceAll("\r\n", "\n");
        const calendarImport = `from "./calendar.mjs";`;
        source = inject(source, calendarImport, "", "after").replace(calendarImport,
            () => `from ${JSON.stringify(new URL("./calendar.mjs", import.meta.url).href)};`);
        const dir = await mkdtemp(join(tmpdir(), "unai-pinned-core-"));
        try {
            await writeFile(join(dir, "core.mjs"), source);
            return await import(pathToFileURL(join(dir, "core.mjs")).href);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    })();
    return pinnedLoad;
}

async function closeScenarios(factory, synthetic) {
    let n = 0;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, writable: true, value: () => {
        n += 1;
        return `${String(n).padStart(8, "0")}-${String(n).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`;
    } });
    try {
        let tamper = attestation => attestation;
        let failing = false;
        const h = setup({ allowSyntheticEvidence: synthetic, verifyEvidence: async (evidence, request) => {
            if (failing) throw new Error("synthetic-evidence-service-down");
            return tamper(syntheticAttestation(evidence, request));
        } }, null, factory);
        const out = [];
        const record = async (label, run) => {
            try {
                const value = await run();
                out.push([label, "COMMITTED", JSON.parse(JSON.stringify(value))]);
                return value;
            } catch (error) {
                out.push([label, error.code ?? `THROW:${error.message}`]);
                return null;
            }
        };
        const production = attestation => attestation && { ...attestation, verifier: { kind: "PRODUCTION", id: "synthetic-evidence-service" } };
        const asIs = attestation => attestation;
        tamper = production;
        const first = await inReview("DISPUTE", h);
        const firstRecord = dgRecord(h, first, { digest: dgDigest("diff-used") });
        await record("first", () => h.resolveReview(first.reviewed, "CLOSE", firstRecord));
        const usedId = firstRecord.evidence.evidenceId;
        const usedDigest = dgDigest("diff-used");
        const usedRef = firstRecord.authorizationRef;
        const future = "2030-01-01T00:00:00.000Z";
        const scenarios = [
            ["fresh-P", {}, {}, production], ["fresh-S", {}, {}, asIs],
            ["usedId", { evidenceId: usedId }, {}, production], ["usedDigest", { digest: usedDigest }, {}, production],
            ["usedBoth", { evidenceId: usedId, digest: usedDigest }, {}, production],
            ["usedRef", {}, { authorizationRef: usedRef }, production],
            ["usedRef+usedDigest", { digest: usedDigest }, { authorizationRef: usedRef }, production],
            ["usedRef+usedId-S", { evidenceId: usedId }, { authorizationRef: usedRef }, asIs],
            ["usedDigest+future", { digest: usedDigest, createdAt: future }, {}, production],
            ["future", { createdAt: future }, {}, production],
            ["beforeOrder", { createdAt: "2020-01-01T00:00:00.000Z" }, {}, production],
            ["upper", { digest: dgDigest("u").toUpperCase() }, {}, production],
            ["short", { digest: "a".repeat(63) }, {}, production],
            ["attNull", {}, {}, () => null], ["attTrue", {}, {}, () => true],
            ["attPending", {}, {}, a => production(a) && { ...production(a), status: "PENDING" }],
            ["verifierOther", {}, {}, a => a && { ...a, verifier: { kind: "OTHER", id: "synthetic-evidence-service" } }],
            ["attDigestOther", {}, {}, a => production(a) && { ...production(a), digest: dgDigest("other") }],
            ["verifierExtra", {}, {}, a => a && { ...a, verifier: { kind: "PRODUCTION", id: "synthetic-evidence-service", extra: "x" } }],
            ["attPurpose", {}, {}, a => production(a) && { ...production(a), purpose: "FINANCIAL_CASE_EVIDENCE" }],
            ["usedId-S", { evidenceId: usedId }, {}, asIs],
            ["verifierThrows", {}, {}, production, { failing: true }],
            ["duplicateOrder", {}, {}, production, { type: "CANCELLATION", code: "DUPLICATE_ORDER" }],
            ["fraudPendingLegal", {}, {}, production, { type: "DISPUTE", code: "FRAUD_CONFIRMED" }],
            ["retry", {}, {}, production, { retry: true }],
            ["staleVersion", {}, {}, production, { stale: true }]
        ];
        for (const [label, evidence, extra, attest, options = {}] of scenarios) {
            tamper = attest;
            failing = Boolean(options.failing);
            const p = await inReview(options.type ?? "DISPUTE", h);
            const close = h.resolution(p.reviewed, p.id, "CLOSE",
                { ...h.closeFields(p.reviewed, p.id, options.code ?? DG_CODE, evidence), ...extra });
            const done = await record(label, () => h.resolveReview(p.reviewed, "CLOSE", close, "finance",
                options.stale ? { version: p.reviewed.version - 1 } : {}));
            failing = false;
            if (options.retry && done) {
                const requestId = done.events.at(-1).requestId;
                await record(`${label}-same`, () => h.resolveReview(p.reviewed, "CLOSE", close, "finance", { requestId }));
                const changed = h.resolution(p.reviewed, p.id, "CLOSE", h.closeFields(p.reviewed, p.id, DG_CODE));
                await record(`${label}-changed`, () => h.resolveReview(p.reviewed, "CLOSE", changed, "finance", { requestId }));
            }
        }
        return out;
    } finally {
        if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
        else delete globalThis.crypto.randomUUID;
    }
}

test("DIFF/1 (DQ-191-02): CLOSE codes and committed snapshots, hashes included, equal the pinned 2B-2a core", async () => {
    const pinned = await pinnedCore();
    for (const synthetic of [true, false]) {
        const before = await closeScenarios(pinned.createCore, synthetic);
        const after = await closeScenarios(createCore, synthetic);
        assert.equal(after.length, before.length);
        assert.ok(before.length >= 28);
        for (let i = 0; i < before.length; i++) assert.deepEqual(after[i], before[i], `synthetic=${synthetic} ${before[i][0]}`);
        // The comparison is not vacuous: commits and refusals both occur.
        assert.ok(before.some(entry => entry[1] === "COMMITTED") && before.some(entry => entry[1] !== "COMMITTED"));
    }
});

test("T-S/6: the 2B-2b gate and storage helpers are synchronous; the purpose policy and claim carry the dispatch's command", async () => {
    const source = await coreSource();
    for (const start of ["function findEvidence(", "function storedEvidenceLocations(snapshot) {",
        "function claimsMatchStoredLocations(before, after, claims) {",
        "function evidenceOnlyInRegisteredPlaces(before, after, audit, claims) {",
        "function evidenceHistoryKept(before, after) {", "function caseEvidenceRule(caseType, evidenceKind, source) {",
        "export function checkCaseEvidence(record, order, item, role) {",
        "export function checkCaseEvidenceAttestation(attestation, request) {",
        "export function checkCaseRecordVerdict(signed, binding) {"]) {
        assert.doesNotMatch(sourceBlock(source, start, "\n}\n"), /\bawait\b|\basync\b|\.then\(/, start);
    }
    const gate = sourceBlock(source, "        const claimEvidence = (purpose, request, attestation) => {", "\n        };\n");
    assert.match(gate, /policy\.commands\.includes\(command\.kind\), "EVIDENCE_PURPOSE_MISMATCH"/);
    assert.match(gate, /command: command\.kind, storage: policy\.storage/);
    assert.equal(occurrences(source, "evidenceClaims.push("), 1);
    // The 2B-2b checks run before any await of the commit block; the registry re-check and writes are unchanged.
    const commit = sourceBlock(source, "        requireThat(evidenceHistoryKept(order, next), \"EVIDENCE_HISTORY_CHANGED\");",
        "        recordClaims();");
    assert.ok(commit.indexOf("EVIDENCE_STORAGE_INVALID") < commit.indexOf("await digest(event)"));
});

test("PB/18: a claim that bypasses the gate is refused at commit unless bound to this command and its purpose's place", async () => {
    const { refunded, claim } = await ecSetup();
    const base = { purpose: "FINANCIAL_CASE_EVIDENCE", command: "probe_claim", storage: "CASE_EVIDENCE", ...ecItem("pb18"),
        orderId: refunded.id, caseId: "case-0001", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" } };
    const refusals = [{ ...base, command: "take_case" }, { ...base, command: "resolve_review" }, { ...base, command: undefined },
        { ...base, storage: "REVIEW_RESOLUTION" }, { ...base, storage: undefined }, { ...base, caseId: null },
        { ...base, purpose: "CLOSE", storage: "REVIEW_RESOLUTION", caseId: null }];
    for (const raw of refusals) {
        await assert.rejects(claim(refunded, { raw: [raw], freezeRaw: true, storeRaw: true }), /EVIDENCE_MISMATCH/,
            JSON.stringify(raw).slice(0, 120));
    }
    await ecCommitsCleanly(claim, refunded, [ecItem("pb18")]);
});

// ---- Görev 197 (Faz 2B-2b remediation; DQ-195-01…06, DQ-196-01) ----
//   MUT/N-xx  one repository test for each mutant the Görev 194 audit found unguarded by this suite
//   NE/*      evidence nested anywhere, cycles, the depth and size limits and non-plain data (A194-01, DQ-195-04)
//   EL/*      the event log is append-only and scanned (A194-02, DQ-195-03)
//   AB/*      case attestations bind all 13 fields, the canonical order and review, and only own fields (A194-03)
//   AS/*      what changes while the commit is suspended is refused after the last await (A194-05, DQ-195-06)
//   T-S/7     the structural lock of the post-await re-check
// Every refusal is followed by a clean commit of the same evidence on the unchanged snapshot: nothing was consumed.

/** A second refunded order of the same probe core: another order with its own case-0001. */
async function scOtherOrder(h) {
    return (await refundedCases(h)).refunded;
}

/** A refusal by the pre-check: the store is refused and the commit block's awaits were never reached (T-S/6 states
 * that the 2B-2b checks run before them; this is the behavioural side of that contract). */
async function scRefusedBeforeAwait(store, order, data, expected, label) {
    const probe = await scProbeCore();
    let reached = 0;
    probe.setProbeAwaitHook(() => { reached += 1; });
    try {
        await assert.rejects(store(order, data), expected, label);
    } finally {
        probe.setProbeAwaitHook(null);
    }
    assert.equal(reached, 0, `${label}: refused before the commit's awaits`);
}

test("MUT/N-02: evidence stored one level below a registered case entry is EVIDENCE_STORAGE_INVALID, claimed or not", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("n02-a");
    await assert.rejects(store(refunded, { claims: [a], put: [[a]] }), /EVIDENCE_STORAGE_INVALID/, "claimed");
    await assert.rejects(store(refunded, { put: [[a]] }), /EVIDENCE_STORAGE_INVALID/, "unclaimed");
    await scCleanAfter(store, refunded, a);
});

test("MUT/N-05: the transition's audit may mirror only at audit.evidence; evidence below it is EVIDENCE_STORAGE_INVALID", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("n05-a");
    const b = scItem("n05-b");
    // Refused by the pre-check itself: the event log scan after the await would refuse it too, later.
    await scRefusedBeforeAwait(store, refunded, { claims: [a], mode: "audit", mirror: { ...a, evidence: b } },
        /EVIDENCE_STORAGE_INVALID/, "audit.evidence.evidence below a known mirror");
    await scRefusedBeforeAwait(store, refunded, { claims: [a], mode: "audit", mirror: { evidence: a } },
        /EVIDENCE_STORAGE_INVALID/, "audit.evidence.evidence");
    await scCleanAfter(store, refunded, a);
});

test("MUT/N-06: renaming a case that holds evidence is EVIDENCE_HISTORY_CHANGED", async () => {
    const { refunded, store } = await scSetup();
    const held = await store(refunded, { claims: [scItem("n06-a")] });
    await assert.rejects(store(held, { mode: "rename" }), /EVIDENCE_HISTORY_CHANGED/);
    await scCleanAfter(store, held, scItem("n06-b"));
});

test("MUT/N-07: turning a case's evidence list into an object is EVIDENCE_HISTORY_CHANGED", async () => {
    const { refunded, store } = await scSetup();
    const held = await store(refunded, { claims: [scItem("n07-a"), scItem("n07-b")] });
    await assert.rejects(store(held, { mode: "non_array" }), /EVIDENCE_HISTORY_CHANGED/);
    await scCleanAfter(store, held, scItem("n07-c"));
});

test("MUT/N-10: a bypassing claim of case evidence bound to the CLOSE storage is EVIDENCE_MISMATCH", async () => {
    const { refunded, claim } = await ecSetup();
    const raw = { purpose: "FINANCIAL_CASE_EVIDENCE", command: "probe_claim", storage: "REVIEW_RESOLUTION",
        ...ecItem("n10"), orderId: refunded.id, caseId: null, verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" } };
    await assert.rejects(claim(refunded, { raw: [raw], freezeRaw: true, storeRaw: true }), /EVIDENCE_MISMATCH/);
    await ecCommitsCleanly(claim, refunded, [ecItem("n10")]);
});

test("MUT/N-16: the gate judges the canonical case before the policy version", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("n16-a");
    await assert.rejects(store(refunded, { claims: [a], request: { caseId: "case-9999", evidencePolicyVersion: "v1.0" } }),
        /EVIDENCE_MISMATCH/);
    await scCleanAfter(store, refunded, a);
});

test("MUT/N-17: a history change is reported before a storage fault in the same transition", async () => {
    const { refunded, store } = await scSetup();
    const held = await store(refunded, { claims: [scItem("n17-a"), scItem("n17-b")] });
    await assert.rejects(store(held, { mode: "delete_and_decisions", put: [scItem("n17-c")] }), /EVIDENCE_HISTORY_CHANGED/);
    await scCleanAfter(store, held, scItem("n17-c"));
});

test("MUT/N-30: a case audit trail mirror may not hold evidence below its own evidence field", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("n30-a");
    await assert.rejects(store(refunded, { claims: [a], mode: "trail", mirror: { inner: a } }), /EVIDENCE_STORAGE_INVALID/);
    await scCleanAfter(store, refunded, a);
});

test("NE/1: evidence nested in a registered case entry is EVIDENCE_STORAGE_INVALID, even when claimed", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("ne1-a");
    const b = scItem("ne1-b");
    const nested = [[{ ...a, extra: b }], [{ ...a, extra: { note: [b] } }], [{ ...a, extra: { evidenceId: b.evidenceId } }],
        [{ ...a, extra: { digest: b.digest } }], [{ ...a, extra: { ...a } }]];
    for (const put of nested) {
        await assert.rejects(store(refunded, { claims: [a], put }), /EVIDENCE_STORAGE_INVALID/, JSON.stringify(put));
    }
    await assert.rejects(store(refunded, { claims: [a, b], put: [{ ...a, extra: b }] }), /EVIDENCE_STORAGE_INVALID/,
        "both claimed, one nested");
    await scCleanAfter(store, refunded, a);
});

test("NE/2: evidence nested in a mirror (the transition's audit, a case audit trail entry) is EVIDENCE_STORAGE_INVALID", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("ne2-a");
    const b = scItem("ne2-b");
    for (const mode of ["audit", "trail"]) {
        for (const mirror of [{ ...a, inner: b }, { ...a, inner: { ...a } }, { ...a, list: [{ note: b }] }]) {
            await assert.rejects(store(refunded, { claims: [a], mode, mirror }), /EVIDENCE_STORAGE_INVALID/,
                `${mode} ${JSON.stringify(mirror)}`);
        }
    }
    // A plain mirror of the claimed evidence still commits (PB/7).
    const mirrored = await store(refunded, { claims: [a], mode: "trail", mirror: a });
    assert.deepEqual(mirrored.financialCases[0].auditTrail.at(-1).evidence, a);
});

test("NE/3: a cycle is refused without a stack overflow; one object reached on several paths is not a cycle", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("ne3-a");
    for (const shape of ["cycle", "array_cycle"]) {
        await assert.rejects(store(refunded, { mode: "shape", shape }), /EVIDENCE_STORAGE_INVALID/, shape);
        await assert.rejects(store(refunded, { mode: "shape", shape, put: [a] }), /EVIDENCE_STORAGE_INVALID/, `${shape} + evidence`);
    }
    const shared = await store(refunded, { mode: "shape", shape: "shared" });
    assert.equal(shared.version, refunded.version + 1);
    const note = shared.financialCases[0].note;
    assert.equal(note.a, note.b[0]);
    assert.equal(note.a, note.b[1].c);
    const { probeFindEvidence } = await scProbeCore();
    const loop = { step: "PROBE" };
    loop.next = { back: [loop] };
    assert.equal(probeFindEvidence({ root: loop }).found, null);
    const once = { ...a };
    assert.deepEqual(probeFindEvidence({ x: once, y: [once] }).found, [["x"], ["y", "0"]]);
});

test("NE/4: CLOSE keeps one evidence object in its resolution, audit and event; later transitions still commit", async () => {
    const probe = await scProbeCore();
    const h = setup({}, null, probe.createCore);
    const p = await inReview("DISPUTE", h);
    const closed = await dgClosesCleanly(h, p, dgRecord(h, p, { digest: dgDigest("ne4") }));
    assert.equal(closed.reviews.at(-1).resolution.evidence, closed.events.at(-1).audit.evidence);
    assert.deepEqual(probe.probeFindEvidence(closed).found.map(path => path.join(".")).sort(),
        [`events.${closed.events.length - 1}.audit.evidence`, `reviews.${closed.reviews.length - 1}.resolution.evidence`]);
    const later = await h.core.dispatch(closed, { kind: "probe_store", requestId: "synthetic-ne4-noop",
        expectedVersion: closed.version, data: { mode: "noop" } }, h.actor("finance", closed, SERVER, "synthetic-finance-ne4"));
    assert.equal(later.version, closed.version + 1);
    assert.ok(closed.events.every((event, index) => later.events[index] === event));
    assert.equal(later.reviews.at(-1).resolution.evidence, closed.reviews.at(-1).resolution.evidence);
});

test("NE/5 (depth): the deepest object may sit at path length 64; 65 and far deeper are refused without a stack overflow", async (t) => {
    const { refunded, store } = await scSetup();
    const { PROBE_SCAN_LIMITS, probeFindEvidence } = await scProbeCore();
    assert.deepEqual({ ...PROBE_SCAN_LIMITS }, { depth: 64, nodes: 200000 });
    // The note sits at path length 3 (financialCases, 0, note): `objects` nested objects end at length 2 + objects.
    await assert.rejects(store(refunded, { mode: "deep", objects: 63 }), /EVIDENCE_STORAGE_INVALID/, "65");
    const started = performance.now();
    await assert.rejects(store(refunded, { mode: "deep", objects: 100000 }), /EVIDENCE_STORAGE_INVALID/, "100000");
    t.diagnostic(`depth 100002 refused in ${(performance.now() - started).toFixed(1)} ms`);
    // The refusals left the snapshot current: the deepest allowed note commits as its next version.
    const deepest = await store(refunded, { mode: "deep", objects: 62 });
    assert.equal(deepest.version, refunded.version + 1);
    // The scan itself: a chain of n objects from the root ends at path length n - 1.
    const chain = n => {
        let value = {};
        for (let level = 1; level < n; level += 1) value = { d: value };
        return value;
    };
    assert.deepEqual(probeFindEvidence(chain(65)).found, []);
    assert.equal(probeFindEvidence(chain(66)).found, null);
    await scCleanAfter(store, deepest, scItem("ne5-depth"));
});

test("NE/5 (nodes): one scan visits at most 200000 objects; the order and the commit stay within it, a DAG cannot explode it", async (t) => {
    const { refunded, store } = await scSetup();
    const { probeFindEvidence } = await scProbeCore();
    const flat = n => Array.from({ length: n }, () => ({}));
    assert.equal(probeFindEvidence(flat(199999)).used, 200000);
    assert.deepEqual(probeFindEvidence(flat(199999)).found, []);
    assert.equal(probeFindEvidence(flat(200000)).found, null);
    // Shared references are visited per path (no global seen-set), so a DAG with 2^40 paths hits the budget at once.
    let dag = {};
    for (let level = 0; level < 40; level += 1) dag = { l: dag, r: dag };
    let started = performance.now();
    assert.equal(probeFindEvidence(dag).found, null);
    t.diagnostic(`DAG with 2^40 paths refused in ${(performance.now() - started).toFixed(1)} ms`);
    // End to end: the order, the note's array, its objects and (after the await) the new event share the budget.
    const base = probeFindEvidence(refunded).used;
    t.diagnostic(`objects in the refunded test order: ${base}`);
    assert.ok(base > 0 && base < 1000);
    const largest = 200000 - base - 2;
    // One object over passes the pre-check and is refused by the re-check after the await, which also counts the event.
    await assert.rejects(store(refunded, { mode: "wide", count: largest + 1 }), /EVIDENCE_STORAGE_INVALID/, "one over");
    await assert.rejects(store(refunded, { mode: "wide", count: 300000 }), /EVIDENCE_STORAGE_INVALID/, "far over");
    started = performance.now();
    const filled = await store(refunded, { mode: "wide", count: largest });
    t.diagnostic(`commit with a ${largest}-object note (two full scans) in ${(performance.now() - started).toFixed(1)} ms`);
    assert.equal(filled.version, refunded.version + 1);
    // A typical commit stays cheap.
    const fresh = await scSetup();
    started = performance.now();
    await scCleanAfter(fresh.store, fresh.refunded, scItem("ne5-nodes"));
    t.diagnostic(`typical probe commit in ${(performance.now() - started).toFixed(1)} ms`);
});

test("NE/5 (budget): the order and the transition's audit share one scan budget; the pre-check refuses the excess", async () => {
    const { refunded, store } = await scSetup();
    // About 199 992 objects in the audit alone fit the limit; with the order's own objects they do not.
    const mirror = Array.from({ length: 199990 }, () => ({}));
    await scRefusedBeforeAwait(store, refunded, { mode: "audit", mirror }, /EVIDENCE_STORAGE_INVALID/, "audit + order");
    await scCleanAfter(store, refunded, scItem("ne5-budget"));
});

test("NE/6: non-plain data anywhere in the order is EVIDENCE_STORAGE_INVALID (fail-closed); plain and null-prototype data commit", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("ne6-a");
    const refused = ["map", "set", "date", "instance", "symbol_key", "accessor", "hidden", "array_key", "function",
        "symbol_value", "bigint"];
    for (const shape of refused) {
        await assert.rejects(store(refunded, { mode: "shape", shape }), /EVIDENCE_STORAGE_INVALID/, shape);
        await assert.rejects(store(refunded, { mode: "shape", shape, put: [a] }), /EVIDENCE_STORAGE_INVALID/, `${shape} + evidence`);
    }
    const held = await scCleanAfter(store, refunded, a);
    const plain = await store(held, { mode: "shape", shape: "plain" });
    assert.equal(plain.version, held.version + 1);
    const nullProto = await store(plain, { mode: "shape", shape: "null_proto" });
    assert.equal(nullProto.version, plain.version + 1);
});

test("EL/1: deleting, reordering, replacing or adding events is EVIDENCE_HISTORY_CHANGED and consumes nothing", async () => {
    const { refunded, store } = await scSetup();
    const a = scItem("ev1-a");
    for (const mode of ["event_drop", "event_pop", "event_reorder", "event_replace", "event_append", "event_evidence"]) {
        await assert.rejects(store(refunded, { mode, put: [a] }), /EVIDENCE_HISTORY_CHANGED/, mode);
        await assert.rejects(store(refunded, { mode, claims: [a] }), /EVIDENCE_HISTORY_CHANGED/, `${mode} claimed`);
    }
    await scCleanAfter(store, refunded, a);
});

test("EL/2: a commit appends exactly its own event; earlier events stay the same objects and the hash chain holds", async () => {
    const { refunded, store } = await scSetup();
    const next = await store(refunded, { claims: [scItem("ev2-a")], mode: "audit", mirror: scItem("ev2-a") });
    assert.equal(next.events.length, refunded.events.length + 1);
    assert.ok(refunded.events.every((event, index) => next.events[index] === event));
    const event = next.events.at(-1);
    assert.equal(event.previousHash, refunded.events.at(-1).hash);
    const { hash, ...hashed } = event;
    assert.equal(createHash("sha256").update(JSON.stringify(hashed)).digest("hex"), hash);
    assert.deepEqual(event.audit.evidence, scItem("ev2-a"));
});

test("EL/3: the event log is scanned: an event may mirror only known evidence, at its audit.evidence", async () => {
    const { refunded } = await scSetup();
    const { probeEvidenceOnly } = await scProbeCore();
    const x = scItem("ev3-x");
    const y = scItem("ev3-y");
    const withEvent = event => ({ ...refunded, events: [...refunded.events, event] });
    assert.equal(probeEvidenceOnly(refunded, withEvent({ audit: { evidence: x } }), null, [x]), true);
    assert.equal(probeEvidenceOnly(refunded, withEvent({ audit: { evidence: x } }), null, []), false);
    assert.equal(probeEvidenceOnly(refunded, withEvent({ note: x }), null, [x]), false);
    assert.equal(probeEvidenceOnly(refunded, withEvent({ audit: { inner: x } }), null, [x]), false);
    assert.equal(probeEvidenceOnly(refunded, withEvent({ audit: { evidence: { ...x, inner: y } } }), null, [x, y]), false);
    assert.equal(probeEvidenceOnly(refunded, refunded, null, []), true);
});

test("AB/1: a case attestation must state each of the 13 attested fields as the request does; another order's is refused", async () => {
    const { h, refunded, store } = await scSetup();
    const { CASE_ATTESTED_FIELDS } = await import("./core.mjs");
    const a = scItem("ab1-a");
    for (const field of CASE_ATTESTED_FIELDS) {
        for (const value of ["synthetic-other-value", undefined]) {
            await assert.rejects(store(refunded, { claims: [a], attestation: { [field]: value } }), /UNTRUSTED_EVIDENCE/,
                `${field}=${value}`);
        }
    }
    // The ADV/02-loose case: every order has a case-0001; an attestation given for another order's case is refused.
    const other = await scOtherOrder(h);
    const foreign = other.financialCases[0];
    assert.equal(foreign.caseId, "case-0001");
    await assert.rejects(store(refunded, { claims: [a], attestation: { orderId: other.id } }), /UNTRUSTED_EVIDENCE/);
    await assert.rejects(store(refunded, { claims: [a], attestation: { orderId: other.id, reviewId: foreign.origin.reviewId,
        createdAt: foreign.createdAt } }), /UNTRUSTED_EVIDENCE/);
    await scCleanAfter(store, refunded, a);
});

test("AB/2: the case request must name this order and the canonical case's review, state the purpose and carry every field", async () => {
    const { h, refunded, store } = await scSetup();
    const a = scItem("ab2-a");
    const other = await scOtherOrder(h);
    const both = change => ({ claims: [a], request: change, attestation: change });
    const refusals = [{ orderId: other.id }, { reviewId: "review-9999" }, { orderId: other.id, reviewId: "review-9999" },
        { purpose: "CLOSE" }, { purpose: undefined }, { createdAt: undefined }, { createdAt: 12345 },
        { decisionBinding: undefined }, { decisionBinding: null }];
    for (const change of refusals) {
        await assert.rejects(store(refunded, both(change)), /EVIDENCE_MISMATCH/, JSON.stringify(change));
    }
    await scCleanAfter(store, refunded, a);
});

test("AB/3: an attested field inherited from the attestation's prototype is UNTRUSTED_EVIDENCE (gate and case contract)", async () => {
    const { refunded, store } = await scSetup();
    const { CASE_ATTESTED_FIELDS, checkCaseEvidence, checkCaseEvidenceAttestation } = await import("./core.mjs");
    const a = scItem("ab3-a");
    for (const field of CASE_ATTESTED_FIELDS) {
        await assert.rejects(store(refunded, { claims: [a], inherit: [field] }), /UNTRUSTED_EVIDENCE/, field);
    }
    const next = await store(refunded, { claims: [a], inherit: [] });
    assert.equal(next.version, refunded.version + 1);
    // The pure case contract reads own fields only, too.
    const item = refunded.financialCases[0];
    const request = checkCaseEvidence(cvRecord(refunded, item), refunded, item, "finance");
    const attested = { status: "VERIFIED", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" }, ...request };
    checkCaseEvidenceAttestation(attested, request);
    for (const field of CASE_ATTESTED_FIELDS) {
        const { [field]: moved, ...own } = attested;
        assert.throws(() => checkCaseEvidenceAttestation(Object.assign(Object.create({ [field]: moved }), own), request),
            /UNTRUSTED_EVIDENCE/, field);
    }
});

test("AS/1: claims, orders, event logs or audits changed while the commit awaits are refused after the last await", async () => {
    const { refunded, store } = await scSetup();
    const probe = await scProbeCore();
    const a = scItem("as1-a");
    const b = scItem("as1-b");
    const pushClaim = scope => scope.evidenceClaims.push({ ...scope.evidenceClaims[0], ...b });
    // add_case_evidence is bound to the purpose, but it is not this dispatch's command.
    const otherCommand = scope => scope.evidenceClaims.push(Object.freeze({ ...scope.evidenceClaims[0], ...b,
        command: "add_case_evidence" }));
    // The transition's own event is swapped for another one as it is appended.
    const substituted = scope => {
        const forged = { ...scope.event, kind: "forged" };
        Object.defineProperty(scope.next.events, "push", { value() { return Array.prototype.push.call(this, forged); } });
    };
    const storeUnclaimed = scope => scope.next.financialCases[0].evidenceReferences.push({ ...b });
    const outside = scope => { scope.next.probeNote = { ...b }; };
    const moveToOtherCase = scope => {
        const cases = scope.next.financialCases;
        cases[1] = { ...cases[1], evidenceReferences: [...cases[1].evidenceReferences, cases[0].evidenceReferences.pop()] };
    };
    const cases = [
        // [stage, label, change, data, expected]
        ["hash", "unfrozen claim", pushClaim, {}, /EVIDENCE_MISMATCH/],
        ["hash", "claim of another command", otherCommand, {}, /EVIDENCE_MISMATCH/],
        ["hash", "event dropped", scope => scope.next.events.shift(), {}, /EVIDENCE_HISTORY_CHANGED/],
        ["hash", "own event substituted", substituted, {}, /EVIDENCE_HISTORY_CHANGED/],
        ["hash", "case renamed", scope => { scope.next.financialCases[0].caseId = "case-0099"; }, {}, /EVIDENCE_HISTORY_CHANGED/],
        ["hash", "evidence outside a place", outside, {}, /EVIDENCE_STORAGE_INVALID/],
        ["hash", "evidence nested in the audit", scope => { scope.audit.extra = { ...b }; }, { mode: "audit", mirror: a },
            /EVIDENCE_STORAGE_INVALID/],
        ["hash", "unclaimed evidence stored", storeUnclaimed, {}, /EVIDENCE_NOT_CLAIMED/],
        ["hash", "evidence moved to another case", moveToOtherCase, {}, /EVIDENCE_STORAGE_INVALID/],
        ["cases", "unclaimed evidence stored", storeUnclaimed, {}, /EVIDENCE_NOT_CLAIMED/],
        ["cases", "evidence outside a place", outside, {}, /EVIDENCE_STORAGE_INVALID/],
        ["cases", "event appended", scope => scope.next.events.push({ sequence: 0, kind: "probe" }), {}, /EVIDENCE_HISTORY_CHANGED/]
    ];
    try {
        for (const [stage, label, change, data, expected] of cases) {
            let fired = 0;
            probe.setProbeAwaitHook((at, scope) => {
                if (at === stage && fired === 0) {
                    fired += 1;
                    change(scope);
                }
            });
            await assert.rejects(store(refunded, { claims: [a], ...data }), expected, `${stage}: ${label}`);
            assert.equal(fired, 1, `${stage}: ${label} ran`);
        }
        // A hook that changes nothing lets the same claim commit.
        probe.setProbeAwaitHook(() => {});
        const next = await scCleanAfter(store, refunded, a);
        // Neither a nor b was consumed by the refusals: b is still free.
        await scCleanAfter(store, next, b);
    } finally {
        probe.setProbeAwaitHook(null);
    }
});

test("MUT/A198-02,03 (F198-05): a registered place is anchored at path[0]; the same tail under another root is EVIDENCE_STORAGE_INVALID", async () => {
    const { refunded, store } = await scSetup();
    const probe = await scProbeCore();
    const a = scItem("p0-a");
    const b = scItem("p0-b");
    assert.ok(refunded.reviews.length > 0 && refunded.financialCases.length > 0);
    // Each misplacement keeps the registered tail (resolution.evidence, evidenceReferences[i]) under the wrong root.
    const misplaced = [
        // A198-02: the review place's tail under financialCases.
        ["financialCases[0].resolution.evidence", next => {
            next.financialCases = next.financialCases.map((item, index) => (index === 0
                ? { ...item, resolution: { evidence: { ...b } } } : item));
        }],
        // A198-03: the case place's tail under reviews and under another top-level array.
        ["reviews[0].evidenceReferences[0]", next => {
            next.reviews = next.reviews.map((review, index) => (index === 0
                ? { ...review, evidenceReferences: [{ ...b }] } : review));
        }],
        ["probeList[0].evidenceReferences[0]", next => { next.probeList = [{ evidenceReferences: [{ ...b }] }]; }]
    ];
    // Pre-check invariant (pure): the registered places themselves are accepted, the misplaced tails are not.
    const copy = () => ({ ...refunded, reviews: [...refunded.reviews], financialCases: [...refunded.financialCases] });
    const inCase = copy();
    inCase.financialCases[0] = { ...inCase.financialCases[0],
        evidenceReferences: [...inCase.financialCases[0].evidenceReferences, { ...b }] };
    assert.equal(probe.probeEvidenceOnly(refunded, inCase, null, []), true, "financialCases[0].evidenceReferences");
    const inReviewPlace = copy();
    inReviewPlace.reviews[0] = { ...inReviewPlace.reviews[0], resolution: { ...inReviewPlace.reviews[0].resolution, evidence: { ...b } } };
    assert.equal(probe.probeEvidenceOnly(refunded, inReviewPlace, null, []), true, "reviews[0].resolution.evidence");
    for (const [label, change] of misplaced) {
        const next = copy();
        change(next);
        assert.equal(probe.probeEvidenceOnly(refunded, next, null, []), false, `pure: ${label}`);
    }
    // Commit-time invariant (dispatch): unclaimed evidence placed there while the commit awaits is refused.
    try {
        for (const [label, change] of misplaced) {
            let fired = 0;
            probe.setProbeAwaitHook((at, scope) => {
                if (at === "hash" && fired === 0) {
                    fired += 1;
                    change(scope.next);
                }
            });
            await assert.rejects(store(refunded, { claims: [a] }), /EVIDENCE_STORAGE_INVALID/, `dispatch: ${label}`);
            assert.equal(fired, 1, `dispatch: ${label} ran`);
        }
        probe.setProbeAwaitHook(() => {});
        const next = await scCleanAfter(store, refunded, a);
        await scCleanAfter(store, next, b);
    } finally {
        probe.setProbeAwaitHook(null);
    }
});

test("PB/18b: a bypassing claim naming another command bound to the same purpose is EVIDENCE_MISMATCH", async () => {
    const { refunded, claim } = await ecSetup();
    // add_case_evidence is bound to FINANCIAL_CASE_EVIDENCE, but the dispatch's command is probe_claim.
    const raw = { purpose: "FINANCIAL_CASE_EVIDENCE", command: "add_case_evidence", storage: "CASE_EVIDENCE",
        ...ecItem("pb18b"), orderId: refunded.id, caseId: "case-0001", verifier: { kind: "SYNTHETIC", id: "synthetic-evidence-service" } };
    await assert.rejects(claim(refunded, { raw: [raw], freezeRaw: true, storeRaw: true }), /EVIDENCE_MISMATCH/);
    await ecCommitsCleanly(claim, refunded, [ecItem("pb18b")]);
});

test("T-S/7 (A194-05): after the last await the commit re-runs the pre-check's evidence invariants, in order, before any write", async () => {
    const source = await coreSource();
    const checks = arg => [`claimsBoundToCommand(evidenceClaims, order.id, command.kind), "EVIDENCE_MISMATCH"`,
        `eventHistoryKept(order, next, ${arg}), "EVIDENCE_HISTORY_CHANGED"`,
        `evidenceHistoryKept(order, next), "EVIDENCE_HISTORY_CHANGED"`,
        `evidenceOnlyInRegisteredPlaces(order, next, audit, evidenceClaims), "EVIDENCE_STORAGE_INVALID"`,
        `claimsMatchStoredEvidence(order, next, evidenceClaims), "EVIDENCE_NOT_CLAIMED"`,
        `claimsMatchStoredLocations(order, next, evidenceClaims), "EVIDENCE_STORAGE_INVALID"`].map(check => `requireThat(${check});`);
    const pre = sourceBlock(source, "        requireThat(claimsBoundToCommand(", "        next.version += 1;");
    const commit = sourceBlock(source, "        event.hash = await digest(event);", "        recordClaims();");
    for (const [name, block, arg] of [["pre-check", pre, "null"], ["commit", commit, "event"]]) {
        const at = checks(arg).map(check => block.indexOf(check));
        assert.ok(at.every(index => index >= 0), `${name}: ${JSON.stringify(at)}`);
        assert.deepEqual([...at].sort((x, y) => x - y), at, `${name}: order`);
        for (const check of checks(arg)) assert.equal(occurrences(block, check), 1, `${name}: ${check}`);
    }
    const last = commit.indexOf(checks("event").at(-1));
    assert.ok(last < commit.indexOf("assertClaimsFree();") && last < commit.indexOf("orders.set(order.id, committed);"));
    assert.ok(commit.indexOf(checks("event")[0]) > commit.indexOf("next.events.push(event);"));
    assert.equal(occurrences(commit, "await"), 1);
    for (const start of ["function eventHistoryKept(before, after, appendedEvent) {",
        "function claimsBoundToCommand(claims, orderId, kind) {", "function findEvidence(root, rootPath, budget) {"]) {
        assert.doesNotMatch(sourceBlock(source, start, "\n}\n"), /\bawait\b|\basync\b|\.then\(/, start);
    }
    // The scan is iterative (it never calls itself) and the event log is no longer left out.
    assert.equal(occurrences(sourceBlock(source, "function findEvidence(root, rootPath, budget) {", "\n}\n"), "findEvidence("), 1);
    assert.doesNotMatch(source, /key !== "events"/);
    assert.match(source, /const EVIDENCE_SCAN_MAX_DEPTH = 64;/);
    assert.match(source, /const EVIDENCE_SCAN_MAX_NODES = 200000;/);
});

// ---- Görev 206 (Faz 2B-3): add_case_evidence, TEST only (Görev 203 test matrix AE/*; DQ-203-01…10, N-1…N-6) ----
// A synthetic case console signs caseEvidenceBinding(record); a synthetic case evidence service vouches for an evidence
// item it signed itself and states every CASE_ATTESTED_FIELDS value of the core's request. Both are test fixtures only.
const aeCore = await import("./core.mjs");
const aeSignRecord = binding => hmac(["case-evidence-console", binding]);
const aeSignEvidence = evidence => hmac(["case-evidence-service", evidence.evidenceId, evidence.digest, evidence.orderId,
    evidence.caseId, evidence.reviewId, evidence.evidenceKind, evidence.source, evidence.createdAt]);
const aeAttest = (evidence, request, kind = "SYNTHETIC") => (evidence && signatureMatches(evidence.signature,
    aeSignEvidence(evidence)) ? { status: "VERIFIED", verifier: { kind, id: "synthetic-case-evidence-service" }, ...request }
    : null);
const aeHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A TEST core with the synthetic case verifiers. `calls` lists every verifier call in order; `tamper.record` and
 * `tamper.evidence` replace a verifier's answer for the next calls. Case-0001 (ORDER_REFUND) is taken by finance. */
async function aeSetup(overrides = {}, inherited = null, factory = createCore) {
    const calls = [];
    const tamper = {};
    const h = setup({
        verifyCaseRecord: async (record, order, context) => {
            calls.push("record");
            if (tamper.record) return tamper.record(record, order, context);
            return { verified: signatureMatches(record.signature, aeSignRecord(context.binding)), binding: context.binding };
        },
        verifyCaseEvidence: async (evidence, request, order) => {
            calls.push("evidence");
            if (tamper.evidence) return tamper.evidence(evidence, request, order);
            return aeAttest(evidence, request);
        },
        ...overrides
    }, inherited, factory);
    const p = await refundedCases(h);
    const taken = await takeCase(h, p.refunded);
    return { ...p, calls, tamper, taken };
}

let aeCounter = 0;
/** A well-formed, signed submission for `caseId` of `order`. `evidence` and `extra` override fields before signing;
 * a `signature` given in either is kept as it is. */
function aeRecord(order, { caseId = "case-0001", role = "finance", actorId = `synthetic-${role}-case-reviewer`,
    n = ++aeCounter, evidence = {}, extra = {} } = {}) {
    const item = order.financialCases.find(entry => entry.caseId === caseId) ?? order.financialCases[0];
    const [evidenceKind, source] = item.caseType === "ORDER_REFUND"
        ? ["PAYMENT_PROVIDER_RECORD", "payment_provider_reconciliation"] : ["REVISION_DELIVERY_RECORD", "producer_console"];
    const entry = { evidenceId: `synthetic-ae-evidence-${n}`, evidenceKind, source, orderId: order.id, caseId,
        reviewId: item.origin.reviewId, createdAt: item.createdAt, digest: dgDigest(`ae-${n}`), ...evidence };
    if (!Object.hasOwn(evidence, "signature")) entry.signature = aeSignEvidence(entry);
    const record = { kind: "CASE_EVIDENCE_SUBMISSION", orderId: order.id, caseId, reviewId: item.origin.reviewId,
        caseType: item.caseType, evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
        authorizationRef: `synthetic-ae-auth-${n}`, source: role === "admin" ? "admin_console" : "finance_console", actorId,
        evidence: entry, ...extra };
    if (!Object.hasOwn(extra, "signature")) record.signature = aeSignRecord(aeCore.caseEvidenceBinding(record));
    return record;
}
const aeWithout = (record, key) => { const copy = structuredClone(record); delete copy[key]; return copy; };
const aeEvidenceWithout = (record, key) => { const copy = structuredClone(record); delete copy.evidence[key]; return copy; };

function aeSend(h, order, record, options = {}) {
    const role = options.role ?? "finance";
    const actorId = Object.hasOwn(options, "actorId") ? options.actorId : `synthetic-${role}-case-reviewer`;
    return h.send(order, "add_case_evidence", role, { caseEvidence: record },
        { actorId, ...(options.requestId ? { requestId: options.requestId } : {}) });
}

/** Refused with `expected`, and the verifiers were called exactly as `calls` lists (none by default). Tests then commit
 * the corrected submission on the same snapshot: nothing of a refused one was committed or consumed. */
async function aeRefused(s, order, record, expected, label, calls = []) {
    s.calls.length = 0;
    await assert.rejects(aeSend(s, order, record), expected, label);
    assert.deepEqual(s.calls, calls, `${label}: verifier calls`);
}

test("AE/1: finance adds verified evidence to a case UNDER_REVIEW; only that case changes and nothing is decided or paid", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 1 });
    s.calls.length = 0;
    const added = await aeSend(s, s.taken, record, { requestId: "synthetic-ae1-request" });
    assert.deepEqual(s.calls, ["record", "evidence"], "the console record first, then the evidence service");
    assert.ok(Object.isFrozen(added));
    assert.equal(added.version, s.taken.version + 1);
    assert.equal(added.state, STATES.CLOSED);
    const [item, other] = added.financialCases;
    const before = s.taken.financialCases[0];
    assert.equal(other, s.taken.financialCases[1], "the other case is the same object");
    assert.deepEqual([item.status, item.policyVersion, item.moneyMovement, item.proposal, item.decisions, item.closure,
        item.assignedActorId, item.items], ["UNDER_REVIEW", "UNAI-FINANCIAL-CASE-v1.0", "NONE", null, [], null,
        before.assignedActorId, before.items]);
    assert.equal(FINANCIAL_CASE_POLICY.approval.status, "NOT_ACTIVE");
    const event = added.events.at(-1);
    const stored = item.evidenceReferences[0];
    assert.deepEqual(stored, {
        evidenceId: "synthetic-ae-evidence-1", digest: dgDigest("ae-1"), evidenceKind: "PAYMENT_PROVIDER_RECORD",
        source: "payment_provider_reconciliation", createdAt: before.createdAt, digestBasis: "RAW_BYTES",
        evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
        verifier: { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" },
        submittedBy: { actorId: "synthetic-finance-case-reviewer", actorType: "HUMAN", role: "finance" },
        addedAt: FIXED_TIME, authorizationRef: "synthetic-ae-auth-1", idempotencyKey: "synthetic-ae1-request",
        eventSequence: added.version, status: "ACTIVE", invalidation: null
    });
    assert.equal(item.evidenceReferences.length, 1);
    assert.deepEqual(item.auditTrail.slice(0, -1), before.auditTrail);
    assert.ok(before.auditTrail.every((entry, index) => item.auditTrail[index] === entry));
    const audit = item.auditTrail.at(-1);
    assert.deepEqual(audit, {
        step: "EVIDENCE_ADDED", caseId: "case-0001", orderId: added.id, caseType: "ORDER_REFUND",
        reviewId: before.origin.reviewId, from: "UNDER_REVIEW", to: "UNDER_REVIEW",
        actorId: "synthetic-finance-case-reviewer", actorType: "HUMAN", role: "finance", at: FIXED_TIME,
        authorizationRef: "synthetic-ae-auth-1", idempotencyKey: "synthetic-ae1-request",
        policyVersion: "UNAI-FINANCIAL-CASE-v1.0", evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1", evidence: stored
    });
    // MIRROR-203: one audit object, its evidence the stored entry itself.
    assert.equal(audit.evidence, stored);
    assert.equal(event.audit, audit);
    assert.ok(Object.isFrozen(audit) && Object.isFrozen(stored));
    // No signature, content or free text is kept.
    assert.doesNotMatch(JSON.stringify(added.financialCases), /synthetic-console|signature/);
    assert.equal(event.kind, "add_case_evidence");
    assert.deepEqual([event.from, event.to, event.role, event.at], [STATES.CLOSED, STATES.CLOSED, "finance", FIXED_TIME]);
    assert.equal(event.financialCasesDigest, caseDigest(added.financialCases));
    assert.equal(event.previousHash, s.taken.events.at(-1).hash);
    const { hash, ...hashed } = event;
    assert.equal(aeHash(hashed), hash);
    assert.deepEqual([added.reviews, added.revisions, added.financialAssessments, added.notifications,
        added.paymentReference], [s.taken.reviews, s.taken.revisions, s.taken.financialAssessments, s.taken.notifications,
        s.taken.paymentReference]);
});

test("AE/2: admin adds evidence to an UNDELIVERED_REVISION case (JCS_UTF8); a second entry appends and keeps the first", async () => {
    const s = await aeSetup();
    const both = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "admin");
    const first = await aeSend(s, both, aeRecord(both, { caseId: "case-0002", role: "admin", n: 21 }), { role: "admin" });
    const entry = first.financialCases[1].evidenceReferences[0];
    assert.deepEqual([entry.evidenceKind, entry.source, entry.digestBasis, entry.submittedBy.role],
        ["REVISION_DELIVERY_RECORD", "producer_console", "JCS_UTF8", "admin"]);
    const second = await aeSend(s, first, aeRecord(first, { caseId: "case-0002", role: "admin", n: 22 }), { role: "admin" });
    const refs = second.financialCases[1].evidenceReferences;
    assert.equal(refs.length, 2);
    assert.equal(refs[0], entry, "append-only: the first entry is the same object");
    assert.equal(refs[1].evidenceId, "synthetic-ae-evidence-22");
    assert.equal(second.financialCases[0], first.financialCases[0]);
    assert.equal(second.financialCases[1].auditTrail.at(-1).evidence, refs[1]);
    assert.equal(second.events.at(-2), first.events.at(-1));
});

test("AE-F/1 (F198-02): the submission and its evidence carry exactly the approved fields; nothing reaches a verifier", async () => {
    const s = await aeSetup();
    const base = aeRecord(s.taken, { n: 31 });
    for (const key of aeCore.CASE_EVIDENCE_FIELDS) {
        const expected = key === "orderId" || key === "caseId" ? /INVALID_CASE_REFERENCE/ : /EVIDENCE_MISMATCH/;
        await aeRefused(s, s.taken, aeWithout(base, key), expected, `missing ${key}`);
    }
    await aeRefused(s, s.taken, { ...base, note: "x" }, /EVIDENCE_MISMATCH/, "extra field");
    for (const key of aeCore.CASE_EVIDENCE_ITEM_FIELDS.filter(field => field !== "signature")) {
        await aeRefused(s, s.taken, aeEvidenceWithout(base, key), /EVIDENCE_MISMATCH/, `missing evidence.${key}`);
    }
    await aeRefused(s, s.taken, { ...base, evidence: { ...base.evidence, content: "raw" } }, /EVIDENCE_MISMATCH/,
        "extra evidence field");
    for (const shape of [null, [], "record", 7]) {
        await aeRefused(s, s.taken, shape, /INVALID_CASE_REFERENCE/, `caseEvidence ${JSON.stringify(shape)}`);
    }
    // The evidence service's own signature is optional and never bound or kept.
    const unsigned = aeEvidenceWithout(base, "signature");
    s.tamper.evidence = (evidence, request) => ({ status: "VERIFIED",
        verifier: { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" }, ...request });
    const added = await aeSend(s, s.taken, { ...unsigned, signature: aeSignRecord(aeCore.caseEvidenceBinding(unsigned)) });
    assert.equal(added.financialCases[0].evidenceReferences[0].evidenceId, "synthetic-ae-evidence-31");
    // Pure: a field must be an own enumerable data property.
    const { refunded } = await refundedCases();
    const item = refunded.financialCases[0];
    const record = cvRecord(refunded, item);
    assert.ok(aeCore.checkCaseEvidence(record, refunded, item, "finance"));
    const accessor = Object.defineProperty({ ...record }, "actorId", { get: () => record.actorId, enumerable: true });
    const hidden = Object.defineProperty({ ...record }, "actorId", { value: record.actorId, enumerable: false });
    const symbol = { ...record, [Symbol("extra")]: 1 };
    const inheritedRecord = Object.assign(Object.create({ actorId: record.actorId }), aeWithout(record, "actorId"));
    for (const [label, value] of [["accessor", accessor], ["hidden", hidden], ["symbol", symbol],
        ["inherited", inheritedRecord]]) {
        assert.throws(() => aeCore.checkCaseEvidence(value, refunded, item, "finance"), /EVIDENCE_MISMATCH/, label);
    }
});

test("AE-F/2 (F198-02, DQ-203-09): actorId is the authenticated person; the console signature is a 1–4096 character string", async () => {
    const s = await aeSetup();
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 41, actorId: "synthetic-finance-other" }), /EVIDENCE_MISMATCH/,
        "another actor than the principal");
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 41, extra: { actorId: "bad id" } }), /EVIDENCE_MISMATCH/, "bad actorId");
    for (const signature of [undefined, null, "", 7, "x".repeat(4097)]) {
        await aeRefused(s, s.taken, aeRecord(s.taken, { n: 41, extra: { signature } }), /EVIDENCE_MISMATCH/,
            `signature ${String(signature).slice(0, 12)}`);
    }
    // A well-formed but wrong signature reaches the console verifier only.
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 41, extra: { signature: "0".repeat(64) } }), /UNTRUSTED_REVIEW/,
        "unsigned", ["record"]);
    // Pure bounds: 1 and 4096 characters pass the shape check, 0 and 4097 do not; a SYSTEM-shaped actor never passes.
    const { refunded } = await refundedCases();
    const item = refunded.financialCases[0];
    for (const [signature, ok] of [["x", true], ["x".repeat(4096), true], ["", false], ["x".repeat(4097), false]]) {
        const check = () => aeCore.checkCaseEvidence({ ...cvRecord(refunded, item), signature }, refunded, item, "finance");
        if (ok) assert.ok(check(), `length ${signature.length}`);
        else assert.throws(check, /EVIDENCE_MISMATCH/, `length ${signature.length}`);
    }
    assert.throws(() => aeCore.checkCaseEvidence({ ...cvRecord(refunded, item), actorId: "system-case-actor" }, refunded,
        item, "finance"), /EVIDENCE_MISMATCH/);
    const principal = { role: "finance", actorId: "synthetic-finance-cv" };
    assert.ok(aeCore.checkCaseEvidenceSubmission(cvRecord(refunded, item), refunded, item, principal));
    for (const other of [null, {}, { role: "finance", actorId: "synthetic-finance-other" }, { role: "admin",
        actorId: "synthetic-finance-cv" }]) {
        assert.throws(() => aeCore.checkCaseEvidenceSubmission(cvRecord(refunded, item), refunded, item, other),
            /EVIDENCE_MISMATCH/, JSON.stringify(other));
    }
});

test("AE-F/3: the submission is bound to this order, the canonical case, its review, type and the approved policies", async () => {
    const s = await aeSetup();
    const n = 51;
    const before = new Date(Date.parse(s.taken.financialCases[0].createdAt) - 1).toISOString();
    const cases = [
        [{ extra: { orderId: "another-order-0001" } }, /INVALID_CASE_REFERENCE/],
        [{ caseId: "case-0099" }, /UNKNOWN_CASE/],
        [{ extra: { reviewId: "review-0099" } }, /INVALID_CASE_REFERENCE/],
        [{ extra: { caseType: "UNDELIVERED_REVISION" } }, /INVALID_CASE_REFERENCE/],
        [{ extra: { kind: "CLOSE_DECISION" } }, /EVIDENCE_MISMATCH/],
        [{ extra: { authorizationRef: "bad ref" } }, /EVIDENCE_MISMATCH/],
        [{ extra: { source: "admin_console" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { orderId: "another-order-0001" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { caseId: "case-0002" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { reviewId: "review-0099" } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { digest: dgDigest("ae-51").toUpperCase() } }, /EVIDENCE_MISMATCH/],
        [{ evidence: { createdAt: "2026-10-28T09:00:00" } }, /EVIDENCE_MISMATCH/],
        [{ extra: { evidencePolicyVersion: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.0" } }, /CASE_EVIDENCE_POLICY_MISMATCH/],
        [{ evidence: { evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION", source: "customer_confirmation_service" } },
            /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidence: { evidenceKind: "REVISION_DELIVERY_RECORD", source: "producer_console" } }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidence: { source: "producer_console" } }, /EVIDENCE_KIND_NOT_ALLOWED/],
        [{ evidence: { createdAt: before } }, /EVIDENCE_STALE/]
    ];
    for (const [options, expected] of cases) {
        await aeRefused(s, s.taken, aeRecord(s.taken, { n, ...options }), expected, JSON.stringify(options));
    }
    // The same evidence, id, digest and reference were never consumed: the clean submission commits.
    const added = await aeSend(s, s.taken, aeRecord(s.taken, { n }));
    assert.equal(added.financialCases[0].evidenceReferences[0].authorizationRef, "synthetic-ae-auth-51");
    // A case whose own policy version is not the approved one fails closed (pure; no command writes another version).
    const item = { ...s.taken.financialCases[0], policyVersion: "UNAI-FINANCIAL-CASE-v1.1" };
    assert.throws(() => aeCore.checkCaseEvidenceSubmission(aeRecord(s.taken, { n: 52 }), s.taken, item,
        { role: "finance", actorId: "synthetic-finance-case-reviewer" }), /INVALID_CASE_REFERENCE/);
});

test("AE-S/1 (DQ-203-05): only a verified finance or admin person, a CLOSED order and a case UNDER_REVIEW", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 61 });
    await aeRefused(s, s.taken, aeRecord(s.taken, { caseId: "case-0002", n: 61 }), /CASE_STATE_INVALID/, "OPEN case");
    for (const role of ["customer", "creative", "scheduler"]) {
        s.calls.length = 0;
        await assert.rejects(aeSend(s, s.taken, record, { role }), /UNAUTHORIZED/, role);
        assert.deepEqual(s.calls, []);
    }
    s.calls.length = 0;
    await assert.rejects(aeSend(s, s.taken, record, { actorId: undefined }), /ACTOR_REQUIRED/);
    await assert.rejects(aeSend(s, s.taken, { ...record, actorId: "system-case-actor" }, { actorId: "system-case-actor" }),
        /RESERVED_ACTOR/);
    await assert.rejects(aeSend(s, s.taken, record, { role: "admin" }), /EVIDENCE_MISMATCH/, "finance record, admin person");
    assert.deepEqual(s.calls, []);
    // An order that is not CLOSED.
    const paid = await paidOrder(s, "START", "ae-s1");
    await assert.rejects(aeSend(s, paid, aeRecord(s.taken, { n: 62, extra: { orderId: paid.id } })), /INVALID_TRANSITION/);
    assert.deepEqual(s.calls, []);
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.financialCases[0].status, "UNDER_REVIEW");
});

test("AE-V/1 (DQ-203-02, N-1, F203-02): a missing verifier fails closed before any verifier call; inherited ones are not seen", async () => {
    const valid = order => aeRecord(order, { n: 71 });
    const noEvidence = await aeSetup({ verifyCaseEvidence: undefined });
    await aeRefused(noEvidence, noEvidence.taken, valid(noEvidence.taken), /CASE_EVIDENCE_UNVERIFIABLE/, "no evidence service");
    const notFunction = await aeSetup({ verifyCaseEvidence: { verify: true } });
    await aeRefused(notFunction, notFunction.taken, valid(notFunction.taken), /CASE_EVIDENCE_UNVERIFIABLE/, "not a function");
    const noRecord = await aeSetup({ verifyCaseRecord: undefined });
    await aeRefused(noRecord, noRecord.taken, valid(noRecord.taken), /UNTRUSTED_REVIEW/, "no console verifier");
    const neither = await aeSetup({ verifyCaseRecord: undefined, verifyCaseEvidence: undefined });
    await aeRefused(neither, neither.taken, valid(neither.taken), /CASE_EVIDENCE_UNVERIFIABLE/, "neither");
    // A polluted prototype never supplies a verifier; neither does an accessor.
    const calls = [];
    const inherited = await aeSetup({}, { verifyCaseEvidence: async (evidence, request) => {
        calls.push("inherited");
        return aeAttest(evidence, request);
    } });
    await aeRefused(inherited, inherited.taken, valid(inherited.taken), /CASE_EVIDENCE_UNVERIFIABLE/, "inherited");
    assert.deepEqual(calls, []);
    const accessor = await aeSetup({}, null, config => createCore(Object.defineProperty({ ...config }, "verifyCaseRecord",
        { get: () => () => ({ verified: true, binding: "x" }), enumerable: true })));
    await aeRefused(accessor, accessor.taken, valid(accessor.taken), /UNTRUSTED_REVIEW/, "accessor");
});

test("AE-V/2 (DQ-203-03): a failed console record verdict is UNTRUSTED_REVIEW and the evidence service is never asked", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 81 });
    for (const [label, verdict] of [["bare true", () => true], ["null", () => null],
        ["no binding", () => ({ verified: true })], ["other binding", (r, o, c) => ({ verified: true, binding: `${c.binding}x` })],
        ["string true", (r, o, c) => ({ verified: "true", binding: c.binding })], ["refused", (r, o, c) => ({ verified: false,
            binding: c.binding })]]) {
        s.tamper.record = verdict;
        await aeRefused(s, s.taken, record, /UNTRUSTED_REVIEW/, label, ["record"]);
    }
    // The console verifier receives the frozen snapshot of the record and exactly its binding.
    s.tamper.record = (seen, order, context) => {
        assert.ok(Object.isFrozen(seen) && Object.isFrozen(order));
        assert.equal(context.binding, aeCore.caseEvidenceBinding(record));
        assert.deepEqual(Object.keys(context), ["binding"]);
        return { verified: true, binding: context.binding };
    };
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.version, s.taken.version + 1);
});

test("AE-V/3: a failed evidence attestation is UNTRUSTED_EVIDENCE; a throwing service commits nothing", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 91 });
    const forged = { ...record, evidence: { ...record.evidence, signature: "0".repeat(64) } };
    await aeRefused(s, s.taken, { ...forged, signature: aeSignRecord(aeCore.caseEvidenceBinding(forged)) },
        /UNTRUSTED_EVIDENCE/, "evidence the service did not sign", ["record", "evidence"]);
    const changes = [["status", { status: "PENDING" }], ["verifier", { verifier: null }],
        ["verifier kind", { verifier: { kind: "OTHER", id: "synthetic-case-evidence-service" } }],
        ["digestBasis", { digestBasis: "JCS_UTF8" }], ["purpose", { purpose: "CLOSE" }], ["caseId", { caseId: "case-0002" }],
        ["createdAt", { createdAt: FIXED_TIME.replace("09:00", "09:01") }], ["decisionBinding", { decisionBinding: "x" }],
        ["digest", { digest: dgDigest("ae-other") }]];
    for (const [label, change] of changes) {
        s.tamper.evidence = (evidence, request) => ({ ...aeAttest(evidence, request), ...change });
        await aeRefused(s, s.taken, record, /UNTRUSTED_EVIDENCE/, label, ["record", "evidence"]);
    }
    s.tamper.evidence = (evidence, request) => {
        const attestation = aeAttest(evidence, request);
        const { digestBasis, ...own } = attestation;
        return Object.assign(Object.create({ digestBasis }), own);
    };
    await aeRefused(s, s.taken, record, /UNTRUSTED_EVIDENCE/, "inherited digestBasis", ["record", "evidence"]);
    s.tamper.evidence = () => { throw new Error("synthetic-case-evidence-service-down"); };
    await aeRefused(s, s.taken, record, /synthetic-case-evidence-service-down/, "service down", ["record", "evidence"]);
    delete s.tamper.evidence;
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.financialCases[0].evidenceReferences[0].evidenceId, "synthetic-ae-evidence-91");
});

test("AE-V/4: the TEST-only synthetic boundary holds for add_case_evidence; a PRODUCTION-kind verifier is kept as { kind, id }", async () => {
    const off = await aeSetup({ allowSyntheticEvidence: false });
    const record = aeRecord(off.taken, { n: 101 });
    await aeRefused(off, off.taken, record, /SYNTHETIC_VERIFIER_NOT_ALLOWED/, "synthetic", ["record", "evidence"]);
    off.tamper.evidence = (evidence, request) => ({ ...aeAttest(evidence, request, "PRODUCTION"), extra: "not kept" });
    const added = await aeSend(off, off.taken, record);
    assert.deepEqual(added.financialCases[0].evidenceReferences[0].verifier,
        { kind: "PRODUCTION", id: "synthetic-case-evidence-service" });
});

test("AE-U/1 (PA-1): evidence ids and digests are consumed once per core, shared by cases, orders and CLOSE, both ways", async () => {
    const s = await aeSetup();
    const first = await aeSend(s, s.taken, aeRecord(s.taken, { n: 111 }));
    await aeRefused(s, first, aeRecord(first, { n: 112, evidence: { evidenceId: "synthetic-ae-evidence-111" } }),
        /EVIDENCE_REFERENCE_USED/, "same id", ["record", "evidence"]);
    await aeRefused(s, first, aeRecord(first, { n: 113, evidence: { digest: dgDigest("ae-111") } }),
        /EVIDENCE_DIGEST_USED/, "same digest", ["record", "evidence"]);
    // Another order of the same core.
    const other = await refundedCases(s);
    const otherTaken = await takeCase(s, other.refunded);
    await aeRefused(s, otherTaken, aeRecord(otherTaken, { n: 114, evidence: { evidenceId: "synthetic-ae-evidence-111" } }),
        /EVIDENCE_REFERENCE_USED/, "other order, same id", ["record", "evidence"]);
    // CLOSE evidence first, then case evidence with its id or digest.
    const closing = await inReview("DISPUTE", s);
    const closeRecord = dgRecord(s, closing, { digest: dgDigest("ae-close") });
    await s.resolveReview(closing.reviewed, "CLOSE", closeRecord);
    await aeRefused(s, otherTaken, aeRecord(otherTaken, { n: 115, evidence: { evidenceId: closeRecord.evidence.evidenceId } }),
        /EVIDENCE_REFERENCE_USED/, "CLOSE id", ["record", "evidence"]);
    await aeRefused(s, otherTaken, aeRecord(otherTaken, { n: 116, evidence: { digest: dgDigest("ae-close") } }),
        /EVIDENCE_DIGEST_USED/, "CLOSE digest", ["record", "evidence"]);
    // Case evidence first, then a CLOSE with its digest.
    const later = await inReview("DISPUTE", s);
    await assert.rejects(s.resolveReview(later.reviewed, "CLOSE", dgRecord(s, later, { digest: dgDigest("ae-111") })),
        /EVIDENCE_DIGEST_USED/);
    const fresh = await aeSend(s, otherTaken, aeRecord(otherTaken, { n: 117 }));
    assert.equal(fresh.financialCases[0].evidenceReferences.length, 1);
});

test("AE-U/2 (DQ-203-04, N-2): a case authorizationRef is single use and shares one namespace with review references", async () => {
    const s = await aeSetup();
    const first = await aeSend(s, s.taken, aeRecord(s.taken, { n: 121 }));
    await aeRefused(s, first, aeRecord(first, { n: 122, extra: { authorizationRef: "synthetic-ae-auth-121" } }),
        /CASE_REFERENCE_USED/, "same case");
    const both = await takeCase(s, first, caseRef(first, "case-0002"), "admin");
    await assert.rejects(aeSend(s, both, aeRecord(both, { caseId: "case-0002", role: "admin", n: 123,
        extra: { authorizationRef: "synthetic-ae-auth-121" } }), { role: "admin" }), /CASE_REFERENCE_USED/, "other case");
    // Review references are refused for case evidence…
    const opening = s.refunded.reviews[0].opening.authorizationRef;
    const deciding = s.refunded.reviews[0].resolution.authorizationRef;
    for (const ref of [opening, deciding]) {
        await aeRefused(s, both, aeRecord(both, { n: 124, extra: { authorizationRef: ref } }), /CASE_REFERENCE_USED/, ref);
    }
    // …and case references for reviews: opening and resolving.
    const p = await producing("PLUS", {}, s);
    await assert.rejects(s.openReview(p.order, "DISPUTE", s.reviewRecord(p.order, "DISPUTE",
        { authorizationRef: "synthetic-ae-auth-121" })), /REVIEW_REFERENCE_USED/);
    // Judged where the review references are, before the clock: a broken clock does not hide the reuse.
    s.setNow("2026-10-28T09:00:00");
    await assert.rejects(s.openReview(p.order, "DISPUTE", s.reviewRecord(p.order, "DISPUTE",
        { authorizationRef: "synthetic-ae-auth-121" })), /REVIEW_REFERENCE_USED/);
    s.setNow(FIXED_TIME);
    const reviewed = await s.openReview(p.order, "DISPUTE");
    await assert.rejects(s.resolveReview(reviewed, "CONTINUE", s.resolution(reviewed, reviewed.reviews[0].reviewId,
        "CONTINUE", { authorizationRef: "synthetic-ae-auth-121" })), /REVIEW_REFERENCE_USED/);
    const continued = await s.resolveReview(reviewed, "CONTINUE");
    assert.equal(continued.reviews[0].status, "RESOLVED");
    const added = await aeSend(s, both, aeRecord(both, { n: 125 }));
    assert.equal(added.financialCases[0].evidenceReferences.length, 2);
});

test("AE-T/1 (DQ-203-06, N-3): createdAt is never after the trusted time, fixed before any verifier is awaited", async () => {
    const s = await aeSetup();
    const later = new Date(Date.parse(FIXED_TIME) + 1).toISOString();
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 131, evidence: { createdAt: later } }), /EVIDENCE_TIME_INVALID/,
        "1 ms in the future");
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 131, evidence: { createdAt: "2099-01-01T00:00:00.000Z" } }),
        /EVIDENCE_TIME_INVALID/, "2099");
    s.setNow("2026-10-28T08:59:59.999Z");
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 131 }), /CLOCK_REGRESSION/, "clock behind the order");
    s.setNow("2026-10-28T09:00:00");
    await aeRefused(s, s.taken, aeRecord(s.taken, { n: 131 }), /INVALID_CLOCK/, "zone-less clock");
    // An offset form of the same instant is equal, so it commits; the time is the one taken before the verifiers.
    s.setNow(FIXED_TIME);
    s.tamper.record = (record, order, context) => {
        s.setNow("2026-10-28T09:30:00.000Z");
        return { verified: signatureMatches(record.signature, aeSignRecord(context.binding)), binding: context.binding };
    };
    const added = await aeSend(s, s.taken, aeRecord(s.taken, { n: 131, evidence: { createdAt: "2026-10-28T12:00:00+03:00" } }));
    const stored = added.financialCases[0].evidenceReferences[0];
    assert.deepEqual([stored.createdAt, stored.addedAt, added.events.at(-1).at], [FIXED_TIME, FIXED_TIME, FIXED_TIME]);
    // Pure: with a trusted time the wrapper judges the upper bound too.
    const item = s.taken.financialCases[0];
    const principal = { role: "finance", actorId: "synthetic-finance-case-reviewer" };
    const record = aeRecord(s.taken, { n: 132, evidence: { createdAt: later } });
    assert.ok(aeCore.checkCaseEvidenceSubmission(record, s.taken, item, principal));
    assert.ok(aeCore.checkCaseEvidenceSubmission(record, s.taken, item, principal, later));
    assert.throws(() => aeCore.checkCaseEvidenceSubmission(record, s.taken, item, principal, FIXED_TIME), /EVIDENCE_TIME_INVALID/);
    assert.throws(() => aeCore.checkCaseEvidenceSubmission(record, s.taken, item, principal, "2026-10-28T09:00:00"),
        /INVALID_CLOCK/);
});

test("AE-I/1 (INV-203-01): only add_case_evidence fingerprints its payload; a replay returns the commit, other content conflicts", async () => {
    const s = await aeSetup();
    // take_case keeps the original 17-element intent: no payload element is appended for any other command.
    const take = s.taken.events.at(-1);
    assert.equal(take.fingerprint, aeHash(["take_case", ...Array(15).fill(null), caseRef(s.taken)]));
    const record = aeRecord(s.taken, { n: 141 });
    const added = await aeSend(s, s.taken, record, { requestId: "synthetic-ae-i1" });
    assert.equal(added.events.at(-1).fingerprint, aeHash(["add_case_evidence", ...Array(16).fill(null), record]));
    s.calls.length = 0;
    const replayed = await aeSend(s, s.taken, record, { requestId: "synthetic-ae-i1" });
    assert.equal(replayed, added, "the same request returns the committed order");
    assert.deepEqual(s.calls, [], "a replay asks no verifier");
    for (const changed of [aeRecord(s.taken, { n: 142 }), { ...record, evidence: { ...record.evidence,
        digest: dgDigest("ae-i1-other") } }]) {
        await assert.rejects(aeSend(s, added, changed, { requestId: "synthetic-ae-i1" }), /IDEMPOTENCY_CONFLICT/);
    }
    await assert.rejects(s.send(added, "take_case", "finance", { caseRef: caseRef(added) },
        { requestId: "synthetic-ae-i1", actorId: "synthetic-finance-case-reviewer" }), /IDEMPOTENCY_CONFLICT/);
    // A refused request records nothing: its id is free for a valid submission.
    await aeRefused(s, added, aeRecord(added, { n: 143, extra: { note: 1 } }), /EVIDENCE_MISMATCH/, "refused");
    const next = await aeSend(s, added, aeRecord(added, { n: 143 }));
    assert.equal(next.version, added.version + 1);
});

test("AE-R/1 (races ×10): one order commits once; two orders sharing an id, digest or reference commit exactly one", async () => {
    for (let round = 0; round < 10; round += 1) {
        const s = await aeSetup();
        const pair = await Promise.allSettled([aeSend(s, s.taken, aeRecord(s.taken, { n: `r${round}-a` })),
            aeSend(s, s.taken, aeRecord(s.taken, { n: `r${round}-b` }))]);
        assert.deepEqual(pair.map(result => result.status).sort(), ["fulfilled", "rejected"], `same order, round ${round}`);
        assert.equal(pair.find(result => result.status === "rejected").reason.code, "VERSION_CONFLICT");
        let left = pair.find(result => result.status === "fulfilled").value;
        const second = await refundedCases(s);
        let right = await takeCase(s, second.refunded);
        // Both submissions pass every pre-check before either commits: the evidence service holds both at a barrier.
        for (const [label, shared, code] of [
            ["id", { evidence: { evidenceId: `synthetic-ae-race-id-${round}` } }, "EVIDENCE_REFERENCE_USED"],
            ["digest", { evidence: { digest: dgDigest(`ae-race-${round}`) } }, "EVIDENCE_DIGEST_USED"],
            ["reference", { extra: { authorizationRef: `synthetic-ae-race-ref-${round}` } }, "CASE_REFERENCE_USED"]]) {
            let arrived = 0;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            s.tamper.evidence = async (evidence, request) => {
                arrived += 1;
                if (arrived === 2) release();
                await gate;
                return aeAttest(evidence, request);
            };
            // A submission refused before the barrier opens it, so the other one never waits forever.
            const results = await Promise.allSettled([
                aeSend(s, left, aeRecord(left, { n: `r${round}-${label}-l`, ...shared })).finally(() => release()),
                aeSend(s, right, aeRecord(right, { n: `r${round}-${label}-r`, ...shared })).finally(() => release())]);
            delete s.tamper.evidence;
            const fulfilled = results.filter(result => result.status === "fulfilled");
            const rejected = results.filter(result => result.status === "rejected");
            assert.equal(arrived, 2, `${label}: both reached the evidence service`);
            assert.equal(fulfilled.length, 1, `${label}, round ${round}`);
            assert.equal(rejected[0].reason.code, code, `${label}, round ${round}`);
            const winner = fulfilled[0].value;
            if (winner.id === left.id) left = winner; else right = winner;
        }
    }
});

test("AE-R/2: a commit on the same order while a verifier is awaited is VERSION_CONFLICT; nothing is consumed", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 201 });
    let other = null;
    s.tamper.record = async (seen, order, context) => {
        delete s.tamper.record;
        other = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "admin");
        return { verified: signatureMatches(seen.signature, aeSignRecord(context.binding)), binding: context.binding };
    };
    await assert.rejects(aeSend(s, s.taken, record), /VERSION_CONFLICT/);
    assert.equal(other.version, s.taken.version + 1);
    const added = await aeSend(s, other, record);
    assert.equal(added.financialCases[0].evidenceReferences[0].authorizationRef, "synthetic-ae-auth-201");
});

test("AE-M/1 (DQ-203-08, MIRROR-203, N-4): an add_case_evidence mirror is the stored entry itself, of the same case", async () => {
    const { probeEvidenceOnly } = await scProbeCore();
    const s = await aeSetup();
    const both = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "admin");
    const one = await aeSend(s, both, aeRecord(both, { n: 171 }));
    const added = await aeSend(s, one, aeRecord(one, { caseId: "case-0002", role: "admin", n: 172 }), { role: "admin" });
    const [first, second] = added.financialCases;
    const stored = first.evidenceReferences[0];
    const otherStored = second.evidenceReferences[0];
    const trail = first.auditTrail.at(-1);
    assert.equal(trail.step, "EVIDENCE_ADDED");
    assert.equal(probeEvidenceOnly(added, added, null, []), true);
    const withTrail = entry => ({ ...added, financialCases: [{ ...first, auditTrail: [...first.auditTrail.slice(0, -1), entry] },
        second] });
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail }), null, []), true, "the stored object itself");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, evidence: { ...stored } }), null, []), false, "an equal copy");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, evidence: otherStored }), null, []), false, "another case's entry");
    // The same audit object placed in the other case's trail: the entry it holds is not that case's own (N-4).
    const moved = { ...added, financialCases: [first, { ...second, auditTrail: [...second.auditTrail, trail] }] };
    assert.equal(probeEvidenceOnly(added, moved, null, []), false, "a mirror moved to another case's trail");
    const eventIndex = added.events.findIndex(event => event.audit === trail);
    assert.ok(eventIndex > 0);
    const withEvent = audit => ({ ...added, events: added.events.map((event, index) => (index === eventIndex
        ? { ...event, audit } : event)) });
    assert.equal(probeEvidenceOnly(added, withEvent({ ...trail }), null, []), true, "event: the stored object");
    assert.equal(probeEvidenceOnly(added, withEvent({ ...trail, evidence: { ...stored } }), null, []), false, "event: a copy");
    assert.equal(probeEvidenceOnly(added, withEvent({ ...trail, evidence: otherStored }), null, []), false,
        "event: another case's entry");
    assert.equal(probeEvidenceOnly(added, added, trail, []), true, "transition audit: the stored object");
    assert.equal(probeEvidenceOnly(added, added, { ...trail, evidence: { ...stored } }, []), false, "transition audit: a copy");
    assert.equal(probeEvidenceOnly(added, added, { ...trail, evidence: otherStored }, []), false,
        "transition audit: another case's entry");
    // Scoped to add_case_evidence (owner decision, Görev 206): other mirrors keep the key rule, CLOSE unchanged.
    assert.equal(probeEvidenceOnly(added, withTrail({ step: "PROBE", evidence: { ...stored } }), null, []), true);
});

test("AE-M/2 (DQ-203-10, N-6): the case evidence audit is frozen before hashing; a mirror swapped while the commit awaits is refused", async () => {
    const probe = await scProbeCore();
    const s = await aeSetup({}, null, probe.createCore);
    try {
        let seen = null;
        probe.setProbeAwaitHook((stage, scope) => {
            if (stage === "cases" && seen === null) {
                seen = [scope.audit.step, Object.isFrozen(scope.audit), Object.isFrozen(scope.audit.evidence)];
                assert.throws(() => { scope.audit.note = "changed"; }, TypeError);
            }
        });
        const added = await aeSend(s, s.taken, aeRecord(s.taken, { n: 181 }));
        assert.deepEqual(seen, ["EVIDENCE_ADDED", true, true]);
        assert.equal(added.events.at(-1).audit.note, undefined);
        let fired = 0;
        probe.setProbeAwaitHook((stage, scope) => {
            if (stage === "hash" && fired === 0) {
                fired += 1;
                const item = scope.next.financialCases[0];
                scope.next.financialCases[0] = { ...item, auditTrail: [...item.auditTrail.slice(0, -1),
                    { ...scope.audit, evidence: { ...scope.audit.evidence } }] };
            }
        });
        const record = aeRecord(added, { n: 182 });
        await assert.rejects(aeSend(s, added, record), /EVIDENCE_STORAGE_INVALID/);
        assert.equal(fired, 1);
        probe.setProbeAwaitHook(() => {});
        const next = await aeSend(s, added, record);
        assert.equal(next.version, added.version + 1);
    } finally {
        probe.setProbeAwaitHook(null);
    }
});

test("AE-B/1 (DQ-203-07, F198-03): the scan also counts own keys, primitives included; depth 64 and 200 000 objects stay", async () => {
    const probe = await scProbeCore();
    assert.deepEqual(probe.PROBE_SCAN_LIMITS, { depth: 64, nodes: 200000 });
    assert.match(await coreSource(), /const EVIDENCE_SCAN_MAX_ENTRIES = 1000000;/);
    const scan = length => probe.probeFindEvidence({ list: new Array(length).fill(0) });
    // One key of the root plus `length` array elements: 1 000 000 entries is the budget itself.
    assert.deepEqual(scan(999999).found, []);
    assert.equal(scan(1000000).found, null);
    assert.equal(scan(10).used, 2, "objects are counted as before");
    const { refunded, store } = await scSetup();
    await assert.rejects(store(refunded, { mode: "decisions", put: [new Array(1000001).fill(0)] }), /EVIDENCE_STORAGE_INVALID/);
    const next = await store(refunded, { mode: "decisions", put: [new Array(1000).fill(0)] });
    assert.equal(next.version, refunded.version + 1);
});

test("AE-P/1: outside TEST add_case_evidence is refused by the central gate for every role, before any verifier", async () => {
    for (const environment of ["PRODUCTION", "STAGING", undefined]) {
        const calls = [];
        const h = setup({ allowSyntheticEvidence: false, environment,
            verifyCaseRecord: async () => { calls.push("record"); return null; },
            verifyCaseEvidence: async () => { calls.push("evidence"); return null; } });
        const { refunded } = await refundedCases(h);
        for (const role of ["finance", "admin"]) {
            await assert.rejects(aeSend(h, refunded, aeRecord(refunded, { role, n: `p-${environment}-${role}` }), { role }),
                /CASE_COMMAND_NOT_ENABLED/, `${environment}/${role}`);
        }
        assert.deepEqual(calls, []);
        const after = await takeCase(h, refunded).catch(error => error.code);
        assert.equal(after, "CASE_COMMAND_NOT_ENABLED");
    }
});

test("AE-O/1: refusals follow one order: state, shape, reference, time, record verifier, evidence verifier, gate", async () => {
    const s = await aeSetup();
    const used = await aeSend(s, s.taken, aeRecord(s.taken, { n: 191 }));
    const future = new Date(Date.parse(FIXED_TIME) + 1).toISOString();
    await aeRefused(s, used, aeRecord(used, { caseId: "case-0002", n: 192, extra: { note: 1 } }), /CASE_STATE_INVALID/,
        "OPEN case and a bad shape");
    await aeRefused(s, used, aeRecord(used, { n: 193, extra: { note: 1, authorizationRef: "synthetic-ae-auth-191" } }),
        /EVIDENCE_MISMATCH/, "bad shape and a used reference");
    await aeRefused(s, used, aeRecord(used, { n: 194, extra: { authorizationRef: "synthetic-ae-auth-191" },
        evidence: { createdAt: future } }), /CASE_REFERENCE_USED/, "used reference and a future time");
    const reused = aeRecord(used, { n: 195, evidence: { evidenceId: "synthetic-ae-evidence-191" } });
    s.tamper.record = () => null;
    s.tamper.evidence = () => null;
    await aeRefused(s, used, reused, /UNTRUSTED_REVIEW/, "record before evidence", ["record"]);
    delete s.tamper.record;
    await aeRefused(s, used, reused, /UNTRUSTED_EVIDENCE/, "evidence before the registries", ["record", "evidence"]);
    delete s.tamper.evidence;
    await aeRefused(s, used, reused, /EVIDENCE_REFERENCE_USED/, "the registries last", ["record", "evidence"]);
    const bare = await aeSetup({ verifyCaseEvidence: undefined });
    await aeRefused(bare, bare.taken, aeRecord(bare.taken, { n: 196, evidence: { createdAt: future } }),
        /EVIDENCE_TIME_INVALID/, "a future time before a missing service");
});

test("AE-C/1: CLOSE beside case evidence keeps its shape: the resolution, audit and event share one evidence object", async () => {
    const s = await aeSetup();
    await aeSend(s, s.taken, aeRecord(s.taken, { n: 211 }));
    const closing = await inReview("DISPUTE", s);
    const closed = await s.resolveReview(closing.reviewed, "CLOSE", dgRecord(s, closing, { digest: dgDigest("ae-c1") }));
    const plain = setup();
    const reference = await inReview("DISPUTE", plain);
    const referenceClosed = await plain.resolveReview(reference.reviewed, "CLOSE",
        dgRecord(plain, reference, { digest: dgDigest("ae-c1-ref") }));
    const resolution = closed.reviews.at(-1).resolution;
    assert.equal(resolution.evidence, closed.events.at(-1).audit.evidence);
    assert.deepEqual(Object.keys(resolution), Object.keys(referenceClosed.reviews.at(-1).resolution));
    assert.deepEqual(Object.keys(resolution.evidence), Object.keys(referenceClosed.reviews.at(-1).resolution.evidence));
    assert.deepEqual(Object.keys(closed.events.at(-1)), Object.keys(referenceClosed.events.at(-1)));
    assert.equal(closed.financialCases.length, 0);
});

// ---- Görev 210 (Faz 2B-3 security remediation): OD-207-01…04, DQ-208-01…05 ----
// RM/1–4: four eyes and the case owner (originDeciderActorId first, assignedActorId second, both before authorizationRef);
// RM/5: GEN-3 for CLOSE-shaped and case-naming mirrors; RM/6: TRAIL-1; RM/7: the pre-check of the transition audit
// (M-38); RM/8–9: the own-data attestation snapshot (DQ-208-03).

test("RM/1 (DQ-208-02, OF-209-01): the review's decider never adds its case's evidence, even as the case's owner", async () => {
    const s = await aeSetup();
    const decider = s.refunded.financialCases[1].originDeciderActorId;
    assert.equal(decider, s.refunded.reviews[0].resolution.actorId);
    const both = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "finance", { actorId: decider });
    assert.equal(both.financialCases[1].assignedActorId, decider);
    s.calls.length = 0;
    await assert.rejects(aeSend(s, both, aeRecord(both, { caseId: "case-0002", actorId: decider, n: 301 }), { actorId: decider }),
        /FOUR_EYES_VIOLATION/);
    assert.deepEqual(s.calls, []);
    // OF-209-01 (TEST-only, open): nobody else may add evidence to that case, and take_case is unchanged (DQ-208-04).
    await assert.rejects(aeSend(s, both, aeRecord(both, { caseId: "case-0002", n: 302 })), /UNAUTHORIZED/);
    assert.deepEqual(s.calls, []);
});

test("RM/2 (DQ-208-01): only the person the case is assigned to adds its evidence; another finance or an admin is UNAUTHORIZED", async () => {
    const s = await aeSetup();
    assert.equal(s.taken.financialCases[0].assignedActorId, "synthetic-finance-case-reviewer");
    for (const [role, actorId] of [["finance", "synthetic-finance-other"], ["admin", "synthetic-admin-case-reviewer"]]) {
        s.calls.length = 0;
        await assert.rejects(aeSend(s, s.taken, aeRecord(s.taken, { role, actorId, n: 311 }), { role, actorId }),
            /UNAUTHORIZED/, `${role} ${actorId}`);
        assert.deepEqual(s.calls, [], `${role}: no verifier is asked`);
    }
    const added = await aeSend(s, s.taken, aeRecord(s.taken, { n: 311 }));
    assert.equal(added.financialCases[0].evidenceReferences[0].submittedBy.actorId, "synthetic-finance-case-reviewer");
});

test("RM/3: a decider who is not the owner gets FOUR_EYES_VIOLATION first", async () => {
    const s = await aeSetup();
    const decider = s.taken.financialCases[0].originDeciderActorId;
    assert.notEqual(decider, s.taken.financialCases[0].assignedActorId);
    s.calls.length = 0;
    await assert.rejects(aeSend(s, s.taken, aeRecord(s.taken, { actorId: decider, n: 321 }), { actorId: decider }),
        /FOUR_EYES_VIOLATION/, "both violations");
    assert.deepEqual(s.calls, []);
});

test("RM/4: four eyes and ownership come after the actor binding and before the reference, the time and the verifiers", async () => {
    const s = await aeSetup();
    const used = await aeSend(s, s.taken, aeRecord(s.taken, { n: 331 }));
    const other = "synthetic-finance-other";
    const decider = used.financialCases[0].originDeciderActorId;
    const future = new Date(Date.parse(FIXED_TIME) + 1).toISOString();
    const cases = [
        ["OPEN case and the decider", aeRecord(used, { caseId: "case-0002", actorId: decider, n: 332 }), decider, /CASE_STATE_INVALID/],
        ["bad shape and not the owner", aeRecord(used, { actorId: other, n: 333, extra: { note: 1 } }), other, /EVIDENCE_MISMATCH/],
        ["record of another actor and not the owner", aeRecord(used, { n: 334 }), other, /EVIDENCE_MISMATCH/],
        ["not the owner and a used reference", aeRecord(used, { actorId: other, n: 335,
            extra: { authorizationRef: "synthetic-ae-auth-331" } }), other, /UNAUTHORIZED/],
        ["the decider and a used reference", aeRecord(used, { actorId: decider, n: 336,
            extra: { authorizationRef: "synthetic-ae-auth-331" } }), decider, /FOUR_EYES_VIOLATION/],
        ["not the owner and a future time", aeRecord(used, { actorId: other, n: 337, evidence: { createdAt: future } }), other,
            /UNAUTHORIZED/]
    ];
    for (const [label, record, actorId, expected] of cases) {
        s.calls.length = 0;
        await assert.rejects(aeSend(s, used, record, { actorId }), expected, label);
        assert.deepEqual(s.calls, [], `${label}: no verifier is asked`);
    }
    // The owner is still refused for the used reference itself.
    await aeRefused(s, used, aeRecord(used, { n: 338, extra: { authorizationRef: "synthetic-ae-auth-331" } }),
        /CASE_REFERENCE_USED/, "owner, used reference");
});

test("RM/5 (OD-207-01, GEN-3): a CLOSE or case-naming mirror must be the stored object of the place it names", async () => {
    const { probeEvidenceOnly } = await scProbeCore();
    const h = setup();
    const p = await inReview("DISPUTE", h);
    const closed = await h.resolveReview(p.reviewed, "CLOSE", dgRecord(h, p, { digest: dgDigest("rm5-close") }));
    const event = closed.events.at(-1);
    const audit = event.audit;
    assert.equal(audit.evidence, closed.reviews[0].resolution.evidence, "a real CLOSE shares one evidence object");
    assert.equal(probeEvidenceOnly(closed, closed, null, []), true);
    assert.equal(probeEvidenceOnly(closed, closed, audit, []), true);
    const withEvent = changed => ({ ...closed, events: [...closed.events.slice(0, -1), { ...event, audit: changed }] });
    const copy = { ...audit, evidence: { ...audit.evidence } };
    assert.equal(probeEvidenceOnly(closed, withEvent(copy), null, []), false, "CLOSE event audit: an equal copy");
    assert.equal(probeEvidenceOnly(closed, closed, copy, []), false, "CLOSE transition audit: an equal copy");
    assert.equal(probeEvidenceOnly(closed, withEvent({ ...audit, reviewId: "review-0099" }), null, []), false,
        "CLOSE audit naming another review");
    // An audit naming an unknown case has no place, even when its review holds that very object (no fallback).
    assert.equal(probeEvidenceOnly(closed, withEvent({ ...audit, caseId: "case-0099" }), null, []), false,
        "audit naming an unknown case and the right review");
    // A case-naming audit belongs to the case it names; an unknown case has no place (no fallback to its review).
    const s = await aeSetup();
    const added = await aeSend(s, s.taken, aeRecord(s.taken, { n: 341 }));
    const trailAudit = added.financialCases[0].auditTrail.at(-1);
    const caseEvent = added.events.at(-1);
    const withCaseEvent = changed => ({ ...added, events: [...added.events.slice(0, -1), { ...caseEvent, audit: changed }] });
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...trailAudit, step: "RELABELLED" }), null, []), true,
        "a relabelled audit still holding the stored object");
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...trailAudit, step: "RELABELLED",
        evidence: { ...trailAudit.evidence } }), null, []), false, "a relabelled audit naming the case: a copy");
    const { reviewId: dropped, ...caseOnly } = trailAudit;
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...caseOnly, step: "RELABELLED", evidence: { ...trailAudit.evidence } }),
        null, []), false, "a relabelled audit naming only the case: a copy");
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...trailAudit, caseId: "case-0099" }), null, []), false,
        "an audit naming an unknown case");
    // A real CLOSE still commits beside case evidence (AE-C/1) and DIFF/1 stays identical.
    const later = await inReview("DISPUTE", s);
    const next = await s.resolveReview(later.reviewed, "CLOSE", dgRecord(s, later, { digest: dgDigest("rm5-later") }));
    assert.equal(next.state, STATES.CLOSED);
});

test("RM/6 (OD-207-03, TRAIL-1): earlier case audit trail entries can never be removed, replaced, reordered or relabelled", async () => {
    const probe = await scProbeCore();
    const s = await aeSetup({}, null, probe.createCore);
    const first = await aeSend(s, s.taken, aeRecord(s.taken, { n: 351 }));
    const tampers = [
        ["replace the opening with an equal copy", trail => [{ ...trail[0] }, ...trail.slice(1)]],
        ["relabel the opening", trail => [{ ...trail[0], step: "RELABELLED" }, ...trail.slice(1)]],
        ["change the opening's actor", trail => [{ ...trail[0], actorId: "synthetic-finance-other" }, ...trail.slice(1)]],
        ["remove the taking", trail => [trail[0], ...trail.slice(2)]],
        ["reorder", trail => [trail[1], trail[0], ...trail.slice(2)]],
        ["replace an earlier evidence step with a placeless copy", trail => trail.map((entry, index) => {
            if (index !== 2) return entry;
            const { caseId, reviewId, ...rest } = entry;
            return { ...rest, step: "EVIDENCE_INVALIDATED", evidence: { ...entry.evidence, status: "INVALIDATED" } };
        })],
        ["not an array", trail => ({ ...trail })]
    ];
    try {
        for (const [label, change] of tampers) {
            let fired = 0;
            probe.setProbeAwaitHook((stage, scope) => {
                if (stage === "hash" && fired === 0) {
                    fired += 1;
                    const item = scope.next.financialCases[0];
                    scope.next.financialCases[0] = { ...item, auditTrail: change(item.auditTrail) };
                }
            });
            s.calls.length = 0;
            await assert.rejects(aeSend(s, first, aeRecord(first, { n: 352 })), /EVIDENCE_HISTORY_CHANGED/, label);
            assert.equal(fired, 1, `${label} ran`);
        }
        probe.setProbeAwaitHook(() => {});
        const next = await aeSend(s, first, aeRecord(first, { n: 352 }));
        assert.ok(first.financialCases[0].auditTrail.every((entry, index) => next.financialCases[0].auditTrail[index] === entry));
    } finally {
        probe.setProbeAwaitHook(null);
    }
});

test("RM/7 (M-38): a transition audit holding unknown evidence is refused by the pre-check, before the commit awaits", async () => {
    const { probeEvidenceOnly } = await scProbeCore();
    const { refunded, store } = await scSetup();
    const a = scItem("rm7-a");
    const b = scItem("rm7-b");
    assert.equal(probeEvidenceOnly(refunded, refunded, { step: "PROBE", evidence: b }, []), false, "unknown audit evidence");
    assert.equal(probeEvidenceOnly(refunded, refunded, { step: "PROBE", evidence: b }, [b]), true, "claimed audit evidence");
    await scRefusedBeforeAwait(store, refunded, { claims: [a], mode: "audit", mirror: b }, /EVIDENCE_STORAGE_INVALID/,
        "unknown audit evidence");
    await scCleanAfter(store, refunded, a);
});

test("RM/8 (DQ-208-03): accessor or inherited attestation fields are UNTRUSTED_EVIDENCE and no getter ever runs", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 361 });
    let reads = 0;
    const getter = value => ({ get() { reads += 1; return value; }, enumerable: true });
    const shapes = [
        ["accessor status", (evidence, request) => Object.defineProperty({ ...aeAttest(evidence, request) }, "status",
            getter("VERIFIED"))],
        ["accessor digestBasis", (evidence, request) => Object.defineProperty({ ...aeAttest(evidence, request) },
            "digestBasis", getter(request.digestBasis))],
        ["accessor verifier", (evidence, request) => Object.defineProperty({ ...aeAttest(evidence, request) }, "verifier",
            getter({ kind: "SYNTHETIC", id: "synthetic-case-evidence-service" }))],
        ["accessor verifier kind", (evidence, request) => ({ ...aeAttest(evidence, request),
            verifier: Object.defineProperty({ id: "synthetic-case-evidence-service" }, "kind", getter("SYNTHETIC")) })],
        ["inherited status", (evidence, request) => {
            const { status, ...own } = aeAttest(evidence, request);
            return Object.assign(Object.create({ status }), own);
        }],
        ["inherited verifier", (evidence, request) => {
            const { verifier, ...own } = aeAttest(evidence, request);
            return Object.assign(Object.create({ verifier }), own);
        }]
    ];
    for (const [label, shape] of shapes) {
        s.tamper.evidence = shape;
        await aeRefused(s, s.taken, record, /UNTRUSTED_EVIDENCE/, label, ["record", "evidence"]);
    }
    assert.equal(reads, 0, "no getter of an attestation was invoked");
    delete s.tamper.evidence;
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.version, s.taken.version + 1);
});

test("RM/9 (DQ-208-03): the checks and the claim gate judge one stable copy; later changes to the attestation change nothing", async () => {
    const probe = await scProbeCore();
    const s = await aeSetup({}, null, probe.createCore);
    let returned = null;
    s.tamper.evidence = (evidence, request) => {
        returned = { ...aeAttest(evidence, request), note: "kept out",
            verifier: { kind: "SYNTHETIC", id: "synthetic-case-evidence-service", extra: "kept out" } };
        return returned;
    };
    try {
        probe.setProbeAwaitHook(stage => {
            if (stage === "cases" && returned) {
                returned.status = "REVOKED";
                returned.verifier.id = "synthetic-other-service";
                returned.digest = dgDigest("rm9-other");
            }
        });
        const added = await aeSend(s, s.taken, aeRecord(s.taken, { n: 371 }));
        const stored = added.financialCases[0].evidenceReferences[0];
        assert.deepEqual(stored.verifier, { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" });
        assert.equal(stored.digest, dgDigest("ae-371"));
        assert.ok(!JSON.stringify(added).includes("kept out"));
        assert.equal(returned.status, "REVOKED", "the verifier's own object was changed, the commit was not");
    } finally {
        probe.setProbeAwaitHook(null);
    }
});

// ============================================================================================================
// Görev 214 (Faz 2B-3, OD-211-01..05, FD-212-01..06): regression tests of the security remediation.
// RM/10 is the approved snapshot test (FD-212-06); RM/9 is unchanged. No Proxy attestation test is added (FD-212-04).
// ============================================================================================================

/** Runs `run` once with an await hook that applies `change` at `stage` the first time; returns the outcome. */
async function rmWithHook(probe, stage, change, run) {
    let fired = 0;
    probe.setProbeAwaitHook((at, scope) => {
        if (at === stage && fired === 0) {
            fired += 1;
            change(scope);
        }
    });
    try {
        return await run().then(value => ({ value, fired }), error => ({ error, fired }));
    } finally {
        probe.setProbeAwaitHook(null);
    }
}

test("RM/10 (FD-212-06, OD-211-03): a polluted Object.prototype never supplies the attestation's status or verifier", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 1001 });
    const shapes = [
        ["neither stated", (evidence, request) => {
            const { status, verifier, ...own } = aeAttest(evidence, request);
            return own;
        }],
        ["status not stated", (evidence, request) => {
            const { status, ...own } = aeAttest(evidence, request);
            return own;
        }],
        ["null-prototype attestation stating neither", (evidence, request) => {
            const { status, verifier, ...own } = aeAttest(evidence, request);
            return Object.assign(Object.create(null), own);
        }],
        ["verifier without its own kind and id", (evidence, request) => ({ ...aeAttest(evidence, request), verifier: {} })]
    ];
    Object.prototype.status = "VERIFIED";
    Object.prototype.verifier = { kind: "PRODUCTION", id: "synthetic-polluted-verifier" };
    Object.prototype.kind = "SYNTHETIC";
    Object.prototype.id = "synthetic-polluted-verifier";
    try {
        for (const [label, shape] of shapes) {
            s.tamper.evidence = shape;
            await aeRefused(s, s.taken, record, /UNTRUSTED_EVIDENCE/, label, ["record", "evidence"]);
        }
    } finally {
        delete Object.prototype.status;
        delete Object.prototype.verifier;
        delete Object.prototype.kind;
        delete Object.prototype.id;
    }
    delete s.tamper.evidence;
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.version, s.taken.version + 1, "nothing of a refused submission was consumed");
    assert.deepEqual(added.financialCases[0].evidenceReferences[0].verifier,
        { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" });
});

test("RM/11 (OD-211-02, I-213-01): nested, array, function and cyclic attestation values are refused unread and unfrozen", async () => {
    const s = await aeSetup();
    const record = aeRecord(s.taken, { n: 1101 });
    let reads = 0;
    const nested = Object.defineProperty({}, "x", { get() { reads += 1; return "v"; }, enumerable: true });
    const cyclic = {};
    cyclic.self = cyclic;
    const ownVerifier = { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" };
    const shapes = [
        ["a nested object with a getter", { decisionBinding: nested }],
        ["a cyclic value", { digestBasis: cyclic }],
        ["an array", { digest: [dgDigest("ae-1101")] }],
        ["a function", { createdAt: () => "2026-01-01T00:00:00Z" }],
        ["an object status", { status: { toString: () => "VERIFIED" } }],
        ["an object verifier kind", { verifier: { kind: nested, id: "synthetic-case-evidence-service" } }],
        ["a number verifier id", { verifier: { kind: "SYNTHETIC", id: 12345678 } }],
        ["an array verifier", { verifier: Object.assign(["x"], ownVerifier) }],
        ["a string verifier", { verifier: "SYNTHETIC" }]
    ];
    for (const [label, change] of shapes) {
        s.tamper.evidence = (evidence, request) => ({ ...aeAttest(evidence, request), ...change });
        await aeRefused(s, s.taken, record, /UNTRUSTED_EVIDENCE/, label, ["record", "evidence"]);
    }
    assert.equal(reads, 0, "no getter of a nested value ran");
    assert.equal(Object.isFrozen(nested), false, "a verifier-owned nested object was not frozen");
    assert.equal(Object.isFrozen(cyclic), false, "a verifier-owned cyclic object was not frozen");
    // A valid attestation whose verifier object belongs to the service: kept as { kind, id }, the service's object unfrozen.
    s.tamper.evidence = (evidence, request) => ({ ...aeAttest(evidence, request), verifier: ownVerifier });
    const added = await aeSend(s, s.taken, record);
    assert.equal(added.version, s.taken.version + 1);
    assert.equal(Object.isFrozen(ownVerifier), false, "the verifier's own object is not frozen");
    const stored = added.financialCases[0].evidenceReferences[0].verifier;
    assert.deepEqual(stored, { kind: "SYNTHETIC", id: "synthetic-case-evidence-service" });
    assert.notEqual(stored, ownVerifier);
    assert.equal(Object.getPrototypeOf(stored), Object.prototype, "the stored verifier is plain data");
});

test("RM/12 (OD-211-05): a present caseId or reviewId is a string that agrees with its place; valid CLOSE is unchanged", async () => {
    const { probeEvidenceOnly } = await scProbeCore();
    const h = setup();
    const p = await inReview("DISPUTE", h);
    const closed = await h.resolveReview(p.reviewed, "CLOSE", dgRecord(h, p, { digest: dgDigest("rm12-close") }));
    const event = closed.events.at(-1);
    const audit = event.audit;
    assert.equal(probeEvidenceOnly(closed, closed, null, []), true, "a real CLOSE");
    assert.equal(probeEvidenceOnly(closed, closed, audit, []), true, "a real CLOSE transition audit");
    const withEvent = changed => ({ ...closed, events: [...closed.events.slice(0, -1), { ...event, audit: changed }] });
    for (const [label, labels] of [["caseId null", { caseId: null }], ["caseId number", { caseId: 1 }],
        ["caseId object", { caseId: { caseId: "case-0001" } }], ["reviewId null", { reviewId: null }],
        ["reviewId array", { reviewId: [audit.reviewId] }], ["reviewId number", { reviewId: 7 }]]) {
        // A copy under an invalid label was accepted by the key rule before (A211-02); now it names no place.
        assert.equal(probeEvidenceOnly(closed, withEvent({ ...audit, ...labels, evidence: { ...audit.evidence } }), null, []),
            false, `event audit: ${label}`);
        assert.equal(probeEvidenceOnly(closed, closed, { ...audit, ...labels, evidence: { ...audit.evidence } }, []), false,
            `transition audit: ${label}`);
        assert.equal(probeEvidenceOnly(closed, withEvent({ ...audit, ...labels }), null, []), false,
            `event audit holding the stored object: ${label}`);
    }
    // Holder labels against the stored case and review (A211-03).
    const s = await aeSetup();
    const both = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "admin");
    const added = await aeSend(s, both, aeRecord(both, { n: 1201 }));
    const [first, second] = added.financialCases;
    const trail = first.auditTrail.at(-1);
    assert.equal(probeEvidenceOnly(added, added, null, []), true, "a real add_case_evidence");
    assert.equal(probeEvidenceOnly(added, added, trail, []), true, "a real case transition audit");
    const withTrail = entry => ({ ...added, financialCases: [{ ...first, auditTrail: [...first.auditTrail.slice(0, -1), entry] },
        second] });
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail }), null, []), true, "the stored object, labels agreeing");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, caseId: "case-0002" }), null, []), false,
        "a trail entry naming another case");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, caseId: "case-0099" }), null, []), false,
        "a trail entry naming an unknown case");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, reviewId: "review-0099" }), null, []), false,
        "a trail entry naming another review");
    assert.equal(probeEvidenceOnly(added, withTrail({ ...trail, caseId: null }), null, []), false,
        "a trail entry with a null caseId");
    const caseEvent = added.events.at(-1);
    const withCaseEvent = changed => ({ ...added, events: [...added.events.slice(0, -1), { ...caseEvent, audit: changed }] });
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...trail, reviewId: "review-0099" }), null, []), false,
        "an event audit whose reviewId contradicts its case");
    assert.equal(probeEvidenceOnly(added, added, { ...trail, reviewId: "review-0099" }, []), false,
        "a transition audit whose reviewId contradicts its case");
    // Unlabelled mirrors keep the key rule (OF-209-03, unchanged); a relabelled step with agreeing labels stays (RM/5).
    assert.equal(probeEvidenceOnly(added, withTrail({ step: "PROBE", evidence: { ...first.evidenceReferences[0] } }),
        null, []), true);
    assert.equal(probeEvidenceOnly(added, withCaseEvent({ ...trail, step: "RELABELLED" }), null, []), true);
    // A real CLOSE still commits beside case evidence.
    const later = await inReview("DISPUTE", s);
    const next = await s.resolveReview(later.reviewed, "CLOSE", dgRecord(s, later, { digest: dgDigest("rm12-later") }));
    assert.equal(next.state, STATES.CLOSED);
});

test("RM/13 (OD-211-01, FD-212-01/02): after the last await only the planned add_case_evidence transition commits", async () => {
    const probe = await scProbeCore();
    const s = await aeSetup({}, null, probe.createCore);
    const both = await takeCase(s, s.taken, caseRef(s.taken, "case-0002"), "admin");
    const replaceCase = (scope, change) => {
        const item = scope.next.financialCases[0];
        scope.next.financialCases[0] = { ...item, ...change(item, scope) };
    };
    const changes = [
        ["the new entry replaced by a forged one holding the stored entry", scope => replaceCase(scope, item => ({
            auditTrail: [...item.auditTrail.slice(0, -1), { ...scope.audit, actorId: "synthetic-forged-actor" }] }))],
        ["the new entry replaced by an equal copy", scope => replaceCase(scope, item => ({
            auditTrail: [...item.auditTrail.slice(0, -1), { ...scope.audit }] }))],
        ["an extra entry after the new one", scope => replaceCase(scope, item => ({
            auditTrail: [...item.auditTrail, scope.next.financialCases[1].auditTrail[0]] }))],
        ["an extra entry before the new one", scope => replaceCase(scope, item => ({
            auditTrail: [...item.auditTrail.slice(0, -1), scope.next.financialCases[1].auditTrail[0], scope.audit] }))],
        ["the new audit appended twice", scope => replaceCase(scope, item => ({
            auditTrail: [...item.auditTrail, scope.audit] }))],
        ["the new entry dropped", scope => replaceCase(scope, item => ({ auditTrail: item.auditTrail.slice(0, -1) }))],
        ["the case status", scope => replaceCase(scope, () => ({ status: "APPROVED" }))],
        ["the assigned actor", scope => replaceCase(scope, () => ({ assignedActorId: "synthetic-forged-actor" }))],
        ["the money movement", scope => replaceCase(scope, () => ({ moneyMovement: "PAID" }))],
        ["the order state", scope => { scope.next.state = STATES.COMPLETED; }],
        ["another case changed", scope => {
            scope.next.financialCases[1] = { ...scope.next.financialCases[1], moneyMovement: "PAID" };
        }],
        ["the cases replaced by an equal array", scope => { scope.next.financialCases = [...scope.next.financialCases]; }],
        ["a field added to the order", scope => { scope.next.probeNote = "added"; }]
    ];
    try {
        for (const stage of ["cases", "hash"]) {
            for (const [label, change] of changes) {
                s.calls.length = 0;
                const { error, fired } = await rmWithHook(probe, stage, change,
                    () => aeSend(s, both, aeRecord(both, { n: 1301 })));
                assert.equal(fired, 1, `${stage}: ${label} ran`);
                assert.equal(error?.code, "EVIDENCE_HISTORY_CHANGED", `${stage}: ${label}: ${error?.code ?? error}`);
            }
            // The planned case is frozen before the first suspension point: changing it in place throws.
            const inPlace = await rmWithHook(probe, stage, scope => {
                scope.next.financialCases[0].moneyMovement = "PAID";
            }, () => aeSend(s, both, aeRecord(both, { n: 1301 })));
            assert.equal(inPlace.fired, 1);
            assert.ok(inPlace.error instanceof TypeError, `${stage}: in place`);
        }
        // Nothing of a refused transition was consumed; the clean submission commits exactly the planned transition.
        const added = await aeSend(s, both, aeRecord(both, { n: 1301 }));
        const [item] = added.financialCases;
        const before = both.financialCases[0];
        assert.equal(item.auditTrail.length, before.auditTrail.length + 1);
        assert.equal(item.auditTrail.at(-1), added.events.at(-1).audit, "the new entry is this event's audit");
        assert.equal(item.evidenceReferences.at(-1), item.auditTrail.at(-1).evidence);
        assert.ok(before.auditTrail.every((entry, index) => item.auditTrail[index] === entry));
        assert.deepEqual([item.status, item.assignedActorId, item.moneyMovement, added.state],
            [before.status, before.assignedActorId, before.moneyMovement, both.state]);
        assert.equal(added.financialCases[1], both.financialCases[1]);
        assert.ok(Object.isFrozen(item));
        // An Object.prototype.toJSON that tries to change the case while it is digested changes nothing (A211/G14).
        // (A toJSON that substitutes what is hashed is the open serialization risk R1/R2, FD-212-03; not tested here.)
        Object.defineProperty(Object.prototype, "toJSON", { configurable: true, writable: true, enumerable: false,
            value: function () {
                if (Object.hasOwn(this, "auditTrail") && Object.hasOwn(this, "moneyMovement") && !Object.isFrozen(this)) {
                    this.moneyMovement = "PAID";
                }
                return this;
            } });
        let polluted;
        try {
            polluted = await aeSend(s, added, aeRecord(added, { n: 1302 }));
        } finally {
            delete Object.prototype.toJSON;
        }
        assert.equal(polluted.version, added.version + 1);
        assert.deepEqual(polluted.financialCases.map(entry => entry.moneyMovement), ["NONE", "NONE"]);
    } finally {
        probe.setProbeAwaitHook(null);
    }
});
