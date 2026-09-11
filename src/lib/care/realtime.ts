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
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void carePost({ kind: "consult_read", id: consultId })
        .then(data => setView(consultViewSchema.parse(data))).catch(() => setLive("offline")), 40);
    };
    const channel = supabase.channel(`consult:${consultId}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, refresh);
    void supabase.realtime.setAuth().then(() => channel.subscribe(status => setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting")));
    return () => { if (timer.current) clearTimeout(timer.current); void supabase.removeChannel(channel); };
  }, [consultId]);
  return { view, setView, live };
}
