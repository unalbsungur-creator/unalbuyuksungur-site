import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createCore, OrderError, PACKAGES, STATES } from "./core.mjs";

const SERVER = Symbol("synthetic-server-session");
const TEST_KEY = "synthetic-fixture-only-not-a-production-secret";
const FIXED_TIME = "2026-10-28T09:00:00.000Z";

function sign(proof) {
    const fields = [proof.orderId, proof.reference, proof.amountKurus, proof.currency,
    proof.status, proof.source];
    return createHmac("sha256", TEST_KEY).update(JSON.stringify(fields)).digest("hex");
}

function setup(overrides = {}) {
    const core = createCore({
        authorize: (principal) => principal.auth === SERVER,
        verifyPayment: (proof) => {
            if (typeof proof.signature !== "string" || !/^[0-9a-f]{64}$/.test(proof.signature)) return false;
            return timingSafeEqual(Buffer.from(proof.signature, "hex"), Buffer.from(sign(proof), "hex"));
        },
        verifyEmail: (proof) => proof.code === "SYNTHETIC-ONE-USE-CODE",
        clock: () => FIXED_TIME,
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
    return { core, actor, send, payment };
}

async function ready(packageId = "START") {
    const h = setup();
    let order = h.core.createOrder(packageId);
    order = await h.send(order, "submit", "customer");
    order = await h.send(order, "verify_payment", "finance", { proof: h.payment(order) });
    order = await h.send(order, "request_email", "customer");
    order = await h.send(order, "verify_email", "customer",
        { proof: { orderId: order.id, code: "SYNTHETIC-ONE-USE-CODE" } });
    order = await h.send(order, "request_booking", "customer");
    order = await h.send(order, "approve_start", "scheduler");
    return { ...h, order };
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
    test(`${packageId}: start clock, exactly two new options per round, max rights and single delivery`, async () => {
        const h = await ready(packageId);
        let order = h.order;
        assert.equal(order.productionStartedAt, null);
        await assert.rejects(h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] }), /INVALID_TRANSITION/);
        order = await h.send(order, "start_production", "creative");
        assert.equal(order.productionStartedAt, FIXED_TIME);
        await assert.rejects(h.send(order, "start_production", "creative"), /INVALID_TRANSITION/);
        await assert.rejects(h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a1"] }), /DUPLICATE_OPTION/);
        order = await h.send(order, "initial_options", "creative", { options: ["synthetic-a1", "synthetic-a2"] });
        for (let round = 1; round <= PACKAGES[packageId].revisions; round++) {
            order = await h.send(order, "request_revision", "customer");
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
    const disputeHarness = await ready();
    const disputed = await disputeHarness.send(disputeHarness.order, "dispute", "customer");
    assert.equal(disputed.state, STATES.DISPUTED);
    await assert.rejects(disputeHarness.send(disputed, "start_production", "creative"), /INVALID_TRANSITION/);
    const reviewHarness = await ready();
    const review = await reviewHarness.send(reviewHarness.order, "refund_review", "finance");
    assert.equal(review.state, STATES.REFUND_REVIEW);
    await assert.rejects(reviewHarness.send(review, "start_production", "creative"), /INVALID_TRANSITION/);
});

test("audit entries are chained, immutable and contain no raw payment or email proof", async () => {
    const h = setup();
    let order = await h.send(h.core.createOrder("START"), "submit", "customer");
    order = await h.send(order, "verify_payment", "finance", { proof: h.payment(order) });
    order = await h.send(order, "request_email", "customer");
    order = await h.send(order, "verify_email", "customer", { proof: { orderId: order.id, code: "SYNTHETIC-ONE-USE-CODE" } });
    assert.equal(order.events.length, order.version);
    for (let i = 0; i < order.events.length; i++) {
        assert.equal(order.events[i].sequence, i + 1);
        assert.equal(order.events[i].previousHash, i ? order.events[i - 1].hash : null);
        assert.match(order.events[i].hash, /^[a-f0-9]{64}$/);
        assert.equal(order.events[i].at, FIXED_TIME);
        assert.ok(Object.isFrozen(order.events[i]));
    }
    assert.ok(!JSON.stringify(order.events).includes("SYNTHETIC-ONE-USE-CODE"));
    assert.ok(!JSON.stringify(order.events).includes("paid_unreversed"));
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
    const production = await ready("START");
    let order = await production.send(production.order, "start_production", "creative");
    order = await production.send(order, "initial_options", "creative", { options: ["synthetic-x1", "synthetic-x2"] });
    for (let i = 0; i < PACKAGES.START.revisions; i++) {
        order = await production.send(order, "request_revision", "customer");
        order = await production.send(order, "revision_options", "creative",
            { options: [`synthetic-x${i + 3}-a`, `synthetic-x${i + 3}-b`] });
    }
    assert.equal(order.options.length, PACKAGES.START.alternatives);
    await assert.rejects(production.send({ ...order, revisionsUsed: 0, options: [] }, "request_revision", "customer"), /REVISION_LIMIT/);
});
