/** Small generated PDFs with selectable text; no real user files are checked in. */
export function contractPdf(pages: string[][], fontSize = 12): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" + pages.map((_, index) => (4 + index * 2) + " 0 R").join(" ") + "] /Count " + pages.length + " >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pages.length; index++) {
    const stream = pages[index].map((line, row) => "BT /F1 " + fontSize + " Tf 20 " + (750 - row * 18) + " Td (" + line.replace(/[\\()]/g, value => "\\" + value) + ") Tj ET").join("\n");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents " + (5 + index * 2) + " 0 R >>");
    objects.push("<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "\nendstream");
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(pdf);
}
