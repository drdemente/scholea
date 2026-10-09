import { afterEach, describe, expect, it } from "vitest";
import { detectTarget } from "./index";
import { webAdapter } from "./web";

describe("platform adapter", () => {
  afterEach(() => localStorage.clear());

  it("detects the web target in a plain browser environment", () => {
    expect(detectTarget()).toBe("web");
  });

  it("key storage round-trips a value", async () => {
    expect(await webAdapter.secureGet("ncbi")).toBeNull();
    await webAdapter.secureSet("ncbi", "a-key-as-typed");
    expect(await webAdapter.secureGet("ncbi")).toBe("a-key-as-typed");
  });

  it("keeps the value on the device as given, under its own prefix", async () => {
    // Not encrypted, and the code and the docs must not claim otherwise.
    await webAdapter.secureSet("ncbi", "a-key-as-typed");
    expect(localStorage.getItem("scholea.secure.ncbi")).toBe("a-key-as-typed");
  });
});
