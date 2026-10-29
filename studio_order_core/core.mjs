/* Isolated, in-memory prototype. Never publish this file or treat caller-supplied roles as authentication. */
import { CalendarError, REVISION_OUTCOMES, TARIFFS, evaluateRevisionRequest, isEligible } from "./calendar.mjs";

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

function instant(value, code) {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    requireThat(Number.isSafeInteger(ms), code);
    return ms;
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
 * combinations. REFUND is finance-only; an admin CLOSE needs a verified reason code. Combinations missing
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

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
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
 * producer/admin console record that the producer failed to deliver an accepted revision.
 * verifyReview(record, canonicalOrder) must return true only for a finance/admin console record that
 * opens a cancellation, refund or dispute review, or that resolves the open review. A REFUND outcome
 * is a recorded decision only; this core never moves money. `reviewPolicy` is the active review
 * outcome matrix (default APPROVED_REVIEW_POLICY; an injected one may only narrow it). For review commands
 * authorize() must also bind principal.actorId to the authenticated session: that id is the trusted actor
 * identity for the audit and the four-eyes rule, never a value taken from the request body.
 * verifyReplan(record, canonicalOrder) must return true
 * only for a producer/admin console delivery-date proposal, or for a customer confirmation that the
 * server's confirmation service recorded for exactly this order, proposal and date.
 * No callback may trust browser claims. No Shopier, booking or notification adapter is provided.
 * Notifications are only recorded as PENDING_OUTBOX entries in this in-memory prototype;
 * nothing is sent, and the event log is not a persistent or tamper-proof audit store.
 * Never expose this core instance or its callbacks to a client.
 */
export function createCore({ authorize, verifyPayment, verifyEmail, verifyBooking, verifyRestoration, verifyReview,
    verifyReplan, reviewPolicy = APPROVED_REVIEW_POLICY, calendar, clock = () => new Date().toISOString() } = {}) {
    requireThat(typeof clock === "function", "INVALID_CLOCK");
    const policy = loadReviewPolicy(reviewPolicy);
    // The private registry is the only authority for state. External snapshots are ID handles,
    // not persisted records. A new process has no authority to restore them and fails closed.
    const orders = new Map();
    const paymentReferences = new Map();
    const restorationReferences = new Map();
    const reviewReferences = new Map();
    const replanReferences = new Map();

    function createOrder(packageId) {
        requireThat(Object.hasOwn(PACKAGES, packageId), "INVALID_PACKAGE");
        const order = freezeDeep({
            id: globalThis.crypto.randomUUID(), packageId, state: STATES.DRAFT,
            version: 0, events: [], paymentReference: null, booking: null, slaStartsAt: null, productionStartedAt: null,
            options: [], revisionsUsed: 0, revisions: [], notifications: [], reviews: [], selectedOption: null,
            delivery: null, replannedDeadline: null, deliveryReplans: [], financialAssessments: []
        });
        orders.set(order.id, order);
        return order;
    }

    async function dispatch(snapshot, command, principal) {
        requireThat(snapshot && typeof snapshot.id === "string" && opaque(snapshot.id.replaceAll("-", "")), "INVALID_ORDER");
        const order = orders.get(snapshot.id);
        requireThat(order, "UNKNOWN_ORDER");
        requireThat(snapshot.packageId === order.packageId, "INVALID_ORDER");
        requireThat(command && typeof command === "object" && opaque(command.requestId), "INVALID_COMMAND");
        const requiredRole = roleFor(command.kind, principal);
        requireThat(typeof requiredRole === "string", "UNKNOWN_ACTION");
        // The server adapter must authenticate the principal; a browser-provided role is never trusted.
        requireThat(principal && principal.role === requiredRole &&
            (requiredRole !== "customer" || principal.orderId === order.id), "UNAUTHORIZED");
        requireThat(typeof authorize === "function" && await authorize(principal, order, requiredRole) === true,
            "UNAUTHORIZED");
        requireThat(orders.get(order.id) === order, "VERSION_CONFLICT");
        const data = command.data || {};
        const payment = data.proof;
        // Only the fingerprint is logged; no raw proof or contact is persisted.
        const intent = [command.kind, data.options, data.selectedOption, data.mp3Ref,
        data.wavRef, data.wavFeasible, data.proof, data.booking, data.revisionId, data.restoration, data.review,
        data.resolution, data.proposal, data.confirmation];
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
            deliveryReplans: [...order.deliveryReplans], financialAssessments: [...order.financialAssessments]
        };
        const inState = (...states) => requireThat(states.includes(order.state), "INVALID_TRANSITION");
        // Trusted server time for the transition; commands that read the clock fix it here once.
        let at = null;
        let audit = null;
        let restorationRef = null;
        let reviewRef = null;
        let replanRef = null;
        const openRevision = () => order.revisions.findLast(revision => revision.status === "ACCEPTED");
        // Decision 134-A: a customer-confirmed new date supersedes, but never overwrites, the booked deadline.
        const effectiveDeadline = () => order.replannedDeadline ?? order.booking?.deadline ?? null;
        const requireLiveDeadline = () => {
            // After a review, time-bound work waits for a confirmed new commitment once the current one has passed.
            at ??= clock();
            const due = effectiveDeadline();
            requireThat(order.reviews.length === 0 || due === null || Date.parse(due) > instant(at, "INVALID_CLOCK"),
                "DELIVERY_REPLAN_REQUIRED");
        };
        const replanStates = [STATES.START_APPROVED, STATES.IN_PRODUCTION, STATES.REVISION_PENDING, STATES.FINAL_SELECTED];
        const expire = replan => ({
            ...replan, status: "EXPIRED", expiry: {
                orderId: order.id, replanId: replan.replanId, expiredAt: replan.expiresAt, recordedAt: at,
                recordedBy: command.kind, role: principal.role, idempotencyKey: command.requestId
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
                next.productionStartedAt = clock();
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
            case "restore_revision_right": {
                // PDR-27: one restoration for an accepted, undelivered revision when the producer could not deliver.
                // IN_PRODUCTION is admitted only to report delivered/restored revisions precisely; it has no open one.
                inState(STATES.REVISION_PENDING, STATES.IN_PRODUCTION);
                const record = data.restoration;
                requireThat(record && typeof record === "object" && record.orderId === order.id &&
                    record.revisionId === data.revisionId && record.source === RESTORATION_SOURCES[principal.role],
                    "RESTORATION_MISMATCH");
                const target = order.revisions.find(revision => revision.revisionId === data.revisionId);
                requireThat(target, "UNKNOWN_REVISION");
                requireThat(target.status !== "RESTORED", "ALREADY_RESTORED");
                requireThat(target.status !== "DELIVERED", "REVISION_ALREADY_DELIVERED");
                requireThat(target === openRevision(), "UNKNOWN_REVISION");
                requireThat(record.reasonCode === "PRODUCER_NON_DELIVERY" && opaque(record.authorizationRef),
                    "INVALID_RESTORATION");
                requireThat(typeof verifyRestoration === "function" &&
                    await verifyRestoration(record, order) === true, "UNTRUSTED_RESTORATION");
                requireThat(!restorationReferences.has(record.authorizationRef), "RESTORATION_REFERENCE_USED");
                requireThat(order.revisionsUsed >= 1, "REVISION_LIMIT");
                at = clock();
                restorationRef = record.authorizationRef;
                audit = {
                    orderId: order.id, revisionId: target.revisionId, reasonCode: record.reasonCode,
                    authorizationRef: record.authorizationRef, at, idempotencyKey: command.requestId
                };
                next.revisionsUsed -= 1;
                next.revisions = order.revisions.map(revision => revision === target
                    ? { ...revision, status: "RESTORED", restoration: audit } : revision);
                next.state = STATES.IN_PRODUCTION;
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
                requireThat(opaque(principal.actorId), "ACTOR_REQUIRED");
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
                at = clock();
                reviewRef = record.authorizationRef;
                const id = `review-${String(order.reviews.length + 1).padStart(4, "0")}`;
                audit = {
                    orderId: order.id, reviewId: id, type: record.type, actorId: principal.actorId, role: principal.role,
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
                requireThat(opaque(principal.actorId), "ACTOR_REQUIRED");
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
                requireThat(principal.role !== "admin" || record.outcome !== REVIEW_OUTCOMES.CLOSE ||
                    record.reasonCode != null, "CLOSE_REASON_REQUIRED");
                requireThat(typeof verifyReview === "function" && await verifyReview(record, order) === true,
                    "UNTRUSTED_REVIEW");
                requireThat(!reviewReferences.has(record.authorizationRef), "REVIEW_REFERENCE_USED");
                at = clock();
                reviewRef = record.authorizationRef;
                audit = {
                    orderId: order.id, reviewId: openReview.reviewId, outcome: record.outcome,
                    actorId: principal.actorId, role: principal.role, reasonCode: record.reasonCode ?? null,
                    authorizationRef: record.authorizationRef, at, policyReference: policy.reference,
                    idempotencyKey: command.requestId
                };
                // A REFUND outcome records the decision only: no money moves and no right is reset.
                next.reviews = order.reviews.map(review => review === openReview
                    ? { ...review, status: "RESOLVED", resolution: { ...audit, moneyMovement: "NONE" } } : review);
                next.state = record.outcome === REVIEW_OUTCOMES.CONTINUE ? openReview.resumeState : STATES.CLOSED;
                if (next.state === STATES.CLOSED) {
                    // Decision 134-B: accepted, undelivered revisions keep their record and right and are flagged
                    // for an authorized financial review. No amount is computed and no money moves here.
                    for (const revision of order.revisions.filter(item => item.status === "ACCEPTED")) {
                        next.financialAssessments.push({
                            assessmentId: `assessment-${String(next.financialAssessments.length + 1).padStart(4, "0")}`,
                            orderId: order.id, reviewId: openReview.reviewId, revisionId: revision.revisionId,
                            reason: "ACCEPTED_NOT_DELIVERED", status: "PENDING_FINANCIAL_REVIEW", amountKurus: null,
                            moneyMovement: "NONE", createdAt: at
                        });
                    }
                }
                break;
            }
            case "propose_delivery_date": {
                // Decision 134-A: after a CONTINUE review, a producer/admin may propose a new date once the current
                // commitment has passed. The proposal is a separate record; it never becomes the deadline by itself.
                inState(...replanStates);
                requireThat(order.reviews.some(review => review.resolution?.outcome === REVIEW_OUTCOMES.CONTINUE),
                    "REPLAN_NOT_ALLOWED");
                const record = data.proposal;
                requireThat(record && typeof record === "object" && record.kind === "DELIVERY_PROPOSAL" &&
                    record.orderId === order.id && record.source === RESTORATION_SOURCES[principal.role] &&
                    opaque(record.authorizationRef) && typeof record.proposedDeadline === "string", "INVALID_PROPOSAL");
                at = clock();
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
                    orderId: order.id, replanId: id, proposedDeadline: proposed, missedDeadline: missed,
                    authorizationRef: record.authorizationRef, at, expiresAt, idempotencyKey: command.requestId
                };
                if (previous) next.deliveryReplans = order.deliveryReplans.map(replan => replan === previous
                    ? expire(replan) : replan);
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
                const pending = order.deliveryReplans.findLast(replan => replan.status === "PROPOSED");
                requireThat(pending, "REPLAN_NOT_PENDING");
                at = clock();
                requireThat(instant(at, "INVALID_CLOCK") >= Date.parse(pending.expiresAt), "PROPOSAL_NOT_EXPIRED");
                const expired = expire(pending);
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
                    record.proposedDeadline === pending.proposedDeadline && ["ACCEPT", "REJECT"].includes(record.decision) &&
                    record.source === CONFIRMATION_SOURCE && opaque(record.confirmationRef), "INVALID_CONFIRMATION");
                requireThat(typeof verifyReplan === "function" && await verifyReplan(record, order) === true,
                    "UNTRUSTED_CONFIRMATION");
                requireThat(!replanReferences.has(record.confirmationRef), "REPLAN_REFERENCE_USED");
                at = clock();
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
            role: principal.role, from: order.state, to: next.state, fingerprint, at: at ?? clock(),
            previousHash: order.events.at(-1)?.hash || null
        };
        if (audit) event.audit = audit;
        requireThat(typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)), "INVALID_CLOCK");
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
        const committed = freezeDeep(next);
        orders.set(order.id, committed);
        if (command.kind === "verify_payment") paymentReferences.set(payment.reference, order.id);
        if (surcharge !== null) paymentReferences.set(surcharge, order.id);
        if (restorationRef) restorationReferences.set(restorationRef, order.id);
        if (reviewRef) reviewReferences.set(reviewRef, order.id);
        if (replanRef) replanReferences.set(replanRef, order.id);
        return committed;
    }
    return Object.freeze({ createOrder, dispatch });
}
