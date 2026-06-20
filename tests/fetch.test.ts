import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import type { AddressInfo } from "net";
import { execFile } from "child_process";
import { promisify } from "util";
import { compileAsync } from "../src/driver";

// `fetch` hits the network, so it can't be a static `cases/*.ts` + `.expected`
// pair (the e2e harness diffs stdout for a fixed program). Instead we stand up a
// localhost HTTP server on an ephemeral port, compile small programs that fetch
// from it, run the native binaries, and assert their stdout — fully hermetic (no
// real network). This mirrors how modules.test.ts owns cases the e2e harness can't.
const run = promisify(execFile);

describe("fetch: compile + run against a localhost server", () => {
  let server: http.Server;
  let base: string; // e.g. http://127.0.0.1:54321
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsn-fetch-"));
    server = http.createServer((req, res) => {
      if (req.url === "/user") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"id":7,"name":"Ada"}');
      } else if (req.url === "/hello") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello world");
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Compile `src` to a native binary, run it, and return its stdout. (Generous
  // timeout: a fetch program #includes <curl/curl.h>, so clang takes a moment.)
  const compileAndRun = async (name: string, src: string): Promise<string> => {
    const input = path.join(dir, `${name}.ts`);
    const out = path.join(dir, name);
    fs.writeFileSync(input, src);
    await compileAsync({ input, output: out, emitCpp: false });
    const { stdout } = await run(out, { encoding: "utf8" });
    return stdout;
  };

  it("reads status, ok, and text() from a 200 response", async () => {
    const stdout = await compileAndRun(
      "ok",
      `async function main(): Promise<void> {
           const res = await fetch("${base}/hello");
           console.log(res.status);
           console.log(res.ok);
           console.log(await res.text());
         }
         main();`,
    );
    expect(stdout).toBe("200\ntrue\nhello world\n");
  }, 30000);

  it("parses a JSON body via `await res.json() as T`", async () => {
    const stdout = await compileAndRun(
      "json",
      `async function main(): Promise<void> {
           const res = await fetch("${base}/user");
           const u = await res.json() as { id: number; name: string };
           console.log(u.name);
           console.log(u.id);
         }
         main();`,
    );
    expect(stdout).toBe("Ada\n7\n");
  }, 30000);

  it("resolves (does not reject) on an HTTP error status", async () => {
    const stdout = await compileAndRun(
      "notfound",
      `async function main(): Promise<void> {
           const res = await fetch("${base}/missing");
           console.log(res.status);
           console.log(res.ok);
         }
         main();`,
    );
    expect(stdout).toBe("404\nfalse\n");
  }, 30000);

  it("rejects the promise on a transport error (catchable with try/catch)", async () => {
    // A closed port → connection refused. Grab an ephemeral port, then close it
    // so nothing is listening there.
    const tmp = http.createServer();
    const deadPort = await new Promise<number>((resolve) =>
      tmp.listen(0, "127.0.0.1", () =>
        resolve((tmp.address() as AddressInfo).port),
      ),
    );
    await new Promise<void>((resolve) => tmp.close(() => resolve()));
    const stdout = await compileAndRun(
      "reject",
      `async function main(): Promise<void> {
           try {
             const res = await fetch("http://127.0.0.1:${deadPort}/x");
             console.log("unexpected: " + res.status);
           } catch (e) {
             console.log("caught");
           }
         }
         main();`,
    );
    expect(stdout).toBe("caught\n");
  }, 30000);

  it("rejects a bare res.json() with no target type", async () => {
    const input = path.join(dir, "barejson.ts");
    fs.writeFileSync(
      input,
      `async function main(): Promise<void> {
         const r = await fetch("${base}/user");
         const j = await r.json();
         console.log(j);
       }
       main();`,
    );
    await expect(
      compileAsync({
        input,
        output: path.join(dir, "barejson"),
        emitCpp: false,
      }),
    ).rejects.toThrow(/target type/);
  });
});
