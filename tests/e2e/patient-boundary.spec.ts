import {expect,test} from "@playwright/test";
test("private patient endpoints reject anonymous requests and foreign origins",async({request,baseURL})=>{
  for(const path of ["/api/patient/view","/api/patient/source","/api/patient/refresh","/api/profiles/settings"]) {
    expect((await request.post(path,{headers:{Origin:baseURL!},data:{}})).status()).toBe(401);
    expect((await request.post(path,{headers:{Origin:"https://foreign.example"},data:{}})).status()).toBe(403);
  }
});
