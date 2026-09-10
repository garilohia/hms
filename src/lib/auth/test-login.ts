export function localTestLoginAllowed(nodeEnv:string|undefined,url:string) {
  if(nodeEnv!=="development")return false;
  const hostname=new URL(url).hostname;
  return hostname==="localhost"||hostname==="127.0.0.1"||hostname==="[::1]";
}
