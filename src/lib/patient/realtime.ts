"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { readView, type PatientView, type ViewSection } from "./model";

export function useRealtimePatientView(initial: PatientView, section: ViewSection) {
  const [view, setView] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subject = initial.profile.id;
  useEffect(() => {
    const supabase = createClient();
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void readView(subject, section).then(setView).catch(() => setLive("offline")), 40);
    };
    const channel = supabase.channel(`patient:${subject}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, refresh);
    void supabase.realtime.setAuth().then(() => channel.subscribe(status => setLive(status === "SUBSCRIBED" ? "live" : status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting")));
    return () => { if (timer.current) clearTimeout(timer.current); void supabase.removeChannel(channel); };
  }, [section, subject]);
  return { view, setView, live };
}
