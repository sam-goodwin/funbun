import { test, expect, describe } from "bun:test";
import { tempDir, bunExe, bunEnv } from "harness";

// A runtime-loaded, already-bundled (`// @bun`) module carrying an INLINE
// `//# sourceMappingURL=data:` map should have its stack frames remapped to the
// original source named in the map. This exercises the inline-map decode path
// (get_source_map_impl -> parse_url -> parse_json) end to end.
//
// The matrix covers the two data-URL media-type spellings:
//   - `application/json;base64`                 (what Bun's own bundler emits)
//   - `application/json;charset=utf-8;base64`   (what tsc / esbuild / webpack emit)
// parse_url previously compared the WHOLE header (`charset=utf-8;base64`) against
// `"base64"` and rejected the charset form with UnsupportedFormat, so the charset
// case silently lost its map. Both must now remap identically.
describe("runtime inline source map (already-bundled module)", () => {
  const HEADERS = {
    plain: "application/json;base64",
    charset: "application/json;charset=utf-8;base64",
  } as const;

  // A v3 map for the generated module below: each generated line maps to the
  // same generated line in `original.ts`, with sourcesContent so the original
  // is displayable without the file existing on disk.
  function inlineMap(header: string): string {
    const map = {
      version: 3,
      sources: ["original.ts"],
      sourcesContent: ["// original source\nexport function boom() {\n  throw new Error('from-original');\n}\n"],
      names: [],
      mappings: "AAAA;AACA;AACA;AACA;AACA;AACA",
    };
    const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
    return `data:${header},${b64}`;
  }

  function fixture(header: string): string {
    return [
      "// @bun",
      "function boom() {",
      "  throw new Error('kaboom');",
      "}",
      "boom();",
      `//# sourceMappingURL=${inlineMap(header)}`,
      "",
    ].join("\n");
  }

  test.each(Object.entries(HEADERS))(
    "%s data-URL map remaps the stack to the original source",
    async (_name, header) => {
      using dir = tempDir(`inline-srcmap-${_name}`, { "entry.js": fixture(header) });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "entry.js"],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
        stdout: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      // The thrown error's own frame names original.ts (from the map), not entry.js.
      const boomFrame = stderr.split("\n").find(l => l.includes("at boom"));
      expect(boomFrame).toBeDefined();
      expect(boomFrame).toContain("original.ts");
      expect(boomFrame).not.toContain("entry.js");
      // The decoder did not warn about an undecodable map.
      expect(stderr).not.toContain("Could not decode sourcemap");
      expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
    },
  );

  // `sourcesContent` is OPTIONAL per the v3 spec — tsc, the closure serializer,
  // and many tools omit it. Bun's parser previously REQUIRED it (and required
  // its length to equal `sources`), rejecting such maps as InvalidSourceMap.
  // A map with no `sourcesContent` must still load and remap.
  test("map without sourcesContent still remaps the stack", async () => {
    const map = {
      version: 3,
      sources: ["original.ts"],
      names: [],
      mappings: "AAAA;AACA;AACA;AACA;AACA;AACA",
    };
    const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
    const entry = [
      "// @bun",
      "function boom() {",
      "  throw new Error('kaboom');",
      "}",
      "boom();",
      `//# sourceMappingURL=data:application/json;base64,${b64}`,
      "",
    ].join("\n");
    using dir = tempDir("inline-srcmap-nocontent", { "entry.js": entry });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "entry.js"],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const boomFrame = stderr.split("\n").find(l => l.includes("at boom"));
    expect(boomFrame).toBeDefined();
    expect(boomFrame).toContain("original.ts");
    expect(boomFrame).not.toContain("entry.js");
    expect(stderr).not.toContain("Could not decode sourcemap");
    expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
  });
});
