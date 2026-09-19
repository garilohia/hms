-- One shared budget per WHOOP client or Google project, never per patient.
-- Server-only callers reserve in a separate committed transaction before HTTP.
CREATE TABLE hms_private.provider_request_budgets (
  provider text NOT NULL CHECK (provider IN ('google_health', 'whoop')),
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  credits numeric NOT NULL CHECK (credits >= 0 AND credits <= CASE WHEN provider='whoop' THEN 10 ELSE 1 END),
  refilled_at timestamptz NOT NULL CHECK (isfinite(refilled_at)),
  blocked_until timestamptz CHECK (isfinite(blocked_until)),
  PRIMARY KEY (provider, scope_hash)
);
ALTER TABLE hms_private.provider_request_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hms_private.provider_request_budgets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hms_private.provider_request_budgets FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint
CREATE FUNCTION hms_private.reserve_provider_request(p_provider text, p_scope text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_bucket hms_private.provider_request_budgets%ROWTYPE;
  v_capacity numeric;
  v_rate numeric;
  v_now timestamptz;
  v_refilled timestamptz;
  v_credits numeric;
  v_retry timestamptz;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('google_health','whoop') OR p_scope IS NULL OR p_scope !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid provider budget scope' USING ERRCODE='22023';
  END IF;
  -- Conservative HMS caps, not a claim about the client's approved quota.
  -- WHOOP: <= 9,010 permits in any 24h and <= 17 in any minute.
  -- Google: <= 61 permits/min globally, therefore also for any single user.
  v_capacity := CASE WHEN p_provider='whoop' THEN 10 ELSE 1 END;
  v_rate := CASE WHEN p_provider='whoop' THEN 9000::numeric/86400 ELSE 1 END;
  INSERT INTO hms_private.provider_request_budgets(provider,scope_hash,credits,refilled_at)
    VALUES(p_provider,p_scope,v_capacity,clock_timestamp()) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_bucket FROM hms_private.provider_request_budgets
    WHERE provider=p_provider AND scope_hash=p_scope FOR UPDATE;
  -- Read the database clock after acquiring the row, not at transaction start.
  v_now := clock_timestamp();
  v_refilled := greatest(v_now,v_bucket.refilled_at);
  v_credits := least(v_capacity,v_bucket.credits + greatest(0,extract(epoch FROM v_now-v_bucket.refilled_at))*v_rate);
  IF v_bucket.blocked_until>v_now THEN v_retry := v_bucket.blocked_until; END IF;
  IF v_credits<1 THEN
    v_retry := greatest(v_retry,v_refilled+make_interval(secs => ((1-v_credits)/v_rate)::double precision));
  END IF;
  UPDATE hms_private.provider_request_budgets
    SET credits=CASE WHEN v_retry IS NULL THEN v_credits-1 ELSE v_credits END,refilled_at=v_refilled
    WHERE provider=p_provider AND scope_hash=p_scope;
  -- NULL means one permit was consumed. Refused attempts do not spend another.
  RETURN v_retry;
END;
$$;
REVOKE ALL ON FUNCTION hms_private.reserve_provider_request(text,text) FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint
CREATE FUNCTION hms_private.defer_provider_requests(p_provider text,p_scope text,p_retry_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_retry timestamptz;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('google_health','whoop') OR p_scope IS NULL OR p_scope !~ '^[a-f0-9]{64}$' OR p_retry_at IS NULL OR NOT isfinite(p_retry_at) THEN
    RAISE EXCEPTION 'Invalid provider cooldown' USING ERRCODE='22023';
  END IF;
  INSERT INTO hms_private.provider_request_budgets(provider,scope_hash,credits,refilled_at,blocked_until)
    VALUES(p_provider,p_scope,0,clock_timestamp(),greatest(p_retry_at,clock_timestamp()+interval '1 second'))
    ON CONFLICT(provider,scope_hash) DO UPDATE
      SET blocked_until=greatest(hms_private.provider_request_budgets.blocked_until,excluded.blocked_until)
    RETURNING blocked_until INTO v_retry;
  -- A subsequent shorter 429 cannot shorten a cooldown or replenish credits.
  RETURN v_retry;
END;
$$;
REVOKE ALL ON FUNCTION hms_private.defer_provider_requests(text,text,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
