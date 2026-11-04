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
    // Görev 169 (F168-01): financial case commands are never listed above; their roles come only from the central
    // registry FINANCIAL_CASE_POLICY.transitions, so a case command exists only once it is registered (and gated) there.
    const role = isCaseCommand(kind) ? FINANCIAL_CASE_POLICY.transitions[kind].roles
        : Object.hasOwn(roles, kind) ? roles[kind] : null;
    if (role === null) return null;
    // A multi-role command resolves to the caller's role only when that role is allowed.
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
// Görev 185 (2B-2a, A178-04): the one format of every consumed evidence digest: a lowercase hex SHA-256, never
// normalized. closeEvidence, the claim gate and the commit invariants all use this same rule.
const EVIDENCE_DIGEST = /^[0-9a-f]{64}$/;

/** Shape and binding of a close evidence reference. This is no proof that the evidence is genuine: only the
 * server's evidence service can tell, through verifyEvidence. The content itself never enters the core. */
function closeEvidence(evidence, rule, order, review) {
    requireThat(evidence && typeof evidence === "object", "EVIDENCE_REQUIRED");
    requireThat(Object.keys(evidence).every(key => EVIDENCE_FIELDS.has(key)) && opaque(evidence.evidenceId) &&
        evidence.orderId === order.id && evidence.reviewId === review.reviewId &&
        typeof evidence.digest === "string" && EVIDENCE_DIGEST.test(evidence.digest) &&
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
/** Görev 193 (Faz 2B-2b; D165-03, D165-04, DR-1/V-A, DQ-183-01): the closed, versioned financial case evidence policy.
 * Only the listed (case type, evidence kind, source) triples are accepted; CUSTOMER_CLOSURE_CONFIRMATION waits for legal
 * review. digestBasis names the canonical bytes of the versioned evidence-service contract (RAW_BYTES: the bytes as
 * received; JCS_UTF8: RFC 8785 JCS output as UTF-8). The service states the basis it used in its attestation and the
 * core compares it with this expected value; the core never sees the content and cannot verify the computation itself
 * (A178-07). This evidence policy does not change a case's own policyVersion (UNAI-FINANCIAL-CASE-v1.0). */
export const CASE_EVIDENCE_POLICY = freezeDeep({
    reference: "UNAI-FINANCIAL-CASE-EVIDENCE-v1.1",
    kinds: {
        ORDER_REFUND: {
            PAYMENT_PROVIDER_RECORD: { source: "payment_provider_reconciliation", digestBasis: "RAW_BYTES" },
            PROVIDER_DISPUTE_OUTCOME: { source: "payment_provider_reconciliation", digestBasis: "RAW_BYTES" }
        },
        UNDELIVERED_REVISION: {
            REVISION_DELIVERY_RECORD: { source: "producer_console", digestBasis: "JCS_UTF8" }
        }
    },
    excludedKinds: { CUSTOMER_CLOSURE_CONFIRMATION: "LEGAL_REVIEW_PENDING" }
});

/** The case evidence rule for one (case type, evidence kind, source), or null. Own keys only: a polluted prototype
 * never adds a kind. */
function caseEvidenceRule(caseType, evidenceKind, source) {
    const kinds = typeof caseType === "string" && Object.hasOwn(CASE_EVIDENCE_POLICY.kinds, caseType)
        ? CASE_EVIDENCE_POLICY.kinds[caseType] : null;
    const rule = kinds && typeof evidenceKind === "string" && Object.hasOwn(kinds, evidenceKind) ? kinds[evidenceKind] : null;
    return rule && rule.source === source ? rule : null;
}

/** Görev 193 (Faz 2B-2b, A186-02): every evidence purpose is bound to the commands that may claim it, the one place its
 * evidence is stored, the purpose its attestation must state and its evidence policy version. The command is taken from
 * the dispatch's frozen snapshot, never from the caller of the claim gate. CLOSE keeps its evidence-service contract
 * unchanged (its attestation carries no purpose). FINANCIAL_CASE_EVIDENCE is bound to add_case_evidence, the TEST-only
 * case command of Görev 206 (Faz 2B-3), registered in FINANCIAL_CASE_POLICY.transitions. */
export const EVIDENCE_PURPOSE_POLICY = freezeDeep({
    CLOSE: { commands: ["resolve_review"], storage: "REVIEW_RESOLUTION", attestedPurpose: null,
        evidencePolicyVersion: null },
    FINANCIAL_CASE_EVIDENCE: { commands: ["add_case_evidence"], storage: "CASE_EVIDENCE",
        attestedPurpose: "FINANCIAL_CASE_EVIDENCE", evidencePolicyVersion: CASE_EVIDENCE_POLICY.reference }
});
const EVIDENCE_PURPOSES = Object.freeze(Object.keys(EVIDENCE_PURPOSE_POLICY));
const evidenceKey = (evidenceId, digest) => JSON.stringify([evidenceId ?? null, digest ?? null]);

/** Görev 185 (2B-2a, A178-03): every evidence an order stores, as identity-and-digest keys: the close evidence of its
 * resolved reviews and the evidence entries of its financial cases. Evidence-shaped objects in any other place are
 * refused by evidenceOnlyInRegisteredPlaces (Görev 193, EVIDENCE_STORAGE_INVALID). */
function storedEvidenceKeys(snapshot) {
    const keys = [];
    for (const review of snapshot.reviews) {
        const evidence = review.resolution?.evidence;
        if (evidence) keys.push(evidenceKey(evidence.evidenceId, evidence.digest));
    }
    for (const item of snapshot.financialCases) {
        for (const evidence of item.evidenceReferences ?? []) keys.push(evidenceKey(evidence.evidenceId, evidence.digest));
    }
    return keys;
}

/** Görev 185 (2B-2a, A178-03): true exactly when the evidence a transition newly stores (after minus before, counted
 * as a multiset) is the evidence it claimed: nothing stored without a claim, no claim without stored evidence. */
function claimsMatchStoredEvidence(before, after, claims) {
    const added = new Map();
    for (const key of storedEvidenceKeys(after)) added.set(key, (added.get(key) ?? 0) + 1);
    for (const key of storedEvidenceKeys(before)) if (added.has(key)) added.set(key, added.get(key) - 1);
    const stored = [...added].flatMap(([key, count]) => Array(Math.max(count, 0)).fill(key)).sort();
    const claimed = claims.map(claim => evidenceKey(claim.evidenceId, claim.digest)).sort();
    return stored.length === claimed.length && stored.every((key, index) => key === claimed[index]);
}

// Görev 193 (Faz 2B-2b, A186-01): the registered evidence places, each bound to one purpose's storage, and the mirror
// places that may only repeat evidence already stored or claimed in the same transition.
const locationKey = (storage, caseId, evidenceId, digest) =>
    JSON.stringify([storage, caseId ?? null, evidenceId ?? null, digest ?? null]);
const isEvidenceShaped = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.hasOwn(value, "evidenceId") || Object.hasOwn(value, "digest"));

/** Görev 197 (A194-01, DQ-195-04): the limits of one evidence scan of an order (every root of one check together).
 * The deepest legitimate path is about 6 objects; an order has a few hundred objects. */
const EVIDENCE_SCAN_MAX_DEPTH = 64;
const EVIDENCE_SCAN_MAX_NODES = 200000;
// Görev 206 (F198-03, DQ-203-07): a second, independent budget: the own keys (properties and array elements, primitive
// values included) of every visited object, so a huge primitive array is refused too. It only ever refuses more.
const EVIDENCE_SCAN_MAX_ENTRIES = 1000000;
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/** Every evidence-shaped object (an own evidenceId or digest key) under `root`, with its path, or null when the
 * structure is refused. Pure, synchronous and iterative (an explicit stack, so no depth overflows the call stack). It
 * keeps descending below evidence-shaped objects, so evidence nested in evidence is found with its own (longer) path.
 * Fail-closed (null): a cycle (an object that is its own ancestor on the current path; the same object reached twice
 * on different paths, as CLOSE shares its evidence between resolution, audit and event, is not a cycle), an object
 * deeper than EVIDENCE_SCAN_MAX_DEPTH, more than budget.nodes objects, and anything that is not plain data: a
 * prototype other than Object.prototype, Array.prototype or null (Map, Set, Date, class instances), a symbol key, a
 * non-enumerable or accessor property (never invoked), an array key that is not an index, a function, symbol or
 * bigint value. Proxies are not detectable and stay out of scope. */
function findEvidence(root, rootPath, budget) {
    const found = [];
    const ancestors = new Set();
    const stack = [{ value: root, path: rootPath }];
    while (stack.length > 0) {
        const frame = stack.pop();
        if (frame.leave) {
            ancestors.delete(frame.value);
            continue;
        }
        const { value, path } = frame;
        if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return null;
        if (value === null || typeof value !== "object") continue;
        if (ancestors.has(value) || path.length > EVIDENCE_SCAN_MAX_DEPTH) return null;
        budget.nodes -= 1;
        if (budget.nodes < 0) return null;
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return null;
        const children = [];
        const keys = Reflect.ownKeys(value);
        budget.entries = (budget.entries ?? EVIDENCE_SCAN_MAX_ENTRIES) - (keys.length - (Array.isArray(value) ? 1 : 0));
        if (budget.entries < 0) return null;
        for (const key of keys) {
            if (typeof key === "symbol") return null;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (array && key === "length") continue;
            if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
            if (array && !(ARRAY_INDEX.test(key) && Number(key) < value.length)) return null;
            children.push([key, descriptor.value]);
        }
        if (isEvidenceShaped(value)) found.push(path);
        ancestors.add(value);
        stack.push({ leave: true, value });
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ value: children[index][1], path: [...path, children[index][0]] });
        }
    }
    return found;
}

/** The stored evidence of an order with its place: identity, digest, storage and case. */
function storedEvidenceLocations(snapshot) {
    const keys = [];
    for (const review of snapshot.reviews) {
        const evidence = review.resolution?.evidence;
        if (evidence) keys.push(locationKey("REVIEW_RESOLUTION", null, evidence.evidenceId, evidence.digest));
    }
    for (const item of snapshot.financialCases) {
        for (const evidence of item.evidenceReferences ?? []) {
            keys.push(locationKey("CASE_EVIDENCE", item.caseId, evidence.evidenceId, evidence.digest));
        }
    }
    return keys;
}

/** True exactly when the evidence a transition newly stores, place by place (storage and case), is what it claimed. */
function claimsMatchStoredLocations(before, after, claims) {
    const added = new Map();
    for (const key of storedEvidenceLocations(after)) added.set(key, (added.get(key) ?? 0) + 1);
    for (const key of storedEvidenceLocations(before)) if (added.has(key)) added.set(key, added.get(key) - 1);
    const stored = [...added].flatMap(([key, count]) => Array(Math.max(count, 0)).fill(key)).sort();
    const claimed = claims.map(claim => locationKey(claim.storage, claim.caseId, claim.evidenceId, claim.digest)).sort();
    return stored.length === claimed.length && stored.every((key, index) => key === claimed[index]);
}

/** True exactly when every evidence-shaped object of the next order, its event log included (Görev 197, A194-02), sits
 * in a registered place, and every mirror (the transition's audit, a case audit trail entry, an event's audit) repeats
 * only evidence stored before or claimed now. Evidence anywhere else, evidence nested in evidence or in a mirror, and
 * a structure findEvidence refuses (cycle, depth, size, non-plain data) are refused (Görev 197, A194-01).
 * Görev 206 (F198-01, MIRROR-203): a mirror written by add_case_evidence (an audit with step EVIDENCE_ADDED: the
 * transition's audit, the case audit trail entry and the event's audit) is also the very object (===) stored in the
 * evidenceReferences of the same case. An equal copy is refused.
 * Görev 210 (OD-207-01, GEN-3): so is every mirror whose holder names a case (caseId) or a review (reviewId), CLOSE
 * included: a case audit trail entry's evidence belongs to that case, an audit naming a caseId to that case, and an audit
 * naming only a reviewId to that review's resolution evidence. A mirror naming neither keeps the key rule.
 * Görev 214 (OD-211-05): a holder names a place when it has its own caseId or reviewId at all; such a label must be a
 * string that agrees with the place: a trail entry's labels with its own case and that case's review, a case-naming
 * holder's reviewId with the review of the case it names. Anything else has no place (EVIDENCE_STORAGE_INVALID). */
function evidenceOnlyInRegisteredPlaces(before, after, audit, claims) {
    const known = new Set([...storedEvidenceKeys(before), ...claims.map(claim => evidenceKey(claim.evidenceId, claim.digest))]);
    const registered = path => (path.length === 4 && path[0] === "reviews" && path[2] === "resolution" &&
        path[3] === "evidence") || (path.length === 4 && path[0] === "financialCases" && path[2] === "evidenceReferences");
    const mirror = path => (path.length === 5 && path[0] === "financialCases" && path[2] === "auditTrail" &&
        path[4] === "evidence") || (path.length === 4 && path[0] === "events" && path[2] === "audit" &&
        path[3] === "evidence");
    const at = (root, path) => path.reduce((value, key) => value[key], root);
    // The objects stored at the registered place a mirror holder belongs to (MIRROR-203).
    const labelled = (holder, key) => Object.hasOwn(holder, key);
    const placeOf = (holder, item) => {
        // Görev 214 (OD-211-05): a label that is present but not a string names no place.
        if ((labelled(holder, "caseId") && typeof holder.caseId !== "string") ||
            (labelled(holder, "reviewId") && typeof holder.reviewId !== "string")) return [];
        // A case named by the trail it sits in, or by the holder itself, is the only place; an unknown case has none.
        const target = item ?? (labelled(holder, "caseId")
            ? after.financialCases.find(entry => entry.caseId === holder.caseId) ?? null : undefined);
        if (target === null) return [];
        if (target !== undefined) {
            // Görev 214 (OD-211-05): the holder's own labels agree with that case and its review.
            if ((labelled(holder, "caseId") && holder.caseId !== target.caseId) ||
                (labelled(holder, "reviewId") && holder.reviewId !== target.origin?.reviewId)) return [];
            return Array.isArray(target.evidenceReferences) ? target.evidenceReferences : [];
        }
        const review = labelled(holder, "reviewId")
            ? after.reviews.find(entry => entry.reviewId === holder.reviewId) : undefined;
        return review?.resolution?.evidence ? [review.resolution.evidence] : [];
    };
    const namesPlace = holder => holder.step === "EVIDENCE_ADDED" || labelled(holder, "caseId") ||
        labelled(holder, "reviewId");
    const identical = (holder, item) => !namesPlace(holder) || placeOf(holder, item).includes(holder.evidence);
    const mirrorKnown = path => {
        const evidence = at(after, path);
        const holder = at(after, path.slice(0, -1));
        const item = path[0] === "financialCases" ? after.financialCases[path[1]] : undefined;
        return known.has(evidenceKey(evidence.evidenceId, evidence.digest)) && identical(holder, item);
    };
    const budget = { nodes: EVIDENCE_SCAN_MAX_NODES, entries: EVIDENCE_SCAN_MAX_ENTRIES };
    const places = findEvidence(after, [], budget);
    const audited = places === null ? null : findEvidence(audit ?? null, ["audit"], budget);
    return places !== null && audited !== null && places.every(path => registered(path) || (mirror(path) && mirrorKnown(path))) &&
        audited.every(path => path.length === 2 && path[1] === "evidence" &&
            known.has(evidenceKey(audit.evidence.evidenceId, audit.evidence.digest)) && identical(audit));
}

/** True exactly when the transition keeps the evidence history: a resolved review's evidence is the same object, and
 * every case keeps its place, its id and its earlier evidence entries as the same objects, in order (append-only).
 * Deleting, moving, reordering or changing stored evidence in place is refused.
 * Görev 210 (OD-207-03, TRAIL-1): so is the case audit trail: every earlier entry stays the same object at the same
 * position, so removing, replacing, reordering, relabelling or changing the actor of a recorded step is refused. */
/** Görev 214 (OD-211-01, FD-212-01/02, I-213-02): the add_case_evidence transition that commits is the one its pre-check
 * planned. Every field of the order but version and events is still the planned object, every case is the planned case
 * and every other case the one before; the one case is the frozen planned object, its audit trail grew by exactly one
 * entry, this event's audit itself, and its status, assignedActorId and moneyMovement and the order's state are those of
 * before. `planned` is null for every other command (true). Pure and synchronous. */
function caseEvidenceTransitionKept(before, after, planned, audit) {
    if (planned === null) return true;
    const keys = Object.keys(planned.next);
    const index = before.financialCases.findIndex(entry => entry.caseId === audit?.caseId);
    const earlier = before.financialCases[index];
    const later = Array.isArray(after.financialCases) ? after.financialCases[index] : undefined;
    return index >= 0 && Object.keys(after).length === keys.length && keys.every(key => Object.hasOwn(after, key) &&
        (key === "version" || key === "events" || after[key] === planned.next[key])) &&
        after.financialCases.length === planned.cases.length &&
        planned.cases.every((entry, position) => after.financialCases[position] === entry &&
            (position === index || entry === before.financialCases[position])) &&
        Object.isFrozen(later) && Array.isArray(later.auditTrail) &&
        later.auditTrail.length === earlier.auditTrail.length + 1 && later.auditTrail.at(-1) === audit &&
        later.status === earlier.status && later.assignedActorId === earlier.assignedActorId &&
        later.moneyMovement === earlier.moneyMovement && after.state === before.state;
}

function evidenceHistoryKept(before, after) {
    return before.reviews.every((review, index) => !review.resolution?.evidence ||
        after.reviews[index]?.resolution?.evidence === review.resolution.evidence) &&
        before.financialCases.every((item, index) => {
            const next = after.financialCases[index];
            const earlier = item.evidenceReferences ?? [];
            const trail = item.auditTrail ?? [];
            return next !== undefined && next.caseId === item.caseId && Array.isArray(next.evidenceReferences) &&
                earlier.every((entry, position) => next.evidenceReferences[position] === entry) &&
                Array.isArray(next.auditTrail) && trail.every((entry, position) => next.auditTrail[position] === entry);
        });
}

/** Görev 197 (A194-02, DQ-195-03): the event log is append-only. Before the transition's own event is appended the next
 * log holds exactly the earlier events, as the same objects and in order; afterwards it holds them followed by that one
 * event. Deleting, moving, reordering, replacing or adding events is refused (EVIDENCE_HISTORY_CHANGED). */
function eventHistoryKept(before, after, appendedEvent) {
    const expected = appendedEvent === null ? before.events.length : before.events.length + 1;
    return Array.isArray(after.events) && after.events.length === expected &&
        before.events.every((event, index) => after.events[index] === event) &&
        (appendedEvent === null || after.events[expected - 1] === appendedEvent);
}

/** Görev 185/193: every claim is a frozen, well-formed gate claim for this order, unique within the transition, bound
 * to this dispatch's command and to its purpose's storage place. Görev 197: one function, checked before and again
 * after the last await of the commit. */
function claimsBoundToCommand(claims, orderId, kind) {
    return claims.every((claim, index) => Object.isFrozen(claim) &&
        EVIDENCE_PURPOSES.includes(claim.purpose) && opaque(claim.evidenceId) && typeof claim.digest === "string" &&
        EVIDENCE_DIGEST.test(claim.digest) && claim.orderId === orderId && claims.findIndex(other =>
            other.evidenceId === claim.evidenceId || other.digest === claim.digest) === index &&
        // Görev 193: a claim is bound to this command and to its purpose's storage place.
        claim.command === kind && EVIDENCE_PURPOSE_POLICY[claim.purpose].commands.includes(claim.command) &&
        claim.storage === EVIDENCE_PURPOSE_POLICY[claim.purpose].storage &&
        (claim.storage === "CASE_EVIDENCE" ? typeof claim.caseId === "string" : claim.caseId === null));
}
const DEPLOYMENT_ENVIRONMENTS = Object.freeze(["PRODUCTION", "STAGING", "TEST"]);

/** Görev 159 (K-01 Faz 1): financial cases, creation only. A REFUND opens an ORDER_REFUND case; accepted, undelivered
 * revisions open one UNDELIVERED_REVISION case over their assessments. Cases are opened inside the deciding
 * transaction, start OPEN and carry no amount: approving, closing, paying and reconciling come in later phases. */
export const FINANCIAL_CASE_POLICY = freezeDeep({
    reference: "UNAI-FINANCIAL-CASE-v1.0", types: ["ORDER_REFUND", "UNDELIVERED_REVISION"],
    // Görev 164 (K-01 Faz 2, D158-1): finance and admin may take an OPEN case for review. Proposing, approving,
    // rejecting and closing wait for verified case evidence (Görev 158 T2/T3) and are not active.
    // Görev 206 (Faz 2B-3, DQ-203-05): finance and admin may add verified evidence to a case UNDER_REVIEW only; the
    // case keeps its status, policy version and every money field. Like every case command it runs only in TEST.
    transitions: {
        take_case: { from: "OPEN", to: "UNDER_REVIEW", roles: ["finance", "admin"] },
        add_case_evidence: { from: "UNDER_REVIEW", to: "UNDER_REVIEW", roles: ["finance", "admin"] }
    },
    // Approved design contract (D164-A, D164-B), not yet enforced by any command: only finance gives the final
    // approval, and never the person who opened or resolved the review or proposed the decision.
    approval: {
        status: "NOT_ACTIVE", roles: ["finance"], excludedActors: ["REVIEW_OPENER", "REVIEW_RESOLVER", "PROPOSER"]
    }
});

/** Görev 169 (F168-01): the one classification of financial case management commands. A command is a case command
 * exactly when it is an own key of FINANCIAL_CASE_POLICY.transitions (never by name prefix or prototype). */
function isCaseCommand(kind) {
    return typeof kind === "string" && Object.hasOwn(FINANCIAL_CASE_POLICY.transitions, kind);
}

/** Görev 193 (Faz 2B-2b, D165-01/02/03/04, DR-1/V-A): the financial case evidence contract. Constants and pure checks
 * only; nothing here calls a verifier. add_case_evidence (Görev 206, Faz 2B-3) uses them through
 * checkCaseEvidenceSubmission.
 * A submission is { kind: "CASE_EVIDENCE_SUBMISSION", orderId, caseId, reviewId, caseType, evidencePolicyVersion,
 * authorizationRef, source, actorId, evidence, signature } and its evidence { evidenceId, evidenceKind, source, orderId,
 * caseId, reviewId, createdAt, digest, signature } (the evidence service's own signature, never bound here). */
export const CASE_EVIDENCE_FIELDS = Object.freeze(["kind", "orderId", "caseId", "reviewId", "caseType",
    "evidencePolicyVersion", "authorizationRef", "source", "actorId", "evidence", "signature"]);
export const CASE_EVIDENCE_ITEM_FIELDS = Object.freeze(["evidenceId", "evidenceKind", "source", "orderId", "caseId",
    "reviewId", "createdAt", "digest", "signature"]);
/** D165-02: every field the case console signature (verifyCaseRecord) must cover, in a fixed order. */
export const CASE_EVIDENCE_BINDING_FIELDS = Object.freeze(["orderId", "caseId", "reviewId", "caseType",
    "evidencePolicyVersion", "authorizationRef", "source", "actorId", "evidence.evidenceId", "evidence.evidenceKind",
    "evidence.source", "evidence.orderId", "evidence.caseId", "evidence.reviewId", "evidence.createdAt", "evidence.digest"]);

export function caseEvidenceBinding(record) {
    return JSON.stringify(["UNAI-CASE-EVIDENCE-v1", ...CASE_EVIDENCE_BINDING_FIELDS.map(path =>
        path.split(".").reduce((value, key) => (value !== null && typeof value === "object" && Object.hasOwn(value, key)
            ? value[key] : undefined), record) ?? null)]);
}

/** D165-01: every field the case evidence service (verifyCaseEvidence) must attest, each equal to the core's request:
 * the purpose, the evidence policy version and the digest basis (DQ-183-01) included. */
export const CASE_ATTESTED_FIELDS = Object.freeze(["purpose", "evidencePolicyVersion", "evidenceId", "evidenceKind",
    "source", "orderId", "caseId", "reviewId", "caseType", "createdAt", "digest", "digestBasis", "decisionBinding"]);

// Görev 206 (DQ-203-09): the technical bound of the case console signature string. The core never interprets it.
const CASE_SIGNATURE_MAX_LENGTH = 4096;

/** Görev 206 (F198-02): true exactly when `value` is a non-array object whose own keys are all string keys of enumerable
 * data properties, every `required` key is present and no key outside `required` and `optional` exists. */
function exactDataFields(value, required, optional = []) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Reflect.ownKeys(value).every(key => {
            const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
            return descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.enumerable &&
                (required.includes(key) || optional.includes(key));
        }) && required.every(key => Object.hasOwn(value, key));
}

/** Görev 193: shape, binding to the canonical case, kind, policy version and time of a case evidence submission. Pure:
 * no verifier and no registry. Returns the frozen request the evidence service must attest field by field. Codes:
 * EVIDENCE_MISMATCH (shape), INVALID_CASE_REFERENCE (another order, case, review or case type),
 * CASE_EVIDENCE_POLICY_MISMATCH, EVIDENCE_KIND_NOT_ALLOWED, EVIDENCE_STALE (created before the case, D165-04).
 * Görev 206 (F198-02): the submission carries exactly CASE_EVIDENCE_FIELDS and its evidence every
 * CASE_EVIDENCE_ITEM_FIELDS entry (the service's own signature optional), as own data properties; actorId is an opaque,
 * non-SYSTEM id and the console signature a string of 1 to 4096 characters (UTF-16 units). */
export function checkCaseEvidence(record, order, item, role) {
    requireThat(exactDataFields(record, CASE_EVIDENCE_FIELDS) &&
        record.kind === "CASE_EVIDENCE_SUBMISSION" && opaque(record.authorizationRef) &&
        opaque(record.actorId) && !RESERVED_ACTOR.test(record.actorId) &&
        typeof record.signature === "string" && record.signature.length >= 1 &&
        record.signature.length <= CASE_SIGNATURE_MAX_LENGTH &&
        typeof role === "string" && Object.hasOwn(REVIEW_SOURCES, role) && record.source === REVIEW_SOURCES[role],
        "EVIDENCE_MISMATCH");
    requireThat(order !== null && typeof order === "object" && item !== null && typeof item === "object" &&
        record.orderId === order.id && item.orderId === order.id && record.caseId === item.caseId &&
        record.reviewId === item.origin?.reviewId && record.caseType === item.caseType, "INVALID_CASE_REFERENCE");
    requireThat(record.evidencePolicyVersion === CASE_EVIDENCE_POLICY.reference, "CASE_EVIDENCE_POLICY_MISMATCH");
    const evidence = record.evidence;
    requireThat(exactDataFields(evidence, CASE_EVIDENCE_ITEM_FIELDS.filter(key => key !== "signature"), ["signature"]) &&
        opaque(evidence.evidenceId) &&
        evidence.orderId === record.orderId && evidence.caseId === record.caseId && evidence.reviewId === record.reviewId &&
        typeof evidence.digest === "string" && EVIDENCE_DIGEST.test(evidence.digest) &&
        Number.isSafeInteger(zonedInstant(evidence.createdAt)), "EVIDENCE_MISMATCH");
    const rule = caseEvidenceRule(record.caseType, evidence.evidenceKind, evidence.source);
    requireThat(rule !== null, "EVIDENCE_KIND_NOT_ALLOWED");
    requireThat(zonedInstant(evidence.createdAt) >= Date.parse(item.createdAt), "EVIDENCE_STALE");
    return freezeDeep({
        purpose: "FINANCIAL_CASE_EVIDENCE", evidencePolicyVersion: CASE_EVIDENCE_POLICY.reference,
        evidenceId: evidence.evidenceId, evidenceKind: evidence.evidenceKind, source: evidence.source, orderId: order.id,
        caseId: item.caseId, reviewId: record.reviewId, caseType: item.caseType,
        createdAt: new Date(zonedInstant(evidence.createdAt)).toISOString(), digest: evidence.digest,
        digestBasis: rule.digestBasis, decisionBinding: caseEvidenceBinding(record)
    });
}

/** Görev 206 (F198-02, DQ-203-06): the facts of a case evidence submission that need the principal and trusted time, on
 * top of checkCaseEvidence. Pure. In order: checkCaseEvidence for the principal's role; the record's actor is the
 * authenticated principal (EVIDENCE_MISMATCH); the case still has the approved case policy version
 * (INVALID_CASE_REFERENCE); and, when the trusted server time `at` is given, the evidence was not created after it, with
 * no tolerance (INVALID_CLOCK, EVIDENCE_TIME_INVALID). Returns checkCaseEvidence's frozen request. */
export function checkCaseEvidenceSubmission(record, order, item, principal, at) {
    const request = checkCaseEvidence(record, order, item, principal?.role);
    requireThat(principal !== null && typeof principal === "object" && record.actorId === principal.actorId,
        "EVIDENCE_MISMATCH");
    requireThat(item.policyVersion === FINANCIAL_CASE_POLICY.reference, "INVALID_CASE_REFERENCE");
    if (at !== undefined) requireThat(caseEvidenceNotAfter(request, at), "EVIDENCE_TIME_INVALID");
    return request;
}

/** DQ-203-06: the case evidence was created at or before the trusted time `at` (INVALID_CLOCK for a bad `at`). */
function caseEvidenceNotAfter(request, at) {
    return Date.parse(request.createdAt) <= instant(at, "INVALID_CLOCK");
}

/** D165-01: a case evidence attestation is VERIFIED, names a known verifier and states every CASE_ATTESTED_FIELDS value
 * of the request, the digest basis included, as its own property (Görev 197, A194-10: an inherited value is not a
 * statement). Anything else is UNTRUSTED_EVIDENCE. Pure. */
export function checkCaseEvidenceAttestation(attestation, request) {
    requireThat(attestation !== null && typeof attestation === "object" && attestation.status === "VERIFIED" &&
        attestation.verifier !== null && typeof attestation.verifier === "object" &&
        EVIDENCE_VERIFIER_KINDS.includes(attestation.verifier.kind) && opaque(attestation.verifier.id) &&
        request !== null && typeof request === "object" &&
        CASE_ATTESTED_FIELDS.every(field => Object.hasOwn(attestation, field) && attestation[field] === request[field]),
    "UNTRUSTED_EVIDENCE");
}

/** Görev 210 (DQ-208-03, T207-03): one stable copy of a case evidence attestation, taken once: status, verifier
 * { kind, id } and every CASE_ATTESTED_FIELDS value, each only from an own data property. An inherited or accessor
 * property is left out without being read (no getter runs), so the checks refuse it (UNTRUSTED_EVIDENCE). Anything that
 * is not an object is returned as it is and refused the same way.
 * Görev 214 (OD-211-02, OD-211-03, I-213-01): the copy and its verifier have no prototype, so a polluted
 * Object.prototype supplies nothing; a field is kept only when its value is a primitive, the verifier only when it is a
 * non-array object, and its kind and id only when they are strings. Nested objects, arrays and functions are left out
 * unread, and the copy is frozen shallowly: nothing the verifier owns is walked or frozen. */
function caseAttestationSnapshot(attestation) {
    if (attestation === null || typeof attestation !== "object") return attestation;
    const primitive = value => value === null || (typeof value !== "object" && typeof value !== "function");
    const ownData = (source, keys, accepted) => {
        const copy = Object.create(null);
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(source, key);
            if (descriptor !== undefined && Object.hasOwn(descriptor, "value") && accepted(key, descriptor.value)) {
                copy[key] = descriptor.value;
            }
        }
        return copy;
    };
    const copy = ownData(attestation, ["status", "verifier", ...CASE_ATTESTED_FIELDS], (key, value) => key === "verifier"
        ? value !== null && typeof value === "object" && !Array.isArray(value) : primitive(value));
    if (Object.hasOwn(copy, "verifier")) {
        copy.verifier = Object.freeze(ownData(copy.verifier, ["kind", "id"], (key, value) => typeof value === "string"));
    }
    return Object.freeze(copy);
}

/** D165-02: verifyCaseRecord(record, canonicalOrder, { binding }) must return { verified: true, binding } only after
 * checking the case console signature over exactly caseEvidenceBinding(record); a bare `true` is refused. Pure. */
export function checkCaseRecordVerdict(signed, binding) {
    requireThat(signed !== null && typeof signed === "object" && signed.verified === true &&
        typeof binding === "string" && signed.binding === binding, "UNTRUSTED_REVIEW");
}

/** Görev 169 (F168-02): a trusted server setting is read only from an own data property of the configuration object.
 * An inherited value (prototype pollution) or an accessor is never taken; an absent or undefined value is the default. */
function ownSetting(config, key, fallback, code) {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    if (!descriptor) return fallback;
    requireThat(Object.hasOwn(descriptor, "value"), code);
    return descriptor.value === undefined ? fallback : descriptor.value;
}

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
 * service every CLOSE is refused (CLOSE_EVIDENCE_UNVERIFIABLE). The attested digest must be the lowercase hex SHA-256
 * the service computed itself from the stored evidence bytes, never an echo of the request: the core never sees the
 * content and cannot recompute it (Görev 176). Within this core instance one evidence id and one digest are each
 * consumed at most once (Görev 177, PA-1): a second use is EVIDENCE_REFERENCE_USED, or EVIDENCE_DIGEST_USED for the
 * same content under another id. Every command that stores evidence consumes it through the dispatch's single claim
 * gate (Görev 185, Architecture C); evidence stored without a claim is refused (EVIDENCE_NOT_CLAIMED). Financial case
 * evidence shares these registries through add_case_evidence (Görev 206, TEST only). Re-verifying evidence
 * already stored (D165-09) is never a claim. Görev 193 (Faz 2B-2b): a purpose may be claimed only by the commands
 * EVIDENCE_PURPOSE_POLICY binds to it (EVIDENCE_PURPOSE_MISMATCH), and its evidence may be stored only in that
 * purpose's place; evidence-shaped objects anywhere else are EVIDENCE_STORAGE_INVALID, and stored evidence is
 * append-only (EVIDENCE_HISTORY_CHANGED). verifyCaseEvidence(evidence, request, canonicalOrder) and
 * verifyCaseRecord(record, canonicalOrder, { binding }) are the contracts of add_case_evidence (CASE_ATTESTED_FIELDS,
 * caseEvidenceBinding); both are read only from own data properties of the configuration. Without
 * verifyCaseEvidence every submission is CASE_EVIDENCE_UNVERIFIABLE, without verifyCaseRecord UNTRUSTED_REVIEW; neither
 * is ever called for a submission the synchronous checks refuse. A case authorizationRef is single use within this core
 * instance and shares one namespace with the review references (CASE_REFERENCE_USED, REVIEW_REFERENCE_USED). A verifier of kind SYNTHETIC is refused unless the
 * core was created with allowSyntheticEvidence: true AND environment: "TEST" (Görev 152, F151-04). Both come from the
 * server's own configuration, never from a command or principal. A missing environment is PRODUCTION; an unknown one,
 * or the flag outside TEST, stops the core from being created. Both are read only from own data properties of the
 * configuration (Görev 169, F168-02). Financial case commands, i.e. the keys of FINANCIAL_CASE_POLICY.transitions,
 * are refused outside TEST with CASE_COMMAND_NOT_ENABLED by one central gate in dispatch (Görev 167/169), and no
 * other command may change an existing case (CASE_COMMAND_NOT_REGISTERED). `reviewPolicy` is the active review
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
export function createCore(config = {}) {
    const { authorize, verifyPayment, verifyEmail, verifyBooking, verifyRestoration, verifyReview, verifyReplan,
        verifyEvidence, reviewPolicy = APPROVED_REVIEW_POLICY, calendar, clock = () => new Date().toISOString() } = config;
    // Görev 169 (F168-02): the two security settings are own data properties only; an inherited value is not seen.
    const environment = ownSetting(config, "environment", "PRODUCTION", "INVALID_ENVIRONMENT");
    const allowSyntheticEvidence = ownSetting(config, "allowSyntheticEvidence", false, "SYNTHETIC_EVIDENCE_NOT_ALLOWED");
    // Görev 206 (F203-02): the case verifiers are taken only from own data properties; an inherited or accessor value is
    // treated as absent, so a polluted prototype can never supply one.
    const ownCallback = key => {
        const descriptor = Object.getOwnPropertyDescriptor(config, key);
        return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
            ? descriptor.value : null;
    };
    const verifyCaseEvidence = ownCallback("verifyCaseEvidence");
    const verifyCaseRecord = ownCallback("verifyCaseRecord");
    requireThat(typeof clock === "function", "INVALID_CLOCK");
    // Görev 152 (F151-04): synthetic evidence is a test-fixture facility. It is refused at creation anywhere but an
    // explicitly declared TEST environment, so a production or staging core can never be started with it.
    requireThat(typeof environment === "string" && DEPLOYMENT_ENVIRONMENTS.includes(environment), "INVALID_ENVIRONMENT");
    requireThat(allowSyntheticEvidence !== true || environment === "TEST", "SYNTHETIC_EVIDENCE_NOT_ALLOWED");
    const syntheticEvidence = allowSyntheticEvidence === true && environment === "TEST";
    // Görev 167 (F166-01): financial case commands carry no signed console record or single-use authorization yet
    // (Görev 164 P-6), so they run only in a core the server configured as TEST. A missing environment is
    // PRODUCTION and an unknown one never starts; nothing in a command or principal can open this.
    const caseCommandsEnabled = environment === "TEST";
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
    // Görev 206 (DQ-203-04): the single-use authorizationRef of add_case_evidence. Case and review references are one
    // namespace: each registry is checked by both kinds of command (CASE_REFERENCE_USED / REVIEW_REFERENCE_USED).
    const caseReferences = new Map();
    const evidenceReferences = new Map();
    // Görev 177 (PA-1, F151-05): evidence digest -> the evidence id that consumed it, shared by CLOSE and (later)
    // financial case evidence. Like every registry here it lives only as long as this core instance: a restart, a second
    // instance or a use outside this core is not seen, so this is no global or persistent uniqueness guarantee.
    // Görev 185: both evidence registries are written in one place only, recordClaims, from claims made by claimEvidence.
    const evidenceDigests = new Map();

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
        data.resolution, data.proposal, data.confirmation, data.restorationId, data.decision, data.caseRef];
        // Görev 206 (INV-203-01): only add_case_evidence appends its payload; every other fingerprint, and so every
        // other event hash, stays byte-for-byte as before.
        if (command.kind === "add_case_evidence") intent.push(data.caseEvidence);
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
        let caseRef = null;
        // Görev 185 (2B-2a, Architecture C, A178-03): the evidence this transition consumes. Only claimEvidence adds to
        // it; nothing is reserved in a registry before the commit, so a refused transition leaves no trace.
        const evidenceClaims = [];
        /** The single gate through which a command consumes evidence, called after the command's own validation and
         * its verifier's full attestation check. Synchronous. In order: purpose; digest and id format; the minimum of a
         * verified attestation for exactly this id and digest; the TEST-only synthetic boundary; a repeat within this
         * transition; the registries, identity before digest. The returned claim is what the command stores. */
        const claimEvidence = (purpose, request, attestation) => {
            requireThat(typeof purpose === "string" && Object.hasOwn(EVIDENCE_PURPOSE_POLICY, purpose), "EVIDENCE_MISMATCH");
            const policy = EVIDENCE_PURPOSE_POLICY[purpose];
            // Görev 193 (A186-02): the command is this dispatch's own, from the frozen snapshot.
            requireThat(policy.commands.includes(command.kind), "EVIDENCE_PURPOSE_MISMATCH");
            requireThat(request !== null && typeof request === "object" && opaque(request.evidenceId) &&
                typeof request.digest === "string" && EVIDENCE_DIGEST.test(request.digest), "EVIDENCE_MISMATCH");
            const caseEvidence = policy.storage === "CASE_EVIDENCE";
            const rule = caseEvidence ? caseEvidenceRule(request.caseType, request.evidenceKind, request.source) : null;
            if (caseEvidence) {
                // A second line behind the command's own checkCaseEvidence: the canonical case, the policy version, the
                // closed kind matrix and the expected digest basis.
                requireThat(typeof request.caseId === "string" && order.financialCases.some(item =>
                    item.caseId === request.caseId && item.caseType === request.caseType), "EVIDENCE_MISMATCH");
                requireThat(request.evidencePolicyVersion === policy.evidencePolicyVersion, "CASE_EVIDENCE_POLICY_MISMATCH");
                requireThat(rule !== null, "EVIDENCE_KIND_NOT_ALLOWED");
                requireThat(request.digestBasis === rule.digestBasis, "EVIDENCE_MISMATCH");
                // Görev 197 (A194-03): the request is for this order and the canonical case's review, states the case
                // evidence purpose, and carries every attested field as its own, defined value.
                const item = order.financialCases.find(entry =>
                    entry.caseId === request.caseId && entry.caseType === request.caseType);
                requireThat(request.orderId === order.id && request.reviewId === item.origin?.reviewId &&
                    request.purpose === policy.attestedPurpose && typeof request.createdAt === "string" &&
                    typeof request.decisionBinding === "string" &&
                    CASE_ATTESTED_FIELDS.every(field => Object.hasOwn(request, field) && request[field] !== undefined),
                "EVIDENCE_MISMATCH");
            }
            requireThat(attestation !== null && typeof attestation === "object" && attestation.verifier !== null &&
                typeof attestation.verifier === "object", "UNTRUSTED_EVIDENCE");
            const verifier = { kind: attestation.verifier.kind, id: attestation.verifier.id };
            requireThat(attestation.status === "VERIFIED" && EVIDENCE_VERIFIER_KINDS.includes(verifier.kind) &&
                opaque(verifier.id) && attestation.evidenceId === request.evidenceId &&
                attestation.digest === request.digest, "UNTRUSTED_EVIDENCE");
            // D165-01, DQ-183-01: case evidence is attested for its purpose, policy version, case, kind and digest basis.
            requireThat(!caseEvidence || (attestation.purpose === policy.attestedPurpose &&
                attestation.evidencePolicyVersion === policy.evidencePolicyVersion &&
                attestation.caseId === request.caseId && attestation.evidenceKind === request.evidenceKind &&
                attestation.source === request.source && attestation.digestBasis === rule.digestBasis &&
                // Görev 197 (A194-03, A194-10): and every attested field, stated by the attestation itself (never
                // inherited), equal to the request: orderId, reviewId, caseType, createdAt and decisionBinding included.
                CASE_ATTESTED_FIELDS.every(field => Object.hasOwn(attestation, field) && attestation[field] === request[field])),
            "UNTRUSTED_EVIDENCE");
            requireThat(verifier.kind === "PRODUCTION" || syntheticEvidence, "SYNTHETIC_VERIFIER_NOT_ALLOWED");
            requireThat(evidenceClaims.every(claim => claim.evidenceId !== request.evidenceId), "EVIDENCE_REFERENCE_USED");
            requireThat(evidenceClaims.every(claim => claim.digest !== request.digest), "EVIDENCE_DIGEST_USED");
            requireThat(!evidenceReferences.has(request.evidenceId), "EVIDENCE_REFERENCE_USED");
            requireThat(!evidenceDigests.has(request.digest), "EVIDENCE_DIGEST_USED");
            const claim = freezeDeep({ purpose, command: command.kind, storage: policy.storage,
                evidenceId: request.evidenceId, digest: request.digest, orderId: order.id,
                caseId: caseEvidence ? request.caseId : null, verifier });
            evidenceClaims.push(claim);
            return claim;
        };
        // Commit-time re-check, after the last await and synchronous: every claim's identity first, then every digest.
        function assertClaimsFree() {
            requireThat(evidenceClaims.every(claim => !evidenceReferences.has(claim.evidenceId)), "EVIDENCE_REFERENCE_USED");
            requireThat(evidenceClaims.every(claim => !evidenceDigests.has(claim.digest)), "EVIDENCE_DIGEST_USED");
        }
        // The only writes to the evidence registries, in the same synchronous block as assertClaimsFree.
        function recordClaims() {
            for (const claim of evidenceClaims) {
                evidenceReferences.set(claim.evidenceId, claim.orderId);
                evidenceDigests.set(claim.digest, claim.evidenceId);
            }
        }
        let linkedOrder = null;
        // Görev 164 (F160-03): set when this transition writes financial cases; the event then commits to their content.
        let casesChanged = false;
        // Görev 169 (F168-01): the central, fail-closed case gate. Every registered case command, present or future,
        // passes here after the role, authorization, version and review checks and before any of its own code runs.
        const caseCommand = isCaseCommand(command.kind);
        requireThat(!caseCommand || caseCommandsEnabled, "CASE_COMMAND_NOT_ENABLED");
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
                requireThat(!reviewReferences.has(record.authorizationRef) && !caseReferences.has(record.authorizationRef),
                    "REVIEW_REFERENCE_USED");
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
                    // Görev 185 (2B-2a): the TEST-only synthetic boundary and the identity-then-digest pre-check
                    // (Görev 177, PA-1) are the claim gate's; the claim is consumed only when the decision commits.
                    verifier = claimEvidence("CLOSE", request, attestation).verifier;
                }
                requireThat(!reviewReferences.has(record.authorizationRef) && !caseReferences.has(record.authorizationRef),
                    "REVIEW_REFERENCE_USED");
                at = serverTime();
                reviewRef = record.authorizationRef;
                let closeAudit = {};
                if (closing) {
                    // A backwards clock is reported as such before the evidence time is judged against it.
                    notBefore(order, at);
                    const created = zonedInstant(record.evidence.createdAt);
                    requireThat(created <= instant(at, "INVALID_CLOCK") && created >= Date.parse(order.events[0].at),
                        "EVIDENCE_TIME_INVALID");
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
                casesChanged = caseTypes.length > 0;
                break;
            }
            case "take_case": {
                // Görev 164 (K-01 Faz 2, T1): a verified finance or admin person takes an OPEN case for review. The
                // case is found in the canonical order only; the request names it with its order, never as a bare id,
                // because case ids are per-order sequences (F160-01). Nothing is decided and no money moves.
                inState(STATES.CLOSED);
                requireHumanActor();
                const ref = data.caseRef;
                requireThat(ref && typeof ref === "object" && ref.orderId === order.id && typeof ref.caseId === "string",
                    "INVALID_CASE_REFERENCE");
                const item = order.financialCases.find(entry => entry.caseId === ref.caseId);
                requireThat(item, "UNKNOWN_CASE");
                const transition = FINANCIAL_CASE_POLICY.transitions.take_case;
                requireThat(item.status === transition.from, "CASE_STATE_INVALID");
                at = serverTime();
                audit = {
                    step: "TAKEN_FOR_REVIEW", caseId: item.caseId, orderId: order.id, caseType: item.caseType,
                    from: transition.from, to: transition.to, ...humanActor(), at, idempotencyKey: command.requestId,
                    policyVersion: FINANCIAL_CASE_POLICY.reference
                };
                next.financialCases = order.financialCases.map(entry => entry === item ? {
                    ...entry, status: transition.to, assignedActorId: principal.actorId,
                    auditTrail: [...entry.auditTrail, audit]
                } : entry);
                casesChanged = true;
                break;
            }
            case "add_case_evidence": {
                // Görev 206 (Faz 2B-3, TEST only): a verified finance or admin person adds one verified evidence entry to
                // a case UNDER_REVIEW. Every synchronous check runs before any verifier is called; the case keeps its
                // status, policy version and money fields; nothing is proposed, decided, approved or paid.
                inState(STATES.CLOSED);
                requireHumanActor();
                const record = data.caseEvidence;
                requireThat(record !== null && typeof record === "object" && !Array.isArray(record) &&
                    record.orderId === order.id && typeof record.caseId === "string", "INVALID_CASE_REFERENCE");
                const item = order.financialCases.find(entry => entry.caseId === record.caseId);
                requireThat(item, "UNKNOWN_CASE");
                const transition = FINANCIAL_CASE_POLICY.transitions.add_case_evidence;
                requireThat(item.status === transition.from, "CASE_STATE_INVALID");
                const request = checkCaseEvidenceSubmission(record, order, item, principal);
                // Görev 210 (OD-207-02, DQ-208-02/01): four eyes first, the person who decided the review never adds its
                // evidence; then only the person the case is assigned to may add it.
                requireThat(principal.actorId !== item.originDeciderActorId, "FOUR_EYES_VIOLATION");
                requireThat(principal.actorId === item.assignedActorId, "UNAUTHORIZED");
                requireThat(!caseReferences.has(record.authorizationRef) && !reviewReferences.has(record.authorizationRef),
                    "CASE_REFERENCE_USED");
                // DQ-203-06: the trusted time is fixed before any verifier is awaited; no tolerance.
                at = serverTime();
                notBefore(order, at);
                requireThat(caseEvidenceNotAfter(request, at), "EVIDENCE_TIME_INVALID");
                requireThat(verifyCaseEvidence !== null, "CASE_EVIDENCE_UNVERIFIABLE");
                requireThat(verifyCaseRecord !== null, "UNTRUSTED_REVIEW");
                // The console record first, then the evidence service (the CLOSE order); separate checks.
                const binding = caseEvidenceBinding(record);
                checkCaseRecordVerdict(await verifyCaseRecord(record, order, { binding }), binding);
                // Görev 210 (DQ-208-03): one own-data snapshot, checked here and by the claim gate alike.
                const attestation = caseAttestationSnapshot(await verifyCaseEvidence(record.evidence, request, order));
                checkCaseEvidenceAttestation(attestation, request);
                const claim = claimEvidence("FINANCIAL_CASE_EVIDENCE", request, attestation);
                caseRef = record.authorizationRef;
                // Flat: the only evidence-shaped object is the entry itself. No signature, content or free text is kept.
                const stored = {
                    evidenceId: request.evidenceId, digest: request.digest, evidenceKind: request.evidenceKind,
                    source: request.source, createdAt: request.createdAt, digestBasis: request.digestBasis,
                    evidencePolicyVersion: request.evidencePolicyVersion,
                    verifier: { kind: claim.verifier.kind, id: claim.verifier.id }, submittedBy: humanActor(),
                    addedAt: at, authorizationRef: record.authorizationRef, idempotencyKey: command.requestId,
                    eventSequence: order.version + 1, status: "ACTIVE", invalidation: null
                };
                // One audit object: the event's audit and the case audit trail entry; its evidence IS the stored entry.
                audit = {
                    step: "EVIDENCE_ADDED", caseId: item.caseId, orderId: order.id, caseType: item.caseType,
                    reviewId: item.origin.reviewId, from: transition.from, to: transition.to, ...humanActor(), at,
                    authorizationRef: record.authorizationRef, idempotencyKey: command.requestId,
                    policyVersion: FINANCIAL_CASE_POLICY.reference, evidencePolicyVersion: CASE_EVIDENCE_POLICY.reference,
                    evidence: stored
                };
                // Görev 214 (OD-211-01): the case is frozen as it is built, before the first suspension point; it holds
                // only objects the core made (the entry, this audit, new arrays) and committed, already frozen ones.
                next.financialCases = order.financialCases.map(entry => entry === item ? freezeDeep({
                    ...entry, evidenceReferences: [...entry.evidenceReferences, stored],
                    auditTrail: [...entry.auditTrail, audit]
                }) : entry);
                casesChanged = true;
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
        // Görev 169 (F168-01): a command outside the case registry may only append new cases (case creation); it can
        // never replace, reorder, drop or change an existing one. A case command added without registering it in
        // FINANCIAL_CASE_POLICY.transitions (and so without the gate above) is refused here before anything is committed.
        requireThat(caseCommand || (next.financialCases.length >= order.financialCases.length &&
            order.financialCases.every((entry, index) => next.financialCases[index] === entry)), "CASE_COMMAND_NOT_REGISTERED");
        // Görev 185 (2B-2a, A178-03/04): every claim is a frozen, well-formed gate claim for this order, unique within
        // the transition, and the claims are exactly the evidence this transition stores. Evidence stored without a
        // claim, or a claim for evidence that is not stored, is refused before anything is committed.
        requireThat(claimsBoundToCommand(evidenceClaims, order.id, command.kind), "EVIDENCE_MISMATCH");
        // Görev 193 (A186-01, A186-04): stored evidence is append-only, and evidence lives only in registered places.
        // Görev 197 (A194-02): so is the event log.
        requireThat(eventHistoryKept(order, next, null), "EVIDENCE_HISTORY_CHANGED");
        requireThat(evidenceHistoryKept(order, next), "EVIDENCE_HISTORY_CHANGED");
        requireThat(evidenceOnlyInRegisteredPlaces(order, next, audit, evidenceClaims), "EVIDENCE_STORAGE_INVALID");
        requireThat(claimsMatchStoredEvidence(order, next, evidenceClaims), "EVIDENCE_NOT_CLAIMED");
        requireThat(claimsMatchStoredLocations(order, next, evidenceClaims), "EVIDENCE_STORAGE_INVALID");
        // Görev 214 (OD-211-01, FD-212-02): what add_case_evidence planned, taken once its pre-check has passed.
        const planned = command.kind === "add_case_evidence"
            ? Object.freeze({ next: Object.freeze({ ...next }), cases: Object.freeze([...next.financialCases]) }) : null;
        next.version += 1;
        const event = {
            sequence: next.version, requestId: command.requestId, kind: command.kind,
            role: principal.role, from: order.state, to: next.state, fingerprint, at: at ?? serverTime(),
            previousHash: order.events.at(-1)?.hash || null
        };
        // Görev 206 (F197-04, DQ-203-10): the case evidence audit is frozen before anything is hashed, so the hashed content
        // cannot change; the audit of every other command is left as before (CLOSE unchanged).
        if (audit) event.audit = command.kind === "add_case_evidence" ? freezeDeep(audit) : audit;
        // Görev 164 (F160-03): an event that writes financial cases carries the digest of all of them, so the hash
        // chain covers case content, not only case ids. The same SHA-256 digest as the chain; no new trust assumption.
        if (casesChanged) event.financialCasesDigest = await digest(next.financialCases);
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
        requireThat(!reviewRef || (!reviewReferences.has(reviewRef) && !caseReferences.has(reviewRef)),
            "REVIEW_REFERENCE_USED");
        requireThat(!caseRef || (!caseReferences.has(caseRef) && !reviewReferences.has(caseRef)), "CASE_REFERENCE_USED");
        requireThat(!replanRef || !replanReferences.has(replanRef), "REPLAN_REFERENCE_USED");
        // Görev 197 (A194-05, DQ-195-06): the evidence invariants once more, after the last suspension point of the
        // dispatch and in the same synchronous block as the registry re-check and every write: whatever changed the
        // claims, the order, its event log or the audit meanwhile is refused here, in the order of the pre-check.
        requireThat(claimsBoundToCommand(evidenceClaims, order.id, command.kind), "EVIDENCE_MISMATCH");
        requireThat(eventHistoryKept(order, next, event), "EVIDENCE_HISTORY_CHANGED");
        requireThat(evidenceHistoryKept(order, next), "EVIDENCE_HISTORY_CHANGED");
        requireThat(evidenceOnlyInRegisteredPlaces(order, next, audit, evidenceClaims), "EVIDENCE_STORAGE_INVALID");
        requireThat(claimsMatchStoredEvidence(order, next, evidenceClaims), "EVIDENCE_NOT_CLAIMED");
        requireThat(claimsMatchStoredLocations(order, next, evidenceClaims), "EVIDENCE_STORAGE_INVALID");
        requireThat(caseEvidenceTransitionKept(order, next, planned, audit), "EVIDENCE_HISTORY_CHANGED");
        assertClaimsFree();
        // Görev 150 (F-02): the linked order must be exactly the record that was checked; any change since is a refusal.
        requireThat(!linkedOrder || orders.get(linkedOrder.id) === linkedOrder, "LINKED_ORDER_CHANGED");
        const committed = freezeDeep(next);
        orders.set(order.id, committed);
        if (command.kind === "verify_payment") paymentReferences.set(payment.reference, order.id);
        if (surcharge !== null) paymentReferences.set(surcharge, order.id);
        if (restorationRef) restorationReferences.set(restorationRef, order.id);
        if (reviewRef) reviewReferences.set(reviewRef, order.id);
        if (replanRef) replanReferences.set(replanRef, order.id);
        if (caseRef) caseReferences.set(caseRef, order.id);
        recordClaims();
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
