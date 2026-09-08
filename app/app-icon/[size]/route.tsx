import { ImageResponse } from "next/og";
export async function GET(_request:Request,{params}:{params:Promise<{size:string}>}) {
  const {size}=await params;
  if(size!=="192" && size!=="512") return new Response("Not found",{status:404});
  const dimension=Number(size);
  return new ImageResponse(<div style={{display:"flex",alignItems:"center",justifyContent:"center",width:"100%",height:"100%",background:"#132f47",color:"#c6f2e6",fontWeight:700,fontSize:dimension*.25,letterSpacing:-dimension*.015}}>HMS</div>,{width:dimension,height:dimension});
}
