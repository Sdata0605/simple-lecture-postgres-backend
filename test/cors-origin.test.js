import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { corsOptions } from "../src/cors.js";

const decide = (opts, origin) => new Promise((resolve) => opts.origin(origin, (_err, ok) => resolve(ok)));

describe("corsOptions", () => {
  it("allows every origin when CORS_ORIGINS is not set", () => {
    assert.equal(corsOptions({}).origin, true);
  });

  it("allows only the listed origins and requests without an Origin header", async () => {
    const opts = corsOptions({ CORS_ORIGINS: " https://simplelecture.com, https://www.simplelecture.com " });
    assert.equal(await decide(opts, "https://simplelecture.com"), true);
    assert.equal(await decide(opts, "https://www.simplelecture.com"), true);
    assert.equal(await decide(opts, "https://evil.example"), false);
    assert.equal(await decide(opts, "http://simplelecture.com"), false);
    assert.equal(await decide(opts, undefined), true);
    assert.equal(opts.credentials, true);
  });
});
