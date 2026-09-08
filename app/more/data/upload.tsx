"use client";
import { useEffect, useRef, useState } from "react";
import type { ImportProgress } from "@/src/lib/ingestion/files";
import type { ImportRequest } from "@/src/lib/ingestion/import.worker";
import { httpTransport } from "@/src/lib/ingestion/http";
import { SimulatorAdapter, personas, type Persona } from "@/src/lib/ingestion/simulator";

type Profile = { id: string; name: string; kind: "self" | "dependent"; timezone: string };
export function DataImport({ profiles, onBusyChange, onComplete }: { profiles: Profile[]; onBusyChange?: (busy:boolean)=>void; onComplete?:()=>void }) {
  const [userId, setUserId] = useState(profiles[0]?.id || "");
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File>();
  const [key, setKey] = useState("CSV");
  const [persona, setPersona] = useState<Persona>("b");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<ImportProgress>();
  const worker = useRef<Worker | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { worker.current?.terminate(); abort.current?.abort(); }, []);
  useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
  const selected = profiles.find(p => p.id === userId);
  async function grantConsent() {
    if (!consent) throw new Error("Give consent before importing data.");
    const response = await fetch("/api/consents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, type: "data_ingestion", grant: true }), signal: abort.current?.signal });
    if (!response.ok) throw new Error("We could not record consent. Check that you own this profile.");
  }
  async function start(sample: boolean) {
    if (busy) return;
    setBusy(true); setMessage(""); setProgress(undefined);
    abort.current = new AbortController();
    try {
      if (!sample && (!file || !/\.(zip|csv)$/i.test(file.name))) throw new Error("Choose an Apple Health .zip or a .csv file.");
      await grantConsent();
      if (sample) {
        const adapter = new SimulatorAdapter(httpTransport(abort.current.signal), persona, 42, undefined, selected?.timezone || "UTC");
        const source = await adapter.connect(userId, null);
        const result = await adapter.sync(source);
        setMessage("Sample data: " + result.inserted + " readings added; " + result.skipped + " duplicates skipped.");
        setBusy(false);
        onComplete?.();
      } else if (file) {
        worker.current?.terminate();
        const active = new Worker(new URL("../../../src/lib/ingestion/import.worker.ts", import.meta.url));
        worker.current = active;
        active.onmessage = (event: MessageEvent<ImportProgress>) => {
          setProgress(event.data);
          if (event.data.status !== "working") {
            setBusy(false); setMessage(event.data.errors.join(" ")); active.terminate(); worker.current = null;
            onComplete?.();
          }
        };
        active.onerror = () => { setBusy(false); setMessage("The import worker stopped. Re-import to resume safely."); active.terminate(); worker.current = null; };
        const input: ImportRequest = { action: "start", userId, file, provider: /\.zip$/i.test(file.name) ? "apple_health_export" : "generic_csv", key: /\.zip$/i.test(file.name) ? "Apple Health" : key };
        active.postMessage(input);
      }
    } catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : "Import failed. Re-import to resume safely."); }
  }
  return <section className="space-y-5">
    <label className="block">Profile<select aria-label="Profile" className="mt-1 w-full rounded border p-3" disabled={busy} value={userId} onChange={e => { setUserId(e.target.value); setConsent(false); }}>
      {profiles.map(p => <option key={p.id} value={p.id}>{p.name}{p.kind === "dependent" ? " · Dependent" : ""}</option>)}
    </select></label>
    <label className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
      <span>{selected?.kind === "dependent" ? "I give guardian consent to store and process this dependent’s health readings." : "I consent to HMS storing and processing my health readings."} Data is stored in Supabase in India. You can withdraw consent and delete data. This does not give a doctor access.</span>
    </label>
    <label className="block">Health export<input aria-label="Health export" className="mt-2 block w-full max-w-full rounded border p-3 text-sm" type="file" accept=".zip,.csv" disabled={busy} onChange={e => setFile(e.target.files?.[0])} /></label>
    <label className="block">CSV source name<input className="mt-1 w-full rounded border p-3" maxLength={200} value={key} disabled={busy} onChange={e => setKey(e.target.value)} /></label>
    <p className="text-sm">Use the same source name when re-importing. Use a different name for a different CSV device. <a className="underline" href="/api/ingestion/template">Download CSV template</a>.</p>
    <button className="rounded bg-slate-900 px-5 py-3 text-white disabled:opacity-40" disabled={busy || !consent || !file} onClick={() => void start(false)}>Import file</button>
    {busy && <button className="ml-3 rounded border px-5 py-3" onClick={() => { abort.current?.abort(); worker.current?.postMessage({ action: "cancel" } satisfies ImportRequest); }}>Cancel import</button>}
    <p className="text-sm">Keep this tab open while importing. If interrupted, select the file again. Saved readings are not duplicated. Unsupported types or invalid rows are counted and skipped.</p>
    {progress && <div role="status" data-testid="import-progress" data-status={progress.status} data-inserted={progress.inserted} data-skipped={progress.skipped} className="rounded border p-4">
      <p>{progress.status === "done" ? "Import complete" : progress.status === "working" ? "Importing" : "Import stopped"}</p>
      <progress className="w-full" max={Math.max(1, progress.totalBytes)} value={progress.bytes} />
      <p>{progress.records.toLocaleString()} records read. {progress.inserted.toLocaleString()} added. {progress.skipped.toLocaleString()} duplicates. {progress.unsupported.toLocaleString()} unsupported or invalid.</p>
    </div>}
    {message && <p role="status">{message}</p>}
    <div className="space-y-3 rounded border p-4"><h2 className="text-xl font-semibold">Try sample data</h2>
      <label className="block">Sample persona<select aria-label="Sample persona" value={persona} disabled={busy} onChange={e => setPersona(e.target.value as Persona)} className="mt-1 w-full rounded border p-3">
        {Object.entries(personas).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
      </select></label>
      <p className="text-sm">90 days of synthetic readings. Always labelled Sample data.</p>
      <button className="rounded border px-4 py-2 disabled:opacity-40" disabled={busy || !consent} onClick={() => void start(true)}>Load sample data</button>
    </div>
  </section>;
}
