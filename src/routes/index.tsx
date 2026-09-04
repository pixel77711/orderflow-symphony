import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Package,
  ClipboardList,
  Boxes,
  CreditCard,
  Bike,
  CheckCircle2,
  XCircle,
  Minus,
  Plus,
  Radio,
  MapPin,
  Star,
  RotateCcw,
  Zap,
} from "lucide-react";
import {
  CATALOG,
  runOrderSaga,
  type ActiveOrder,
  type OrderLine,
  type OrderState,
} from "@/lib/order-saga";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NexusMart Customer Portal — Order Tracking" },
      { name: "description", content: "Place orders and watch them move through the event-driven pipeline in real time: placement, inventory, payment, dispatch, and delivery." },
      { property: "og:title", content: "NexusMart Customer Portal — Order Tracking" },
      { property: "og:description", content: "Real-time order execution flow: place an order and track every microservice event to your door." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Portal,
});

const STEPS: { state: OrderState; label: string; icon: typeof Package }[] = [
  { state: "ORDER_CREATED", label: "Order placed", icon: ClipboardList },
  { state: "INVENTORY_RESERVED", label: "Inventory reserved", icon: Boxes },
  { state: "PAYMENT_CAPTURED", label: "Payment captured", icon: CreditCard },
  { state: "DISPATCHED", label: "Rider dispatched", icon: Bike },
  { state: "DELIVERED", label: "Delivered", icon: CheckCircle2 },
];

const STATE_ORDER: OrderState[] = STEPS.map((s) => s.state);

function Portal() {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<ActiveOrder | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [order?.events.length]);

  // ETA countdown while dispatched
  useEffect(() => {
    if (!order || order.state !== "DISPATCHED" || order.etaSeconds == null) return;
    const iv = setInterval(() => {
      setOrder((o) =>
        o && o.state === "DISPATCHED" && o.etaSeconds != null && o.etaSeconds > 0
          ? { ...o, etaSeconds: o.etaSeconds - 1 }
          : o,
      );
    }, 1000);
    return () => clearInterval(iv);
  }, [order?.state]);

  const selectedLines: OrderLine[] = CATALOG.filter((c) => (quantities[c.sku] ?? 0) > 0).map((c) => ({
    sku: c.sku,
    name: c.name,
    price: c.price,
    qty: quantities[c.sku]!,
  }));
  const total = selectedLines.reduce((s, l) => s + l.price * l.qty, 0);
  const running = order && !["DELIVERED", "CANCELLED", "OUT_OF_STOCK"].includes(order.state);

  const setQty = (sku: string, delta: number) =>
    setQuantities((q) => ({ ...q, [sku]: Math.max(0, Math.min(9, (q[sku] ?? 0) + delta)) }));

  const placeOrder = () => {
    cancelRef.current?.();
    const newOrder: ActiveOrder = {
      id: `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      traceId: "",
      state: "ORDER_CREATED",
      lines: selectedLines,
      total,
      events: [],
    };
    setOrder(newOrder);
    cancelRef.current = runOrderSaga(
      selectedLines,
      (e) => setOrder((o) => (o ? { ...o, traceId: e.traceId, events: [...o.events, e] } : o)),
      (state, extra) => setOrder((o) => (o ? { ...o, state, ...extra } : o)),
    );
  };

  const reset = () => {
    cancelRef.current?.();
    setOrder(null);
    setQuantities({});
  };

  const failed = order?.state === "OUT_OF_STOCK" || order?.state === "CANCELLED";

  return (
    <div className="scanline min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/60 bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="event-glow flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Zap className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">NexusMart</h1>
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Customer Portal</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1.5">
            <Radio className={`h-3.5 w-3.5 ${running ? "animate-pulse text-success" : "text-muted-foreground"}`} />
            <span className="font-mono text-[11px] text-muted-foreground">
              {running ? "event bus · live" : "event bus · idle"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1fr_1.1fr]">
        {/* Left: catalog / order form */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Place an order</h2>
          <div className="mt-4 space-y-3">
            {CATALOG.map((item) => {
              const qty = quantities[item.sku] ?? 0;
              const out = item.stock === 0;
              return (
                <div
                  key={item.sku}
                  className={`flex items-center justify-between rounded-xl border bg-card p-4 transition-colors ${
                    qty > 0 ? "border-primary/60" : "border-border"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
                      <Package className="h-4 w-4 text-accent" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {item.sku} · {out ? <span className="text-destructive">out of stock</span> : `${item.stock} in stock`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-primary">${item.price}</span>
                    <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/50 p-0.5">
                      <button
                        onClick={() => setQty(item.sku, -1)}
                        disabled={qty === 0 || !!running}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                        aria-label={`Remove one ${item.name}`}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-5 text-center font-mono text-sm">{qty}</span>
                      <button
                        onClick={() => setQty(item.sku, 1)}
                        disabled={!!running}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                        aria-label={`Add one ${item.name}`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-card p-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {selectedLines.length === 0 ? "No items selected" : `${selectedLines.reduce((s, l) => s + l.qty, 0)} item(s)`}
              </p>
              <p className="font-mono text-xl font-bold text-primary">${total.toFixed(2)}</p>
            </div>
            <button
              onClick={placeOrder}
              disabled={selectedLines.length === 0 || !!running}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "Processing…" : "Place order"}
            </button>
          </div>
          <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
            POST /api/v1/orders → 202 Accepted · Idempotency-Key enforced. Tip: include the Nomad Backpack to see the
            OUT_OF_STOCK compensation saga.
          </p>
        </section>

        {/* Right: live status */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Order status</h2>
          {!order ? (
            <div className="mt-4 flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 text-center">
              <Package className="h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">No active order</p>
              <p className="text-xs text-muted-foreground/70">Place an order to watch the saga execute live.</p>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {/* Status timeline */}
              <div className="rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="font-mono text-sm font-bold text-primary">{order.id}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">trace {order.traceId || "…"}</p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold ${
                      order.state === "DELIVERED"
                        ? "bg-success/15 text-success"
                        : failed
                          ? "bg-destructive/15 text-destructive"
                          : "bg-primary/15 text-primary"
                    }`}
                  >
                    {order.state}
                  </span>
                </div>
                <ol className="space-y-1">
                  {STEPS.map((step, i) => {
                    const reached = !failed && STATE_ORDER.indexOf(order.state) >= i;
                    const current = !failed && order.state === step.state;
                    return (
                      <li key={step.state} className="flex items-center gap-3">
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-full border transition-all ${
                            current
                              ? "event-glow border-primary bg-primary text-primary-foreground"
                              : reached
                                ? "border-success/50 bg-success/15 text-success"
                                : "border-border bg-secondary/50 text-muted-foreground/50"
                          }`}
                        >
                          <step.icon className="h-4 w-4" />
                        </div>
                        {i < STEPS.length - 1 && (
                          <div className={`absolute ml-[15px] mt-9 h-4 w-px ${reached && !current ? "bg-success/50" : "bg-border"}`} />
                        )}
                        <span className={`py-2 text-sm ${reached ? "text-foreground" : "text-muted-foreground/50"}`}>
                          {step.label}
                        </span>
                        {current && order.state !== "DELIVERED" && (
                          <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-primary">in flight</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {failed && (
                  <div className="mt-4 flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <div className="flex items-center gap-2 text-sm text-destructive">
                      <XCircle className="h-4 w-4" />
                      {order.state === "OUT_OF_STOCK" ? "Item unavailable — backorder logged" : "Order cancelled, payment released"}
                    </div>
                    <button
                      onClick={reset}
                      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <RotateCcw className="h-3 w-3" /> New order
                    </button>
                  </div>
                )}
                {order.state === "DELIVERED" && (
                  <div className="mt-4 flex items-center justify-between rounded-lg border border-success/40 bg-success/10 p-3">
                    <div className="flex items-center gap-2 text-sm text-success">
                      <CheckCircle2 className="h-4 w-4" /> Delivered — enjoy!
                    </div>
                    <button
                      onClick={reset}
                      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <RotateCcw className="h-3 w-3" /> New order
                    </button>
                  </div>
                )}
              </div>

              {/* Rider tracking */}
              {order.rider && (
                <div className="rounded-xl border border-accent/40 bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15">
                        <Bike className="h-5 w-5 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{order.rider.name}</p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Star className="h-3 w-3 text-primary" /> {order.rider.rating} · {order.rider.vehicle}
                        </p>
                      </div>
                    </div>
                    {order.state === "DISPATCHED" && order.etaSeconds != null && (
                      <div className="text-right">
                        <p className="font-mono text-lg font-bold text-accent">
                          {Math.floor(order.etaSeconds / 60)}:{String(order.etaSeconds % 60).padStart(2, "0")}
                        </p>
                        <p className="flex items-center justify-end gap-1 font-mono text-[10px] text-muted-foreground">
                          <MapPin className="h-3 w-3" /> ETA
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Event stream */}
              <div className="rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Live event stream</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{order.events.length} events</span>
                </div>
                <div ref={logRef} className="max-h-56 space-y-2 overflow-y-auto p-4 font-mono text-[11px]">
                  {order.events.map((e) => (
                    <div key={e.id} className="rounded-lg bg-secondary/40 p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-accent">{e.type}</span>
                        <span className="text-muted-foreground/70">{new Date(e.time).toLocaleTimeString()}</span>
                      </div>
                      <p className="mt-0.5 text-muted-foreground">
                        [{e.source}] {e.message}
                      </p>
                    </div>
                  ))}
                  {running && <p className="animate-pulse text-primary">▍ consuming…</p>}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
