"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { readView, type PatientView, type ViewSection } from "./model";

type ViewQuery = Omit<NonNullable<Parameters<typeof readView>[2]>, "signal">;

export function useRealtimePatientView(initial: PatientView, section: ViewSection, query: ViewQuery = {}) {
  const [view, setView] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subject = initial.profile.id;
  const queryKey = JSON.stringify(query);
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
      timer.current = setTimeout(() => {
        const options: ViewQuery = JSON.parse(queryKey);
        void readView(subject, section, {...options, signal: controller.signal})
          .then(next => { if (!controller.signal.aborted && !disposed) { setView(next); if (channel.state === "joined") setLive("live"); } })
          .catch(() => { if (!controller.signal.aborted && !disposed) setLive("offline"); });
      }, 40);
    };
    const channel = supabase.channel(`patient:${subject}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, refresh);
    const offline = () => { request?.abort(); if (timer.current) clearTimeout(timer.current); setLive("offline"); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    void supabase.realtime.setAuth().then(() => {
      if (disposed) return;
      channel.subscribe(status => {
        if (disposed) return;
        setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting");
        // Read again after joining, including reconnects, to recover missed pings.
        if (status === "SUBSCRIBED") refresh();
      });
    }).catch(() => { if (!disposed) setLive("offline"); });
    return () => { disposed = true; window.removeEventListener("offline", offline); window.removeEventListener("online", refresh); request?.abort(); if (timer.current) clearTimeout(timer.current); void supabase.removeChannel(channel); };
  }, [section, subject, queryKey]);
  return { view, setView, live };
}
