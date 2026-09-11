import {defineConfig} from "@playwright/test";
import golden from "./playwright.golden.config";
// Design audit: full-page screenshots of every route at 390px in light and dark mode, saved to design-audit/.
export default defineConfig({...golden,testDir:"./tests/design-audit",outputDir:"./test-results/design-audit",timeout:900000,workers:1});
