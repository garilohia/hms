import { ImageResponse } from "next/og";
import { colourTokens } from "@/src/lib/design/tokens";
export async function GET(_request:Request,{params}:{params:Promise<{size:string}>}) {
  const {size}=await params;
  if(size!=="192" && size!=="512") return new Response("Not found",{status:404});
  const dimension=Number(size);
  return new ImageResponse(<div style={{display:"flex",alignItems:"center",justifyContent:"center",width:"100%",height:"100%",background:colourTokens.dark.groundTop,color:colourTokens.dark.ink,fontFamily:"Georgia, serif",fontWeight:500,fontSize:dimension*.28,letterSpacing:-dimension*.01}}>HMS</div>,{width:dimension,height:dimension});
}
