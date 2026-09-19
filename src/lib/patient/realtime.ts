"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { readView, type PatientView, type ViewSection } from "./model";
import { createReadQueue } from "./read-queue";
import { isTransientReadError } from "./read-errors";

type ViewQuery = Omit<NonNullable<Parameters<typeof readView>[2]>, "signal">;

export function useRealtimePatientView(initial: PatientView, section: ViewSection, query: ViewQuery = {}) {
  const [view, setView] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const [retrying, setRetrying] = useState(true);
  const [readError, setReadError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const suspendCurrent = useRef<(() => Promise<() => void>) | null>(null);
  const subject = initial.profile.id;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let suspended = false;
    let permanentFailure = false;
    let readStopped = false;
    const options: ViewQuery = JSON.parse(queryKey);
    const queue = createReadQueue({
      online: navigator.onLine,
      read: signal => readView(subject, section, {...options, signal}),
      onSuccess: next => {
        readStopped = false;
        setView(next);
        setReadError("");
        setRetrying(false);
        setLive(channel.state === "joined" ? "live" : "connecting");
      },
      onError: (error, willRetry) => {
        permanentFailure = !isTransientReadError(error);
        readStopped = !willRetry;
        setReadError(error instanceof Error ? error.message : "We could not refresh this view.");
        setRetrying(willRetry);
        setLive("offline");
      },
    });
    suspendCurrent.current = async () => {
      suspended = true;
      setLive("connecting");
      setRetrying(false);
      await queue.dispose();
      return () => { if (!disposed) setReadVersion(version => version + 1); };
    };
    const refresh = () => {
      if (disposed || suspended || permanentFailure || !navigator.onLine) return false;
      const accepted = queue.refresh();
      if (accepted) { readStopped = false; setRetrying(true); }
      return accepted;
    };
    const channel = supabase.channel(`patient:${subject}`, { config: { private: true } })
      .on("broadcast", { event: "changed" }, refresh);
    const offline = () => { if (suspended) return; queue.setOnline(false); setRetrying(false); setLive("offline"); };
    const online = () => { if (!suspended && queue.setOnline(true) && !permanentFailure) { setRetrying(true); setLive("connecting"); } };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void supabase.realtime.setAuth().then(() => {
      if (disposed || suspended) return;
      channel.subscribe(status => {
        if (disposed || suspended) return;
        if (permanentFailure) return;
        // Read again after joining, including reconnects, to recover missed pings.
        if (status === "SUBSCRIBED") {
          if (refresh()) setLive("connecting");
          else setRetrying(false);
        } else {
          setLive(status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting");
          setRetrying(navigator.onLine && !readStopped);
        }
      });
    }).catch(() => { if (!disposed && !suspended) { setLive("offline"); setRetrying(false); setReadError("Live updates could not connect. Refresh this page to retry."); } });
    return () => { disposed = true; suspendCurrent.current = null; window.removeEventListener("offline", offline); window.removeEventListener("online", online); void queue.dispose(); void supabase.removeChannel(channel); };
  }, [section, subject, queryKey, readVersion]);
  async function suspendReads() { return await suspendCurrent.current?.() ?? (() => undefined); }
  return { view, setView, live, retrying, readError, suspendReads };
}
