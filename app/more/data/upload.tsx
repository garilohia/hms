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
  const [files, setFiles] = useState<File[]>([]);
  const [selection, setSelection] = useState("");
  const [key, setKey] = useState("CSV");
  const [persona, setPersona] = useState<Persona>("b");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<ImportProgress>();
  const worker = useRef<Worker | null>(null);
  const abort = useRef<AbortController | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { worker.current?.terminate(); abort.current?.abort(); }, []);
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); folderInput.current?.setAttribute("directory", ""); }, []);
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
      if (!sample && (!files.length || files.length > 20_000)) throw new Error("Choose an Apple Health ZIP, a CSV, or a folder containing up to 20,000 CSV files.");
      await grantConsent();
      if (sample) {
        const adapter = new SimulatorAdapter(httpTransport(abort.current.signal), persona, 42, undefined, selected?.timezone || "UTC");
        const source = await adapter.connect(userId, null);
        const result = await adapter.sync(source);
        setMessage("Sample data: " + result.inserted + " readings added; " + result.skipped + " duplicates skipped.");
        setBusy(false);
        onComplete?.();
      } else {
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
        const provider = files.length === 1 && /\.zip$/i.test(files[0].name) ? "apple_health_export" : "generic_csv";
        const input: ImportRequest = { action: "start", userId, files, provider, key: provider === "apple_health_export" ? "Apple Health" : key,
          timezone: selected?.timezone || "UTC" };
        active.postMessage(input);
      }
    } catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : "Import failed. Re-import to resume safely."); }
  }
  return <section className="stack">
    <label className="block">Profile<select aria-label="Profile" className="mt-1 w-full" disabled={busy} value={userId} onChange={e => { setUserId(e.target.value); setConsent(false); }}>
      {profiles.map(p => <option key={p.id} value={p.id}>{p.name}{p.kind === "dependent" ? " · Dependent" : ""}</option>)}
    </select></label>
    <label className="flex items-start gap-3"><input className="mt-1" type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
      <span>{selected?.kind === "dependent" ? "I give guardian consent to store and process this dependent’s health readings." : "I consent to HMS storing and processing my health readings."} Data is stored in Supabase in India. You can withdraw consent and delete data. This does not give a doctor access.</span>
    </label>
    <p className="muted"><a className="underline" href="/legal/privacy" target="_blank" rel="noreferrer">Read the privacy notice</a>. Guardian consent verification must be approved before using real children’s data.</p>
    <label className="block">Single health export<input aria-label="Health export" className="mt-2 block w-full max-w-full" type="file" accept=".zip,.csv,text/csv,application/zip" disabled={busy} onChange={e => {
      const selectedFile = e.target.files?.[0]; setFiles(selectedFile ? [selectedFile] : []); setSelection(selectedFile ? selectedFile.name : "");
      setKey(current => current === "Google Health folder" ? "CSV" : current);
    }} /></label>
    <label className="block">Google Fit or health CSV folder<input ref={folderInput} aria-label="Health CSV folder" className="mt-2 block w-full max-w-full" type="file" accept=".csv,text/csv" multiple disabled={busy} onChange={e => {
      const all = Array.from(e.target.files || []), csv = all.filter(candidate => /\.csv$/i.test(candidate.name));
      setFiles(csv); setKey(current => current === "CSV" ? "Google Health folder" : current);
      setSelection(csv.length ? csv.length.toLocaleString() + " CSV files selected" + (all.length > csv.length ? "; " + (all.length - csv.length).toLocaleString() + " other files ignored" : "") : "No CSV files found in that folder");
    }} /></label>
    {selection && <p className="muted" role="status">{selection}</p>}
    <label className="block">CSV source name<input className="mt-1 w-full" maxLength={200} value={key} disabled={busy} onChange={e => setKey(e.target.value)} /></label>
    <p className="muted">Folders are read recursively on this device. HMS recognises its four-column template, legacy Google Fit Daily activity metrics, and Google Health Takeout readings for heart rate, resting heart rate, steps, calories, RMSSD HRV, SpO₂, respiratory rate, skin temperature and weight. Account files, settings, empty datasets and unrecognised CSVs are named and skipped. Use the same source name when re-importing. <a className="underline" href="/api/ingestion/template">Download CSV template</a>.</p>
    <button className="button" disabled={busy || !consent || !files.length} onClick={() => void start(false)}>Import selected data</button>
    {busy && <button className="button secondary ml-3" onClick={() => { abort.current?.abort(); worker.current?.postMessage({ action: "cancel" } satisfies ImportRequest); }}>Cancel import</button>}
    <p className="muted">Keep this tab open while importing. If interrupted, select the file again. Saved readings are not duplicated. Unsupported types or invalid rows are counted and skipped.</p>
    {progress && <div role="status" data-testid="import-progress" data-status={progress.status} data-inserted={progress.inserted} data-skipped={progress.skipped} data-file-count={progress.fileCount} data-skipped-files={progress.skippedFiles} className="panel stack">
      <p>{progress.status === "done" ? "Import complete" : progress.status === "working" ? "Importing" : "Import stopped"}</p>
      {progress.fileCount && <p>{progress.fileName ? progress.fileName + " · " : ""}{progress.fileIndex?.toLocaleString()} of {progress.fileCount.toLocaleString()} files. {(progress.supportedFiles || 0).toLocaleString()} health files recognised; {(progress.skippedFiles || 0).toLocaleString()} nonmetric or unsupported files skipped.</p>}
      <progress className="w-full" max={Math.max(1, progress.totalBytes)} value={progress.bytes} />
      <p>{progress.records.toLocaleString()} records read. {progress.inserted.toLocaleString()} added. {progress.skipped.toLocaleString()} duplicates. {progress.unsupported.toLocaleString()} unsupported or invalid.</p>
    </div>}
    {message && <p role="status">{message}</p>}
    <div className="card stack"><h2 className="type-section">Try sample data</h2>
      <label className="block">Sample persona<select aria-label="Sample persona" value={persona} disabled={busy} onChange={e => setPersona(e.target.value as Persona)} className="mt-1 w-full">
        {Object.entries(personas).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
      </select></label>
      <p className="muted">90 days of synthetic readings. Always labelled Sample data.</p>
      <button className="button secondary" disabled={busy || !consent} onClick={() => void start(true)}>Load sample data</button>
    </div>
  </section>;
}
