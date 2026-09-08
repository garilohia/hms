"use client";
import { useEffect, useState } from "react";
export function PushTest() {
  const [status, setStatus] = useState("Checking browser notification support…");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    if (!("serviceWorker" in navigator) || !("Notification" in window)) {
      Promise.resolve().then(() => { if (live) setStatus("Notifications are unavailable in this browser."); });
      return () => { live = false; };
    }
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready).then(() => { if (live) { setReady(true); setStatus("Browser notification worker registered."); } })
      .catch(() => { if (live) setStatus("Notifications are unavailable in this browser."); });
    return () => { live = false; };
  }, []);
  async function test() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setStatus("Notifications are blocked. You can change this in browser settings."); return; }
      const worker = await navigator.serviceWorker.ready;
      await worker.showNotification("HMS test", { body: "This is a local browser test. No health data was sent.", tag: "hms-test" });
      setStatus("Local test notification shown. Server push is not enabled.");
    } catch { setStatus("Could not show the notification. Check browser permissions."); }
  }
  return <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Browser notifications</h2><p role="status">{status}</p><p className="text-sm text-slate-600">Server push is a stub in this build. This button tests a local notification only. In-app alerts still work.</p><button disabled={!ready} onClick={test} className="rounded-lg border px-4 py-2 disabled:opacity-50">Test browser notification</button></section>;
}
