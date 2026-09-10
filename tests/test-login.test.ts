import {describe,expect,it} from "vitest";
import {localTestLoginAllowed} from "@/src/lib/auth/test-login";

describe("local test login guard",()=>{
  it("allows only development loopback URLs",()=>{
    expect(localTestLoginAllowed("development","http://localhost:3001/api/auth/test-login")).toBe(true);
    expect(localTestLoginAllowed("development","http://127.0.0.1:3001/api/auth/test-login")).toBe(true);
    expect(localTestLoginAllowed("production","http://localhost:3001/api/auth/test-login")).toBe(false);
    expect(localTestLoginAllowed("development","https://hms.example/api/auth/test-login")).toBe(false);
  });
});
