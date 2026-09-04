// Client-side simulation of the event-driven order saga from the API spec.
// Mirrors the contracts: ORDER_CREATED → INVENTORY_RESERVED → PAYMENT_CAPTURED
// → DISPATCHED → DELIVERED, with OUT_OF_STOCK / CANCELLED compensation.

export type OrderState =
  | "ORDER_CREATED"
  | "INVENTORY_RESERVED"
  | "PAYMENT_CAPTURED"
  | "DISPATCHED"
  | "DELIVERED"
  | "OUT_OF_STOCK"
  | "CANCELLED";

export interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  price: number;
  stock: number;
}

export interface OrderLine {
  sku: string;
  name: string;
  price: number;
  qty: number;
}

export interface OrderEvent {
  id: string;
  type: string;
  source: string;
  time: string;
  state: OrderState;
  message: string;
  traceId: string;
}

export interface ActiveOrder {
  id: string;
  traceId: string;
  state: OrderState;
  lines: OrderLine[];
  total: number;
  events: OrderEvent[];
  rider?: { name: string; rating: number; vehicle: string };
  etaSeconds?: number;
}

export const CATALOG: CatalogItem[] = [
  { sku: "SKU-AUR-100", name: "Aurora Wireless Headphones", description: "ANC over-ear, 40h battery", price: 189, stock: 12 },
  { sku: "SKU-VTX-204", name: "Vertex Mechanical Keyboard", description: "Hot-swap, gasket mount", price: 129, stock: 7 },
  { sku: "SKU-NMD-310", name: "Nomad Travel Backpack", description: "28L, weatherproof shell", price: 99, stock: 0 },
  { sku: "SKU-PLS-118", name: "Pulse Smartwatch", description: "AMOLED, dual-band GPS", price: 249, stock: 5 },
];

const RIDERS = [
  { name: "Brian K.", rating: 4.9, vehicle: "E-bike · KMN 412B" },
  { name: "Aisha M.", rating: 4.8, vehicle: "Motorbike · KMF 220C" },
  { name: "Daniel O.", rating: 4.7, vehicle: "Van · KDJ 883A" },
];

const rand = (n: number) => Math.floor(Math.random() * n);
const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export function runOrderSaga(
  lines: OrderLine[],
  onEvent: (e: OrderEvent) => void,
  onState: (s: OrderState, extra?: Partial<ActiveOrder>) => void,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const traceId = id("trc");
  const outOfStock = lines.find((l) => (CATALOG.find((c) => c.sku === l.sku)?.stock ?? 0) < l.qty);
  let seq = 0;

  const emit = (delay: number, ev: Omit<OrderEvent, "id" | "time" | "traceId">, state?: OrderState, extra?: Partial<ActiveOrder>) => {
    timers.push(
      setTimeout(() => {
        seq += 1;
        onEvent({ ...ev, id: `evt-${String(seq).padStart(3, "0")}`, time: new Date().toISOString(), traceId });
        if (state) onState(state, extra);
      }, delay),
    );
  };

  let t = 400;
  emit(t, { type: "order.placed", source: "order-service", state: "ORDER_CREATED", message: `Order persisted with state ORDER_CREATED · published to orders.events` }, "ORDER_CREATED");

  t += 1600;
  if (outOfStock) {
    emit(t, { type: "inventory.out_of_stock", source: "inventory-service", state: "OUT_OF_STOCK", message: `${outOfStock.name} unavailable · backorder logged` }, "OUT_OF_STOCK");
    t += 1500;
    emit(t, { type: "order.cancel_requested", source: "order-service", state: "CANCELLED", message: `Saga compensation: payment hold released · order cancelled` }, "CANCELLED");
    return () => timers.forEach(clearTimeout);
  }

  emit(t, { type: "inventory.reserved", source: "inventory-service", state: "INVENTORY_RESERVED", message: `Stock reserved atomically (optimistic lock) · ${lines.length} line item${lines.length > 1 ? "s" : ""}` }, "INVENTORY_RESERVED");

  t += 1600;
  emit(t, { type: "payment.captured", source: "payment-service", state: "PAYMENT_CAPTURED", message: `Payment captured · hold converted to charge` }, "PAYMENT_CAPTURED");

  t += 1800;
  const rider = RIDERS[rand(RIDERS.length)]!;
  emit(t, { type: "dispatch.assigned", source: "dispatch-service", state: "DISPATCHED", message: `Rider matched within 5 km geo-radius · ${rider.name} accepted in ${8 + rand(20)}s` }, "DISPATCHED", { rider, etaSeconds: 45 + rand(40) });

  t += 2400;
  emit(t, { type: "delivery.confirmed", source: "delivery-service", state: "DELIVERED", message: `Proof of delivery verified (OTP) · saga closed` }, "DELIVERED");

  return () => timers.forEach(clearTimeout);
}
