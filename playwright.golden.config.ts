import {existsSync} from "node:fs";
import {defineConfig} from "@playwright/test";
import base from "./playwright.config";
if(existsSync(".env.local")) process.loadEnvFile(".env.local");
export default defineConfig({...base,testDir:"./tests/golden",outputDir:"./test-results/golden",timeout:240000,expect:{timeout:15000},
  projects:[{name:"chromium",use:{channel:"chromium",viewport:{width:390,height:844}}}],use:{...base.use,trace:"off",screenshot:"off"},
  webServer:{...base.webServer,command:"npm run start -- --port "+(process.env.HMS_TEST_PORT||"3100"),url:String(base.use?.baseURL),reuseExistingServer:process.env.HMS_TEST_REUSE_DEV==="1",env:{RESEND_API_KEY:""}},workers:1});
