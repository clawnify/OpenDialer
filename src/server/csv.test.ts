import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("reads headers, quoted commas and CRLF", () => {
    const { headers, rows } = parseCsv('First Name,last_name,Company,phone,country,notes\r\nAda,Lovelace,"Analytical, Ltd",+44 20 7123 4567,GB,"said ""hi"""\r\n\r\n');
    expect(headers).toEqual(["first_name", "last_name", "company", "phone", "country", "notes"]);
    expect(rows).toEqual([["Ada", "Lovelace", "Analytical, Ltd", "+44 20 7123 4567", "GB", 'said "hi"']]);
  });
  it("skips blank lines and strips a BOM", () => {
    expect(parseCsv("﻿a,b\n\n1,2\n").rows).toEqual([["1", "2"]]);
  });
});
