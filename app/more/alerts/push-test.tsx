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
      setStatus("Local test notification shown.");
    } catch { setStatus("Could not show the notification. Check browser permissions."); }
  }
  async function enable() {
    try {
      const publicKey=process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if(!publicKey) { setStatus("Server push needs VAPID keys in the environment."); return; }
      const permission=await Notification.requestPermission();
      if(permission!=="granted") { setStatus("Notifications are blocked in browser settings."); return; }
      const registration=await navigator.serviceWorker.ready;
      const bytes=Uint8Array.from(atob(publicKey.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(publicKey.length/4)*4,"=")),character=>character.charCodeAt(0));
      const current=await registration.pushManager.getSubscription();
      const value=current||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      const response=await fetch("/api/alerts/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"subscribe",subscription:value.toJSON()})});
      if(!response.ok)throw new Error();setStatus("Instant browser alerts enabled on this device.");
    } catch { setStatus("Could not enable server push. Check the VAPID configuration and retry."); }
  }
  async function disable() {
    try { const registration=await navigator.serviceWorker.ready,value=await registration.pushManager.getSubscription();if(value){await fetch("/api/alerts/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"unsubscribe",endpoint:value.endpoint})});await value.unsubscribe();}setStatus("Browser alerts disabled on this device."); }
    catch { setStatus("Could not disable browser alerts. Please retry."); }
  }
  return <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Instant browser notifications</h2><p role="status">{status}</p><p className="muted">When HMS receives an unusual live reading, this device can be notified even when the site is closed. Lock-screen text never includes health values.</p><div className="flex flex-wrap gap-2"><button disabled={!ready} onClick={enable} className="rounded-lg border px-4 py-2 disabled:opacity-50">Enable instant alerts</button><button disabled={!ready} onClick={test} className="rounded-lg border px-4 py-2 disabled:opacity-50">Test notification</button><button disabled={!ready} onClick={disable} className="rounded-lg border px-4 py-2 disabled:opacity-50">Disable</button></div></section>;
}
