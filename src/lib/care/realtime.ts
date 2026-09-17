"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { createClient } from "@/utils/supabase/client";
import { carePost, consultViewSchema } from "./model";

type ConsultView = z.infer<typeof consultViewSchema>;

/** The channel carries only a "changed" ping. The thread itself is re-read through
 * hms_consult_read, so participation and consent are re-checked on every refresh. */
export function useRealtimeConsult(initial: ConsultView) {
  const [view, setView] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consultId = initial.consult.id;
  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let request: AbortController | undefined;
    const refresh = () => {
      if (disposed) return;
      if (timer.current) clearTimeout(timer.current);
      request?.abort();
      const controller = new AbortController();
      request = controller;
      timer.current = setTimeout(() => void carePost({ kind: "consult_read", id: consultId }, controller.signal)
        .then(data => { if (!disposed && !controller.signal.aborted) { setView(consultViewSchema.parse(data)); if (channel.state === "joined") setLive("live"); } })
        .catch(() => { if (!disposed && !controller.signal.aborted) setLive("offline"); }), 40);
    };
    const channel = supabase.channel(`consult:${consultId}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, refresh);
    const offline = () => { request?.abort(); if (timer.current) clearTimeout(timer.current); setLive("offline"); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    void supabase.realtime.setAuth().then(() => {
      if (disposed) return;
      channel.subscribe(status => {
        if (disposed) return;
        setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting");
        if (status === "SUBSCRIBED") refresh();
      });
    }).catch(() => { if (!disposed) setLive("offline"); });
    return () => { disposed = true; window.removeEventListener("offline", offline); window.removeEventListener("online", refresh); request?.abort(); if (timer.current) clearTimeout(timer.current); void supabase.removeChannel(channel); };
  }, [consultId]);
  return { view, setView, live };
}
