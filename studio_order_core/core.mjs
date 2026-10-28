/* Isolated, in-memory prototype. Never publish this file or treat caller-supplied roles as authentication. */
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
    REFUND_REVIEW: "REFUND_REVIEW", DISPUTED: "DISPUTED"
});

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

function roleFor(kind) {
    const roles = {
        submit: "customer", verify_payment: "finance", request_email: "customer",
        verify_email: "customer", request_booking: "customer", approve_start: "scheduler",
        start_production: "creative", initial_options: "creative", request_revision: "customer",
        revision_options: "creative", select_final: "customer", complete: "creative",
        cancel: "finance", refund_review: "finance", dispute: "customer"
    };
    return Object.hasOwn(roles, kind) ? roles[kind] : null;
}

/** Server-only interface: authorize(principal, canonicalOrder, role) and
 * verifyPayment(proof, canonicalOrder) must return true only after authenticated
 * seller-side reconciliation (including order/amount/currency/status/ref).
 * Neither callback may trust browser claims. No Shopier adapter is provided.
 * Never expose this core instance or its callbacks to a client.
 */
export function createCore({ authorize, verifyPayment, verifyEmail, clock = () => new Date().toISOString() } = {}) {
    requireThat(typeof clock === "function", "INVALID_CLOCK");
    // The private registry is the only authority for state. External snapshots are ID handles,
    // not persisted records. A new process has no authority to restore them and fails closed.
    const orders = new Map();
    const paymentReferences = new Map();

    function createOrder(packageId) {
        requireThat(Object.hasOwn(PACKAGES, packageId), "INVALID_PACKAGE");
        const order = freezeDeep({
            id: globalThis.crypto.randomUUID(), packageId, state: STATES.DRAFT,
            version: 0, events: [], paymentReference: null, productionStartedAt: null,
            options: [], revisionsUsed: 0, selectedOption: null, delivery: null
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
        const requiredRole = roleFor(command.kind);
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
        data.wavRef, data.wavFeasible, data.proof];
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
        const next = { ...order, options: [...order.options], events: [...order.events] };
        const inState = (...states) => requireThat(states.includes(order.state), "INVALID_TRANSITION");
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
            case "approve_start": inState(STATES.BOOKING_PENDING); next.state = STATES.START_APPROVED; break;
            case "start_production":
                inState(STATES.START_APPROVED);
                next.productionStartedAt = clock();
                requireThat(typeof next.productionStartedAt === "string" &&
                    !Number.isNaN(Date.parse(next.productionStartedAt)), "INVALID_CLOCK");
                next.state = STATES.IN_PRODUCTION;
                break;
            case "initial_options":
                inState(STATES.IN_PRODUCTION);
                requireThat(order.options.length === 0, "ALREADY_PUBLISHED");
                next.options = pair(data.options, order.options);
                break;
            case "request_revision":
                inState(STATES.IN_PRODUCTION);
                requireThat(order.options.length >= 2 && order.revisionsUsed < PACKAGES[order.packageId].revisions,
                    "REVISION_LIMIT");
                next.state = STATES.REVISION_PENDING;
                break;
            case "revision_options":
                inState(STATES.REVISION_PENDING);
                next.options.push(...pair(data.options, order.options));
                next.revisionsUsed += 1;
                requireThat(next.options.length <= PACKAGES[order.packageId].alternatives, "ALTERNATIVE_LIMIT");
                next.state = STATES.IN_PRODUCTION;
                break;
            case "select_final":
                inState(STATES.IN_PRODUCTION);
                requireThat(order.options.includes(data.selectedOption), "UNKNOWN_OPTION");
                next.selectedOption = data.selectedOption;
                next.state = STATES.FINAL_SELECTED;
                break;
            case "complete":
                inState(STATES.FINAL_SELECTED);
                requireThat(opaque(data.mp3Ref) && typeof data.wavFeasible === "boolean" &&
                    (data.wavFeasible ? opaque(data.wavRef) : data.wavRef == null), "INVALID_DELIVERY");
                next.delivery = {
                    selectedOption: order.selectedOption, mp3Ref: data.mp3Ref,
                    wavRef: data.wavFeasible ? data.wavRef : null, commercialRights: false
                };
                next.state = STATES.COMPLETED;
                break;
            case "cancel":
                inState(STATES.DRAFT, STATES.PAYMENT_PENDING, STATES.PAYMENT_VERIFIED, STATES.EMAIL_PENDING,
                    STATES.EMAIL_VERIFIED, STATES.BOOKING_PENDING, STATES.START_APPROVED, STATES.IN_PRODUCTION,
                    STATES.REVISION_PENDING, STATES.FINAL_SELECTED);
                next.state = STATES.CANCELLED;
                break;
            case "refund_review":
                inState(STATES.PAYMENT_VERIFIED, STATES.EMAIL_PENDING, STATES.EMAIL_VERIFIED,
                    STATES.BOOKING_PENDING, STATES.START_APPROVED, STATES.IN_PRODUCTION,
                    STATES.REVISION_PENDING, STATES.FINAL_SELECTED, STATES.COMPLETED);
                next.state = STATES.REFUND_REVIEW;
                break;
            case "dispute":
                inState(STATES.PAYMENT_VERIFIED, STATES.EMAIL_PENDING, STATES.EMAIL_VERIFIED,
                    STATES.BOOKING_PENDING, STATES.START_APPROVED, STATES.IN_PRODUCTION,
                    STATES.REVISION_PENDING, STATES.FINAL_SELECTED, STATES.COMPLETED);
                next.state = STATES.DISPUTED;
                break;
            default: throw new OrderError("UNKNOWN_ACTION");
        }
        next.version += 1;
        const event = {
            sequence: next.version, requestId: command.requestId, kind: command.kind,
            role: principal.role, from: order.state, to: next.state, fingerprint,
            at: command.kind === "start_production" ? next.productionStartedAt : clock(),
            previousHash: order.events.at(-1)?.hash || null
        };
        requireThat(typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)), "INVALID_CLOCK");
        event.hash = await digest(event);
        next.events.push(event);
        requireThat(orders.get(order.id) === order, "VERSION_CONFLICT");
        if (command.kind === "verify_payment") {
            requireThat(!paymentReferences.has(payment.reference), "PAYMENT_REFERENCE_USED");
        }
        const committed = freezeDeep(next);
        orders.set(order.id, committed);
        if (command.kind === "verify_payment") paymentReferences.set(payment.reference, order.id);
        return committed;
    }
    return Object.freeze({ createOrder, dispatch });
}
