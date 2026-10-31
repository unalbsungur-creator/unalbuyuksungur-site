/* Isolated, in-memory prototype. Never publish this file or treat caller-supplied roles as authentication. */
import { CalendarError, REVISION_OUTCOMES, TARIFFS, evaluateRevisionRequest, isEligible, parseInstant } from "./calendar.mjs";

export const PACKAGES = Object.freeze({
    START: Object.freeze({ priceKurus: 69000, revisions: 3, alternatives: 8 }),
    PLUS: Object.freeze({ priceKurus: 119000, revisions: 5, alternatives: 12 }),
    PREMIUM: Object.freeze({ priceKurus: 229000, revisions: 10, alternatives: 22 })
});

export const STATES = Object.freeze({
    DRAFT: "DRAFT", PAYMENT_PENDING: "PAYMENT_PENDING", PAYMENT_VERIFIED: "PAYMENT_VERIFIED",
    EMAIL_PENDING: "EMAIL_PENDING", EMAIL_VERIFIED: "EMAIL_VERIFIED",
    BOOKING_PENDING: "BOOKING_PENDING", START_APPROVED: "START_APPROVED",
    IN_PRODUCTION: "IN_PRODUCTION", REVISION_PENDING: "REVISION_PENDING",
    FINAL_SELECTED: "FINAL_SELECTED", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED",
    CANCELLATION_REVIEW: "CANCELLATION_REVIEW", REFUND_REVIEW: "REFUND_REVIEW", DISPUTED: "DISPUTED",
    CLOSED: "CLOSED"
});

// Decision B: each review type suspends the order in its own state; revision rights are kept as they are.
const REVIEW_STATES = Object.freeze({
    CANCELLATION: STATES.CANCELLATION_REVIEW, REFUND: STATES.REFUND_REVIEW, DISPUTE: STATES.DISPUTED
});

export const REVIEW_OUTCOMES = Object.freeze({ CONTINUE: "CONTINUE", REFUND: "REFUND", CLOSE: "CLOSE" });

// Paid, not yet completed states; a completed order may still enter a refund or dispute review.
const ACTIVE_STATES = Object.freeze([STATES.PAYMENT_VERIFIED, STATES.EMAIL_PENDING, STATES.EMAIL_VERIFIED,
    STATES.BOOKING_PENDING, STATES.START_APPROVED, STATES.IN_PRODUCTION, STATES.REVISION_PENDING,
    STATES.FINAL_SELECTED]);
// Görev 152 (F151-01): states in which an order can be the surviving original of a duplicate pair.
const LINKED_ORDER_STATES = Object.freeze([...ACTIVE_STATES, STATES.COMPLETED]);

export class OrderError extends Error {
    constructor(code) { super(code); this.name = "OrderError"; this.code = code; }
}

function requireThat(condition, code) {
    if (!condition) throw new OrderError(code);
}

function freezeDeep(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freezeDeep);
        Object.freeze(value);
    }
    return value;
}

function opaque(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

/** Görev 154 (F153-01): a deep, frozen snapshot of the command and the principal. Every field is read exactly once
 * and copied, nested objects included, so neither the caller nor a verifier can change it later. Only plain data is
 * accepted; a principal's symbol values (a server session marker) are kept as they are, since symbols are immutable.
 * A command that cannot be copied is INVALID_COMMAND; a principal that cannot be copied is UNAUTHORIZED. */
function requestContext(command, principal) {
    requireThat(command !== null && typeof command === "object", "INVALID_COMMAND");
    let snapshotCommand;
    try {
        snapshotCommand = structuredClone({ kind: command.kind, requestId: command.requestId,
            expectedVersion: command.expectedVersion, data: command.data || {} });
    } catch {
        throw new OrderError("INVALID_COMMAND");
    }
    let snapshotPrincipal = null;
    if (principal !== null && typeof principal === "object") {
        try {
            snapshotPrincipal = Object.fromEntries(Object.entries(principal).map(([key, value]) =>
                [key, typeof value === "symbol" ? value : structuredClone(value)]));
        } catch {
            throw new OrderError("UNAUTHORIZED");
        }
    }
    return freezeDeep({ command: snapshotCommand, principal: snapshotPrincipal });
}

function pair(value, prior) {
    requireThat(Array.isArray(value) && value.length === 2 && value.every(opaque), "INVALID_PAIR");
    requireThat(value[0] !== value[1] && value.every(id => !prior.includes(id)), "DUPLICATE_OPTION");
    return [...value];
}

async function digest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Decision 140: an instant is an ISO-8601 string with an explicit zone (Z or ±HH:MM) and exact calendar
 * fields, parsed by the calendar's strict parser. Zone-less values are rejected, never read as local time. */
function zonedInstant(value) {
    if (typeof value !== "string") return Number.NaN;
    try {
        return parseInstant(value);
    } catch (error) {
        if (error instanceof CalendarError) return Number.NaN;
        throw error;
    }
}

function instant(value, code) {
    const ms = zonedInstant(value);
    requireThat(Number.isSafeInteger(ms), code);
    return ms;
}

export const PROPOSAL_VISIBILITY = Object.freeze({
    ACTIVE: "ACTIVE", ACCEPTED: "ACCEPTED", REJECTED: "REJECTED", EXPIRED: "EXPIRED"
});

/** Decision 140: the visible state of a delivery-date proposal at a trusted server time `now`. Pure: it never
 * changes the record, writes audit or uses a reference. A record of another order, an unknown status or broken
 * time data fails closed; it is never shown as ACTIVE. Trusted server-side use only. */
export function proposalVisibility(replan, orderId, now) {
    requireThat(replan && typeof replan === "object" && replan.proposal && typeof orderId === "string" &&
        replan.proposal.orderId === orderId && replan.proposal.replanId === replan.replanId, "PROPOSAL_MISMATCH");
    const at = instant(now, "INVALID_CLOCK");
    const created = instant(replan.createdAt, "INVALID_PROPOSAL_TIME");
    const expires = instant(replan.expiresAt, "INVALID_PROPOSAL_TIME");
    requireThat(expires > created, "INVALID_PROPOSAL_TIME");
    switch (replan.status) {
        case "CONFIRMED": return PROPOSAL_VISIBILITY.ACCEPTED;
        case "REJECTED": return PROPOSAL_VISIBILITY.REJECTED;
        case "EXPIRED": return PROPOSAL_VISIBILITY.EXPIRED;
        // At expiresAt itself the proposal is already dead, as in confirm_delivery_date.
        case "PROPOSED": return at < expires ? PROPOSAL_VISIBILITY.ACTIVE : PROPOSAL_VISIBILITY.EXPIRED;
        default: throw new OrderError("INVALID_PROPOSAL_STATUS");
    }
}

function calendarCall(fn) {
    try {
        return fn();
    } catch (error) {
        if (error instanceof CalendarError) throw new OrderError(error.code);
        throw error;
    }
}

/** Shape check for the booking service's confirmed record; authenticity is decided by verifyBooking.
 * The SLA starts at the planned start of this record (PD-01), never at the producer's actual start. */
function bookingRecord(booking, order, paymentVerifiedAt, calendar) {
    requireThat(booking && typeof booking === "object" && booking.orderId === order.id &&
        booking.source === "booking_service" && opaque(booking.bookingId), "BOOKING_MISMATCH");
    requireThat(booking.status === "CONFIRMED", "BOOKING_NOT_CONFIRMED");
    requireThat(Object.hasOwn(TARIFFS, booking.tariff), "INVALID_BOOKING");
    const start = instant(booking.scheduledStart, "INVALID_BOOKING");
    const deadline = booking.deadline == null ? null : instant(booking.deadline, "INVALID_BOOKING");
    // A start before payment verification, a deadline before the start, or a start outside the
    // tariff's production hours cannot belong to a genuinely confirmed booking.
    requireThat(start > paymentVerifiedAt && (deadline === null || deadline > start), "INVALID_BOOKING");
    requireThat(calendarCall(() => isEligible(start, booking.tariff, calendar)), "INVALID_BOOKING");
    const urgent = booking.urgent;
    if (booking.tariff === TARIFFS.URGENT) {
        requireThat(urgent && urgent.surchargeVerified === true && urgent.producerApproved === true &&
            opaque(urgent.surchargeReference), "URGENT_NOT_CLEARED");
    } else {
        requireThat(urgent == null, "INVALID_BOOKING");
    }
    return {
        bookingId: booking.bookingId, tariff: booking.tariff, scheduledStart: new Date(start).toISOString(),
        deadline: deadline === null ? null : new Date(deadline).toISOString(),
        surchargeReference: booking.tariff === TARIFFS.URGENT ? urgent.surchargeReference : null
    };
}

function roleFor(kind, principal) {
    const roles = {
        submit: "customer", verify_payment: "finance", request_email: "customer",
        verify_email: "customer", request_booking: "customer", approve_start: "scheduler",
        start_production: "creative", initial_options: "creative", request_revision: "customer",
        revision_options: "creative", select_final: "customer", complete: "creative",
        cancel: "finance", restore_revision_right: ["creative", "admin"],
        propose_revision_restoration: ["creative", "admin"], decide_revision_restoration: ["creative", "admin"],
        open_review: ["finance", "admin"], resolve_review: ["finance", "admin"],
        propose_delivery_date: ["creative", "admin"], confirm_delivery_date: "customer",
        expire_delivery_proposal: ["creative", "admin"]
    };
    if (!Object.hasOwn(roles, kind)) return null;
    // A multi-role command resolves to the caller's role only when that role is allowed.
    const role = roles[kind];
    return Array.isArray(role) ? (role.includes(principal?.role) ? principal.role : role[0]) : role;
}

const RESTORATION_SOURCES = Object.freeze({ creative: "producer_console", admin: "admin_console" });
const REVIEW_SOURCES = Object.freeze({ finance: "finance_console", admin: "admin_console" });
const CONFIRMATION_SOURCE = "customer_confirmation_service";

/** Decision 135: owner-approved review outcome policy UNAI-REVIEW-POLICY-v1.0, 15 type × role × outcome
 * combinations. REFUND is finance-only; every CLOSE needs an approved reason and evidence (Görev 147,
 * APPROVED_CLOSE_REASONS), which may narrow the CLOSE combinations further. Combinations missing
 * from the active policy fail closed. */
export const APPROVED_REVIEW_POLICY = freezeDeep({
    status: "APPROVED", reference: "UNAI-REVIEW-POLICY-v1.0",
    matrix: Object.fromEntries(Object.keys(REVIEW_STATES).map(type => [type, {
        finance: [REVIEW_OUTCOMES.CONTINUE, REVIEW_OUTCOMES.REFUND, REVIEW_OUTCOMES.CLOSE],
        admin: [REVIEW_OUTCOMES.CONTINUE, REVIEW_OUTCOMES.CLOSE]
    }]))
});

function loadReviewPolicy(policy) {
    // An injected policy may only narrow the approved one: anything outside it is a configuration error,
    // never an extra grant.
    requireThat(policy && typeof policy === "object" && policy.status === "APPROVED" &&
        typeof policy.reference === "string" && policy.reference.length > 0 &&
        policy.matrix && typeof policy.matrix === "object", "INVALID_REVIEW_POLICY");
    const matrix = {};
    for (const [type, roles] of Object.entries(policy.matrix)) {
        requireThat(Object.hasOwn(REVIEW_STATES, type) && roles && typeof roles === "object", "INVALID_REVIEW_POLICY");
        matrix[type] = {};
        for (const [role, outcomes] of Object.entries(roles)) {
            requireThat(Object.hasOwn(REVIEW_SOURCES, role) && Array.isArray(outcomes) &&
                outcomes.every(outcome => APPROVED_REVIEW_POLICY.matrix[type][role].includes(outcome)) &&
                new Set(outcomes).size === outcomes.length, "INVALID_REVIEW_POLICY");
            matrix[type][role] = [...outcomes];
        }
    }
    return freezeDeep({ status: policy.status, reference: policy.reference, matrix });
}

/** Görev 147 (142B, K-05/06/07): owner-approved close reasons UNAI-CLOSE-REASONS-v1.0. Every CLOSE, by finance or
 * admin, names one of these codes and carries evidence of the code's kind. TERMS_VIOLATION and CUSTOMER_UNREACHABLE
 * were removed. A code pending legal review is listed but not usable live; enabling it takes a new policy version.
 * `obligations` are the customer money outcomes a code may close with: any other outcome needs the financial case
 * process (K-01), which does not exist yet, so such a CLOSE is refused. `priorEvidence` admits evidence created
 * before the review opened (external records only). Nothing here is ever widened at run time. */
export const APPROVED_CLOSE_REASONS = freezeDeep({
    status: "APPROVED", reference: "UNAI-CLOSE-REASONS-v1.0",
    codes: {
        DUPLICATE_ORDER: {
            types: ["CANCELLATION", "REFUND"], roles: ["finance"], legalReview: "NOT_REQUIRED",
            evidenceKind: "DUPLICATE_PAYMENT_RECONCILIATION", evidenceSource: "payment_provider_reconciliation",
            priorEvidence: true, obligations: ["NONE", "RESOLVED"], linkedOrder: true, finding: null
        },
        CUSTOMER_WITHDREW_AFTER_SETTLEMENT: {
            types: ["CANCELLATION", "REFUND", "DISPUTE"], roles: ["finance", "admin"], legalReview: "PENDING",
            evidenceKind: "CUSTOMER_CLOSURE_CONFIRMATION", evidenceSource: "customer_confirmation_service",
            priorEvidence: false, obligations: ["NONE"], linkedOrder: false, finding: null
        },
        DISPUTE_RESOLVED_BY_PROVIDER: {
            types: ["DISPUTE"], roles: ["finance", "admin"], legalReview: "NOT_REQUIRED",
            evidenceKind: "PROVIDER_DISPUTE_OUTCOME", evidenceSource: "payment_provider_reconciliation",
            priorEvidence: true, obligations: ["NONE"], linkedOrder: false, finding: null
        },
        // K-07: finance only and only a confirmed finding; a suspicion keeps the review open.
        FRAUD_CONFIRMED: {
            types: ["CANCELLATION", "REFUND", "DISPUTE"], roles: ["finance"], legalReview: "PENDING",
            evidenceKind: "RISK_REVIEW_RECORD", evidenceSource: "risk_review_console",
            priorEvidence: false, obligations: ["NONE"], linkedOrder: false, finding: "CONFIRMED"
        }
    }
});

// The customer money outcome a close evidence states: none, already returned and reconciled, or still owed.
const FINANCIAL_OBLIGATIONS = Object.freeze(["NONE", "RESOLVED", "OPEN"]);
const RISK_FINDINGS = Object.freeze(["CONFIRMED", "SUSPECTED"]);
// The only fields a close evidence reference may carry (`signature` is the evidence service's own, never bound here).
export const CLOSE_EVIDENCE_FIELDS = Object.freeze(["evidenceId", "orderId", "reviewId", "evidenceKind", "source",
    "createdAt", "digest", "financialObligation", "linkedOrderId", "finding", "signature"]);
const EVIDENCE_FIELDS = new Set(CLOSE_EVIDENCE_FIELDS);

/** Shape and binding of a close evidence reference. This is no proof that the evidence is genuine: only the
 * server's evidence service can tell, through verifyEvidence. The content itself never enters the core. */
function closeEvidence(evidence, rule, order, review) {
    requireThat(evidence && typeof evidence === "object", "EVIDENCE_REQUIRED");
    requireThat(Object.keys(evidence).every(key => EVIDENCE_FIELDS.has(key)) && opaque(evidence.evidenceId) &&
        evidence.orderId === order.id && evidence.reviewId === review.reviewId &&
        typeof evidence.digest === "string" && /^[0-9a-f]{64}$/.test(evidence.digest) &&
        Number.isSafeInteger(zonedInstant(evidence.createdAt)) &&
        FINANCIAL_OBLIGATIONS.includes(evidence.financialObligation), "EVIDENCE_MISMATCH");
    requireThat(evidence.evidenceKind === rule.evidenceKind && evidence.source === rule.evidenceSource,
        "EVIDENCE_KIND_NOT_ALLOWED");
    // DUPLICATE_ORDER names the other order of the pair; no other code may carry one.
    requireThat(rule.linkedOrder ? typeof evidence.linkedOrderId === "string" &&
        opaque(evidence.linkedOrderId.replaceAll("-", "")) && evidence.linkedOrderId !== order.id
        : evidence.linkedOrderId === undefined, "EVIDENCE_MISMATCH");
    requireThat(rule.finding ? RISK_FINDINGS.includes(evidence.finding) : evidence.finding === undefined,
        "EVIDENCE_MISMATCH");
}

/** Görev 150 (F-03): the exact field set a CLOSE authorization signature must cover, in a fixed order. The core
 * hands this binding to verifyReview, which must confirm the console signature over exactly this value. Any field
 * changed after signing changes the binding, so the signature no longer matches. Exported for the server adapter.
 * Görev 152 (F151-07): the binding is built from CLOSE_DECISION_FIELDS alone, so tests can prove every field of
 * it, and that no decision or evidence field is left out, from the same list. */
export const CLOSE_DECISION_FIELDS = Object.freeze(["orderId", "reviewId", "outcome", "reasonCode", "closeReasonPolicy",
    "authorizationRef", "source", "actorId", "evidence.evidenceId", "evidence.evidenceKind", "evidence.source",
    "evidence.orderId", "evidence.reviewId", "evidence.createdAt", "evidence.digest", "evidence.financialObligation",
    "evidence.linkedOrderId", "evidence.finding"]);

export function closeDecisionBinding(record) {
    return JSON.stringify(["UNAI-CLOSE-DECISION-v1", ...CLOSE_DECISION_FIELDS.map(path =>
        path.split(".").reduce((value, key) => (value !== null && typeof value === "object" && Object.hasOwn(value, key)
            ? value[key] : undefined), record) ?? null)]);
}

// Görev 150 (F-01): every field the evidence service must attest, each equal to the core's request. A bare `true`,
// a missing field or any differing value is a refusal.
const ATTESTED_FIELDS = Object.freeze(["evidenceId", "evidenceKind", "source", "orderId", "reviewId", "createdAt",
    "digest", "financialObligation", "linkedOrderId", "finding", "closeReasonPolicy", "reasonCode", "decision",
    "decisionBinding"]);
const EVIDENCE_VERIFIER_KINDS = Object.freeze(["PRODUCTION", "SYNTHETIC"]);
const DEPLOYMENT_ENVIRONMENTS = Object.freeze(["PRODUCTION", "STAGING", "TEST"]);

/** Görev 159 (K-01 Faz 1): financial cases, creation only. A REFUND opens an ORDER_REFUND case; accepted, undelivered
 * revisions open one UNDELIVERED_REVISION case over their assessments. Cases are opened inside the deciding
 * transaction, start OPEN and carry no amount: approving, closing, paying and reconciling come in later phases. */
export const FINANCIAL_CASE_POLICY = freezeDeep({
    reference: "UNAI-FINANCIAL-CASE-v1.0", types: ["ORDER_REFUND", "UNDELIVERED_REVISION"]
});

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
// Decision 141: SYSTEM is not a role and no principal can claim it. It only labels the narrow automatic
// step the core itself performs (closing an elapsed proposal when a new one is made).
const SYSTEM_ACTOR_ID = "SYSTEM";
const RESERVED_ACTOR = /^system(?:[^a-z0-9]|$)/i;
const PROPOSAL_LIFETIME_MS = 48 * 60 * 60 * 1000; // Decision 135: elapsed time, not working hours

function permittedOutcomes(policy, type, role) {
    return Object.hasOwn(policy.matrix, type) && Object.hasOwn(policy.matrix[type], role)
        ? policy.matrix[type][role] : [];
}

function revisionId(sequence) {
    return `revision-${String(sequence).padStart(4, "0")}`;
}

/** Server-only interface: authorize(principal, canonicalOrder, role) and
 * verifyPayment(proof, canonicalOrder) must return true only after authenticated
 * seller-side reconciliation (including order/amount/currency/status/ref).
 * verifyBooking(record, canonicalOrder) must return true only for a record read from the
 * authoritative booking service (confirmed slot, and for URGENT the verified surcharge and
 * producer approval). `calendar` is a loadCalendar() result used for revision timing and
 * production hours. verifyRestoration(record, canonicalOrder) must return true only for a
 * producer/admin console record: a RESTORATION_PROPOSAL that the producer failed to deliver an accepted
 * revision, with its evidence, or a RESTORATION_DECISION by another person on that proposal.
 * verifyReview(record, canonicalOrder) must return true only for a finance/admin console record that
 * opens a cancellation, refund or dispute review, or that resolves the open review. For a CLOSE it is called as
 * verifyReview(record, canonicalOrder, { binding }) and must return { verified: true, binding } only after checking
 * the console signature over exactly that closeDecisionBinding(record) value; a bare `true` is refused (Görev 150,
 * F-03). A REFUND outcome is a recorded decision only; this core never moves money.
 * verifyEvidence(evidence, request, canonicalOrder) is the server's evidence service (Görev 150, F-01). It must
 * look the evidence up in its own store and return an attestation { status: "VERIFIED", verifier: { kind, id },
 * ...fields } that states, from its own records, every ATTESTED_FIELDS value of `request`: evidence id, kind,
 * source, order, review, creation time (UTC), content digest, money outcome, linked order and fraud finding (null
 * where not applicable), and that it vouches for this evidence under the given close-reason policy, reason code,
 * decision and decision binding. Anything else, including `true`, is a refusal (UNTRUSTED_EVIDENCE); without the
 * service every CLOSE is refused (CLOSE_EVIDENCE_UNVERIFIABLE). A verifier of kind SYNTHETIC is refused unless the
 * core was created with allowSyntheticEvidence: true AND environment: "TEST" (Görev 152, F151-04). Both come from the
 * server's own configuration, never from a command or principal. A missing environment is PRODUCTION; an unknown one,
 * or the flag outside TEST, stops the core from being created. `reviewPolicy` is the active review
 * outcome matrix (default APPROVED_REVIEW_POLICY; an injected one may only narrow it). For review,
 * restoration, delivery-proposal and manual expiry commands authorize() must also bind principal.actorId to
 * the authenticated session: that id is the trusted actor identity for the audit and the four-eyes rules,
 * never a value taken from the request body. No principal may carry a SYSTEM-shaped id.
 * verifyReplan(record, canonicalOrder) must return true
 * only for a producer/admin console delivery-date proposal, or for a customer confirmation that the
 * server's confirmation service recorded for exactly this order, proposal and date.
 * No callback may trust browser claims. No Shopier, booking or notification adapter is provided.
 * Notifications are only recorded as PENDING_OUTBOX entries in this in-memory prototype;
 * nothing is sent, and the event log is not a persistent or tamper-proof audit store.
 * Never expose this core instance or its callbacks to a client.
 */
export function createCore({ authorize, verifyPayment, verifyEmail, verifyBooking, verifyRestoration, verifyReview,
    verifyReplan, verifyEvidence, allowSyntheticEvidence = false, environment = "PRODUCTION",
    reviewPolicy = APPROVED_REVIEW_POLICY, calendar, clock = () => new Date().toISOString() } = {}) {
    requireThat(typeof clock === "function", "INVALID_CLOCK");
    // Görev 152 (F151-04): synthetic evidence is a test-fixture facility. It is refused at creation anywhere but an
    // explicitly declared TEST environment, so a production or staging core can never be started with it.
    requireThat(DEPLOYMENT_ENVIRONMENTS.includes(environment), "INVALID_ENVIRONMENT");
    requireThat(allowSyntheticEvidence !== true || environment === "TEST", "SYNTHETIC_EVIDENCE_NOT_ALLOWED");
    const syntheticEvidence = allowSyntheticEvidence === true && environment === "TEST";
    const policy = loadReviewPolicy(reviewPolicy);
    // Decision 140: every trusted time is validated and stored as UTC ISO; a zone-less clock value is refused.
    const serverTime = () => new Date(instant(clock(), "INVALID_CLOCK")).toISOString();
    const notBefore = (order, time) => {
        // Decision 140: trusted time never runs backwards against the order's last recorded event.
        const last = order.events.at(-1);
        requireThat(!last || Date.parse(time) >= Date.parse(last.at), "CLOCK_REGRESSION");
    };
    // The private registry is the only authority for state. External snapshots are ID handles,
    // not persisted records. A new process has no authority to restore them and fails closed.
    const orders = new Map();
    const paymentReferences = new Map();
    const restorationReferences = new Map();
    const reviewReferences = new Map();
    const replanReferences = new Map();
    const evidenceReferences = new Map();

    function createOrder(packageId) {
        requireThat(Object.hasOwn(PACKAGES, packageId), "INVALID_PACKAGE");
        const order = freezeDeep({
            id: globalThis.crypto.randomUUID(), packageId, state: STATES.DRAFT,
            version: 0, events: [], paymentReference: null, booking: null, slaStartsAt: null, productionStartedAt: null,
            options: [], revisionsUsed: 0, revisions: [], restorations: [], notifications: [], reviews: [], selectedOption: null,
            delivery: null, replannedDeadline: null, deliveryReplans: [], financialAssessments: [], financialCases: []
        });
        orders.set(order.id, order);
        return order;
    }

    async function dispatch(snapshot, untrustedCommand, untrustedPrincipal) {
        requireThat(snapshot && typeof snapshot.id === "string" && opaque(snapshot.id.replaceAll("-", "")), "INVALID_ORDER");
        const order = orders.get(snapshot.id);
        requireThat(order, "UNKNOWN_ORDER");
        requireThat(snapshot.packageId === order.packageId, "INVALID_ORDER");
        // Görev 154 (F153-01): the one trusted context of this dispatch, taken before the first await. Authorization,
        // four eyes, idempotency, execution, events and audit all read this snapshot; the caller's objects are never
        // read again, so changing them while a verifier is awaited changes nothing.
        const { command, principal } = requestContext(untrustedCommand, untrustedPrincipal);
        requireThat(opaque(command.requestId), "INVALID_COMMAND");
        const requiredRole = roleFor(command.kind, principal);
        requireThat(typeof requiredRole === "string", "UNKNOWN_ACTION");
        // The server adapter must authenticate the principal; a browser-provided role is never trusted.
        requireThat(principal && principal.role === requiredRole &&
            (requiredRole !== "customer" || principal.orderId === order.id), "UNAUTHORIZED");
        requireThat(typeof authorize === "function" && await authorize(principal, order, requiredRole) === true,
            "UNAUTHORIZED");
        requireThat(orders.get(order.id) === order, "VERSION_CONFLICT");
        // Görev 152 (F151-02): the request data is part of the deep, frozen snapshot above, never a second copy.
        const data = command.data;
        const payment = data.proof;
        // Only the fingerprint is logged; no raw proof or contact is persisted.
        const intent = [command.kind, data.options, data.selectedOption, data.mp3Ref,
        data.wavRef, data.wavFeasible, data.proof, data.booking, data.revisionId, data.restoration, data.review,
        data.resolution, data.proposal, data.confirmation, data.restorationId, data.decision];
        const fingerprint = await digest(intent);
        const prior = order.events.find(event => event.requestId === command.requestId);
        if (prior) {
            requireThat(prior.fingerprint === fingerprint && prior.kind === command.kind, "IDEMPOTENCY_CONFLICT");
            return order; // Retried request: no second revision, payment or clock start.
        }
        // A notification with a NEW request ID but the SAME verified reference is also a no-op.
        // The verifier must confirm it again; a caller's reference alone cannot assert payment.
        if (command.kind === "verify_payment" && order.paymentReference === payment?.reference) {
            requireThat(payment.orderId === order.id && opaque(payment.reference) &&
                payment.source === "seller_reconciliation" && payment.status === "paid_unreversed" &&
                payment.currency === "TRY" && payment.amountKurus === PACKAGES[order.packageId].priceKurus,
                "PAYMENT_MISMATCH");
            requireThat(typeof verifyPayment === "function" && await verifyPayment(payment, order) === true,
                "UNTRUSTED_PAYMENT");
            requireThat(orders.get(order.id) === order, "VERSION_CONFLICT");
            return order;
        }
        requireThat(Number.isSafeInteger(command.expectedVersion) && command.expectedVersion === order.version,
            "VERSION_CONFLICT");
        // Decision B: an open review suspends every other command until an authorized resolution.
        const openReview = order.reviews.findLast(review => review.status === "OPEN");
        requireThat(!openReview || command.kind === "resolve_review", "REVIEW_IN_PROGRESS");
        const next = {
            ...order, options: [...order.options], events: [...order.events],
            revisions: [...order.revisions], notifications: [...order.notifications], reviews: [...order.reviews],
            deliveryReplans: [...order.deliveryReplans], financialAssessments: [...order.financialAssessments],
            restorations: [...order.restorations], financialCases: [...order.financialCases]
        };
        const inState = (...states) => requireThat(states.includes(order.state), "INVALID_TRANSITION");
        // Trusted server time for the transition; commands that read the clock fix it here once.
        let at = null;
        let audit = null;
        let restorationRef = null;
        let reviewRef = null;
        let replanRef = null;
        let evidenceRef = null;
        let linkedOrder = null;
        const openRevision = () => order.revisions.findLast(revision => revision.status === "ACCEPTED");
        // Accepted, undelivered revisions: each needs a financial assessment when the order closes (Decision 134-B).
        const undeliveredRevisions = () => order.revisions.filter(revision => revision.status === "ACCEPTED");
        // Decision 134-A: a customer-confirmed new date supersedes, but never overwrites, the booked deadline.
        const effectiveDeadline = () => order.replannedDeadline ?? order.booking?.deadline ?? null;
        const requireLiveDeadline = () => {
            // After a review, time-bound work waits for a confirmed new commitment once the current one has passed.
            at ??= serverTime();
            const due = effectiveDeadline();
            requireThat(order.reviews.length === 0 || due === null || Date.parse(due) > instant(at, "INVALID_CLOCK"),
                "DELIVERY_REPLAN_REQUIRED");
        };
        const replanStates = [STATES.START_APPROVED, STATES.IN_PRODUCTION, STATES.REVISION_PENDING, STATES.FINAL_SELECTED];
        // Decision 141 (K-08): a verified person. The id comes from the authenticated principal, never from the
        // request body, and an id shaped like the reserved SYSTEM actor is refused.
        const requireHumanActor = () => {
            requireThat(opaque(principal.actorId), "ACTOR_REQUIRED");
            requireThat(!RESERVED_ACTOR.test(principal.actorId), "RESERVED_ACTOR");
        };
        const humanActor = () => ({ actorId: principal.actorId, actorType: "HUMAN", role: principal.role });
        const expire = (replan, actor) => ({
            ...replan, status: "EXPIRED", expiry: {
                orderId: order.id, replanId: replan.replanId, expiredAt: replan.expiresAt, recordedAt: at,
                recordedBy: command.kind, ...actor, idempotencyKey: command.requestId
            }
        });
        const checkedDeadline = (value, now) => {
            const due = instant(value, "INVALID_PROPOSAL");
            requireThat(due > now, "DEADLINE_IN_PAST");
            // The last minute before the deadline must be working time of the order's tariff in the approved calendar.
            requireThat(calendarCall(() => isEligible(due - 1, order.booking.tariff, calendar)), "DEADLINE_NOT_ELIGIBLE");
            return new Date(due).toISOString();
        };
        switch (command.kind) {
            case "submit": inState(STATES.DRAFT); next.state = STATES.PAYMENT_PENDING; break;
            case "verify_payment":
                inState(STATES.PAYMENT_PENDING);
                requireThat(payment && payment.orderId === order.id && opaque(payment.reference) &&
                    payment.source === "seller_reconciliation" && payment.status === "paid_unreversed" &&
                    payment.currency === "TRY" && payment.amountKurus === PACKAGES[order.packageId].priceKurus,
                    "PAYMENT_MISMATCH");
                requireThat(typeof verifyPayment === "function" && await verifyPayment(payment, order) === true,
                    "UNTRUSTED_PAYMENT");
                requireThat(!paymentReferences.has(payment.reference) || paymentReferences.get(payment.reference) === order.id,
                    "PAYMENT_REFERENCE_USED");
                next.paymentReference = payment.reference;
                next.state = STATES.PAYMENT_VERIFIED;
                break;
            case "request_email": inState(STATES.PAYMENT_VERIFIED); next.state = STATES.EMAIL_PENDING; break;
            case "verify_email":
                inState(STATES.EMAIL_PENDING);
                requireThat(typeof verifyEmail === "function" && data.proof &&
                    data.proof.orderId === order.id && await verifyEmail(data.proof, order) === true,
                    "UNTRUSTED_EMAIL");
                next.state = STATES.EMAIL_VERIFIED;
                break;
            case "request_booking": inState(STATES.EMAIL_VERIFIED); next.state = STATES.BOOKING_PENDING; break;
            case "approve_start": {
                inState(STATES.BOOKING_PENDING);
                const paidAt = order.events.find(event => event.kind === "verify_payment" &&
                    event.to === STATES.PAYMENT_VERIFIED);
                requireThat(paidAt && order.paymentReference, "PAYMENT_NOT_VERIFIED");
                const record = bookingRecord(data.booking, order, Date.parse(paidAt.at), calendar);
                requireThat(typeof verifyBooking === "function" && await verifyBooking(data.booking, order) === true,
                    "UNTRUSTED_BOOKING");
                requireThat(record.surchargeReference === null || !paymentReferences.has(record.surchargeReference),
                    "PAYMENT_REFERENCE_USED");
                next.booking = record;
                next.slaStartsAt = record.scheduledStart;
                next.state = STATES.START_APPROVED;
                break;
            }
            case "start_production": {
                inState(STATES.START_APPROVED);
                // Defence in depth: START_APPROVED is only reachable through these checks.
                requireThat(order.paymentReference && order.booking && order.slaStartsAt, "BOOKING_NOT_CONFIRMED");
                requireThat(order.booking.tariff !== TARIFFS.URGENT || order.booking.surchargeReference,
                    "URGENT_NOT_CLEARED");
                // Early or late, the actual start is recorded separately; slaStartsAt and the committed
                // deadline never move. Work may only start inside the tariff's production hours.
                next.productionStartedAt = serverTime();
                const startedAt = instant(next.productionStartedAt, "INVALID_CLOCK");
                requireThat(calendarCall(() => isEligible(startedAt, order.booking.tariff, calendar)),
                    "OUTSIDE_PRODUCTION_HOURS");
                at = next.productionStartedAt;
                next.state = STATES.IN_PRODUCTION;
                break;
            }
            case "initial_options":
                inState(STATES.IN_PRODUCTION);
                requireLiveDeadline();
                requireThat(order.options.length === 0, "ALREADY_PUBLISHED");
                next.options = pair(data.options, order.options);
                break;
            case "request_revision": {
                // A valid request is accepted automatically (PDR-26); acceptance and right consumption
                // are one transition (PD-10). No producer approval is required.
                inState(STATES.IN_PRODUCTION);
                requireThat(order.booking && order.booking.deadline, "DEADLINE_UNAVAILABLE");
                requireLiveDeadline();
                const timing = calendarCall(() => evaluateRevisionRequest({
                    deadline: Date.parse(effectiveDeadline()), evaluatedAt: instant(at, "INVALID_CLOCK"),
                    tariff: order.booking.tariff, calendar, relatedOrderId: order.id
                }));
                // At or after the deadline: routed to new-order review; this order and its rights stay untouched.
                requireThat(timing.outcome !== REVISION_OUTCOMES.NEW_ORDER_REVIEW_REQUIRED, "NEW_ORDER_REVIEW_REQUIRED");
                requireThat(order.options.length >= 2 && order.revisionsUsed < PACKAGES[order.packageId].revisions,
                    "REVISION_LIMIT");
                next.revisionsUsed += 1;
                if (timing.extended && order.replannedDeadline) {
                    next.replannedDeadline = new Date(timing.deadline).toISOString();
                } else if (timing.extended) {
                    next.booking = { ...order.booking, deadline: new Date(timing.deadline).toISOString() };
                }
                const id = revisionId(order.revisions.length + 1);
                next.revisions.push({
                    revisionId: id, status: "ACCEPTED", acceptedAt: at, acceptRequestId: command.requestId,
                    deliveredAt: null, restoration: null
                });
                // The producer notice is an outbox entry with a stable logical id; it is not a delivery claim,
                // and a later dispatch failure cannot undo the acceptance committed here.
                next.notifications.push({
                    notificationId: await digest(["REVISION_ACCEPTED", order.id, id]), kind: "REVISION_ACCEPTED",
                    recipient: "PRODUCER", orderId: order.id, revisionId: id, createdAt: at, dispatch: "PENDING_OUTBOX"
                });
                next.state = STATES.REVISION_PENDING;
                break;
            }
            case "revision_options": {
                inState(STATES.REVISION_PENDING);
                requireLiveDeadline();
                const open = openRevision();
                requireThat(open, "UNKNOWN_REVISION");
                // Delivering alternatives completes the accepted round; it never changes the right count.
                next.options.push(...pair(data.options, order.options));
                requireThat(next.options.length === 2 + 2 * order.revisionsUsed &&
                    next.options.length <= PACKAGES[order.packageId].alternatives, "ALTERNATIVE_LIMIT");
                next.revisions = order.revisions.map(revision => revision === open
                    ? { ...revision, status: "DELIVERED", deliveredAt: at } : revision);
                next.state = STATES.IN_PRODUCTION;
                break;
            }
            case "restore_revision_right":
                // Decision 141 (K-08): the single-person restoration is closed; it must go through
                // propose_revision_restoration and a second person's decide_revision_restoration.
                throw new OrderError("RESTORATION_REQUIRES_APPROVAL");
            case "propose_revision_restoration": {
                // PDR-27 eligibility, unchanged: an accepted, undelivered revision the producer could not deliver.
                // IN_PRODUCTION is admitted only to report delivered/restored revisions precisely; it has no open one.
                inState(STATES.REVISION_PENDING, STATES.IN_PRODUCTION);
                requireHumanActor();
                const record = data.restoration;
                requireThat(record && typeof record === "object" && record.kind === "RESTORATION_PROPOSAL" &&
                    record.orderId === order.id && record.revisionId === data.revisionId &&
                    record.source === RESTORATION_SOURCES[principal.role] && record.actorId === principal.actorId,
                    "RESTORATION_MISMATCH");
                const target = order.revisions.find(revision => revision.revisionId === data.revisionId);
                requireThat(target, "UNKNOWN_REVISION");
                requireThat(target.status !== "RESTORED", "ALREADY_RESTORED");
                requireThat(target.status !== "DELIVERED", "REVISION_ALREADY_DELIVERED");
                requireThat(target === openRevision(), "UNKNOWN_REVISION");
                requireThat(record.reasonCode === "PRODUCER_NON_DELIVERY" && opaque(record.authorizationRef) &&
                    opaque(record.evidenceRef), "INVALID_RESTORATION");
                requireThat(!order.restorations.some(item => item.revisionId === target.revisionId &&
                    item.status === "PENDING_APPROVAL"), "RESTORATION_PENDING");
                requireThat(typeof verifyRestoration === "function" &&
                    await verifyRestoration(record, order) === true, "UNTRUSTED_RESTORATION");
                requireThat(!restorationReferences.has(record.authorizationRef), "RESTORATION_REFERENCE_USED");
                requireThat(order.revisionsUsed >= 1, "REVISION_LIMIT");
                at = serverTime();
                restorationRef = record.authorizationRef;
                const id = `restoration-${String(order.restorations.length + 1).padStart(4, "0")}`;
                audit = {
                    orderId: order.id, restorationId: id, revisionId: target.revisionId, step: "PROPOSAL",
                    reasonCode: record.reasonCode, evidenceRef: record.evidenceRef, ...humanActor(),
                    authorizationRef: record.authorizationRef, at, idempotencyKey: command.requestId
                };
                // A proposal changes no right and no revision: only the decision of a second person can.
                next.restorations.push({
                    restorationId: id, revisionId: target.revisionId, status: "PENDING_APPROVAL", proposal: audit,
                    decision: null
                });
                break;
            }
            case "decide_revision_restoration": {
                inState(STATES.REVISION_PENDING, STATES.IN_PRODUCTION);
                requireHumanActor();
                const pending = order.restorations.find(item => item.restorationId === data.restorationId);
                requireThat(pending, "UNKNOWN_RESTORATION");
                requireThat(pending.status === "PENDING_APPROVAL", "RESTORATION_NOT_PENDING");
                const record = data.decision;
                // The decision re-asserts the proposal's order, revision and evidence under its own signature.
                requireThat(record && typeof record === "object" && record.kind === "RESTORATION_DECISION" &&
                    record.orderId === order.id && record.restorationId === pending.restorationId &&
                    record.revisionId === pending.revisionId && record.evidenceRef === pending.proposal.evidenceRef &&
                    ["APPROVE", "REJECT"].includes(record.decision) &&
                    record.source === RESTORATION_SOURCES[principal.role] && record.actorId === principal.actorId &&
                    opaque(record.authorizationRef) && (record.reasonCode == null || REASON_CODE.test(record.reasonCode)),
                    "RESTORATION_MISMATCH");
                requireThat(record.decision === "APPROVE" || record.reasonCode != null, "REJECTION_REASON_REQUIRED");
                // Four eyes: the proposer never decides, whatever role they use.
                requireThat(principal.actorId !== pending.proposal.actorId, "FOUR_EYES_VIOLATION");
                requireThat(typeof verifyRestoration === "function" &&
                    await verifyRestoration(record, order) === true, "UNTRUSTED_RESTORATION");
                requireThat(!restorationReferences.has(record.authorizationRef), "RESTORATION_REFERENCE_USED");
                const target = order.revisions.find(revision => revision.revisionId === pending.revisionId);
                const approve = record.decision === "APPROVE";
                if (approve) {
                    // Still eligible at approval time: accepted, undelivered and the open revision.
                    requireThat(target.status === "ACCEPTED" && target === openRevision(), "RESTORATION_NOT_ELIGIBLE");
                    requireThat(order.revisionsUsed >= 1, "REVISION_LIMIT");
                }
                at = serverTime();
                restorationRef = record.authorizationRef;
                audit = {
                    orderId: order.id, restorationId: pending.restorationId, revisionId: pending.revisionId,
                    step: "DECISION", decision: record.decision, reasonCode: record.reasonCode ?? null,
                    evidenceRef: record.evidenceRef, ...humanActor(), authorizationRef: record.authorizationRef, at,
                    idempotencyKey: command.requestId
                };
                next.restorations = order.restorations.map(item => item === pending
                    ? { ...item, status: approve ? "APPROVED" : "REJECTED", decision: audit } : item);
                if (approve) {
                    next.revisionsUsed -= 1;
                    next.revisions = order.revisions.map(revision => revision === target
                        ? { ...revision, status: "RESTORED", restoration: { proposal: pending.proposal, approval: audit } }
                        : revision);
                    next.state = STATES.IN_PRODUCTION;
                }
                break;
            }
            case "select_final":
                inState(STATES.IN_PRODUCTION);
                requireThat(order.options.includes(data.selectedOption), "UNKNOWN_OPTION");
                next.selectedOption = data.selectedOption;
                next.state = STATES.FINAL_SELECTED;
                break;
            case "complete":
                inState(STATES.FINAL_SELECTED);
                requireLiveDeadline();
                requireThat(opaque(data.mp3Ref) && typeof data.wavFeasible === "boolean" &&
                    (data.wavFeasible ? opaque(data.wavRef) : data.wavRef == null), "INVALID_DELIVERY");
                next.delivery = {
                    selectedOption: order.selectedOption, mp3Ref: data.mp3Ref,
                    wavRef: data.wavFeasible ? data.wavRef : null, commercialRights: false
                };
                next.state = STATES.COMPLETED;
                break;
            case "cancel":
                // Once production has started, cancellation goes through a CANCELLATION review instead.
                inState(STATES.DRAFT, STATES.PAYMENT_PENDING, STATES.PAYMENT_VERIFIED, STATES.EMAIL_PENDING,
                    STATES.EMAIL_VERIFIED, STATES.BOOKING_PENDING, STATES.START_APPROVED);
                next.state = STATES.CANCELLED;
                break;
            case "open_review": {
                // The actor id comes from the authenticated principal; the signed record must name the same actor.
                requireHumanActor();
                const record = data.review;
                requireThat(record && typeof record === "object" && record.orderId === order.id &&
                    Object.hasOwn(REVIEW_STATES, record.type) && record.source === REVIEW_SOURCES[principal.role] &&
                    record.actorId === principal.actorId && opaque(record.authorizationRef), "INVALID_REVIEW");
                if (record.type === "CANCELLATION") inState(...ACTIVE_STATES);
                else inState(...ACTIVE_STATES, STATES.COMPLETED);
                requireThat(permittedOutcomes(policy, record.type, principal.role).length > 0, "REVIEW_NOT_PERMITTED");
                requireThat(typeof verifyReview === "function" && await verifyReview(record, order) === true,
                    "UNTRUSTED_REVIEW");
                requireThat(!reviewReferences.has(record.authorizationRef), "REVIEW_REFERENCE_USED");
                at = serverTime();
                reviewRef = record.authorizationRef;
                const id = `review-${String(order.reviews.length + 1).padStart(4, "0")}`;
                audit = {
                    orderId: order.id, reviewId: id, type: record.type, ...humanActor(),
                    authorizationRef: record.authorizationRef, at, policyReference: policy.reference,
                    idempotencyKey: command.requestId
                };
                // Rights, revisions, SLA start and deadline are left untouched; only the state is suspended.
                next.reviews.push({
                    reviewId: id, type: record.type, status: "OPEN", resumeState: order.state, opening: audit,
                    resolution: null
                });
                next.state = REVIEW_STATES[record.type];
                break;
            }
            case "resolve_review": {
                requireThat(openReview, "INVALID_TRANSITION");
                requireHumanActor();
                const record = data.resolution;
                requireThat(record && typeof record === "object" && record.orderId === order.id &&
                    record.reviewId === openReview.reviewId && Object.hasOwn(REVIEW_OUTCOMES, record.outcome) &&
                    record.source === REVIEW_SOURCES[principal.role] && record.actorId === principal.actorId &&
                    opaque(record.authorizationRef) && (record.reasonCode == null || REASON_CODE.test(record.reasonCode)),
                    "INVALID_REVIEW");
                // Decision 135: four eyes. The actor who opened the review never decides it, whatever their role.
                requireThat(principal.actorId !== openReview.opening.actorId, "FOUR_EYES_VIOLATION");
                // Decision 134-C / 135: the type, role and outcome are each valid; the combination must be in the policy.
                requireThat(permittedOutcomes(policy, openReview.type, principal.role).includes(record.outcome),
                    "REVIEW_OUTCOME_NOT_PERMITTED");
                const closing = record.outcome === REVIEW_OUTCOMES.CLOSE;
                const rule = closing ? APPROVED_CLOSE_REASONS.codes[record.reasonCode] : null;
                let verifier = null;
                if (closing) {
                    // Görev 148 (D-3): an undelivered revision right needs a financial assessment, which only the
                    // financial case process (K-01) can settle. Until it exists such an order cannot be closed. The
                    // canonical order decides, never the request; the review stays open and nothing is consumed.
                    requireThat(undeliveredRevisions().length === 0, "FINANCIAL_CASE_REQUIRED");
                    // Görev 147 (K-06): every CLOSE, by finance or admin, names an approved code for this review
                    // type and role and carries evidence of that code's kind, bound to this order and review.
                    requireThat(record.reasonCode != null, "CLOSE_REASON_REQUIRED");
                    requireThat(record.closeReasonPolicy === APPROVED_CLOSE_REASONS.reference,
                        "CLOSE_REASON_POLICY_MISMATCH");
                    requireThat(Object.hasOwn(APPROVED_CLOSE_REASONS.codes, record.reasonCode), "CLOSE_REASON_UNKNOWN");
                    requireThat(rule.types.includes(openReview.type), "CLOSE_REASON_NOT_FOR_TYPE");
                    requireThat(rule.roles.includes(principal.role), "CLOSE_REASON_ROLE_NOT_PERMITTED");
                    closeEvidence(record.evidence, rule, order, openReview);
                    requireThat(!rule.finding || record.evidence.finding === rule.finding, "CLOSE_FINDING_NOT_CONFIRMED");
                    // Görev 146 F-12: a close that leaves money owed to, or returned to, the customer waits for the
                    // financial case process. It is refused, never shown as settled.
                    requireThat(rule.obligations.includes(record.evidence.financialObligation), "FINANCIAL_CASE_REQUIRED");
                    // Decision D-1: only external records may predate the review. Judged against the canonical review
                    // opening, so it holds before any legal gate opens.
                    requireThat(rule.priorEvidence || zonedInstant(record.evidence.createdAt) >=
                        Date.parse(openReview.opening.at), "EVIDENCE_STALE");
                    if (rule.linkedOrder) {
                        // Görev 150 (F-02, D-4): the other order of the pair is checked in the core's own registry,
                        // never taken on the request's word: it exists, was paid, and was not itself closed as the
                        // duplicate. It must still be the same record when the decision commits.
                        // Görev 152 (F151-01): a payment reference alone proves nothing about what became of the
                        // money. The surviving order must still stand: paid and live or completed, never cancelled,
                        // closed or itself under a cancellation, refund or dispute review.
                        linkedOrder = orders.get(record.evidence.linkedOrderId) ?? null;
                        requireThat(linkedOrder, "LINKED_ORDER_NOT_FOUND");
                        requireThat(LINKED_ORDER_STATES.includes(linkedOrder.state) && linkedOrder.paymentReference !== null &&
                            !linkedOrder.reviews.some(review => review.resolution?.reasonCode === "DUPLICATE_ORDER"),
                            "LINKED_ORDER_INVALID");
                    }
                    requireThat(rule.legalReview === "NOT_REQUIRED", "CLOSE_REASON_PENDING_LEGAL_REVIEW");
                    // Without a trusted evidence service a well-formed reference proves nothing: blocked.
                    requireThat(typeof verifyEvidence === "function", "CLOSE_EVIDENCE_UNVERIFIABLE");
                }
                // Görev 150 (F-03): for a CLOSE the signature must be confirmed over the full decision binding.
                const binding = closing ? closeDecisionBinding(record) : null;
                const signed = typeof verifyReview === "function"
                    ? await verifyReview(record, order, ...(closing ? [{ binding }] : [])) : null;
                requireThat(closing ? signed !== null && typeof signed === "object" && signed.verified === true &&
                    signed.binding === binding : signed === true, "UNTRUSTED_REVIEW");
                requireThat(closing || (record.evidence === undefined && record.closeReasonPolicy === undefined),
                    "INVALID_REVIEW");
                if (closing) {
                    // Görev 150 (F-01): the evidence service states every field from its own records. Signature and
                    // evidence stay separate checks: a valid signature never vouches for the evidence, nor vice versa.
                    const request = freezeDeep({
                        evidenceId: record.evidence.evidenceId, evidenceKind: record.evidence.evidenceKind,
                        source: record.evidence.source, orderId: order.id, reviewId: openReview.reviewId,
                        createdAt: new Date(zonedInstant(record.evidence.createdAt)).toISOString(),
                        digest: record.evidence.digest, financialObligation: record.evidence.financialObligation,
                        linkedOrderId: record.evidence.linkedOrderId ?? null, finding: record.evidence.finding ?? null,
                        closeReasonPolicy: APPROVED_CLOSE_REASONS.reference, reasonCode: record.reasonCode,
                        decision: REVIEW_OUTCOMES.CLOSE, decisionBinding: binding
                    });
                    const attestation = await verifyEvidence(record.evidence, request, order);
                    requireThat(attestation !== null && typeof attestation === "object" &&
                        attestation.status === "VERIFIED" && attestation.verifier && typeof attestation.verifier === "object" &&
                        EVIDENCE_VERIFIER_KINDS.includes(attestation.verifier.kind) && opaque(attestation.verifier.id) &&
                        ATTESTED_FIELDS.every(field => attestation[field] === request[field]), "UNTRUSTED_EVIDENCE");
                    requireThat(attestation.verifier.kind === "PRODUCTION" || syntheticEvidence,
                        "SYNTHETIC_VERIFIER_NOT_ALLOWED");
                    verifier = { kind: attestation.verifier.kind, id: attestation.verifier.id };
                    requireThat(!evidenceReferences.has(record.evidence.evidenceId), "EVIDENCE_REFERENCE_USED");
                }
                requireThat(!reviewReferences.has(record.authorizationRef), "REVIEW_REFERENCE_USED");
                at = serverTime();
                reviewRef = record.authorizationRef;
                let closeAudit = {};
                if (closing) {
                    // A backwards clock is reported as such before the evidence time is judged against it.
                    notBefore(order, at);
                    const created = zonedInstant(record.evidence.createdAt);
                    requireThat(created <= instant(at, "INVALID_CLOCK") && created >= Date.parse(order.events[0].at),
                        "EVIDENCE_TIME_INVALID");
                    evidenceRef = record.evidence.evidenceId;
                    const { evidenceId, evidenceKind, source, digest, financialObligation, linkedOrderId, finding } =
                        record.evidence;
                    // Only the reference, kind, source, time, digest and stated outcome are kept; never the content.
                    closeAudit = {
                        closeReasonPolicy: APPROVED_CLOSE_REASONS.reference, evidence: {
                            evidenceId, evidenceKind, source, createdAt: new Date(created).toISOString(), digest,
                            financialObligation, ...(linkedOrderId === undefined ? {} : { linkedOrderId }),
                            ...(finding === undefined ? {} : { finding }), verifier
                        }
                    };
                }
                // Görev 159 (K-01 Faz 1): the financial cases this decision opens, known before the audit so that the
                // decision names them. Every REFUND opens an ORDER_REFUND; a closing with accepted, undelivered
                // revisions also opens one UNDELIVERED_REVISION over their assessments (today only a REFUND, D-3).
                const closingOrder = record.outcome !== REVIEW_OUTCOMES.CONTINUE;
                const pendingRevisions = closingOrder ? undeliveredRevisions() : [];
                const caseTypes = [...(record.outcome === REVIEW_OUTCOMES.REFUND ? ["ORDER_REFUND"] : []),
                    ...(pendingRevisions.length > 0 ? ["UNDELIVERED_REVISION"] : [])];
                const caseIds = caseTypes.map((type, index) =>
                    `case-${String(order.financialCases.length + index + 1).padStart(4, "0")}`);
                audit = {
                    orderId: order.id, reviewId: openReview.reviewId, outcome: record.outcome,
                    ...humanActor(), reasonCode: record.reasonCode ?? null, ...closeAudit,
                    ...(caseIds.length > 0 ? { financialCaseIds: caseIds } : {}),
                    authorizationRef: record.authorizationRef, at, policyReference: policy.reference,
                    idempotencyKey: command.requestId
                };
                // A REFUND outcome records the decision only: no money moves and no right is reset.
                next.reviews = order.reviews.map(review => review === openReview
                    ? { ...review, status: "RESOLVED", resolution: { ...audit, moneyMovement: "NONE" } } : review);
                next.state = closingOrder ? STATES.CLOSED : openReview.resumeState;
                // Decision 134-B: accepted, undelivered revisions keep their record and right and are flagged
                // for an authorized financial review. No amount is computed and no money moves here. Since Görev
                // 148 only a REFUND reaches this with such revisions; a CLOSE is refused above.
                const assessmentIds = pendingRevisions.map(revision => {
                    const assessmentId = `assessment-${String(next.financialAssessments.length + 1).padStart(4, "0")}`;
                    next.financialAssessments.push({
                        assessmentId, orderId: order.id, reviewId: openReview.reviewId, revisionId: revision.revisionId,
                        reason: "ACCEPTED_NOT_DELIVERED", status: "PENDING_FINANCIAL_REVIEW", amountKurus: null,
                        moneyMovement: "NONE", createdAt: at
                    });
                    return assessmentId;
                });
                caseTypes.forEach((caseType, index) => {
                    // One case per order, review and type. The review resolves once, so this cannot repeat through
                    // the API; the check keeps the rule explicit for a persistent store's unique key.
                    const dedupKey = `${order.id}:${openReview.reviewId}:${caseType}`;
                    requireThat(!order.financialCases.some(item => item.dedupKey === dedupKey), "FINANCIAL_CASE_EXISTS");
                    const opening = {
                        step: "OPENED", caseId: caseIds[index], orderId: order.id, caseType, ...humanActor(), at,
                        authorizationRef: record.authorizationRef, idempotencyKey: command.requestId,
                        policyVersion: FINANCIAL_CASE_POLICY.reference
                    };
                    next.financialCases.push({
                        caseId: caseIds[index], orderId: order.id, caseType, dedupKey, status: "OPEN",
                        origin: { kind: "REVIEW_RESOLUTION", reviewId: openReview.reviewId, reviewType: openReview.type,
                            outcome: record.outcome, eventSequence: order.version + 1 },
                        // The person who decided the review; policy item 5 bars them from approving this case later.
                        originDeciderActorId: principal.actorId, createdAt: at,
                        createdBy: { ...humanActor(), mechanism: "ON_REVIEW_RESOLUTION" }, assignedRole: "finance",
                        assignedActorId: null, items: caseType === "UNDELIVERED_REVISION" ? assessmentIds : [],
                        evidenceReferences: [], proposal: null, decisions: [], closure: null,
                        policyVersion: FINANCIAL_CASE_POLICY.reference, reviewPolicyReference: policy.reference,
                        moneyMovement: "NONE", auditTrail: [opening]
                    });
                });
                break;
            }
            case "propose_delivery_date": {
                // Decision 134-A: after a CONTINUE review, a producer/admin may propose a new date once the current
                // commitment has passed. The proposal is a separate record; it never becomes the deadline by itself.
                inState(...replanStates);
                requireThat(order.reviews.some(review => review.resolution?.outcome === REVIEW_OUTCOMES.CONTINUE),
                    "REPLAN_NOT_ALLOWED");
                requireHumanActor();
                const record = data.proposal;
                requireThat(record && typeof record === "object" && record.kind === "DELIVERY_PROPOSAL" &&
                    record.orderId === order.id && record.source === RESTORATION_SOURCES[principal.role] &&
                    record.actorId === principal.actorId && opaque(record.authorizationRef) &&
                    typeof record.proposedDeadline === "string", "INVALID_PROPOSAL");
                at = serverTime();
                const now = instant(at, "INVALID_CLOCK");
                // One active proposal at a time. An expired one is closed on record below, never silently replaced.
                const previous = order.deliveryReplans.findLast(replan => replan.status === "PROPOSED");
                requireThat(!previous || now >= Date.parse(previous.expiresAt), "REPLAN_PENDING");
                const missed = effectiveDeadline();
                requireThat(missed !== null && Date.parse(missed) <= now, "DEADLINE_NOT_MISSED");
                const proposed = checkedDeadline(record.proposedDeadline, now);
                requireThat(typeof verifyReplan === "function" && await verifyReplan(record, order) === true,
                    "UNTRUSTED_PROPOSAL");
                requireThat(!replanReferences.has(record.authorizationRef), "REPLAN_REFERENCE_USED");
                replanRef = record.authorizationRef;
                const id = `replan-${String(order.deliveryReplans.length + 1).padStart(4, "0")}`;
                const expiresAt = new Date(now + PROPOSAL_LIFETIME_MS).toISOString();
                audit = {
                    orderId: order.id, replanId: id, proposedDeadline: proposed, missedDeadline: missed, ...humanActor(),
                    authorizationRef: record.authorizationRef, at, expiresAt, idempotencyKey: command.requestId
                };
                // The only SYSTEM step: the elapsed proposal is closed by the core itself, on the trusted clock,
                // inside this person's transaction. SYSTEM approves nothing and counts as no second person.
                if (previous) next.deliveryReplans = order.deliveryReplans.map(replan => replan === previous
                    ? expire(replan, {
                        actorId: SYSTEM_ACTOR_ID, actorType: "SYSTEM", role: null, reason: "EXPIRED_BEFORE_NEW_PROPOSAL",
                        triggeredBy: { actorId: principal.actorId, role: principal.role }
                    }) : replan);
                // The missed commitment stays on record as delay history; slaStartsAt and booking are untouched.
                next.deliveryReplans.push({
                    replanId: id, status: "PROPOSED", proposedDeadline: proposed, missedDeadline: missed,
                    bookedDeadline: order.booking.deadline, proposedBy: principal.role, createdAt: at, expiresAt,
                    proposal: audit, confirmation: null, expiry: null
                });
                break;
            }
            case "expire_delivery_proposal": {
                // Records an expiry on the order. Only the trusted clock decides; nothing else changes.
                inState(...replanStates);
                requireHumanActor();
                const pending = order.deliveryReplans.findLast(replan => replan.status === "PROPOSED");
                requireThat(pending, "REPLAN_NOT_PENDING");
                at = serverTime();
                requireThat(instant(at, "INVALID_CLOCK") >= Date.parse(pending.expiresAt), "PROPOSAL_NOT_EXPIRED");
                const expired = expire(pending, { ...humanActor(), reason: "MANUAL_EXPIRY_RECORD" });
                audit = expired.expiry;
                next.deliveryReplans = order.deliveryReplans.map(replan => replan === pending ? expired : replan);
                break;
            }
            case "confirm_delivery_date": {
                inState(...replanStates);
                const pending = order.deliveryReplans.findLast(replan => replan.status === "PROPOSED");
                requireThat(pending, "REPLAN_NOT_PENDING");
                const record = data.confirmation;
                requireThat(record && typeof record === "object" && record.kind === "DELIVERY_CONFIRMATION" &&
                    record.orderId === order.id && record.replanId === pending.replanId &&
                    // The same instant in any explicit offset matches; a zone-less or other date never does.
                    zonedInstant(record.proposedDeadline) === Date.parse(pending.proposedDeadline) &&
                    ["ACCEPT", "REJECT"].includes(record.decision) &&
                    record.source === CONFIRMATION_SOURCE && opaque(record.confirmationRef), "INVALID_CONFIRMATION");
                requireThat(typeof verifyReplan === "function" && await verifyReplan(record, order) === true,
                    "UNTRUSTED_CONFIRMATION");
                requireThat(!replanReferences.has(record.confirmationRef), "REPLAN_REFERENCE_USED");
                at = serverTime();
                // Decision 135: the answer must arrive strictly before expiresAt; at expiresAt the proposal is dead.
                requireThat(instant(at, "INVALID_CLOCK") < Date.parse(pending.expiresAt), "PROPOSAL_EXPIRED");
                // The date and calendar are checked again: a confirmation never commits a past or ineligible date.
                if (record.decision === "ACCEPT") next.replannedDeadline = checkedDeadline(pending.proposedDeadline,
                    instant(at, "INVALID_CLOCK"));
                replanRef = record.confirmationRef;
                audit = {
                    orderId: order.id, replanId: pending.replanId, decision: record.decision,
                    confirmationRef: record.confirmationRef, at, idempotencyKey: command.requestId
                };
                next.deliveryReplans = order.deliveryReplans.map(replan => replan === pending
                    ? { ...replan, status: record.decision === "ACCEPT" ? "CONFIRMED" : "REJECTED", confirmation: audit }
                    : replan);
                break;
            }
            default: throw new OrderError("UNKNOWN_ACTION");
        }
        next.version += 1;
        const event = {
            sequence: next.version, requestId: command.requestId, kind: command.kind,
            role: principal.role, from: order.state, to: next.state, fingerprint, at: at ?? serverTime(),
            previousHash: order.events.at(-1)?.hash || null
        };
        if (audit) event.audit = audit;
        requireThat(typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)), "INVALID_CLOCK");
        // Checked before anything is committed: a refused transition changes no state, right or reference.
        notBefore(order, event.at);
        event.hash = await digest(event);
        next.events.push(event);
        requireThat(orders.get(order.id) === order, "VERSION_CONFLICT");
        if (command.kind === "verify_payment") {
            requireThat(!paymentReferences.has(payment.reference), "PAYMENT_REFERENCE_USED");
        }
        const surcharge = command.kind === "approve_start" ? next.booking.surchargeReference : null;
        requireThat(surcharge === null || !paymentReferences.has(surcharge), "PAYMENT_REFERENCE_USED");
        requireThat(!restorationRef || !restorationReferences.has(restorationRef), "RESTORATION_REFERENCE_USED");
        requireThat(!reviewRef || !reviewReferences.has(reviewRef), "REVIEW_REFERENCE_USED");
        requireThat(!replanRef || !replanReferences.has(replanRef), "REPLAN_REFERENCE_USED");
        requireThat(!evidenceRef || !evidenceReferences.has(evidenceRef), "EVIDENCE_REFERENCE_USED");
        // Görev 150 (F-02): the linked order must be exactly the record that was checked; any change since is a refusal.
        requireThat(!linkedOrder || orders.get(linkedOrder.id) === linkedOrder, "LINKED_ORDER_CHANGED");
        const committed = freezeDeep(next);
        orders.set(order.id, committed);
        if (command.kind === "verify_payment") paymentReferences.set(payment.reference, order.id);
        if (surcharge !== null) paymentReferences.set(surcharge, order.id);
        if (restorationRef) restorationReferences.set(restorationRef, order.id);
        if (reviewRef) reviewReferences.set(reviewRef, order.id);
        if (replanRef) replanReferences.set(replanRef, order.id);
        if (evidenceRef) evidenceReferences.set(evidenceRef, order.id);
        return committed;
    }
    /** Decision 140: trusted server-side read of a proposal's visible state from the canonical record and the
     * trusted clock. It writes no event, audit or reference and never extends a proposal. */
    function viewProposal(snapshot, replanId) {
        requireThat(snapshot && typeof snapshot.id === "string", "INVALID_ORDER");
        const order = orders.get(snapshot.id);
        requireThat(order, "UNKNOWN_ORDER");
        requireThat(snapshot.packageId === order.packageId, "INVALID_ORDER");
        const replan = order.deliveryReplans.find(item => item.replanId === replanId);
        requireThat(replan, "UNKNOWN_PROPOSAL");
        const now = serverTime();
        // A clock behind the order's history could show an expired proposal as ACTIVE: refuse instead.
        notBefore(order, now);
        return freezeDeep({
            orderId: order.id, replanId: replan.replanId, visibleStatus: proposalVisibility(replan, order.id, now),
            storedStatus: replan.status, proposedDeadline: replan.proposedDeadline, createdAt: replan.createdAt,
            expiresAt: replan.expiresAt, evaluatedAt: now
        });
    }
    return Object.freeze({ createOrder, dispatch, viewProposal });
}
