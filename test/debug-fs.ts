import { readFileSync } from "node:fs";
import { parseComponent } from "../src/parser/parse.ts";
const wasmBytes = new Uint8Array(readFileSync("test/guest/out/go-filesystem/component.wasm"));
const parsed = parseComponent(wasmBytes);
// Show type @11 and @12 and @13
for (const section of parsed.sections) {
  if (section.tag === "type") {
    for (let i = 0; i < section.entries.length; i++) {
      const entry = section.entries[i];
      const typeIdx = section.startIndex + i;
      if (typeIdx >= 10 && typeIdx <= 14) {
        console.log("Type @" + typeIdx + ": " + entry.tag);
        if (entry.tag === "instance") {
          for (const decl of entry.entries) {
            if (decl.tag === "type") {
              if (decl.entry.tag === "resource") console.log("  resource");
              else if (decl.entry.tag === "defined") console.log("  defined:", decl.entry.type.tag, "typeIndex:", (decl.entry.type as any).typeIndex);
            }
            if (decl.tag === "alias") console.log("  alias:", JSON.stringify(decl.alias));
            if (decl.tag === "exportType") console.log("  export:", decl.name, JSON.stringify(decl.type));
          }
        } else if (entry.tag === "resource") {
          console.log("  (resource type)");
        } else if (entry.tag === "defined") {
          console.log("  defined:", entry.type.tag, "typeIndex:", (entry.type as any).typeIndex);
        }
      }
    }
  }
  if (section.tag === "alias") {
    const a = section.alias;
    if (a.tag === "instanceExport") {
      console.log("Alias instanceExport:", a.name, "from instance", a.instanceIndex, "sort:", a.sort);
    }
  }
}

// Now check what resolve produces
import { generateCode } from "../src/codegen/index.ts";
const result = generateCode(parsed, "go-filesystem", { jspiMode: true });
// Find resourceNew in generated code
const lines = result.source.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("resourceNew") && i < 250) {
    console.log("resourceNew at line", i+1, ":", lines[i].trim());
  }
}
