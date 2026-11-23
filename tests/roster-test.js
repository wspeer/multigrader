// Unit tests for js/roster.js (made-up names only).
//   node tests/roster-test.js
require("../js/roster.js");
const R = globalThis.MGRoster;
let fails = 0;
function check(input, want, label) {
  const got = R.parse(input).map((p) => `${p.first}|${p.last}` + (p.form ? `|${p.form}` : "")).join(" ; ");
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL "}${label}${ok ? "" : `\n        want: ${want}\n        got:  ${got}`}`);
}

// OCR of a roster screenshot ("Last, First (grade) level"), as text recognition returns it.
check(`Abbott, Jordan (v)

Baker, Lin (1v)
Castillo, Mia (v) Advanced
Dunn, Eli (Iv)
Roman, Ana Sofia (v) Ap
O'Neill, Kate (V)`,
  "Jordan|Abbott|V ; Lin|Baker|IV ; Mia|Castillo|V ; Eli|Dunn|IV ; Ana Sofia|Roman|V ; Kate|O'Neill|V", "OCR screenshot: Form kept (misread (1v)/(Iv) → IV), Advanced/AP dropped");

check("Garcia, Maria\nChen, David\nSam Okafor", "Maria|Garcia ; David|Chen ; Sam|Okafor", "Last, First and First Last lines");
check("First Name,Last Name,Email\nMaria,Garcia,mg@school.org\nDavid,Chen,dc@school.org", "Maria|Garcia ; David|Chen", "CSV export with header row and email column");
check("Last Name\tFirst Name\tGrade\nGarcia\tMaria\t11\nChen\tDavid\t10", "Maria|Garcia|11 ; David|Chen|10", "spreadsheet paste with header (Last first), Grade → Form");
check('"Garcia, Maria"\n"Chen, David"', "Maria|Garcia ; David|Chen", "quoted \"Last, First\"");
check('Student,Email\n"Garcia, Maria",mg@x.org\n"Chen, David",dc@x.org', "Maria|Garcia ; David|Chen", "CSV with a single Student column");
check("Name\tStudent ID\nMaria Garcia\t10234\nDavid Chen\t10235", "Maria|Garcia ; David|Chen", "Name + ID columns");
check("Maria\tGarcia\nDavid\tChen", "Maria|Garcia ; David|Chen", "two columns, no header (First, Last)");
check("1. Maria Garcia\n2. David Chen\n• Ana Lee", "Maria|Garcia ; David|Chen ; Ana|Lee", "numbered and bulleted lists");
check("Students (3)\nGarcia, Maria\nChen, David", "Maria|Garcia ; David|Chen", "header-like line skipped");
check("Núñez, José\nWiśniewski, Łukasz", "José|Núñez ; Łukasz|Wiśniewski", "accented names kept");
check("Garcia, Maria  mg@school.org", "Maria|Garcia", "email on the same line dropped");
check("Garcia, Maria (Gr 11) Honors\nChen, David (12th)\nLee, Ana [AP]", "Maria|Garcia|11 ; David|Chen|12 ; Ana|Lee", "grade numbers become Form; non-grade tags dropped");
check("Last Name,First Name,Grade,Email\nGarcia,Maria,11,mg@x.org\nChen,David,10,dc@x.org", "Maria|Garcia|11 ; David|Chen|10", "Grade column becomes Form");
check("Student\tForm\nGarcia, Maria\tIV\nChen, David\tV", "Maria|Garcia|IV ; David|Chen|V", "Form column with \"Last, First\" names");

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
