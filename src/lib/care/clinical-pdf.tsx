import {resolve} from "node:path";
import {Document,Page,Text,View,Svg,Path,Circle,StyleSheet,renderToBuffer,Font} from "@react-pdf/renderer";
import {clinicalMetrics,clinicalNumber,clinicalTrend,type ClinicalBody} from "./clinical-model";

const families=["HMS Noto","HMS Devanagari"];
Font.register({family:families[0],src:resolve("public/fonts/NotoSans-Regular.ttf")});
Font.register({family:families[1],src:resolve("public/fonts/NotoSansDevanagari-Regular.ttf")});
export class UnsupportedPdfText extends Error {}
const styles=StyleSheet.create({
  page:{padding:32,fontFamily:families,fontSize:9,color:"#132f47"},
  title:{fontSize:24,fontFamily:"Helvetica-Bold"},muted:{color:"#526879",fontSize:8},
  header:{borderBottomWidth:1,borderBottomColor:"#cedee5",paddingBottom:10,marginBottom:9},
  section:{fontSize:11,fontFamily:"Helvetica-Bold",marginTop:10,marginBottom:5},
  grid:{display:"flex",flexDirection:"row",flexWrap:"wrap",gap:8},
  itemGrid:{display:"flex",flexDirection:"row",flexWrap:"wrap",columnGap:8,rowGap:0},
  card:{width:261,height:79,padding:8,borderWidth:1,borderColor:"#d8e6ea",borderRadius:5},
  cardTitle:{fontFamily:"Helvetica-Bold",fontSize:10,marginBottom:2},
  badge:{fontFamily:"Helvetica-Bold",fontSize:9,color:"#006964",marginTop:4},
  item:{width:261,minHeight:22,fontSize:8,maxLines:2,textOverflow:"ellipsis"},
  medicine:{width:530,minHeight:20,fontSize:8},
  footer:{position:"absolute",left:32,right:32,bottom:25,borderTopWidth:1,borderTopColor:"#cedee5",paddingTop:8,fontSize:8},
});
const shorten=(value:string,max:number)=>value.length>max?value.slice(0,max-3)+"...":value;
// Explicit measured breaks also handle long identifiers. No medication text is discarded
// and no visible hyphen is inserted into a name or dose. Keep grapheme clusters intact.
function wrapPdfText(value:string,width:number,fontSize=8) {
  const fonts=families.map(fontFamily=>Font.getFont({fontFamily}).data!);
  let lineWidth=0,result="";
  for(const {segment} of new Intl.Segmenter("en",{granularity:"grapheme"}).segment(value.replace(/\s+/g," "))) {
    const font=fonts.find(f=>[...segment].every(c=>f.hasGlyphForCodePoint(c.codePointAt(0)!)))||fonts[0];
    const advance=font.layout(segment).advanceWidth/font.unitsPerEm*fontSize;
    if(lineWidth+advance>width&&lineWidth>0){result+="\n";lineWidth=0;}
    result+=segment;lineWidth+=advance;
  }
  return result;
}
function MetricCard({body,metric}:{body:ClinicalBody;metric:typeof clinicalMetrics[number]}) {
  const trend=clinicalTrend(body,metric.key);
  const second=metric.key==="bp_systolic"?clinicalTrend(body,"bp_diastolic"):null;
  return <View style={styles.card}>
    <Text style={styles.cardTitle}>{metric.label} ({metric.unit})</Text>
    {trend.n?<>
      <Svg viewBox="0 0 228 44" width={228} height={26}>
        {trend.segments.map((d,i)=><Path key={i} d={d} fill="none" stroke="#00736e" strokeWidth={1.3}/>)}
        {trend.points.filter(p=>p.y!==null).map(p=><Circle key={p.day} cx={p.x} cy={p.y!} r={.9} fill="#00736e"/>)}
      </Svg>
      <Text>{second?"Systolic":"Daily"} mean {clinicalNumber(trend.mean)} - {trend.n}/{body.days} recorded days</Text>
      <Text style={styles.muted}>{second?"Diastolic mean "+clinicalNumber(second.mean)+" ("+second.n+" days)":"First "+clinicalNumber(trend.first)+" / last "+clinicalNumber(trend.last)}</Text>
    </>:<Text style={{marginTop:17,color:"#526879"}}>{second?.n?"Systolic not recorded. Diastolic mean "+clinicalNumber(second.mean)+" ("+second.n+" days).":"No recorded days in this period."}</Text>}
  </View>;
}
export function ClinicalPdf({body}:{body:ClinicalBody}) {
  return <Document title="HMS clinical summary" author="HMS" subject="Consumer wearable summary for discussion with a doctor">
    <Page size="A4" style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>HMS / Clinical summary</Text>
        <Text style={{fontSize:13,marginTop:5}}>{shorten(body.profile.name.replace(/\s+/g," "),40)}</Text>
        <Text>DOB {body.profile.dob} | Sex at birth {body.profile.sex_at_birth||"not recorded"} | {body.profile.country}</Text>
        <Text style={styles.muted}>{body.from} to {body.to} ({body.days} days) | {body.profile.timezone}</Text>
        <Text style={styles.muted}>Generated {new Date(body.generated_at).toISOString().replace("T"," ").slice(0,16)} UTC</Text>
        {body.contains_sample&&<Text style={styles.badge}>Sample data - illustrative readings, not a real patient record.</Text>}
        {body.consent_given_by_guardian&&<Text style={styles.badge}>Consent given by guardian</Text>}
      </View>
      <View style={styles.grid}>{clinicalMetrics.map(metric=><MetricCard key={metric.key} body={body} metric={metric}/>)}</View>
      <Text style={{...styles.muted,marginTop:4}}>Daily aggregates. Lines break at missing data. Each chart uses its own scale. First/last are recorded values, not period endpoints.</Text>
      <Text style={styles.section}>Unusual readings in this period</Text>
      <Text>{body.alert_counts.length?body.alert_counts.map(a=>a.severity+": "+a.count).join(" | "):"No recorded alerts in this period."}</Text>
      <Text style={styles.section}>Reported medications</Text>
      <View>{body.medications.length?body.medications.slice(0,6).map((m,i)=><Text key={i} style={styles.medicine}>{wrapPdfText(m,520)}</Text>):<Text>Not recorded. This does not mean none are taken.</Text>}</View>
      {body.medications.length>6&&<Text style={styles.muted}>First 6 of {body.medications.length} entries. This is not a complete medication list. See the app for all entries.</Text>}
      <Text style={styles.section}>Documents and prescriptions</Text>
      <View style={styles.itemGrid}>{body.documents.length?body.documents.slice(0,6).map(d=><Text key={d.id} style={styles.item}>{wrapPdfText(shorten(d.title,50)+" ("+d.type.replaceAll("_"," ")+")",251)}</Text>):<Text>No documents recorded.</Text>}</View>
      {body.document_count>Math.min(6,body.documents.length)&&<Text style={styles.muted}>{Math.min(6,body.documents.length)} most recent listed of {body.document_count}. Open History for the remaining documents.</Text>}
      <Text style={{...styles.muted,marginTop:4}}>Long names/titles may be shortened with &quot;...&quot;. Original entries remain in the app.</Text>
      <View style={styles.footer}>
        <Text style={{fontFamily:"Helvetica-Bold"}}>{body.disclaimer}</Text>
        <Text>Discuss with your doctor. Not for emergencies. Do not change medication based on this report.</Text>
        <Text style={styles.muted}>Profile {body.profile.id} | This downloaded copy cannot be remotely revoked.</Text>
      </View>
    </Page>
  </Document>;
}
export async function renderClinicalPdf(body:ClinicalBody) {
  await Promise.all(families.map(fontFamily=>Font.load({fontFamily})));
  const fonts=families.map(fontFamily=>Font.getFont({fontFamily}).data!);
  const values=[body.profile.name,...body.medications,...body.documents.map(d=>d.title)];
  for(const char of values.join(" "))if(!/\s/u.test(char)&&!fonts.some(f=>f.hasGlyphForCodePoint(char.codePointAt(0)!)))throw new UnsupportedPdfText("Unsupported PDF character.");
  return renderToBuffer(<ClinicalPdf body={body}/>);
}
