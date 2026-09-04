
CREATE TABLE public.products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(10,2) NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.products TO anon, authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Products are publicly readable" ON public.products FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  reference TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ORDER_CREATED',
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  rider_name TEXT,
  rider_rating NUMERIC(2,1),
  rider_vehicle TEXT,
  dispatch_at TIMESTAMPTZ,
  eta_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers read own orders" ON public.orders FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  qty INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers read own order items" ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

CREATE TABLE public.order_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.order_events TO authenticated;
GRANT ALL ON public.order_events TO service_role;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers read own order events" ON public.order_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

CREATE TABLE public.payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'AUTHORIZED',
  provider_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers read own payments" ON public.payments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

CREATE INDEX idx_orders_user ON public.orders(user_id, created_at DESC);
CREATE INDEX idx_order_events_order ON public.order_events(order_id, created_at);

INSERT INTO public.products (sku, name, description, price, stock) VALUES
  ('SKU-AUR-100', 'Aurora Wireless Headphones', 'ANC over-ear, 40h battery', 189, 12),
  ('SKU-VTX-204', 'Vertex Mechanical Keyboard', 'Hot-swap, gasket mount', 129, 7),
  ('SKU-NMD-310', 'Nomad Travel Backpack', '28L, weatherproof shell', 99, 0),
  ('SKU-PLS-118', 'Pulse Smartwatch', 'AMOLED, dual-band GPS', 249, 5);

-- Order Service: creates the order, then calls Inventory and Payment inline (saga orchestration)
CREATE OR REPLACE FUNCTION public.place_order(items JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  new_id UUID;
  ref TEXT;
  trace TEXT;
  item JSONB;
  prod public.products%ROWTYPE;
  short_name TEXT;
  order_total NUMERIC(10,2) := 0;
  line_count INTEGER := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF items IS NULL OR jsonb_array_length(items) = 0 THEN
    RAISE EXCEPTION 'Order must contain at least one item';
  END IF;

  ref := 'ORD-' || upper(substr(md5(random()::text), 1, 6));
  trace := 'trc-' || upper(substr(md5(random()::text), 1, 6));

  INSERT INTO public.orders (user_id, reference, trace_id, state, total)
  VALUES (uid, ref, trace, 'ORDER_CREATED', 0)
  RETURNING id INTO new_id;

  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    SELECT * INTO prod FROM public.products WHERE sku = item->>'sku';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown SKU %', item->>'sku';
    END IF;
    INSERT INTO public.order_items (order_id, sku, name, price, qty)
    VALUES (new_id, prod.sku, prod.name, prod.price, (item->>'qty')::int);
    order_total := order_total + prod.price * (item->>'qty')::int;
    line_count := line_count + 1;
  END LOOP;

  UPDATE public.orders SET total = order_total WHERE id = new_id;

  INSERT INTO public.order_events (order_id, type, source, state, message)
  VALUES (new_id, 'order.placed', 'order-service', 'ORDER_CREATED',
          'Order persisted with state ORDER_CREATED · published to orders.events');

  -- Payment Service: authorize a hold
  INSERT INTO public.payments (order_id, amount, status, provider_ref)
  VALUES (new_id, order_total, 'AUTHORIZED', 'pay_' || substr(md5(random()::text), 1, 12));

  -- Inventory Service: atomic reservation across all lines
  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    UPDATE public.products
      SET stock = stock - (item->>'qty')::int
      WHERE sku = item->>'sku' AND stock >= (item->>'qty')::int;
    IF NOT FOUND THEN
      SELECT name INTO short_name FROM public.products WHERE sku = item->>'sku';
      -- compensation: release reservations made so far, void the payment hold
      FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
        UPDATE public.products p SET stock = stock + (item->>'qty')::int
        WHERE p.sku = item->>'sku'
          AND EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = new_id AND oi.sku = p.sku);
        EXIT;
      END LOOP;
      INSERT INTO public.order_events (order_id, type, source, state, message)
      VALUES (new_id, 'inventory.out_of_stock', 'inventory-service', 'OUT_OF_STOCK',
              short_name || ' unavailable · backorder logged');
      UPDATE public.payments SET status = 'VOIDED', updated_at = now() WHERE order_id = new_id;
      INSERT INTO public.order_events (order_id, type, source, state, message)
      VALUES (new_id, 'order.cancel_requested', 'order-service', 'CANCELLED',
              'Saga compensation: payment hold released · order cancelled');
      UPDATE public.orders SET state = 'CANCELLED', updated_at = now() WHERE id = new_id;
      RETURN new_id;
    END IF;
  END LOOP;

  INSERT INTO public.order_events (order_id, type, source, state, message)
  VALUES (new_id, 'inventory.reserved', 'inventory-service', 'INVENTORY_RESERVED',
          'Stock reserved atomically (optimistic lock) · ' || line_count || ' line item(s)');
  UPDATE public.orders SET state = 'INVENTORY_RESERVED', updated_at = now() WHERE id = new_id;

  -- Payment Service: capture
  UPDATE public.payments SET status = 'CAPTURED', updated_at = now() WHERE order_id = new_id;
  INSERT INTO public.order_events (order_id, type, source, state, message)
  VALUES (new_id, 'payment.captured', 'payment-service', 'PAYMENT_CAPTURED',
          'Payment captured · hold converted to charge');
  UPDATE public.orders
    SET state = 'PAYMENT_CAPTURED', dispatch_at = now() + interval '6 seconds', updated_at = now()
    WHERE id = new_id;

  RETURN new_id;
END;
$$;

-- Dispatch/Delivery progression driven by the database clock
CREATE OR REPLACE FUNCTION public.advance_orders()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  o public.orders%ROWTYPE;
  riders TEXT[][] := ARRAY[
    ARRAY['Brian K.','4.9','E-bike · KMN 412B'],
    ARRAY['Aisha M.','4.8','Motorbike · KMF 220C'],
    ARRAY['Daniel O.','4.7','Van · KDJ 883A']
  ];
  pick INTEGER;
BEGIN
  IF uid IS NULL THEN RETURN; END IF;

  FOR o IN SELECT * FROM public.orders
           WHERE user_id = uid AND state IN ('PAYMENT_CAPTURED','DISPATCHED') LOOP
    IF o.state = 'PAYMENT_CAPTURED' AND o.dispatch_at IS NOT NULL AND now() >= o.dispatch_at THEN
      pick := 1 + floor(random() * 3)::int;
      UPDATE public.orders SET
        state = 'DISPATCHED',
        rider_name = riders[pick][1],
        rider_rating = riders[pick][2]::numeric,
        rider_vehicle = riders[pick][3],
        eta_at = now() + interval '45 seconds',
        updated_at = now()
      WHERE id = o.id;
      INSERT INTO public.order_events (order_id, type, source, state, message)
      VALUES (o.id, 'dispatch.assigned', 'dispatch-service', 'DISPATCHED',
              'Rider matched within 5 km geo-radius · ' || riders[pick][1] || ' accepted the job');
    ELSIF o.state = 'DISPATCHED' AND o.eta_at IS NOT NULL AND now() >= o.eta_at THEN
      UPDATE public.orders SET state = 'DELIVERED', updated_at = now() WHERE id = o.id;
      INSERT INTO public.order_events (order_id, type, source, state, message)
      VALUES (o.id, 'delivery.confirmed', 'delivery-service', 'DELIVERED',
              'Proof of delivery verified (OTP) · saga closed');
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_order(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_orders() TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.order_events;
