import Link from "next/link";
export default function DisclaimerPage() {
  return <main className="onboarding stack"><h1 className="page-title">Health disclaimer</h1>
    <p>HMS is not a medical device. It does not diagnose conditions, detect emergencies or provide medical advice. Trends, scores and unusual-reading notices describe consumer wearable data, which may be incomplete or inaccurate.</p>
    <p>Discuss readings and insights with your doctor. Do not start, stop or change medicines or supplements based on this app.</p>
    <p>Cycle phases are estimates for planning training and energy. They are not suitable for fertility prediction or contraception.</p>
    <p>HMS is not for emergencies. If you need urgent help, contact your local emergency services. Do not wait for an alert or a consultation here.</p>
    <Link className="button secondary" href="/today">Back to Today</Link></main>;
}
